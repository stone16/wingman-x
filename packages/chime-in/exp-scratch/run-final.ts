/** Experiment only (temporary folder). Regression: production path on the 20 fixed posts (blind vs round three) plus 6 fresh posts (single column). */
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
if (!rt.kb.constraints.includes("a distinction is not owed")) throw new Error("identity edits not loaded");
const load = (f: string) => readFileSync(join(OUT, f), "utf8").trim().split("\n").map((l) => { const o = JSON.parse(l); return { post: NormalizedPostSchema.parse(o.post), theme: o.theme_hint as string }; });
const rows = [...load("posts.jsonl").map((r) => ({ ...r, fresh: false })), ...load("posts-fresh.jsonl").map((r) => ({ ...r, fresh: true }))];
const prev = readFileSync(join(OUT, "results-round4b.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const t0 = Date.now();
const results = await mapC(rows, 4, async (row, i) => {
  try {
    const r = await runSinglePost(row.post, { config: rt.config, llm: rt.llm, kb: rt.kb, themes: rt.themes, policy: rt.policy, digest: rt.digest, experienceIndex: rt.experienceIndex, facts: rt.facts, candidateLog: createMemoryCandidateLog(), postCandidates: async (cs) => ({ accepted: cs.length }) });
    console.log(`${i + 1}/${rows.length} @${row.post.author_handle} (${Math.round((Date.now() - t0) / 1000)}s)`);
    return { tweet_id: row.post.tweet_id, fresh: row.fresh, author: row.post.author_handle, theme: row.theme, text: row.post.tweet_text, quoted: row.post.quoted_tweet ? `@${row.post.quoted_tweet.author_handle}: ${row.post.quoted_tweet.text}` : null, reply: r.reply, move: r.move, grounding: r.grounding, match_reason: r.candidate.match_reason, flags: r.candidate.ai_tell_flags ?? [] };
  } catch (e) { return { tweet_id: row.post.tweet_id, fresh: row.fresh, author: row.post.author_handle, theme: row.theme, text: row.post.tweet_text, quoted: null, error: (e as Error).message }; }
});
writeFileSync(join(OUT, "results-round5.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
const key: Record<string, { col1: string; col2: string }> = {};
const txt = (x: any) => (x.error ? `(failed: ${x.error})` : x.reply) + (x.flags?.length ? `\n\n_flags: ${x.flags.join("; ")}_` : "");
const md = ["# Round five: connectors and approved exchanges vs round four (20 posts), plus 6 fresh posts", "", "Part A: two columns, random order. Part B: fresh posts, one column, score post / edit / factual issues only.", ""];
let n = 0;
md.push("## Part A");
for (const r of results.filter((x) => !x.fresh)) {
  n += 1; const p = prev.find((x: any) => x.tweet_id === r.tweet_id); const flip = Math.random() < 0.5; const [c1, c2] = flip ? [p, r] : [r, p];
  key[r.tweet_id] = { col1: flip ? "round4" : "round5", col2: flip ? "round5" : "round4" };
  md.push(`### ${n}. @${r.author} · ${r.theme}`, "", `> ${r.text.replace(/\n+/g, "\n> ")}`); if (r.quoted) md.push(">", `> *quoting* ${r.quoted.replace(/\n+/g, " ")}`);
  md.push("", "**Column 1**", "", txt(c1), "", "**Column 2**", "", txt(c2), "", "**Post:** ___  **Edit needed:** ___  **Factual issues:** ___", "", "---", "");
}
md.push("## Part B: fresh posts");
for (const r of results.filter((x) => x.fresh)) {
  n += 1;
  md.push(`### ${n}. @${r.author} · ${r.theme}`, "", `> ${r.text.replace(/\n+/g, "\n> ")}`); if (r.quoted) md.push(">", `> *quoting* ${r.quoted.replace(/\n+/g, " ")}`);
  md.push("", "**Reply**", "", txt(r), "", "**Post:** yes / no  **Edit needed:** ___  **Factual issues:** ___", "", "---", "");
}
writeFileSync(join(OUT, "blind-round5.md"), md.join("\n"));
writeFileSync(join(OUT, "key-round5.json"), JSON.stringify(key, null, 2));
console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
