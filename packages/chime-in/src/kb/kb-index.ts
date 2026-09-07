/**
 * Lightweight retrieval over the Wingman knowledge base.
 *
 * No vector database (deliberately out of scope for the MVP). Library
 * files are split into heading-delimited chunks and scored with BM25
 * against the post text + theme. This is good enough because the KB is
 * small (tens of files) and topical; the strong-model stages then pick
 * which excerpts actually apply and cite them as `kb_refs`.
 */
export interface KBDoc {
  /** kebab-case id from the adapter (file name without .md). */
  id: string;
  title: string;
  markdown: string;
}

export interface KBChunk {
  /** Stable reference: `library/<id>.md#<heading-slug>`. */
  ref: string;
  /** Wingman-style file ref: `library/<id>.md`. */
  file: string;
  title: string;
  heading: string;
  text: string;
}

/** Library files that are constraints rather than knowledge. Always injected into drafting and contribution prompts, excluded from retrieval. */
export const CONSTRAINT_FILES: readonly string[] = [
  "library/identity_and_boundaries.md",
  "library/identity-and-boundaries.md",
  "library/boundaries.md",
];

export interface KBIndex {
  tone: string;
  chunks: KBChunk[];
  files: string[];
  /** Full text of the constraint files, or "" when none exist. */
  constraints: string;
  /** One line per library file — what the person knows, at a glance. */
  summary: string;
  /**
   * BM25 over chunks. `minRelative` drops chunks scoring below that fraction of the top hit;
   * `minMatched` requires that many distinct query terms in the chunk. Both default off.
   */
  search(query: string, k: number, opts?: { maxPerFile?: number; minRelative?: number; minMatched?: number }): KBChunk[];
  chunksByRef(refs: string[]): KBChunk[];
  chunksForFiles(files: string[], limit: number): KBChunk[];
}

const STOPWORDS = new Set(
  "the a an and or of to in on for with is are was were be been being it its this that these those as at by from but not no yes if then than so we you they he she i my our your their them us his her me do does did done have has had can could should would will just very more most much many some any all about into over under out up down there here what which who whom why how when where also than".split(
    " ",
  ),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[^a-z0-9$]+/)
    .map((t) => t.replace(/^\$/, ""))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .map(lightStem);
}

/** Tiny suffix stemmer: enough to match "tokenized"/"tokenization"/"tokens". */
function lightStem(t: string): string {
  for (const suffix of ["ization", "isation", "ations", "ation", "ized", "ised", "izing", "ising", "ings", "ing", "ies", "ers", "er", "ed", "es", "s"]) {
    if (t.length - suffix.length >= 4 && t.endsWith(suffix)) {
      return t.slice(0, t.length - suffix.length);
    }
  }
  return t;
}

export function slugifyHeading(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "section";
}

const MAX_CHUNK_CHARS = 1600;
export const NON_RETRIEVABLE_HEADING_RE = /reply angles|relevance cues/i;

/** Split one markdown document into heading-delimited chunks. */
export function chunkMarkdown(doc: KBDoc): KBChunk[] {
  const file = `library/${doc.id}.md`;
  // HTML comments are authoring notes (the seed files use them for
  // instructions to the user) — never knowledge. Strip before chunking so
  // they are neither retrieved nor shown to the model.
  const lines = doc.markdown.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const sections: Array<{ heading: string; body: string[] }> = [];
  let current: { heading: string; body: string[] } = { heading: doc.title, body: [] };
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (m?.[2]) {
      if (current.body.some((l) => l.trim().length > 0)) sections.push(current);
      current = { heading: m[2], body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.some((l) => l.trim().length > 0)) sections.push(current);

  const chunks: KBChunk[] = [];
  const usedSlugs = new Map<string, number>();
  for (const section of sections) {
    // "Good reply angles" / "Relevance cues" sections are recognition
    // notes for humans maintaining the KB. Retrieving them teaches the
    // drafter to treat them as a menu of moves, so they are excluded.
    if (NON_RETRIEVABLE_HEADING_RE.test(section.heading)) continue;
    const text = section.body.join("\n").trim();
    if (!text) continue;
    const baseSlug = slugifyHeading(section.heading);
    const n = usedSlugs.get(baseSlug) ?? 0;
    usedSlugs.set(baseSlug, n + 1);
    const slug = n === 0 ? baseSlug : `${baseSlug}-${n + 1}`;
    const pieces = splitLong(text, MAX_CHUNK_CHARS);
    pieces.forEach((piece, i) => {
      chunks.push({
        ref: pieces.length === 1 ? `${file}#${slug}` : `${file}#${slug}-p${i + 1}`,
        file,
        title: doc.title,
        heading: section.heading,
        text: piece,
      });
    });
  }
  return chunks;
}

function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if ((cur + "\n\n" + p).length > max && cur) {
      out.push(cur.trim());
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  // A single paragraph longer than max: hard-wrap on sentence-ish boundaries.
  return out.flatMap((piece) => (piece.length <= max ? [piece] : hardSplit(piece, max)));
}

function hardSplit(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(". ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function firstParagraph(markdown: string): string {
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const para: string[] = [];
  let started = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^#/.test(t) || /^<!--/.test(t) || t.startsWith(">")) {
      if (started) break;
      continue;
    }
    if (!t) {
      if (started) break;
      continue;
    }
    started = true;
    para.push(t.replace(/^[-*]\s+/, ""));
  }
  return para.join(" ");
}

