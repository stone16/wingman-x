import type { NormalizedPost } from "../../model/post.js";
import type { WatchAccount } from "../../watchlist.js";
import type {
  AccountFetchResult,
  FetchOptions,
  FetchPostsResult,
  PostSource,
} from "../post-source.js";
import { normalizeApifyItems } from "./normalize.js";

/**
 * Runs one actor invocation and returns the raw dataset items. Injected so
 * the source is unit-testable without an Apify token; the production
 * implementation lives in `apify-client-runner.ts`.
 */
export type ActorRunner = (input: Record<string, unknown>) => Promise<unknown[]>;

export interface ApifySourceOptions {
  actorId: string;
  mode: "search" | "handles";
  /** Defaults to `inferInputStyle(actorId)`. */
  inputStyle?: ApifyInputStyle;
  /** Search mode: how many `from:` handles to OR into one query. */
  handlesPerQuery: number;
  /** Handles mode: how many handles per actor run (failure isolation). */
  handlesPerRun: number;
  runActor: ActorRunner;
  now?: () => Date;
  log?: (line: string) => void;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * X advanced search accepts a time-precise lower bound in the form
 * `since:YYYY-MM-DD_HH:MM:SS_UTC`. Day-granular `since:` made every
 * incremental scan refetch (and pay for) a whole day of posts to find the
 * few new ones; the precise form returns only what is actually new.
 */
export function sinceStamp(d: Date, overlapMs = 5 * 60_000): string {
  const t = new Date(d.getTime() - overlapMs);
  return `${t.toISOString().slice(0, 19).replace("T", "_")}_UTC`;
}

/**
 * Build the X advanced-search query for one handle group. `since:` is
 * day-granular on X, so we start a day early and let the pipeline apply
 * the exact `since` timestamp client-side.
 */
export function buildSearchQuery(
  handles: string[],
  since: Date,
  opts: Pick<FetchOptions, "includeReplies" | "includeReposts">,
): string {
  const from = handles.map((h) => `from:${h}`).join(" OR ");
  const parts = [`(${from})`, `since:${sinceStamp(since)}`];
  if (!opts.includeReplies) parts.push("-filter:replies");
  if (!opts.includeReposts) parts.push("-filter:retweets");
  return parts.join(" ");
}

/**
 * Actors accept the same X advanced-search query but spell their other
 * inputs differently. `apidojo` covers apidojo/* and clones (feedminer…);
 * `zebu` covers delicious_zebu/ultimate-x-twitter-advanced-search-scraper.
 */
export type ApifyInputStyle = "apidojo" | "zebu";

export function inferInputStyle(actorId: string): ApifyInputStyle {
  return /^delicious_zebu\//i.test(actorId) ? "zebu" : "apidojo";
}

export function buildSearchInput(
  handles: string[],
  since: Date,
  opts: FetchOptions,
  handlesPerQuery: number,
  style: ApifyInputStyle = "apidojo",
): Record<string, unknown> {
  const queries = chunk(handles, handlesPerQuery).map((group) =>
    buildSearchQuery(group, since, opts),
  );
  if (style === "zebu") {
    return {
      searchTerms: queries,
      sortBy: "Latest",
      // Inclusive day-granular start; the exact `since` is applied client-side.
      startDate: ymd(new Date(since.getTime() - 24 * 3600 * 1000)),
      excludeReplies: !opts.includeReplies,
      // zebu's maxItems is PER search term.
      maxItems: Math.max(1, handlesPerQuery * opts.maxPostsPerAccount),
    };
  }
  return {
    searchTerms: queries,
    sort: "Latest",
    maxItems: Math.max(1, handles.length * opts.maxPostsPerAccount),
    includeSearchTerms: false,
  };
}

export function buildHandlesInput(
  handles: string[],
  opts: FetchOptions,
): Record<string, unknown> {
  return {
    twitterHandles: handles,
    sort: "Latest",
    maxItems: Math.max(1, handles.length * opts.maxPostsPerAccount),
    // Honoured by actors that support it (feedminer/x-tweet-scraper);
    // ignored by the rest. The pipeline re-filters client-side anyway.
    includeReplies: opts.includeReplies,
    // Deliberately no `start`/`end` here: on feedminer/x-tweet-scraper a
    // date filter in handles mode returns zero items (verified 2026-09-04).
    // Recency is enforced client-side by applyClientSideBounds.
  };
}

/** Keep the newest N posts per account, drop anything older than `since`. */
export function applyClientSideBounds(
  posts: NormalizedPost[],
  handles: string[],
  since: Date,
  maxPerAccount: number,
): NormalizedPost[] {
  const allowed = new Set(handles.map((h) => h.toLowerCase()));
  const byHandle = new Map<string, NormalizedPost[]>();
  for (const p of posts) {
    const key = p.author_handle.toLowerCase();
    if (!allowed.has(key)) continue;
    if (Date.parse(p.created_at) < since.getTime()) continue;
    const list = byHandle.get(key) ?? [];
    list.push(p);
    byHandle.set(key, list);
  }
  const out: NormalizedPost[] = [];
  for (const list of byHandle.values()) {
    list.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    out.push(...list.slice(0, maxPerAccount));
  }
  return out;
}

export function createApifySource(options: ApifySourceOptions): PostSource {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);

