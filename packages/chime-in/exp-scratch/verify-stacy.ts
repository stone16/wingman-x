/** Verifier behaviour on the actual Stacy failure: same claim at four confidence levels, current verifier vs widened causal definition, two samples each. */
import "../../../scripts/load-env.mjs";
import { readFileSync } from "node:fs";
import { buildRuntime, parseFlags } from "../src/cli/bootstrap.js";
import { NormalizedPostSchema } from "../src/model/post.js";
import { buildVerifySystemPrompt, buildVerifyPrompt, VerifyResultSchema, judge } from "../src/pipeline/stages/verify.js";
const OUT = "/private/tmp/claude-501/-Users-uditbhansali-Desktop-Chime-In/6da9911a-f570-42ac-8bf8-3b03ad28adff/scratchpad/exp";
const rows = readFileSync(`${OUT}/posts.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const post = NormalizedPostSchema.parse(rows.find((r) => r.post.author_handle === "stacy_muur").post);
const rt = await buildRuntime({ ...parseFlags([]), dryRun: true }, { needWatchlist: false });
const OLD = `causal (why a specific named thing happened or will happen, stated as fact: \\"people muted because there was no human\\")`;
const NEW = `causal (why a specific named thing happened or will happen, OR why the people in the post's story such as its audience, users, readers, or customers behaved or will behave, stated as fact rather than as the author's own account or the writer's read: \\"people muted because there was no human\\")`;
const base = buildVerifySystemPrompt();
if (!base.includes(OLD.replace(/\\"/g, '"'))) throw new Error("causal definition text not found");
const widened = base.replace(OLD.replace(/\\"/g, '"'), NEW.replace(/\\"/g, '"'));
const TEXTS: Record<string, string> = {
  A_assertion: "The part that stands out is that it cleared your own quality bar and still died. Nobody was grading the writing, they were checking whether anyone was on the hook for it, and a pipeline can't be on the hook.",
  B_my_read: "The part that stands out is that it cleared your own quality bar and still died. My read is that nobody was grading the writing, they were checking whether anyone was on the hook for it.",
  C_tentative_question: "The part that stands out is that it cleared your own quality bar and still died. Do you think they were reacting to the writing, or to nobody being on the hook for it?",
  D_attributed_to_author: "Your read that people mute humanless content squares with the cheap cost per subscriber: joining was the one step the engine could buy.",
};
for (const [variant, system] of [["current", base], ["widened", widened]] as const) {
  for (const [name, text] of Object.entries(TEXTS)) {
    for (const s of [1, 2]) {
      const res = await rt.llm.complete({ tier: "cheap", system, prompt: buildVerifyPrompt(text, { post, chunks: [] }), schema: VerifyResultSchema, label: `vtest:${variant}:${name}:${s}`, maxTokens: 600 });
      const v = judge(res);
      console.log(`${variant.padEnd(8)} ${name.padEnd(24)} s${s} → ${v.status.padEnd(11)} ${res.specifics.map((x) => `[${x.kind}/${x.support}] ${x.claim.slice(0, 70)}`).join(" | ") || "(no specifics)"}`);
    }
  }
}
