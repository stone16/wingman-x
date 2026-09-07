import "../../../scripts/load-env.mjs";
import { buildRuntime, parseFlags } from "../src/cli/bootstrap.js";
import { buildReasonSystemPrompt } from "../src/pipeline/stages/reason.js";
import { buildDraftSystemPrompt } from "../src/pipeline/stages/draft.js";
import { buildVerifySystemPrompt } from "../src/pipeline/stages/verify.js";
const wc = (s: string) => s.trim() ? s.trim().split(/\s+/).length : 0;
const rt = await buildRuntime({ ...parseFlags([]), dryRun: true }, { needWatchlist: false });
const reasonCode = buildReasonSystemPrompt({ digest: "", experienceIndex: "", boundaries: "", policy: "", authorPriority: 2 });
const reasonFull = buildReasonSystemPrompt({ digest: rt.digest, experienceIndex: rt.experienceIndex, boundaries: rt.kb.constraints, policy: rt.policy, authorPriority: 2 });
const draftCode = buildDraftSystemPrompt("", 1000, {});
const draftFull = buildDraftSystemPrompt(rt.kb.tone, 1000, { boundaries: rt.kb.constraints, policy: rt.policy });
console.log(JSON.stringify({
  reasoner: { total: wc(reasonFull), code_rules: wc(reasonCode), digest: wc(rt.digest), experience_index: wc(rt.experienceIndex), boundaries: wc(rt.kb.constraints), policy: wc(rt.policy) },
  drafter: { total: wc(draftFull), code_rules: wc(draftCode), tone: wc(rt.kb.tone), boundaries: wc(rt.kb.constraints), policy: wc(rt.policy) },
  verifier: { total: wc(buildVerifySystemPrompt()) },
  shared_in_both: { boundaries: wc(rt.kb.constraints), policy: wc(rt.policy) },
}, null, 1));
