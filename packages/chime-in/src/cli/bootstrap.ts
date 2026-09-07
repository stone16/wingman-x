import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createKBLoader } from "@wingman-x/agent-kit";
import { loadConfig, type Config } from "../config.js";
import { buildKBIndex, type KBIndex } from "../kb/kb-index.js";
import { createLLMProvider } from "../llm/index.js";
import type { LLMProvider } from "../llm/provider.js";
import { chimePaths } from "../paths.js";
import { loadThemes } from "../pipeline/themes.js";
import type { ScanSummary } from "../pipeline/scan.js";
import { createApifyClientRunner } from "../sources/apify/apify-client-runner.js";
import { createApifySource } from "../sources/apify/apify-source.js";
import { createFixtureSource } from "../sources/fixture-source.js";
import type { PostSource } from "../sources/post-source.js";
import { openCandidateLog, type CandidateLog } from "../state/candidate-log.js";
import { openProcessedStore, createMemoryProcessedStore, type ProcessedStore } from "../state/processed-store.js";
import { loadScanState, type ScanState } from "../state/scan-state.js";
import { createLogger, type Logger } from "../util/logger.js";
import { loadWatchlist, type WatchAccount } from "../watchlist.js";
import { loadConversationalPolicy } from "../kb/conversational.js";
import { loadOptionsPolicy } from "../kb/options.js";
import { loadAlwaysPresent } from "../kb/always.js";
import { loadFactArchive, type FactArchive } from "../pipeline/ground.js";
import { resolveWingmanXStateDir } from "../paths.js";

/** Shared wiring for the bin entrypoints. */
export interface Runtime {
  config: Config;
  paths: ReturnType<typeof chimePaths>;
  log: Logger;
  kb: KBIndex;
  llm: LLMProvider;
  themes: string[];
  /** Conversational-lane reply policy text (kb/conversational.md, or the built-in default). */
  policy: string;
  /** /options policy (kb/options.md, the adapted twitter-reply skill). */
  optionsPolicy: string;
  /** Always present for reasoning: working views and the experience map. */
  digest: string;
  experienceIndex: string;
  /** Dated research archive, consulted only for a specific factual dependency. */
  facts: FactArchive;
  watchlist: WatchAccount[];
  processed: ProcessedStore;
  candidateLog: CandidateLog;
  state: ScanState;
}

export interface CliFlags {
  dryRun: boolean;
  reprocess: boolean;
  verbose: boolean;
  fixture?: string;
  handles?: string[];
  limit?: number;
  since?: string;
  noRegen: boolean;
  regenOnly: boolean;
  force: boolean;
}

export function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { dryRun: false, reprocess: false, verbose: false, noRegen: false, regenOnly: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} requires a value`);
      i += 1;
      return v;
    };
    if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--reprocess") flags.reprocess = true;
    else if (a === "--no-watch") {
      /* handled in bin/scan.ts: do not auto-start the background watcher */
    }
    else if (a === "--verbose" || a === "-v") flags.verbose = true;
    else if (a === "--no-regen") flags.noRegen = true;
    else if (a === "--regen-only") flags.regenOnly = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--fixture") flags.fixture = next();
    else if (a.startsWith("--fixture=")) flags.fixture = a.slice("--fixture=".length);
    else if (a === "--handles") flags.handles = next().split(",").map((h) => h.trim().replace(/^@/, "")).filter(Boolean);
    else if (a.startsWith("--handles=")) flags.handles = a.slice("--handles=".length).split(",").map((h) => h.trim().replace(/^@/, "")).filter(Boolean);
    else if (a === "--limit") flags.limit = Number(next());
    else if (a.startsWith("--limit=")) flags.limit = Number(a.slice("--limit=".length));
    else if (a === "--since") flags.since = next();
    else if (a.startsWith("--since=")) flags.since = a.slice("--since=".length);
    else if (a === "--help" || a === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    } else throw new Error(`unknown flag ${a} (try --help)`);
  }
  return flags;
}

export const HELP = `Usage: npm run scan -- [flags]

  --dry-run           run the whole pipeline but send nothing and mark nothing processed
  --fixture <file>    read posts from a JSON file instead of Apify (raw Apify dump or {"posts": [...]})
  --handles a,b,c     only scan these handles from the watchlist
  --limit N           cap posts admitted to the LLM stages
  --since <ISO|Nh>    override the lookback (e.g. 2026-09-01T00:00:00Z or 12h)
  --reprocess         ignore the processed store (re-run already-seen posts)
  --no-regen          skip serving Wingman regeneration requests
  --regen-only        only serve regeneration requests, no scan
  --force             (regen) redraft ♻️ candidates even if their last click was already served
  --verbose, -v       per-post debug lines
