/** Experiment only. Full traces (every model call: system, prompt, response) for three posts through the production path. */
import "../../../scripts/load-env.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRuntime, parseFlags } from "../src/cli/bootstrap.js";
import { runSinglePost } from "../src/pipeline/single.js";
import { createMemoryCandidateLog } from "../src/state/candidate-log.js";
import { NormalizedPostSchema } from "../src/model/post.js";
import type { LLMProvider } from "../src/llm/provider.js";
const OUT = "/private/tmp/claude-501/-Users-uditbhansali-Desktop-Chime-In/6da9911a-f570-42ac-8bf8-3b03ad28adff/scratchpad/exp";
const IDS = ["2095780156757656035", "2095244995976397237", "2096442797134028834"]; // stacy, aave, signulll (fresh 26)
const rt = await buildRuntime({ ...parseFlags([]), dryRun: true }, { needWatchlist: false });
const rows = [...readFileSync(join(OUT, "posts.jsonl"), "utf8").trim().split("\n"), ...readFileSync(join(OUT, "posts-fresh.jsonl"), "utf8").trim().split("\n")].map((l) => JSON.parse(l));
const md: string[] = ["# Traces: every model call for three posts (deployed build)", ""];
for (const id of IDS) {
  const row = rows.find((r) => r.post.tweet_id === id) ?? rows.find((r) => r.post.author_handle === "signulll");
  if (!row) { md.push(`## ${id}: not found`); continue; }
  const post = NormalizedPostSchema.parse(row.post);
  const calls: Array<{ label: string; tier: string; system: string; prompt: string; response: unknown }> = [];
  const llm: LLMProvider = { ...rt.llm, complete: async (req) => { const res = await rt.llm.complete(req); calls.push({ label: req.label, tier: req.tier, system: req.system, prompt: req.prompt, response: res }); return res; } };
  const r = await runSinglePost(post, { config: rt.config, llm, kb: rt.kb, themes: rt.themes, policy: rt.policy, digest: rt.digest, experienceIndex: rt.experienceIndex, facts: rt.facts, candidateLog: createMemoryCandidateLog(), postCandidates: async (cs) => ({ accepted: cs.length }) });
  md.push(`## @${post.author_handle} (${post.tweet_id})`, "", `> ${post.tweet_text.replace(/\n+/g, "\n> ")}`, "", `**Final reply:** ${r.reply}`, "", `**Flags:** ${(r.candidate.ai_tell_flags ?? []).join("; ") || "none"}`, "");
  calls.forEach((c, i) => {
    md.push(`### Call ${i + 1}: ${c.label} (${c.tier})`, "", "<details><summary>System prompt</summary>", "", "```", c.system, "```", "", "</details>", "", "**Prompt**", "", "```", c.prompt, "```", "", "**Response**", "", "```json", JSON.stringify(c.response, null, 2), "```", "");
  });
  console.log(`@${post.author_handle}: ${calls.length} calls`);
}
writeFileSync(join(OUT, "traces.md"), md.join("\n"));
console.log("written");
