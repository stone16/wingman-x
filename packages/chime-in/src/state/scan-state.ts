import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Small mutable state beside the processed log: when the last scan ran
 * (to anchor `since`) and which regen requests we have already served
 * (keyed by the candidate's `status_updated_at`, so a fresh click on
 * ♻️ after we redrafted is served again).
 */
export const ScanStateSchema = z.object({
  last_scan_started_at: z.string().optional(),
  last_scan_completed_at: z.string().optional(),
  regen_handled: z.record(z.string(), z.string()).default({}),
  /** handle (lowercase) → ISO time of its first successful fetch. New handles get a backfill window on their first scan. */
  accounts_seen: z.record(z.string(), z.string()).optional(),
});
export type ScanState = z.infer<typeof ScanStateSchema>;

export function loadScanState(path: string): ScanState {
  if (!existsSync(path)) return ScanStateSchema.parse({});
  try {
    const parsed = ScanStateSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : ScanStateSchema.parse({});
  } catch {
    return ScanStateSchema.parse({});
  }
}

/**
 * Merge our in-memory view with whatever another process saved since we
 * loaded (the watcher and a manual `npm run scan` both write this file):
 * regen_handled is a union with the newer click winning; scan timestamps
 * take the later value. The caller's object is updated in place so its
 * view stays current too.
 */
export function mergeScanState(target: ScanState, other: ScanState): ScanState {
  for (const [id, at] of Object.entries(other.regen_handled)) {
    const mine = target.regen_handled[id];
    if (mine === undefined || at > mine) target.regen_handled[id] = at;
  }
  if (other.accounts_seen) {
    const seen = (target.accounts_seen ??= {});
    for (const [h, at] of Object.entries(other.accounts_seen)) {
      if (seen[h] === undefined || at < seen[h]!) seen[h] = at;
    }
  }
  const later = (x?: string, y?: string): string | undefined => (x === undefined ? y : y === undefined ? x : x > y ? x : y);
  target.last_scan_started_at = later(target.last_scan_started_at, other.last_scan_started_at);
  target.last_scan_completed_at = later(target.last_scan_completed_at, other.last_scan_completed_at);
  return target;
}

/** Atomic write: tmp + fsync + rename, same discipline as the daemon. Merges with the on-disk copy first. */
export function saveScanState(path: string, state: ScanState): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) mergeScanState(state, loadScanState(path));
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * Where to start this scan from. We overlap the previous scan by one hour
 * so a post published while the last scan ran is not lost; dedupe makes
 * the overlap free.
 */
export function computeSince(
  state: ScanState,
  lookbackHours: number,
  now: Date,
  overlapMs = 60 * 60 * 1000,
): Date {
  const floor = now.getTime() - lookbackHours * 3600 * 1000;
  const last = state.last_scan_started_at ? Date.parse(state.last_scan_started_at) : NaN;
  if (Number.isFinite(last)) {
    return new Date(Math.max(floor, last - overlapMs));
  }
  return new Date(floor);
}
