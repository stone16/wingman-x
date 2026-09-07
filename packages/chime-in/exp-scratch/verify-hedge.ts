/** Candidate verifier on six texts: assertion, hedged motive, question, attributed-to-author, hedged mechanism opinion, hedged motive with "I suspect". Two samples each. */
import "../../../scripts/load-env.mjs";
import { readFileSync } from "node:fs";
import { buildRuntime, parseFlags } from "../src/cli/bootstrap.js";
import { NormalizedPostSchema } from "../src/model/post.js";
import { buildVerifySystemPrompt, buildVerifyPrompt, VerifyResultSchema, judge } from "../src/pipeline/stages/verify.js";
const OUT = "/private/tmp/claude-501/-Users-uditbhansali-Desktop-Chime-In/6da9911a-f570-42ac-8bf8-3b03ad28adff/scratchpad/exp";
const rows = readFileSync(`${OUT}/posts.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const stacy = NormalizedPostSchema.parse(rows.find((r) => r.post.author_handle === "stacy_muur").post);
const maple = NormalizedPostSchema.parse(rows.find((r) => r.post.author_handle === "maplefinance").post);
const rt = await buildRuntime({ ...parseFlags([]), dryRun: true }, { needWatchlist: false });
const TEXTS: Array<[string, string, typeof stacy, "flag" | "pass"]> = [
  ["M1_repaired_question", "Is the 5% cap sized to loss tolerance or to redemption liquidity? Curious how the maturity profile on these lines up with how deposits come out.", maple, "pass"],
  ["M2_presupposing", "Why does this vault block withdrawals once the sleeve is at cap?", maple, "flag"],
  ["M3_asserted_terms", "These strategies have terms and the deposits don't, so the 5% cap is doing the liquidity work.", maple, "flag"],
  ["M4_open_how", "How do the direct lending and securitization sleeves line up against depositor withdrawals?", maple, "pass"],
  ["S1_repair_swapped", "The v2 split is the pattern I keep seeing everywhere, AI upstream on sourcing and fit, and the published part stays human.", stacy, "flag"],
  ["S2_plain_ack", "The v2 split makes sense to me, AI upstream on sourcing and fit, with the published part still yours.", stacy, "pass"],
];
for (const [name, text, post, expected] of TEXTS) for (const s of [1, 2]) {
  const res = await rt.llm.complete({ tier: "cheap", system: buildVerifySystemPrompt("candidate"), prompt: buildVerifyPrompt(text, { post, chunks: [] }), schema: VerifyResultSchema, label: `vhedge:${name}:${s}`, maxTokens: 600 });
  const v = judge(res);
  const ok = (expected === "flag") === (v.status === "unsupported");
  console.log(`${ok ? "OK " : "MISS"} ${name.padEnd(20)} s${s} → ${v.status.padEnd(11)} ${res.specifics.map((x) => `[${x.kind}/${x.support}] ${x.claim.slice(0, 60)}`).join(" | ") || "(no specifics)"}`);
}
