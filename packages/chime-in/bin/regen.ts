#!/usr/bin/env tsx
/** `npm run regen` — serve pending ♻️ requests only. Equivalent to `scan --regen-only`. */
import "../../../scripts/load-env.mjs";
import { runRegen } from "../src/pipeline/regen.js";
import { saveScanState } from "../src/state/scan-state.js";
import { connectDaemon } from "../src/wingman/daemon.js";
import { buildRuntime, parseFlags } from "../src/cli/bootstrap.js";

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const rt = await buildRuntime({ ...flags, dryRun: false }, { needWatchlist: false });
  const daemon = await connectDaemon(rt.config.daemonPort);
  const regen = await runRegen({
    config: rt.config,
    llm: rt.llm,
    kb: rt.kb,
    policy: rt.policy,
    digest: rt.digest,
    experienceIndex: rt.experienceIndex,
    facts: rt.facts,
    factCachePath: rt.paths.factCache,
    candidateLog: rt.candidateLog,
    state: rt.state,
    getCandidates: () => daemon.client.getCandidates(),
    postCandidates: (cs) => daemon.client.postCandidates(cs),
    log: rt.log,
    force: flags.force,
  });
  saveScanState(rt.paths.state, rt.state);
  rt.log.info(
    `Regenerated ${regen.regenerated}/${regen.requested} (failed ${regen.failed}${regen.served_from_alternates > 0 ? `, ${regen.served_from_alternates} from pre-drafted alternates` : ""})${regen.already_served > 0 ? `, ${regen.already_served} already served` : ""}${regen.fills_recorded > 0 ? `, ${regen.fills_recorded} fill(s) recorded` : ""}`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`regen failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
