import "../../../scripts/load-env.mjs";
import { writeFileSync } from "node:fs";
import { buildRuntime, parseFlags } from "../src/cli/bootstrap.js";
import { buildReasonSystemPrompt } from "../src/pipeline/stages/reason.js";
import { buildDraftSystemPrompt } from "../src/pipeline/stages/draft.js";
import { buildVerifySystemPrompt } from "../src/pipeline/stages/verify.js";
const OUT = "/private/tmp/claude-501/-Users-uditbhansali-Desktop-Chime-In/6da9911a-f570-42ac-8bf8-3b03ad28adff/scratchpad/exp";
const rt = await buildRuntime({ ...parseFlags([]), dryRun: true }, { needWatchlist: false });
const wc = (s: string) => s.trim().split(/\s+/).length;
for (const profile of ["baseline", "candidate"] as const) {
  const r = buildReasonSystemPrompt({ digest: rt.digest, experienceIndex: rt.experienceIndex, boundaries: rt.kb.constraints, policy: rt.policy, authorPriority: 2, profile });
  const d = buildDraftSystemPrompt(rt.kb.tone, rt.config.replyMaxChars, { boundaries: rt.kb.constraints, policy: rt.policy, profile });
  const v = buildVerifySystemPrompt(profile);
  writeFileSync(`${OUT}/prompt-${profile}-reasoner.txt`, r); writeFileSync(`${OUT}/prompt-${profile}-drafter.txt`, d); writeFileSync(`${OUT}/prompt-${profile}-verifier.txt`, v);
  console.log(profile, "reasoner", wc(r), "drafter", wc(d), "verifier", wc(v));
}
