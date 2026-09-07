import "../../../scripts/load-env.mjs";
import { writeFileSync } from "node:fs";
import { buildRuntime, parseFlags } from "../src/cli/bootstrap.js";
import { buildReasonSystemPrompt } from "../src/pipeline/stages/reason.js";
const rt = await buildRuntime({ ...parseFlags([]), dryRun: true }, { needWatchlist: false });
const wc = (s: string) => s.trim().split(/\s+/).length;
const base = { digest: rt.digest, experienceIndex: rt.experienceIndex, boundaries: rt.kb.constraints, policy: rt.policy, authorPriority: 2 as const };
const finance = buildReasonSystemPrompt({ ...base, profile: "candidate", theme: "Credit and collateral" });
const general = buildReasonSystemPrompt({ ...base, profile: "candidate", theme: "Technology and startups" });
const baseline = buildReasonSystemPrompt({ ...base, theme: "Credit and collateral" });
const md = [
  "# Assembled reasoner prompts, current code (2026-09-07)",
  "",
  "What the reasoning model receives before the post, under the candidate profile with progressive loading, versus the production baseline. Live KB: replacement library, frozen digest.",
  "",
  `| Prompt | Words |`, `|---|---|`, `| Candidate, finance post (theme Credit and collateral) | ${wc(finance)} |`, `| Candidate, general post (theme Technology and startups) | ${wc(general)} |`, `| Baseline (production), any post | ${wc(baseline)} |`,
  "", "## Candidate, finance post", "", "```", finance, "```",
  "", "## Candidate, general post", "", "```", general, "```",
  "", "## Baseline (production), for comparison", "", "```", baseline, "```",
].join("\n");
writeFileSync(process.env.HOME + "/Desktop/chime-in-reasoner-prompts.md", md);
console.log("finance", wc(finance), "general", wc(general), "baseline", wc(baseline));
