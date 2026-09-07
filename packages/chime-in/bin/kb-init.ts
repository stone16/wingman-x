#!/usr/bin/env tsx
/**
 * `npm run kb:init` — scaffold the knowledge base, watchlist and themes.
 * Copies `packages/chime-in/kb-seed/` into `~/.wingman-x/kb/` and the
 * Chime In state dir. Never overwrites an existing file.
 */
import "../../../scripts/load-env.mjs";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { chimePaths, resolveWingmanXStateDir } from "../src/paths.js";

const here = dirname(fileURLToPath(import.meta.url));
const seed = resolve(here, "../kb-seed");

function copyIfMissing(from: string, to: string): boolean {
  if (existsSync(to)) return false;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  return true;
}

const config = loadConfig();
const paths = chimePaths(config.chimeDir);
const kbDir = join(resolveWingmanXStateDir(), "kb");
let copied = 0;
let skipped = 0;

const report = (ok: boolean, to: string): void => {
  if (ok) copied += 1;
  else skipped += 1;
  process.stdout.write(`${ok ? "created" : "kept   "} ${to}\n`);
};

report(copyIfMissing(join(seed, "tone.md"), join(kbDir, "tone.md")), join(kbDir, "tone.md"));
report(copyIfMissing(join(seed, "conversational.md"), join(kbDir, "conversational.md")), join(kbDir, "conversational.md"));
report(copyIfMissing(join(seed, "options.md"), join(kbDir, "options.md")), join(kbDir, "options.md"));
for (const f of readdirSync(join(seed, "library")).filter((n) => n.endsWith(".md"))) {
  report(copyIfMissing(join(seed, "library", f), join(kbDir, "library", f)), join(kbDir, "library", f));
}
report(copyIfMissing(join(seed, "watchlist.example.csv"), paths.watchlist), paths.watchlist);
report(copyIfMissing(join(seed, "themes.txt"), paths.themes), paths.themes);

process.stdout.write(`\n${copied} file(s) created, ${skipped} kept.\n`);
process.stdout.write(`Next: edit ${join(kbDir, "tone.md")} and the library files so they say what YOU know and believe, then put your handles in ${paths.watchlist}.\n`);
