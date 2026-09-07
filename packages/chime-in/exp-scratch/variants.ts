/** Controlled comparison: reasoner instruction variants, everything else fixed (post, priority, drafter, verifier). Scan configuration (no mustReply). */
import "../../../scripts/load-env.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRuntime, parseFlags } from "../src/cli/bootstrap.js";
import { NormalizedPostSchema, type NormalizedPost } from "../src/model/post.js";
import { buildReasonSystemPrompt, ReasonResultSchema } from "../src/pipeline/stages/reason.js";
import { renderPost } from "../src/pipeline/prompts.js";
import { resolveGrounding } from "../src/pipeline/ground.js";
import { draftReply } from "../src/pipeline/stages/draft.js";
const OUT = "/private/tmp/claude-501/-Users-uditbhansali-Desktop-Chime-In/6da9911a-f570-42ac-8bf8-3b03ad28adff/scratchpad/exp";
const CASES: Array<{ id: string; priority: 1 | 2 | 3 }> = [
  { id: "2095839043565048083", priority: 2 }, { id: "2095192834039267738", priority: 2 }, { id: "2095137809598410844", priority: 2 }, { id: "2095780156757656035", priority: 1 },
];
const AGREE_OLD = `agree_extend: the author is basically right, and you add a consequence or implication they did not draw. No correction.`;
const AGREE_NEW = `agree_extend: the author is basically right, and you say so with one thing they would want to hear back: a consequence you can actually support, a question about the next step, or a plain acknowledgment tied to one specific in their post. No correction. Do not invent an implication the post does not support; if there is none, the acknowledgment is the reply.`;
const COUNT_OLD = `Generic agreement, praise, restating the post, or a manufactured correction do not count.`;
const COUNT_NEW = `Empty praise and manufactured corrections do not count. Plain agreement or acknowledgment counts when it is what the person would actually post.`;
const FIT_LINE = `Test it: would this angle fit just as well under a different post on the same theme? If yes, it is generic. Find the one that only makes sense here, or choose a lighter move.`;
const VARIANTS: Record<string, (s: string) => string> = {
  V0_current: (s) => s,
  V1_agree_redefined: (s) => s.replace(AGREE_OLD, AGREE_NEW).replace(COUNT_OLD, COUNT_NEW),
  V2_V1_plus_no_fit_test: (s) => s.replace(AGREE_OLD, AGREE_NEW).replace(COUNT_OLD, COUNT_NEW).replace(FIT_LINE, ""),
};
const rt = await buildRuntime({ ...parseFlags([]), dryRun: true }, { needWatchlist: false });
const rows = readFileSync(join(OUT, "posts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const base = buildReasonSystemPrompt({ digest: rt.digest, experienceIndex: rt.experienceIndex, boundaries: rt.kb.constraints, policy: rt.policy, authorPriority: 2 });
for (const [name, fn] of Object.entries(VARIANTS)) if (name !== "V0_current" && fn(base) === base) throw new Error(`${name} changed nothing`);
const results: any[] = [];
const jobs: Array<() => Promise<void>> = [];
for (const c of CASES) for (const [variant, fn] of Object.entries(VARIANTS)) for (const sample of [1, 2]) {
  jobs.push(async () => {
    const row = rows.find((r) => r.post.tweet_id === c.id)!; const post: NormalizedPost = NormalizedPostSchema.parse(row.post);
    const system = fn(buildReasonSystemPrompt({ digest: rt.digest, experienceIndex: rt.experienceIndex, boundaries: rt.kb.constraints, policy: rt.policy, authorPriority: c.priority }));
    const reason = await rt.llm.complete({ tier: "strong", system, prompt: [renderPost(post), "", `Theme (discovery label only; it does not decide the kind of reply): ${row.theme_hint}`, `Author priority: ${c.priority}`, "", "Decide. Return the JSON."].join("\n"), schema: ReasonResultSchema, label: `${variant}-reason:${c.id}:${sample}`, maxTokens: 700 });
    let reply: string | null = null; let flags: string[] = [];
    if (sample === 1 && reason.move !== "none" && reason.worth >= rt.config.worthThreshold) {
      const g = await resolveGrounding(reason, post, row.theme_hint, { kb: rt.kb, facts: rt.facts, topK: rt.config.kbTopK, llm: rt.llm });
      const d = await draftReply({ post, theme: row.theme_hint, angle: reason.angle, authorPoint: reason.author_point, chunks: g.chunks, tone: rt.kb.tone, boundaries: rt.kb.constraints, policy: rt.policy, maxChars: rt.config.replyMaxChars, move: reason.move, depth: reason.depth, posture: reason.posture, energy: reason.energy, experience: g.experience, fact: g.fact, unresolved: g.unresolved, llm: rt.llm });
      reply = d.suggested_reply; flags = d.ai_tell_flags;
    }
    results.push({ author: post.author_handle, variant, sample, worth: reason.worth, move: reason.move, author_point: reason.author_point, angle: reason.angle, reason: reason.reason, reply, flags });
    console.log(`@${post.author_handle} ${variant} s${sample}: worth ${reason.worth} ${reason.move} | ${reason.angle}`);
  });
}
let next = 0; await Promise.all(Array.from({ length: 4 }, async () => { while (next < jobs.length) { const i = next++; await jobs[i]!(); } }));
writeFileSync(join(OUT, "variants.json"), JSON.stringify(results, null, 1));
console.log("written variants.json");
