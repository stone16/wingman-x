#!/usr/bin/env tsx
/** `npm run watch:start` — start the background watcher (no scan) if none is running. */
import "../../../scripts/load-env.mjs";
import { loadConfig } from "../src/config.js";
import { chimePaths } from "../src/paths.js";
import { isWatcherRunning, spawnWatcherDetached } from "../src/cli/watcher-process.js";

const paths = chimePaths(loadConfig().chimeDir);
const running = isWatcherRunning(paths);
if (running !== null) process.stdout.write(`watcher already running (pid ${running}); log: ${paths.watchLog}\n`);
else process.stdout.write(`watcher started in the background (pid ${spawnWatcherDetached(paths, process.argv.slice(2))}); log: ${paths.watchLog}\n`);