  async function runGroup(
    handles: string[],
    input: Record<string, unknown>,
  ): Promise<{ items: unknown[]; error?: string }> {
    try {
      const items = await options.runActor(input);
      return { items };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[apify] run failed for ${handles.length} handle(s): ${message}`);
      return { items: [], error: message };
    }
  }

  return {
    name: `apify:${options.actorId}:${options.mode}`,

    async fetchPosts(accounts, since, opts): Promise<FetchPostsResult> {
      const handles = accounts.map((a) => a.handle);
      const scrapedAt = now().toISOString();
      const style = options.inputStyle ?? inferInputStyle(options.actorId);
      // zebu has no profile-timeline mode; its `from:` search IS the handles path.
      const useSearch = options.mode === "search" || style === "zebu";
      const groups = useSearch
        ? // One run covers every query; a run failure fails every handle.
          [{ handles, input: buildSearchInput(handles, since, opts, options.handlesPerQuery, style) }]
        : chunk(handles, options.handlesPerRun).map((g) => ({
            handles: g,
            input: buildHandlesInput(g, opts),
          }));

      const allItems: unknown[] = [];
      const errorsByHandle = new Map<string, string>();
      for (const group of groups) {
        log(
          `[apify] running ${options.actorId} (${options.mode}) for ${group.handles.length} handle(s)`,
        );
        const result = await runGroup(group.handles, group.input);
        allItems.push(...result.items);
        if (result.error !== undefined) {
          for (const h of group.handles) errorsByHandle.set(h.toLowerCase(), result.error);
        }
      }

      const normalized = normalizeApifyItems(allItems, scrapedAt);
      const bounded = applyClientSideBounds(normalized, handles, since, opts.maxPostsPerAccount);

      const countByHandle = new Map<string, number>();
      for (const p of bounded) {
        const k = p.author_handle.toLowerCase();
        countByHandle.set(k, (countByHandle.get(k) ?? 0) + 1);
      }
      const accountResults: AccountFetchResult[] = handles.map((h) => {
        const key = h.toLowerCase();
        const error = errorsByHandle.get(key);
        return error === undefined
          ? { handle: h, ok: true, posts: countByHandle.get(key) ?? 0 }
          : { handle: h, ok: false, posts: 0, error };
      });

      return {
        source: `apify:${options.actorId}:${options.mode}`,
        posts: bounded,
        accounts: accountResults,
        raw_count: allItems.length,
      };
    },
  };
}