`;

export function parseSince(value: string, now: Date): Date {
  const m = /^(\d+(?:\.\d+)?)h$/i.exec(value.trim());
  if (m?.[1]) return new Date(now.getTime() - Number(m[1]) * 3600 * 1000);
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new Error(`--since must be an ISO date or Nh, got ${JSON.stringify(value)}`);
  return new Date(t);
}

export async function buildRuntime(flags: CliFlags, options: { needWatchlist: boolean }): Promise<Runtime> {
  const config = loadConfig();
  const paths = chimePaths(config.chimeDir);
  const log = createLogger({ verbose: flags.verbose });
  mkdirSync(config.chimeDir, { recursive: true });

  const loader = createKBLoader({ log: (e) => log.debug(`kb: ${JSON.stringify(e)}`) });
  await loader.refresh();
  const kb = await buildKBIndex(loader);
  if (kb.files.length === 0) {
    log.warn("knowledge base has no library files — every post will fail the expertise gate. Run `npm run kb:init` to scaffold one.");
  }
  const llm = createLLMProvider(config, process.env, (l) => log.debug(l));
  const themes = loadThemes(paths.themes);
  const policy = loadConversationalPolicy(resolveWingmanXStateDir());
  const optionsPolicy = loadOptionsPolicy(resolveWingmanXStateDir());
  const always = loadAlwaysPresent(resolveWingmanXStateDir());
  if (always.sources.digest === "missing") log.warn("kb/beliefs-digest.md is missing: the reasoning stage will run without the person's views. Create it beside tone.md.");
  const facts = loadFactArchive(join(resolveWingmanXStateDir(), "kb", "sources", "research-notes.md"));
  for (const heading of ["Who is speaking", "What can legitimately be claimed", "Confidentiality", "Facts and verification", "Diplomatic floor", "Lane discipline"]) {
    if (kb.constraints.trim() && !new RegExp(`^## ${heading}`, "mi").test(kb.constraints)) log.warn(`identity file: section "${heading}" not found; a renamed heading would silently drop that boundary`);
  }
  const watchlist = options.needWatchlist ? await loadWatchlist(paths.watchlist) : [];
  const processed = flags.dryRun ? createMemoryProcessedStore() : openProcessedStore(paths.processed);
  // Dry runs still need to know what was already processed for "seen".
  const processedForSeen = flags.dryRun ? openProcessedStore(paths.processed) : processed;
  const candidateLog = openCandidateLog(paths.candidates);
  const state = loadScanState(paths.state);

  const models = llm.describeModels();
  log.info(
    `KB: ${kb.files.length} library file(s), ${kb.chunks.length} excerpt(s) · LLM: ${llm.name} (cheap=${models.cheap}, strong=${models.strong}, draft=${models.draft}) · themes: ${themes.length} · digest: ${always.sources.digest} · facts archive: ${facts.size} entries`,
  );

  return {
    config,
    paths,
    log,
    kb,
    llm,
    themes,
    policy: policy.text,
    optionsPolicy: optionsPolicy.text,
    digest: always.digest,
    experienceIndex: always.experienceIndex,
    facts,
    watchlist,
    processed: flags.dryRun ? withReadOnlySeen(processed, processedForSeen) : processed,
    candidateLog,
    state,
  };
}

/** Dry-run store: reads "seen" from disk, records only in memory. */
function withReadOnlySeen(memory: ProcessedStore, disk: ProcessedStore): ProcessedStore {
  return {
    path: memory.path,
    has: (id) => disk.has(id) || memory.has(id),
    get: (id) => memory.get(id) ?? disk.get(id),
    record: (rec) => memory.record(rec),
    size: () => disk.size(),
  };
}

/**
 * `npm run scan -- --fixture x.json` runs with cwd = packages/chime-in, but
 * the user typed the path relative to where they ran npm (`INIT_CWD`).
 * Prefer that; fall back to the process cwd.
 */
export function resolveUserPath(p: string, env: NodeJS.ProcessEnv = process.env): string {
  if (isAbsolute(p)) return p;
  const fromInit = env.INIT_CWD ? resolve(env.INIT_CWD, p) : null;
  if (fromInit && existsSync(fromInit)) return fromInit;
  return resolve(process.cwd(), p);
}

export function buildSource(rt: Runtime, flags: CliFlags): PostSource {
  if (flags.fixture) return createFixtureSource(resolveUserPath(flags.fixture));
  const { config } = rt;
  if (!config.apifyToken) {
    throw new Error("APIFY_TOKEN is not set. Add it to .env, or pass --fixture <file> to scan from a local JSON dump.");
  }
  return createApifySource({
    actorId: config.apifyActor,
    mode: config.apifyMode,
    handlesPerQuery: config.apifyHandlesPerQuery,
    handlesPerRun: config.apifyHandlesPerRun,
    runActor: createApifyClientRunner({
      token: config.apifyToken,
      actorId: config.apifyActor,
      timeoutSecs: config.apifyTimeoutSecs,
      log: (l) => rt.log.debug(l),
    }),
    log: (l) => rt.log.debug(l),
  });
}

export function writeScanReport(rt: Runtime, summary: ScanSummary): string {
  mkdirSync(rt.paths.scansDir, { recursive: true });
  const name = `${summary.started_at.replace(/[:.]/g, "-")}${summary.dry_run ? "-dry" : ""}.json`;
  const path = join(rt.paths.scansDir, name);
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return path;
}

export function printCandidates(log: Logger, summary: ScanSummary): void {
  if (summary.candidates.length === 0) return;
  log.info("");
  log.info("Candidates:");
  summary.candidates.forEach((c, i) => {
    log.info(`${i + 1}. @${c.author_handle} — ${c.tweet_url}`);
    log.info(`   theme ${c.theme} (${c.theme_score}) · worth ${c.worth ?? c.contribution_score} · ${c.move ?? "?"} · ${c.depth ?? "?"} · grounding ${c.grounding ?? "none"}`);
    log.info(`   angle: ${c.contribution_angle}`);
    log.info(`   reply: ${c.suggested_reply}${c.ai_tell_flags.length ? `  [ai-tell: ${c.ai_tell_flags.join(", ")}]` : ""}`);
  });
}
