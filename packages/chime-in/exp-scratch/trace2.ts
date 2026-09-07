/** Investigation harness. For each post: full traces under the scan configuration (watchlist priority, no mustReply) and the link configuration (priority 1, mustReply). Every model call captured. */
import "../../../scripts/load-env.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRuntime, parseFlags } from "../src/cli/bootstrap.js";
import { NormalizedPostSchema, type NormalizedPost } from "../src/model/post.js";
import { reasonAboutPost } from "../src/pipeline/stages/reason.js";
import { resolveGrounding } from "../src/pipeline/ground.js";
import { draftReply } from "../src/pipeline/stages/draft.js";
import type { LLMProvider } from "../src/llm/provider.js";
const OUT = "/private/tmp/claude-501/-Users-uditbhansali-Desktop-Chime-In/6da9911a-f570-42ac-8bf8-3b03ad28adff/scratchpad/exp";
const CASES: Array<{ id: string; priority: 1 | 2 | 3 }> = [
  { id: "2095839043565048083", priority: 2 }, // mzeller
  { id: "2095192834039267738", priority: 2 }, // maple
  { id: "2095137809598410844", priority: 2 }, // frambot / bitwise
  { id: "2095780156757656035", priority: 1 }, // stacy
];
const rt = await buildRuntime({ ...parseFlags([]), dryRun: true }, { needWatchlist: false });
const rows = readFileSync(join(OUT, "posts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const out: any[] = [];
for (const c of CASES) {
  const row = rows.find((r) => r.post.tweet_id === c.id)!;
  const post: NormalizedPost = NormalizedPostSchema.parse(row.post);
  for (const mode of ["scan", "link"] as const) {
    const calls: any[] = [];
    const llm: LLMProvider = { ...rt.llm, complete: async (req) => { const res = await rt.llm.complete(req); calls.push({ label: req.label, tier: req.tier, system: req.system, prompt: req.prompt, response: res }); return res; } };
    const ctx = { digest: rt.digest, experienceIndex: rt.experienceIndex, boundaries: rt.kb.constraints, policy: rt.policy, authorPriority: mode === "scan" ? c.priority : (1 as const), ...(mode === "link" ? { mustReply: true } : {}) };
    const reason = await reasonAboutPost(post, row.theme_hint, ctx, { llm });
    const move = reason.move === "none" ? "light_reaction" : reason.move;
    const casual = ["light_reaction", "irony", "thinking_out_loud"].includes(move);
    const bar = rt.config.worthThreshold + (c.priority === 3 && casual ? 10 : 0);
    const gated = mode === "scan" && (reason.move === "none" || reason.worth < bar);
    const r = { ...reason, move } as typeof reason;
    const g = await resolveGrounding(r, post, row.theme_hint, { kb: rt.kb, facts: rt.facts, topK: rt.config.kbTopK, llm: rt.llm });
    const depth = r.depth === "deep" && [...post.tweet_text].length < 100 ? "substantive" : r.depth;
    let draft: any = null;
    if (!gated) {
      draft = await draftReply({ post, theme: row.theme_hint, angle: r.angle, authorPoint: r.author_point, chunks: g.chunks, tone: rt.kb.tone, digest: rt.digest, boundaries: rt.kb.constraints, policy: rt.policy, maxChars: rt.config.replyMaxChars, move, depth, posture: r.posture, energy: r.energy, experience: g.experience, fact: g.fact, unresolved: g.unresolved, llm });
    }
    out.push({ id: c.id, author: post.author_handle, mode, priority: ctx.authorPriority, mustReply: mode === "link", gated, bar, reason, grounding: { chunks: g.chunks.map((k) => ({ ref: k.ref, text: k.text })), experience: g.experience, fact: g.fact, unresolved: g.unresolved }, draft, calls });
    console.log(`@${post.author_handle} ${mode}: worth ${reason.worth} move ${reason.move} depth ${reason.depth} gated=${gated} chunks=${g.chunks.length} calls=${calls.length}${draft ? ` | ${draft.suggested_reply}` : ""}`);
  }
}
writeFileSync(join(OUT, "traces-baseline-scan-and-link-4posts.json"), JSON.stringify(out, null, 1));
console.log("written traces2.json");
