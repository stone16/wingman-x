import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The always-present context for the unified reasoning stage: a short
 * digest of the person's working views and a map of where firsthand
 * grounding may exist. Both live at `<kb>/` beside tone.md, outside
 * `library/`, so retrieval never chunks them and they never become "facts".
 * Deliberately small: whatever sits in front of the model on every call
 * becomes its default move.
 */
export interface AlwaysPresent {
  digest: string;
  experienceIndex: string;
  sources: { digest: "file" | "missing"; experienceIndex: "file" | "missing" };
}

export function loadAlwaysPresent(stateDir: string): AlwaysPresent {
  const read = (name: string): string | null => {
    const p = join(stateDir, "kb", name);
    if (!existsSync(p)) return null;
    const t = readFileSync(p, "utf8");
    return t.trim() ? t : null;
  };
  const digest = read("beliefs-digest.md");
  const idx = read("experience-index.md");
  return {
    digest: digest ?? "",
    experienceIndex: idx ?? "",
    sources: { digest: digest ? "file" : "missing", experienceIndex: idx ? "file" : "missing" },
  };
}
