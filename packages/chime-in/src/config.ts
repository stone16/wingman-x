import { join } from "node:path";
import { z } from "zod";
import { resolveWingmanXStateDir } from "./paths.js";

/**
 * All tunables in one place. Values come from the environment (the repo's
 * `.env` is loaded by `scripts/load-env.mjs` before any bin entrypoint
 * reads this). Thresholds are deliberately configurable rather than
 * baked into a ranking formula — tune them from scan reports.
 */
export const LLMProviderNameSchema = z.enum([
  "auto",
  "claude-cli",
  "codex-cli",
  "anthropic",
  "fake",
]);
export type LLMProviderName = z.infer<typeof LLMProviderNameSchema>;

export const ConfigSchema = z.object({
  // ---- Ingestion (Apify) -------------------------------------------------
  apifyToken: z.string().min(1).optional(),
  /** Apify actor id, e.g. "apidojo/twitter-scraper-lite" or "apidojo/tweet-scraper". */
  apifyActor: z.string().min(1).default("delicious_zebu/ultimate-x-twitter-advanced-search-scraper"),
  /**
   * "search":  batched `from:a OR from:b … since:YYYY-MM-DD` queries. Default.
   *            Verified on apidojo/twitter-scraper-lite (2026-09-04): recent
   *            posts, replies/reposts excluded server-side, ~6 queries for
   *            64 handles. Needs an actor that runs logged-in sessions.
   * "handles": profile timelines via `twitterHandles`, one query per handle.
   *            Fallback when search returns nothing. Anonymous-mode actors
   *            (feedminer, studio-amba) only return all-time top posts here.
   */
  apifyMode: z.enum(["search", "handles"]).default("search"),
  apifyHandlesPerQuery: z.number().int().min(1).max(30).default(12),
  apifyHandlesPerRun: z.number().int().min(1).max(200).default(50),
  apifyTimeoutSecs: z.number().int().positive().default(600),
  maxPostsPerAccount: z.number().int().min(1).default(10),
  includeReplies: z.boolean().default(false),
  includeReposts: z.boolean().default(false),
  /** How far back a scan looks when there is no previous scan to anchor on. */
  lookbackHours: z.number().positive().default(36),
  /** Hard safety cap on posts admitted to the LLM stages per scan. */
  maxPostsPerScan: z.number().int().positive().default(400),

  // ---- Scoring thresholds (0–100) ---------------------------------------
  themeThreshold: z.number().min(0).max(100).default(60),
  expertiseThreshold: z.number().min(0).max(100).default(70),
  contributionThreshold: z.number().min(0).max(100).default(70),
  /** Optional ceiling on drafted expertise candidates per scan. 0 (default) means no cap: everything above the thresholds is drafted and the person decides. */
  maxCandidatesPerScan: z.number().int().min(0).default(0),
  /** Unified gate: would the person plausibly post the response? 0-100. Casual replies to organization accounts need +10. */
  worthThreshold: z.number().min(0).max(100).default(70),
  /** Themes routed to the conversational lane (no KB, line gate). Others are expertise. */
  conversationalThemes: z.array(z.string()).default(["Technology and startups", "General and internet culture"]),
  /** Conversational themes where priority-2 accounts need an exceptional line (+10). */
  conversationalStrictThemes: z.array(z.string()).default(["General and internet culture"]),
  conversationalThreshold: z.number().min(0).max(100).default(80),
  maxConversationalCandidates: z.number().int().min(0).default(40),
  /** Telegram surface (watch mode). Off unless both token and chat id are set. */
  telegramBotToken: z.string().optional(),
  telegramChatId: z.number().int().optional(),
  /** "23-8" = hold cards from 23:00 to 08:00 in telegramTz. Empty disables. */
  telegramQuietHours: z.string().optional(),
  telegramTz: z.string().default("America/Chicago"),
  /** Rank bonus for priority-1 accounts (and penalty for priority-3). */
  priorityBoost: z.number().min(0).default(5),

  // ---- LLM ----------------------------------------------------------------
  llmProvider: LLMProviderNameSchema.default("auto"),
  llmModelCheap: z.string().min(1).optional(),
  llmModelStrong: z.string().min(1).optional(),
  llmModelDraft: z.string().min(1).optional(),
  llmConcurrency: z.number().int().min(1).max(8).default(3),
  llmTimeoutMs: z.number().int().positive().default(180_000),
  themeBatchSize: z.number().int().min(1).max(20).default(8),
  /** How many KB excerpts to retrieve per post for expertise/contribution/draft. */
  kbTopK: z.number().int().min(1).max(20).default(8),

  // ---- Wingman / state ---------------------------------------------------
  chimeDir: z.string().min(1),
  daemonPort: z.number().int().positive().optional(),
  /** Hard cap on a drafted reply. 1000 assumes X Premium (long posts); set 280 for a standard account. Normal length is governed by depth and instructions, not this cap. */
  replyMaxChars: z.number().int().positive().default(1000),
  /** Drafts generated per candidate. 1 by default (♻️ goes to the model); set higher to pre-draft alternates served on ♻️ without a model call. */
  draftVariants: z.number().int().min(1).max(5).default(1),
  /** Prompt profile. "baseline" is production. "candidate" is the consolidated prompt set under evaluation: one owner per decision, duplicates removed. */
  promptProfile: z.enum(["baseline", "candidate"]).default("baseline"),
});
export type Config = z.infer<typeof ConfigSchema>;

