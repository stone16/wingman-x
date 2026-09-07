/** Experiment only (temporary folder). Production path on the 20 posts with the local tone.md v3; two-column blind file against the previous production run. */
import "../../../scripts/load-env.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRuntime, parseFlags } from "../src/cli/bootstrap.js";
import { runSinglePost } from "../src/pipeline/single.js";
import { createMemoryCandidateLog } from "../src/state/candidate-log.js";
import { NormalizedPostSchema } from "../src/model/post.js";
const OUT = "/private/tmp/claude-501/-Users-uditbhansali-Desktop-Chime-In/6da9911a-f570-42ac-8bf8-3b03ad28adff/scratchpad/exp";
async function mapC<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!, i); } }));
  return out;
}
const rt = await buildRuntime({ ...parseFlags([]), dryRun: true }, { needWatchlist: false });
if (!rt.kb.tone.includes("Real exchanges")) throw new Error("local tone.md is not v3");
const rows = readFileSync(join(OUT, "posts.jsonl"), "utf8").trim().split("\n").map((l) => { const o = JSON.parse(l); return { post: NormalizedPostSchema.parse(o.post), theme: o.theme_hint as string }; });
const prev = readFileSync(join(OUT, "results-prod.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const t0 = Date.now();
const results = await mapC(rows, 4, async (row, i) => {
  try {
    const r = await runSinglePost(row.post, { config: rt.config, llm: rt.llm, kb: rt.kb, themes: rt.themes, policy: rt.policy, digest: rt.digest, experienceIndex: rt.experienceIndex, facts: rt.facts, candidateLog: createMemoryCandidateLog(), postCandidates: async (cs) => ({ accepted: cs.length }) });
    console.log(`${i + 1}/${rows.length} @${row.post.author_handle} (${Math.round((Date.now() - t0) / 1000)}s)`);
    return { tweet_id: row.post.tweet_id, author: row.post.author_handle, theme: row.theme, text: row.post.tweet_text, quoted: row.post.quoted_tweet ? `@${row.post.quoted_tweet.author_handle}: ${row.post.quoted_tweet.text}` : null, reply: r.reply, move: r.move, grounding: r.grounding, match_reason: r.candidate.match_reason, flags: r.candidate.ai_tell_flags ?? [] };
  } catch (e) { return { tweet_id: row.post.tweet_id, author: row.post.author_handle, theme: row.theme, text: row.post.tweet_text, quoted: null, error: (e as Error).message }; }
});
writeFileSync(join(OUT, "results-tone3.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
const key: Record<string, { col1: string; col2: string }> = {};
const md = ["# Blind: tone.md v3 vs previous production, 20 posts", "", "Only tone.md differs (synthetic targets removed, parents added, argument and certainty lines softened). Column order random per post.", "", "- **Post:** 1 / 2 / both / neither", "- **Edit needed:** none / light / rewrite", "- **Factual issues:** anything wrong, invented, or over-certain", ""];
results.forEach((r, i) => {
  const p = prev.find((x: any) => x.tweet_id === r.tweet_id);
  const flip = Math.random() < 0.5;
  const [c1, c2] = flip ? [p, r] : [r, p];
  key[r.tweet_id] = { col1: flip ? "prev" : "tone3", col2: flip ? "tone3" : "prev" };
  const txt = (x: any) => (x.error ? `(failed: ${x.error})` : x.reply) + (x.flags?.length ? `\n\n_flags: ${x.flags.join("; ")}_` : "");
  md.push(`## ${i + 1}. @${r.author} · ${r.theme}`, "", `> ${r.text.replace(/\n+/g, "\n> ")}`);
  if (r.quoted) md.push(">", `> *quoting* ${r.quoted.replace(/\n+/g, " ")}`);
  md.push("", "**Column 1**", "", txt(c1), "", "**Column 2**", "", txt(c2), "", "**Post:** ___  **Edit needed:** ___  **Factual issues:** ___", "", "---", "");
});
writeFileSync(join(OUT, "blind-tone3.md"), md.join("\n"));
writeFileSync(join(OUT, "key-tone3.json"), JSON.stringify(key, null, 2));
console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
