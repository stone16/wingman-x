#!/usr/bin/env tsx
/**
 * `npm run scan` — one manual pass: fetch → filter → classify → score →
 * draft → send to Wingman. Also serves any pending ♻️ regeneration
 * requests first (skip with --no-regen). Never posts to X.
 */
import "../../../scripts/load-env.mjs";
import { runRegen } from "../src/pipeline/regen.js";
import { runScan } from "../src/pipeline/scan.js";
import { computeSince, saveScanState } from "../src/state/scan-state.js";
import { connectDaemon } from "../src/wingman/daemon.js";
import {
  buildRuntime,
  buildSource,
  parseFlags,
  parseSince,
  printCandidates,
  writeScanReport,
} from "../src/cli/bootstrap.js";
import { isWatcherRunning, spawnWatcherDetached } from "../src/cli/watcher-process.js";

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const rt = await buildRuntime(flags, { needWatchlist: !flags.regenOnly });
  const now = new Date();

  // Daemon is required unless this is a dry run.
  let daemon: Awaited<ReturnType<typeof connectDaemon>> | null = null;
  if (!flags.dryRun) {
    daemon = await connectDaemon(rt.config.daemonPort);
    rt.log.info(`Wingman daemon on port ${daemon.port}`);
  } else {
    rt.log.info("Dry run: nothing will be sent to Wingman or marked processed");
  }

  // 1. Regeneration requests (♻️ in the extension).
  if (daemon && !flags.noRegen) {
    const client = daemon.client;
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
      getCandidates: () => client.getCandidates(),
      postCandidates: (cs) => client.postCandidates(cs),
      log: rt.log,
      force: flags.force,
    });
    if (regen.requested > 0) {
      saveScanState(rt.paths.state, rt.state);
      rt.log.info(
        `Regenerated ${regen.regenerated}/${regen.requested} (failed ${regen.failed})${regen.already_served > 0 ? `, ${regen.already_served} already served` : ""}`,
      );
    }
  }
  if (flags.regenOnly) return 0;

  // 2. The scan.
  const since = flags.since ? parseSince(flags.since, now) : computeSince(rt.state, rt.config.lookbackHours, now);
  const source = buildSource(rt, flags);
  if (!flags.dryRun) {
    rt.state.last_scan_started_at = now.toISOString();
    saveScanState(rt.paths.state, rt.state);
  }
  const summary = await runScan(
    {
      config: rt.config,
      watchlist: rt.watchlist,
      source,
      llm: rt.llm,
      kb: rt.kb,
      policy: rt.policy,
      digest: rt.digest,
      experienceIndex: rt.experienceIndex,
      facts: rt.facts,
      factCachePath: rt.paths.factCache,
      themes: rt.themes,
      processed: rt.processed,
      candidateLog: rt.candidateLog,
      sink: daemon ? { postCandidates: (cs) => daemon!.client.postCandidates(cs) } : null,
      log: rt.log,
    },
    {
      since,
      dryRun: flags.dryRun,
      reprocess: flags.reprocess,
      ...(flags.handles ? { handles: flags.handles } : {}),
      ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
      // First-timers (never fetched before) get the lookback window once.
      knownHandles: new Set(Object.keys(rt.state.accounts_seen ?? {})),
      backfillSince: new Date(now.getTime() - rt.config.lookbackHours * 3600 * 1000),
    },
  );
  {
    const seen = (rt.state.accounts_seen ??= {});
    for (const h of summary.accounts_fetched_ok) {
      const key = h.toLowerCase();
      if (seen[key] === undefined) seen[key] = now.toISOString();
    }
  }
  if (!flags.dryRun) {
    rt.state.last_scan_completed_at = new Date().toISOString();
    saveScanState(rt.paths.state, rt.state);
  }
  const report = writeScanReport(rt, summary);
  printCandidates(rt.log, summary);
  rt.log.info("");
  rt.log.info(
    `LLM: ${summary.llm.calls} call(s), ${summary.llm.failures} failure(s), ~$${summary.llm.cost_usd.toFixed(3)}, ${Math.round(summary.llm.elapsed_ms / 1000)}s model time`,
  );
  rt.log.info(`Report: ${report}`);

  // Make sure ♻️ clicks get served without a second terminal: if no watcher
  // is running, start one in the background (regen only, no scheduled
  // scans). Skip with --no-watch.
  if (!flags.dryRun && !process.argv.includes("--no-watch")) {
    const running = isWatcherRunning(rt.paths);
    if (running === null) {
      const pid = spawnWatcherDetached(rt.paths);
      rt.log.info(`Watcher started in the background (pid ${pid}) to serve ♻️ clicks · log: ${rt.paths.watchLog} · stop: npm run watch:stop`);
    } else {
      rt.log.info(`Watcher already running (pid ${running}); ♻️ clicks are being served.`);
    }
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`scan failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