export function buildKBIndexFromDocs(tone: string, allDocs: KBDoc[]): KBIndex {
  const isConstraint = (d: KBDoc): boolean => CONSTRAINT_FILES.includes(`library/${d.id}.md`);
  const constraints = allDocs
    .filter(isConstraint)
    .map((d) => d.markdown.replace(/<!--[\s\S]*?-->/g, "").trim())
    .join("\n\n");
  const docs = allDocs.filter((d) => !isConstraint(d));
  const chunks = docs.flatMap(chunkMarkdown);
  const docTokens = chunks.map((c) => {
    // Title tokens are counted twice so file topic matters more than
    // incidental body mentions.
    const titleTokens = tokenize(`${c.title} ${c.heading}`);
    return [...titleTokens, ...titleTokens, ...tokenize(c.text)];
  });
  const df = new Map<string, number>();
  for (const toks of docTokens) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = Math.max(1, chunks.length);
  const avgLen = docTokens.reduce((s, t) => s + t.length, 0) / N || 1;
  const k1 = 1.2;
  const b = 0.75;

  const tfCache = docTokens.map((toks) => {
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    return tf;
  });

  function score(queryTokens: string[], i: number): number {
    const tf = tfCache[i]!;
    const len = docTokens[i]!.length;
    let s = 0;
    for (const q of new Set(queryTokens)) {
      const f = tf.get(q);
      if (!f) continue;
      const n = df.get(q) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgLen)));
    }
    return s;
  }

  const summary = docs
    .map((d) => {
      const fp = firstParagraph(d.markdown);
      const short = fp.length > 220 ? `${fp.slice(0, 217)}…` : fp;
      return `- ${d.title} (library/${d.id}.md)${short ? `: ${short}` : ""}`;
    })
    .join("\n");

  return {
    tone,
    chunks,
    files: docs.map((d) => `library/${d.id}.md`),
    constraints,
    summary,
    search(query, k, opts = {}) {
      const maxPerFile = opts.maxPerFile ?? 3;
      const qt = tokenize(query);
      if (qt.length === 0 || chunks.length === 0) return [];
      const distinct = new Set(qt);
      const matchedTerms = (i: number): number => { let m = 0; for (const q of distinct) if (tfCache[i]!.has(q)) m += 1; return m; };
      let ranked = chunks
        .map((c, i) => ({ c, s: score(qt, i), m: matchedTerms(i) }))
        .filter((r) => r.s > 0)
        .sort((a, b2) => b2.s - a.s);
      const top = ranked[0]?.s ?? 0;
      if (opts.minRelative !== undefined) ranked = ranked.filter((r) => r.s >= opts.minRelative! * top);
      if (opts.minMatched !== undefined) ranked = ranked.filter((r) => r.m >= Math.min(opts.minMatched!, distinct.size));
      const perFile = new Map<string, number>();
      const out: KBChunk[] = [];
      for (const r of ranked) {
        const n = perFile.get(r.c.file) ?? 0;
        if (n >= maxPerFile) continue;
        perFile.set(r.c.file, n + 1);
        out.push(r.c);
        if (out.length >= k) break;
      }
      return out;
    },
    chunksByRef(refs) {
      const want = new Set(refs);
      return chunks.filter((c) => want.has(c.ref));
    },
    chunksForFiles(files, limit) {
      const want = new Set(files);
      return chunks.filter((c) => want.has(c.file)).slice(0, limit);
    },
  };
}

/** Load via Wingman's KB loader (respects ~/.wingman-x/config.json adapters). */
export async function buildKBIndex(loader: {
  getTone(): Promise<{ markdown: string }>;
  listLibrary(): Promise<Array<{ id: string; title: string }>>;
  getLibraryEntry(id: string): Promise<{ markdown: string }>;
}): Promise<KBIndex> {
  const [tone, entries] = await Promise.all([loader.getTone(), loader.listLibrary()]);
  const docs: KBDoc[] = [];
  for (const e of entries) {
    const content = await loader.getLibraryEntry(e.id);
    docs.push({ id: e.id, title: e.title, markdown: content.markdown });
  }
  return buildKBIndexFromDocs(tone.markdown, docs);
}

/** Render excerpts for a prompt with stable `[K1]`…`[Kn]` labels. */
export function renderExcerpts(chunks: KBChunk[]): string {
  if (chunks.length === 0) return "(no knowledge base excerpts matched this post)";
  return chunks
    .map((c, i) => `[K${i + 1}] ${c.ref}\n(${c.title} › ${c.heading})\n${c.text}`)
    .join("\n\n");
}