function optString(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function optNumber(v: string | undefined): number | undefined {
  const s = optString(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) {
    throw new Error(`invalid numeric env value: ${JSON.stringify(v)}`);
  }
  return n;
}

function optBool(v: string | undefined): boolean | undefined {
  const s = optString(v);
  if (s === undefined) return undefined;
  const l = s.toLowerCase();
  if (["1", "true", "yes", "on"].includes(l)) return true;
  if (["0", "false", "no", "off"].includes(l)) return false;
  throw new Error(`invalid boolean env value: ${JSON.stringify(v)}`);
}

/** Drop `undefined` so zod defaults apply. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

export function defaultChimeDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveWingmanXStateDir(env), "chime-in");
}

function optList(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const items = v.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = compact({
    apifyToken: optString(env.APIFY_TOKEN),
    apifyActor: optString(env.APIFY_ACTOR),
    apifyMode: optString(env.APIFY_MODE),
    apifyHandlesPerQuery: optNumber(env.APIFY_HANDLES_PER_QUERY),
    apifyHandlesPerRun: optNumber(env.APIFY_HANDLES_PER_RUN),
    apifyTimeoutSecs: optNumber(env.APIFY_TIMEOUT_SECS),
    maxPostsPerAccount: optNumber(env.MAX_POSTS_PER_ACCOUNT),
    includeReplies: optBool(env.INCLUDE_REPLIES),
    includeReposts: optBool(env.INCLUDE_REPOSTS),
    lookbackHours: optNumber(env.SCAN_LOOKBACK_HOURS),
    maxPostsPerScan: optNumber(env.MAX_POSTS_PER_SCAN),
    themeThreshold: optNumber(env.THEME_THRESHOLD),
    expertiseThreshold: optNumber(env.EXPERTISE_THRESHOLD),
    contributionThreshold: optNumber(env.CONTRIBUTION_THRESHOLD),
    maxCandidatesPerScan: optNumber(env.MAX_CANDIDATES_PER_SCAN),
    worthThreshold: optNumber(env.WORTH_THRESHOLD),
    conversationalThemes: optList(env.CONVERSATIONAL_THEMES),
    conversationalStrictThemes: optList(env.CONVERSATIONAL_STRICT_THEMES),
    conversationalThreshold: optNumber(env.CONVERSATIONAL_THRESHOLD),
    maxConversationalCandidates: optNumber(env.MAX_CONVERSATIONAL_CANDIDATES),
    telegramBotToken: optString(env.TELEGRAM_BOT_TOKEN),
    telegramChatId: optNumber(env.TELEGRAM_CHAT_ID),
    telegramQuietHours: optString(env.TELEGRAM_QUIET_HOURS),
    telegramTz: optString(env.TELEGRAM_TZ),
    priorityBoost: optNumber(env.PRIORITY_BOOST),
    llmProvider: optString(env.LLM_PROVIDER),
    llmModelCheap: optString(env.LLM_MODEL_CHEAP),
    llmModelStrong: optString(env.LLM_MODEL_STRONG),
    llmModelDraft: optString(env.LLM_MODEL_DRAFT),
    llmConcurrency: optNumber(env.LLM_CONCURRENCY),
    llmTimeoutMs: optNumber(env.LLM_TIMEOUT_MS),
    themeBatchSize: optNumber(env.THEME_BATCH_SIZE),
    kbTopK: optNumber(env.KB_TOP_K),
    chimeDir: optString(env.CHIME_IN_DIR) ?? defaultChimeDir(env),
    daemonPort: optNumber(env.DAEMON_PORT),
    replyMaxChars: optNumber(env.REPLY_MAX_CHARS),
    draftVariants: optNumber(env.DRAFT_VARIANTS),
    promptProfile: env.PROMPT_PROFILE === "candidate" ? "candidate" : env.PROMPT_PROFILE === "baseline" ? "baseline" : undefined,
  });
  return ConfigSchema.parse(raw);
}
