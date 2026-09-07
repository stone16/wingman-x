import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Mirrors `@wingman-x/agent-kit`'s state-dir resolution so Chime In state
 * sits beside the daemon's `state.json` and the KB under `~/.wingman-x/`.
 * Re-declared here (it is three lines) rather than importing an internal
 * agent-kit module that is not on its public export surface.
 */
export function resolveWingmanXStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.WINGMAN_X_STATE_DIR;
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".wingman-x");
}

export function chimePaths(chimeDir: string): {
  watchlist: string;
  processed: string;
  state: string;
  candidates: string;
  scansDir: string;
  themes: string;
  watchPid: string;
  watchLog: string;
  telegram: string;
  scanInProgress: string;
  factCache: string;
} {
  return {
    watchlist: join(chimeDir, "watchlist.csv"),
    processed: join(chimeDir, "processed.jsonl"),
    state: join(chimeDir, "state.json"),
    candidates: join(chimeDir, "candidates.jsonl"),
    scansDir: join(chimeDir, "scans"),
    themes: join(chimeDir, "themes.txt"),
    watchPid: join(chimeDir, "watch.pid"),
    watchLog: join(chimeDir, "watch.log"),
    telegram: join(chimeDir, "telegram.jsonl"),
    scanInProgress: join(chimeDir, "scan.inprogress"),
    factCache: join(chimeDir, "verified_facts.jsonl"),
  };
}
