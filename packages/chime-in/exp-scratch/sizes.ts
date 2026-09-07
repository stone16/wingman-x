import "../../../scripts/load-env.mjs";
import { buildRuntime, parseFlags } from "../src/cli/bootstrap.js";
import { buildReasonSystemPrompt } from "../src/pipeline/stages/reason.js";
import { buildDraftSystemPrompt } from "../src/pipeline/stages/draft.js";
import { buildVerifySystemPrompt } from "../src/pipeline/stages/verify.js";
import { selectSections } from "../src/kb/sections.js";
const wc = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const rt = await buildRuntime({ ...parseFlags([]), dryRun: true }, { needWatchlist: false });
for (const profile of ["baseline", "candidate"] as const) {
  const rc = buildReasonSystemPrompt({ digest: "", experienceIndex: "", boundaries: "", policy: "", profile });
  const dc = buildDraftSystemPrompt("", 1000, { profile });
  const rb = profile === "candidate" ? selectSections(rt.kb.constraints, ["Who is speaking", "Confidentiality", "Facts and verification", "Diplomatic floor", "Lane discipline"]) : rt.kb.constraints;
  const rp = profile === "candidate" ? selectSections(rt.policy ?? "", ["North star", "Reply types", "Rules"]) : rt.policy ?? "";
  const db = profile === "candidate" ? selectSections(rt.kb.constraints, ["Confidentiality", "Facts and verification"]) : rt.kb.constraints;
  const tone = profile === "candidate" ? rt.kb.tone.replace(/^## Choosing what to say[\s\S]*?(?=^## )/m, "") : rt.kb.tone;
  console.log(`${profile}: reasoner rules ${wc(rc)} | digest ${wc(rt.digest)} | index ${wc(rt.experienceIndex)} | identity ${wc(rb)} | policy ${wc(rp)}`);
  console.log(`${profile}: drafter rules ${wc(dc)} | tone ${wc(tone)} | identity ${wc(db)} | policy ${profile === "candidate" ? 0 : wc(rt.policy ?? "")} | verifier ${wc(buildVerifySystemPrompt(profile))}`);
}
const t = rt.kb.tone; const ex = (t.match(/^> /gm) || []).length; const exWords = wc((t.match(/^(Post by[^\n]*\n)?> [^\n]*/gm) || []).join(" "));
console.log(`tone.md: ${wc(t)} words, ${ex} example replies, examples+parents ${exWords} words, rules/prose ${wc(t) - exWords}`);
