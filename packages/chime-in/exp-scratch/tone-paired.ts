/** Paired drafter comparison: each post reasoned ONCE (candidate), grounded once, then drafted twice from the identical
 *  arguments, differing only in tone loading (whole tone.md vs progressive). Removes reasoner randomness from the comparison. */
import "../../../scripts/load-env.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRuntime, parseFlags } from "../src/cli/bootstrap.js";
import { NormalizedPostSchema, type NormalizedPost } from "../src/model/post.js";
import { classifyThemes } from "../src/pipeline/stages/theme.js";
import { reasonAboutPost } from "../src/pipeline/stages/reason.js";
import { resolveGrounding } from "../src/pipeline/ground.js";
import { draftReply } from "../src/pipeline/stages/draft.js";
const OUT = "/private/tmp/claude-501/-Users-uditbhansali-Desktop-Chime-In/6da9911a-f570-42ac-8bf8-3b03ad28adff/scratchpad/exp";
const rt = await buildRuntime({ ...parseFlags([]), dryRun: true }, { needWatchlist: true });
const config = { ...rt.config, promptProfile: "candidate" as const };
const load = (f: string, fresh: boolean) => readFileSync(join(OUT, f), "utf8").trim().split("\n").map((l) => { const o = JSON.parse(l); return { post: NormalizedPostSchema.parse(o.post ?? o), fresh }; });
const rows = [...load("posts.jsonl", false), ...load("posts-fresh.jsonl", true), ...load("posts-finance5.jsonl", true)];
const posts = rows.map((r) => r.post);
const byHandle = new Map(rt.watchlist.map((a: any) => [a.handle.toLowerCase(), a]));
const themes = await classifyThemes(posts, { llm: rt.llm, themes: rt.themes, conversationalThemes: rt.policy ? config.conversationalThemes : [], batchSize: config.themeBatchSize, concurrency: config.llmConcurrency, log: () => {} });
const out: any[] = [];
const pool = <T, R>(xs: T[], n: number, fn: (x: T, i: number) => Promise<R>) => { let i = 0; const res: R[] = []; return Promise.all(Array.from({ length: n }, async () => { while (i < xs.length) { const k = i++; res[k] = await fn(xs[k]!, k); } })).then(() => res); };
const t0 = Date.now();
const results = await pool(rows, config.llmConcurrency, async ({ post, fresh }) => {
  const th = themes.get(post.tweet_id);
  const base = { tweet_id: post.tweet_id, author: post.author_handle, fresh, text: post.tweet_text, quoted: post.quoted_tweet ? `@${post.quoted_tweet.author_handle}: ${post.quoted_tweet.tweet_text}` : undefined };
  if (!th || !th.ok) return { ...base, theme: "?", decision: "error", skip_reason: "theme failed" };
  const theme = th.result.theme;
  if (!th.result.relevant || th.result.theme_score < config.themeThreshold) return { ...base, theme, decision: "skip", skip_reason: `theme ${th.result.theme_score} < ${config.themeThreshold}` };
  const account = byHandle.get(post.author_handle.toLowerCase()) ?? { handle: post.author_handle, priority: 2 };
  let r; try { r = await reasonAboutPost(post, theme, { digest: rt.digest ?? "", experienceIndex: rt.experienceIndex ?? "", boundaries: rt.kb.constraints, policy: rt.policy, profile: "candidate", authorPriority: account.priority }, { llm: rt.llm }); } catch (e) { return { ...base, theme, decision: "error", skip_reason: String(e).slice(0, 200) }; }
  const casual = ["light_reaction", "irony", "thinking_out_loud"].includes(r.move);
  const bar = config.worthThreshold + (account.priority === 3 && casual ? 10 : 0);
  if (r.move === "none" || r.worth < bar) return { ...base, theme, decision: "skip", skip_reason: r.move === "none" ? `move none (${r.worth}): ${r.reason}` : `worth ${r.worth} < ${bar}: ${r.reason}` };
  const g = await resolveGrounding(r, post, theme, { kb: rt.kb, facts: rt.facts, factCachePath: rt.factCachePath, topK: config.kbTopK, llm: rt.llm });
  const depth = r.depth === "deep" && [...post.tweet_text].length < 100 ? "substantive" : r.depth;
  const common = { post, theme, angle: r.angle, authorPoint: r.author_point, chunks: g.chunks, tone: rt.kb.tone, digest: rt.digest, boundaries: rt.kb.constraints, policy: rt.policy, profile: "candidate" as const, maxChars: config.replyMaxChars, move: r.move, depth, posture: r.posture, energy: r.energy, experience: g.experience, fact: g.fact, unresolved: g.unresolved, llm: rt.llm };
  const one = async (toneLoading: "whole" | "progressive") => { try { const d = await draftReply({ ...common, toneLoading }); return { decision: "reply", reply: d.suggested_reply, flags: d.ai_tell_flags ?? [], angle_problem: d.angleProblem }; } catch (e) { return { decision: "error", skip_reason: String(e).slice(0, 200) }; } };
  const [W, P] = await Promise.all([one("whole"), one("progressive")]);
  return { ...base, theme, decision: "reply", reason: { worth: r.worth, move: r.move, depth, posture: r.posture, angle: r.angle, grounding: r.grounding }, W, P };
});
console.log(`paired run: ${Math.round((Date.now() - t0) / 1000)}s`);
writeFileSync(join(OUT, "results-tone-paired.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log("done");
