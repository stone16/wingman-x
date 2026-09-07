import "../../../scripts/load-env.mjs";
import { readFileSync } from "node:fs";
import { buildRuntime, parseFlags } from "../src/cli/bootstrap.js";
import { buildReasonSystemPrompt } from "../src/pipeline/stages/reason.js";
import { buildDraftSystemPrompt } from "../src/pipeline/stages/draft.js";
import { buildVerifySystemPrompt } from "../src/pipeline/stages/verify.js";
const rt = await buildRuntime({ ...parseFlags([]), dryRun: true }, { needWatchlist: false });
const w = (s: string) => s.split(/\s+/).filter(Boolean).length;
const tone = readFileSync(`${process.env.HOME}/.wingman-x/kb/tone.md`, "utf8");
const identity = rt.kb.constraints ?? "";
const row = (n: string, a: number, b: number) => console.log(n.padEnd(46), String(a).padStart(6), String(b).padStart(6), (Math.round((1 - b / a) * 100) + "%").padStart(6));
console.log("".padEnd(46), "before", " after", " saved");
for (const theme of ["Tokenization and market structure", "Technology and startups"]) {
  const base = buildReasonSystemPrompt({ digest: rt.digest, experienceIndex: rt.experienceIndex, boundaries: identity, theme });
  const cand = buildReasonSystemPrompt({ digest: rt.digest, experienceIndex: rt.experienceIndex, boundaries: identity, profile: "candidate", theme });
  row(`reasoner system · ${theme.slice(0, 26)}`, w(base), w(cand));
}
const dBase = buildDraftSystemPrompt(tone, 1000, { digest: rt.digest, boundaries: identity, policy: rt.policy });
for (const move of ["distinction", "question", "light_reaction"] as const) row(`drafter system · ${move}`, w(dBase), w(buildDraftSystemPrompt(tone, 1000, { boundaries: identity, policy: rt.policy, profile: "candidate", move })));
row("verifier system", w(buildVerifySystemPrompt("baseline")), w(buildVerifySystemPrompt("candidate")));
console.log("\nfile sizes (words): tone", w(tone), "digest", w(rt.digest), "experience", w(rt.experienceIndex), "identity", w(identity));
