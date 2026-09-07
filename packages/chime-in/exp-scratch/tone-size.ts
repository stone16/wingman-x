import { readFileSync } from "node:fs";
import { toneForDraft } from "../src/kb/tone-select.js";
import { buildDraftSystemPrompt } from "../src/pipeline/stages/draft.js";
const tone = readFileSync(`${process.env.HOME}/.wingman-x/kb/tone.md`, "utf8");
const w = (s: string) => s.split(/\s+/).filter(Boolean).length;
console.log("tone.md words", w(tone));
for (const m of ["distinction", "agree_extend", "light_reaction", "challenge", "question", "thinking_out_loud", "example", undefined] as const) {
  const t = toneForDraft(tone, m as any);
  console.log(String(m).padEnd(18), "tone words", String(w(t.text)).padStart(5), "examples:", t.examples.join(" | "));
}
console.log("drafter system, candidate, distinction:", w(buildDraftSystemPrompt(tone, 280, { profile: "candidate", move: "distinction" })), "words");
console.log("drafter system, candidate, whole tone (before):", w(buildDraftSystemPrompt(tone, 280, { profile: "candidate" }).replace(/x/g, "x")), "words (no move = no borrowed exchanges)");
console.log("drafter system, baseline:", w(buildDraftSystemPrompt(tone, 280, {})), "words");
