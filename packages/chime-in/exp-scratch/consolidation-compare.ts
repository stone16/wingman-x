/** Candidate (consolidated prompt profile) vs baseline (production) under scan conditions: watchlist priority, no mustReply, skipping allowed. 20 regression + 11 fresh posts. */
import "../../../scripts/load-env.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRuntime, parseFlags } from "../src/cli/bootstrap.js";
import { NormalizedPostSchema, type NormalizedPost } from "../src/model/post.js";
import { buildReasonSystemPrompt, ReasonResultSchema } from "../src/pipeline/stages/reason.js";
import { renderPost } from "../src/pipeline/prompts.js";
import { resolveGrounding } from "../src/pipeline/ground.js";
import { draftReply } from "../src/pipeline/stages/draft.js";
import type { LLMProvider } from "../src/llm/provider.js";
const OUT = "/private/tmp/claude-501/-Users-uditbhansali-Desktop-Chime-In/6da9911a-f570-42ac-8bf8-3b03ad28adff/scratchpad/exp";
const UNUSED_MOTIVE = "Do not assert why the author's audience, users, customers, or counterparties behaved or will behave unless the post states it. If the point depends on that, ask it as a question or say it as your read.";
const CAUSAL_OLD = `causal (why a specific named thing happened or will happen, stated as fact: "people muted because there was no human")`;
const CAUSAL_NEW = `causal (why a specific named thing happened or will happen, OR why the people in the post's story such as its audience, users, readers, or customers behaved or will behave, stated as fact rather than as the author's own account or the writer's read: "people muted because there was no human")`;
const rt = await buildRuntime({ ...parseFlags([]), dryRun: true }, { needWatchlist: true });
const prio = new Map(rt.watchlist.map((w) => [w.handle.toLowerCase(), w.priority] as const));
const load = (f: string, fresh: boolean) => readFileSync(join(OUT, f), "utf8").trim().split("\n").map((l) => { const o = JSON.parse(l); return { post: NormalizedPostSchema.parse(o.post) as NormalizedPost, theme: o.theme_hint as string, fresh }; });
const rows = [...load("posts.jsonl", false), ...load("posts-fresh.jsonl", true), ...load("posts-finance5.jsonl", true)];
async function run(build: "A" | "B", row: typeof rows[number]) {
  const priority = (prio.get(row.post.author_handle.toLowerCase()) ?? 2) as 1 | 2 | 3;
  const profile = build === "A" ? "baseline" as const : "candidate" as const;
  const llm: LLMProvider = rt.llm;
  const system = buildReasonSystemPrompt({ digest: rt.digest, experienceIndex: rt.experienceIndex, boundaries: rt.kb.constraints, policy: rt.policy, authorPriority: priority, profile });
  const reason = await rt.llm.complete({ tier: "strong", system, prompt: [renderPost(row.post), "", `Theme (discovery label only; it does not decide the kind of reply): ${row.theme}`, `Author priority: ${priority}`, "", "Decide. Return the JSON."].join("\n"), schema: ReasonResultSchema, label: `${build}-reason:${row.post.tweet_id}`, maxTokens: 700 });
  const casual = ["light_reaction", "irony", "thinking_out_loud"].includes(reason.move);
  const bar = rt.config.worthThreshold + (priority === 3 && casual ? 10 : 0);
  const skip = reason.move === "none" || reason.worth < bar;
  const base = { priority, worth: reason.worth, move: reason.move, depth: reason.depth, angle: reason.angle, author_point: reason.author_point, why: reason.reason };
  if (skip) return { ...base, decision: "skip" as const, skip_reason: reason.move === "none" ? `move none: ${reason.reason}` : `worth ${reason.worth} < ${bar}` };
  const g = await resolveGrounding(reason, row.post, row.theme, { kb: rt.kb, facts: rt.facts, topK: rt.config.kbTopK, llm: rt.llm });
  const d = await draftReply({ post: row.post, theme: row.theme, angle: reason.angle, authorPoint: reason.author_point, chunks: g.chunks, tone: rt.kb.tone, boundaries: rt.kb.constraints, policy: rt.policy, maxChars: rt.config.replyMaxChars, move: reason.move, depth: reason.depth === "deep" && [...row.post.tweet_text].length < 100 ? "substantive" : reason.depth, posture: reason.posture, energy: reason.energy, experience: g.experience, fact: g.fact, unresolved: g.unresolved, profile, llm });
  return { ...base, decision: "reply" as const, reply: d.suggested_reply, flags: d.ai_tell_flags, kb_files: [...new Set(g.chunks.map((c) => c.file))] };
}
async function mapC<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> { const out: R[] = new Array(items.length); let next = 0; await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!, i); } })); return out; }
const t0 = Date.now();
const results = await mapC(rows, 3, async (row, i) => {
  const [A, B] = await Promise.all([run("A", row).catch((e) => ({ error: (e as Error).message })), run("B", row).catch((e) => ({ error: (e as Error).message }))]);
  console.log(`${i + 1}/${rows.length} @${row.post.author_handle} A:${(A as any).decision ?? "err"} B:${(B as any).decision ?? "err"} (${Math.round((Date.now() - t0) / 1000)}s)`);
  return { tweet_id: row.post.tweet_id, author: row.post.author_handle, theme: row.theme, fresh: row.fresh, text: row.post.tweet_text, quoted: row.post.quoted_tweet ? `@${row.post.quoted_tweet.author_handle}: ${row.post.quoted_tweet.text}` : null, A, B };
});
writeFileSync(join(OUT, "results-consolidation5.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
// Blind file: decisions table first (not blind: which build skipped is hidden as X/Y), then replies.
const key: Record<string, { col1: "A" | "B"; col2: "A" | "B" }> = {};
const md = ["# Updated candidate vs updated baseline (2026-09-07, after the follow-up review): 20 regression posts + 11 fresh", "", "Both builds ran with watchlist priorities and were allowed to skip. Column order is random per post and consistent between the decisions table and the reply sections.", "", "## Decisions", "", "| # | Post | Column 1 | Column 2 |", "|---|---|---|---|"];
results.forEach((r, i) => {
  const flip = Math.random() < 0.5; key[r.tweet_id] = { col1: flip ? "B" : "A", col2: flip ? "A" : "B" };
  const c1 = flip ? r.B : r.A, c2 = flip ? r.A : r.B;
  const d = (x: any) => x.error ? "error" : x.decision === "skip" ? "skip" : "reply";
  md.push(`| ${i + 1} | @${r.author}${r.fresh ? " (fresh)" : ""} | ${d(c1)} | ${d(c2)} |`);
});
md.push("", "Score decisions separately: for each post, was replying right, was skipping right?", "", "## Replies", "");
results.forEach((r, i) => {
  const k = key[r.tweet_id]!; const c1 = k.col1 === "A" ? r.A : r.B, c2 = k.col2 === "A" ? r.A : r.B;
  const txt = (x: any) => x.error ? `(failed: ${x.error})` : x.decision === "skip" ? `_(skipped: ${x.skip_reason.slice(0, 160)})_` : x.reply + (x.flags?.length ? `\n\n_flags: ${x.flags.join("; ")}_` : "");
  md.push(`### ${i + 1}. @${r.author} · ${r.theme}${r.fresh ? " · fresh" : ""}`, "", `> ${r.text.replace(/\n+/g, "\n> ")}`); if (r.quoted) md.push(">", `> *quoting* ${r.quoted.replace(/\n+/g, " ")}`);
  md.push("", "**Column 1**", "", txt(c1), "", "**Column 2**", "", txt(c2), "", "**Post:** 1 / 2 / both / neither  **Edit needed:** ___  **Factual issues:** ___", "", "---", "");
});
writeFileSync(join(OUT, "blind-consolidation5.md"), md.join("\n")); writeFileSync(join(OUT, "key-consolidation5.json"), JSON.stringify(key, null, 2));
console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
