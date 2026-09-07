import "../../../scripts/load-env.mjs";
import { buildRuntime, parseFlags } from "../src/cli/bootstrap.js";
const rt = await buildRuntime({ ...parseFlags([]), dryRun: true }, { needWatchlist: false });
const long = rt.kb.chunks.filter((c) => c.text.length > 1500).length;
console.log("chunks:", rt.kb.chunks.length, "| files:", rt.kb.files.length, "| chunks >1500 chars:", long, "| identity words:", rt.kb.constraints.trim().split(/\s+/).length);
for (const q of ["vault curator discretion risk parameters", "redemption terms deposits maturity lending strategies", "tokenized equity holder claim register intermediary", "stablecoin issuer reserve carry distribution"]) console.log(q, "→", [...new Set(rt.kb.search(q, 6, { minRelative: 0.45, minMatched: 3 }).map((c) => c.file))].join(", ") || "none");
