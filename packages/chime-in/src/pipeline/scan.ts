import type { CandidateInput } from "@wingman-x/agent-kit";
import type { Config } from "../config.js";
import type { KBIndex } from "../kb/kb-index.js";
import type { LLMProvider } from "../llm/provider.js";
import type { NormalizedPost } from "../model/post.js";
import type { FetchPostsResult, PostSource } from "../sources/post-source.js";
import type { CandidateLog } from "../state/candidate-log.js";
import type { ProcessedStore } from "../state/processed-store.js";
import { mapWithConcurrency, settle } from "../util/concurrency.js";
import type { Logger } from "../util/logger.js";
import type { WatchAccount } from "../watchlist.js";
import { toWingmanCandidate, type ScoredDraft } from "../wingman/candidate-map.js";
import { rankCandidates } from "./rank.js";
import type { ReplyDepth } from "./stages/contribution.js";
import { reasonAboutPost, type ReasonMove, type ReasonResult } from "./stages/reason.js";
import { resolveGrounding, type FactArchive } from "./ground.js";
import { describeEvidence, reconsiderAngle } from "./reconsider.js";
import { expandTruncated } from "../sources/full-text.js";
import { draftReply, toSentenceCase } from "./stages/draft.js";
import { mechanicalFilter, type MechanicalReason } from "./stages/mechanical.js";
import { classifyThemes, type ThemeResult } from "./stages/theme.js";

/**
 * The scan orchestrator. Pure with respect to I/O — every side effect
 * (source, LLM, stores, daemon) is injected — so the whole funnel is
 * testable with the fake provider and the fixture source.
 */
export interface CandidateSink {
  postCandidates(cs: CandidateInput[]): Promise<{ accepted: number }>;
}

export interface ScanDeps {
  config: Config;
  watchlist: WatchAccount[];
  source: PostSource;
  llm: LLMProvider;
  kb: KBIndex;
  themes: readonly string[];
  /** Casual-reply policy (kb/conversational.md). */
  policy?: string;
  /** Always present for the reasoning stage: the person's working views and where firsthand grounding may exist. */
  digest?: string;
  experienceIndex?: string;
  /** Dated research archive for on-demand fact resolution, and the cache of resolved facts. */
  facts?: FactArchive;
  factCachePath?: string;
  processed: ProcessedStore;
  candidateLog: CandidateLog;
  /** `null` in dry-run: nothing is sent, nothing is marked processed. */
  sink: CandidateSink | null;
  log: Logger;
  now?: () => Date;
}

export interface ScanOptions {
  since: Date;
  dryRun: boolean;
  /** Ignore the processed store (explicit re-run on already-seen posts). */
  reprocess: boolean;
  /** Only scan these handles (subset of the watchlist). */
  handles?: string[];
  /** Cap posts admitted to the LLM stages (debugging). */
  limit?: number;
  /**
   * Handles (lowercase) already fetched in earlier scans. Handles NOT in this
   * set are first-timers and are fetched from `backfillSince` instead of
   * `since`, so a newly added account contributes its recent history once.
   */
  knownHandles?: ReadonlySet<string>;
  backfillSince?: Date;
}

export interface PostOutcome {
  tweet_id: string;
  author_handle: string;
  tweet_url: string;
  stage: "mechanical" | "theme" | "expertise" | "contribution" | "line" | "reason" | "rank" | "draft" | "sent" | "error";
  decision: "filtered" | "candidate" | "error";
  reason?: string;
  theme?: string;
  theme_score?: number;
  expertise_score?: number;
  contribution_score?: number;
  contribution_angle?: string;
  suggested_reply?: string;
}

export interface ScanSummary {
  started_at: string;
  completed_at: string;
  since: string;
  source: string;
  dry_run: boolean;
  accounts_requested: number;
  accounts_fetched: number;
  /** Handles (as given) whose fetch succeeded this run; callers record them as seen. */
  accounts_fetched_ok: string[];
  account_failures: Array<{ handle: string; error: string }>;
  posts_fetched: number;
  raw_items: number;
  unseen_posts: number;
  removed_by_basic_filters: number;
  basic_filter_breakdown: Record<MechanicalReason, number>;
  theme_candidates: number;
  expertise_candidates: number;
  contribution_candidates: number;
  conversational_candidates: number;
  ranked_out: number;
  drafted: number;
  sent: number;
  errors: number;
  llm: { provider: string; calls: number; failures: number; cost_usd: number; elapsed_ms: number };
  candidates: Array<{
    tweet_id: string;
    tweet_url: string;
    author_handle: string;
    theme: string;
    theme_score: number;
    expertise_score: number;
    contribution_score: number;
    contribution_angle: string;
    suggested_reply: string;
    ai_tell_flags: string[];
    move?: string;
    depth?: string;
    posture?: string;
    lane?: string;
    grounding?: string;
    worth?: number;
  }>;
  outcomes: PostOutcome[];
}

/** Split the accounts to fetch into ones seen before and first-timers. No known set → everyone is known. */
export function splitFirstTimers(
  accounts: WatchAccount[],
  known?: ReadonlySet<string>,
): { known: WatchAccount[]; fresh: WatchAccount[] } {
  if (known === undefined) return { known: accounts, fresh: [] };
  const fresh = accounts.filter((a) => !known.has(a.handle.toLowerCase()));
  return { known: accounts.filter((a) => known.has(a.handle.toLowerCase())), fresh };
}

export function mergeFetches(a: FetchPostsResult | null, b: FetchPostsResult): FetchPostsResult {
  if (a === null) return b;
  const seenIds = new Set(a.posts.map((p) => p.tweet_id));
  return {
    source: a.source,
    posts: [...a.posts, ...b.posts.filter((p) => !seenIds.has(p.tweet_id))],
    accounts: [...a.accounts, ...b.accounts],
    raw_count: a.raw_count + b.raw_count,
  };
}

/**
 * The last few replies we actually sent (from candidates.jsonl), so the
 * drafter knows what has just been said and does not recycle it.
 */
/** The reasoner's context on repetition: what was contributed on other posts recently. Context, not a rule. */
export function recentContributions(log: CandidateLog, recent = 10): string[] {
  return log
    .all()
    .sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at))
    .slice(0, recent)
    .map((r) => r.contribution_angle)
    .filter((a): a is string => typeof a === "string" && a.trim().length > 0)
    .map((a) => a.replace(/\s+/g, " ").slice(0, 140));
}

/** Recent suggestions drafted by this system (not necessarily posted). Baseline drafter context only. */
export function buildEditorialMemory(log: CandidateLog, recent = 12): string {
  const sent = log
    .all()
    .sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at))
    .slice(0, recent)
    .map((r) => r.replies[r.replies.length - 1])
    .filter((r): r is string => typeof r === "string" && r.length > 0);
  // Normalised to the current register so old lowercase replies do not
  // anchor the model back into it.
  return sent.map((r) => `- ${toSentenceCase(r.replace(/\s+/g, " "))}`).join("\n");
}

interface Scored {
  post: NormalizedPost;
  account: WatchAccount;
  theme: ThemeResult;
  reason: ReasonResult;
  move: ReasonMove;
  depth: ReplyDepth;
  posture: string;
}

export async function runScan(deps: ScanDeps, opts: ScanOptions): Promise<ScanSummary> {
  const { config, log } = deps;
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const outcomes: PostOutcome[] = [];
  const breakdown: Record<MechanicalReason, number> = { seen: 0, repost: 0, reply: 0, empty: 0, spam: 0 };
  let errors = 0;

  const markFiltered = (
    post: NormalizedPost,
    stage: PostOutcome["stage"],
    reason: string,
    scores?: { theme?: number; expertise?: number; contribution?: number },
    extra?: Partial<PostOutcome>,
  ): void => {
    outcomes.push({
      tweet_id: post.tweet_id,
      author_handle: post.author_handle,
      tweet_url: post.tweet_url,
      stage,
      decision: "filtered",
      reason,
      ...extra,
    });
    if (opts.dryRun) return;
    deps.processed.record({
      tweet_id: post.tweet_id,
      first_seen_at: deps.processed.get(post.tweet_id)?.first_seen_at ?? startedAt,
      processed_at: now().toISOString(),
      decision: "filtered",
      stage,
      reason,
      author_handle: post.author_handle,
      ...(scores ? { scores } : {}),
    });
  };
  const markError = (post: NormalizedPost, stage: PostOutcome["stage"], error: string): void => {
    errors += 1;
    log.warn(`${stage} failed for ${post.tweet_url}: ${error}`);
    // Deliberately NOT recorded as processed — it will be retried next scan.
    outcomes.push({
      tweet_id: post.tweet_id,
      author_handle: post.author_handle,
      tweet_url: post.tweet_url,
      stage,
      decision: "error",
      reason: error,
    });
  };

  // ---- Fetch ---------------------------------------------------------
  const accounts = opts.handles
    ? deps.watchlist.filter((a) => opts.handles!.some((h) => h.toLowerCase() === a.handle.toLowerCase()))
    : deps.watchlist;
  const byHandle = new Map(accounts.map((a) => [a.handle.toLowerCase(), a] as const));
  log.info("Starting scan");
  log.info(`${accounts.length} accounts requested (source: ${deps.source.name}, since ${opts.since.toISOString()})`);

  const fetchOpts = {
    maxPostsPerAccount: config.maxPostsPerAccount,
    includeReplies: config.includeReplies,
    includeReposts: config.includeReposts,
  };
  const { known: knownAccounts, fresh: freshAccounts } = splitFirstTimers(accounts, opts.knownHandles);
  const backfillSince = opts.backfillSince !== undefined && opts.backfillSince < opts.since ? opts.backfillSince : undefined;
  let fetched: FetchPostsResult;
  if (opts.knownHandles !== undefined && backfillSince !== undefined && freshAccounts.length > 0) {
    log.info(`${freshAccounts.length} account(s) not fetched before; backfilling them since ${backfillSince.toISOString()}`);
    const [a, b] = await Promise.all([
      knownAccounts.length > 0 ? deps.source.fetchPosts(knownAccounts, opts.since, fetchOpts) : null,
      deps.source.fetchPosts(freshAccounts, backfillSince, fetchOpts),
    ]);
    fetched = mergeFetches(a, b);
  } else {
    fetched = await deps.source.fetchPosts(accounts, opts.since, fetchOpts);
  }
  const failures = fetched.accounts.filter((a) => !a.ok);
  log.info(`${fetched.accounts.length - failures.length} accounts successfully fetched`);
  if (failures.length > 0) {
    log.info(`${failures.length} account failures`);
    for (const f of failures.slice(0, 10)) log.debug(`  @${f.handle}: ${f.error ?? "unknown error"}`);
  }
  log.info(`${fetched.posts.length} posts fetched (${fetched.raw_count} raw items)`);

  // ---- Stage 1: mechanical ------------------------------------------
  const seen = (id: string): boolean => (opts.reprocess ? false : deps.processed.has(id));
  let admitted: NormalizedPost[] = [];
  for (const post of fetched.posts) {
    const r = mechanicalFilter(post, {
      includeReplies: config.includeReplies,
      includeReposts: config.includeReposts,
      seen,
    });
    if (r.pass) {
      admitted.push(post);
    } else {
      breakdown[r.reason] += 1;
      // Already-seen posts are not re-recorded; everything else is a decision.
      if (r.reason !== "seen") markFiltered(post, "mechanical", r.reason);
    }
  }
  // Long posts arrive cut at 280 from the actor; fill in the full text before anything reads them.
  const expanded = await expandTruncated(fetched.posts);
  if (expanded > 0) log.info(`${expanded} truncated post(s) expanded to full text`);
  const unseen = fetched.posts.length - breakdown.seen;
  const removedByBasic = breakdown.repost + breakdown.reply + breakdown.empty + breakdown.spam;
  log.info(`${unseen} unseen posts`);
  log.info(
    `${removedByBasic} removed by basic filters (reposts ${breakdown.repost}, replies ${breakdown.reply}, empty ${breakdown.empty}, spam ${breakdown.spam})`,
  );
  const cap = Math.min(config.maxPostsPerScan, opts.limit ?? Number.POSITIVE_INFINITY);
  if (admitted.length > cap) {
    log.warn(`capping LLM stages at ${cap} of ${admitted.length} posts (newest first)`);
    admitted = [...admitted]
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, cap);
  }

  // ---- Stage 2: theme -------------------------------------------------
  const themeOutcomes = await classifyThemes(admitted, {
    llm: deps.llm,
    themes: deps.themes,
    conversationalThemes: deps.policy ? config.conversationalThemes : [],
    batchSize: config.themeBatchSize,
    concurrency: config.llmConcurrency,
    log: (l) => log.debug(l),
  });
  const themed: Array<{ post: NormalizedPost; theme: ThemeResult }> = [];
  for (const post of admitted) {
    const o = themeOutcomes.get(post.tweet_id);
    if (!o) {
      markError(post, "theme", "no classification returned");
      continue;
    }
    if (!o.ok) {
      markError(post, "theme", o.error);
      continue;
    }
    if (!o.result.relevant || o.result.theme_score < config.themeThreshold) {
      markFiltered(post, "theme", `theme ${o.result.theme_score} < ${config.themeThreshold}: ${o.result.reason}`, { theme: o.result.theme_score }, { theme: o.result.theme, theme_score: o.result.theme_score });
      continue;
    }
    themed.push({ post, theme: o.result });
  }
  log.info(`${themed.length} theme candidates`);

  // ---- Stage 3: reason (unified) -------------------------------------
  // One call per post: is there a response the person would plausibly post,
  // what does it do (move), how deep, and how much grounding it needs.
  // Themes and the watchlist only decided the post was worth looking at.
  const recentAngles = config.promptProfile === "candidate" ? recentContributions(deps.candidateLog) : undefined;
  const reasonCtx = { digest: deps.digest ?? "", experienceIndex: deps.experienceIndex ?? "", boundaries: deps.kb.constraints, policy: deps.policy, profile: config.promptProfile, ...(recentAngles && recentAngles.length > 0 ? { recentAngles } : {}) };
  const accountOf = (post: NormalizedPost): WatchAccount => byHandle.get(post.author_handle.toLowerCase()) ?? { handle: post.author_handle, priority: 2 as const };
  const reasonResults = await mapWithConcurrency(themed, config.llmConcurrency, ({ post, theme }) =>
    settle(reasonAboutPost(post, theme.theme, { ...reasonCtx, authorPriority: accountOf(post).priority }, { llm: deps.llm })),
  );
  const scored: Scored[] = [];
  themed.forEach(({ post, theme }, i) => {
    const r = reasonResults[i]!;
    if (!r.ok) {
      markError(post, "reason", r.error.message);
      return;
    }
    const account = accountOf(post);
    const casual = r.value.move === "light_reaction" || r.value.move === "irony" || r.value.move === "thinking_out_loud";
    // Author is a soft prior, not a gate: a casual reply to an organization's feed needs to be exceptional.
    const bar = config.worthThreshold + (account.priority === 3 && casual ? 10 : 0);
    const scores = { theme: theme.theme_score, contribution: r.value.worth };
    if (r.value.move === "none" || r.value.worth < bar) {
      markFiltered(
        post,
        "reason",
        r.value.move === "none" ? `move none (${r.value.worth}): ${r.value.reason}` : `worth ${r.value.worth} < ${bar}: ${r.value.reason}`,
        scores,
        { theme: theme.theme, theme_score: theme.theme_score, contribution_score: r.value.worth, contribution_angle: r.value.angle },
      );
      return;
    }
    scored.push({
      post,
      account,
      theme,
      reason: r.value,
      move: r.value.move,
      // A short post never earns a deep reply, whatever the model said.
      depth: r.value.depth === "deep" && [...post.tweet_text].length < 100 ? "substantive" : r.value.depth,
      posture: r.value.posture,
    });
  });
  log.info(`${scored.length} worth replying (of ${themed.length} reasoned)`);

  // ---- Rank ------------------------------------------------------------
  const { selected, rankedOut } = rankCandidates(
    scored.map((s) => ({
      ...s,
      tweet_id: s.post.tweet_id,
      theme_score: s.theme.theme_score,
      expertise_score: s.reason.worth,
      contribution_score: s.reason.worth,
      account_priority: s.account.priority,
      created_at: s.post.created_at,
    })),
    { priorityBoost: config.priorityBoost, max: config.maxCandidatesPerScan },
  );
  for (const s of rankedOut) {
    markFiltered(
      s.post,
      "rank",
      `ranked out (cap ${config.maxCandidatesPerScan})`,
      { theme: s.theme_score, contribution: s.reason.worth },
      { theme: s.theme.theme, theme_score: s.theme_score, contribution_score: s.reason.worth, contribution_angle: s.reason.angle },
    );
  }
  if (rankedOut.length > 0) log.info(`${rankedOut.length} above threshold but ranked out by MAX_CANDIDATES_PER_SCAN`);

  // ---- Stage 4: ground + draft + verify ---------------------------------
  // Grounding is fetched only as the reasoning stage asked for it. Drafts run
  // in parallel; variety comes from what is known before drafting.
  const editorial = buildEditorialMemory(deps.candidateLog);
  const angleOf = (s: Scored): string => `[@${s.post.author_handle}, ${s.move}] ${s.reason.angle}`;
  const drafts = await mapWithConcurrency(selected, config.llmConcurrency, async (s, i) => {
    const g = await resolveGrounding(s.reason, s.post, s.theme.theme, { kb: deps.kb, facts: deps.facts, factCachePath: deps.factCachePath, topK: config.kbTopK, llm: deps.llm });
    const prev = selected[i - 1];
    const prev2 = selected[i - 2];
    const avoidMoves: ReasonMove[] = prev !== undefined && prev.move === s.move ? [prev.move] : [];
    const twoLongAbove = prev !== undefined && prev2 !== undefined && prev.depth !== "light" && prev2.depth !== "light";
    const nudgeShort = twoLongAbove && s.depth !== "light" && !["argument", "technical_explanation"].includes(s.posture);
    const common = {
      post: s.post,
      theme: s.theme.theme,
      angle: s.reason.angle,
      authorPoint: s.reason.author_point,
      chunks: g.chunks,
      tone: deps.kb.tone,
      digest: deps.digest,
      boundaries: deps.kb.constraints,
      policy: deps.policy,
      profile: config.promptProfile,
      maxChars: config.replyMaxChars,
      editorial,
      avoidPoints: selected.filter((o) => o !== s).map(angleOf),
      move: s.move,
      depth: s.depth,
      posture: s.posture,
      energy: s.reason.energy,
      experience: g.experience,
      fact: g.fact,
      unresolved: g.unresolved,
      llm: deps.llm,
    };
    let result = await settle(draftReply({ ...common, avoidMoves, avoidConcedeOpener: i > 0, ...(nudgeShort ? { lengthNudge: "short" as const } : {}) }));
    if (!result.ok) return result;
    let reasonUsed: ReasonResult = s.reason;
    let groundingUsed = g;
    if (config.promptProfile === "candidate" && result.value.angleProblem) {
      // The drafter could not say it without an unsupported assumption: let the reasoner pick again, once.
      const outcome = await reconsiderAngle(s.post, s.theme.theme, s.reason, result.value.angleProblem, { ...reasonCtx, authorPriority: s.account.priority }, { llm: deps.llm }, describeEvidence(g));
      if (outcome.kind === "none") {
        return { ok: true as const, value: { dropped: `reconsidered: none (${result.value.angleProblem})` } };
      }
      if (outcome.kind === "unavailable") log.warn(`reconsideration unavailable for ${s.post.tweet_url}, keeping the flagged draft: ${outcome.error}`);
      if (outcome.kind === "reasoned") {
        const r2 = outcome.reason;
        // The new contribution faces the same bar as the first one.
        const casual2 = r2.move === "light_reaction" || r2.move === "irony" || r2.move === "thinking_out_loud";
        const bar2 = config.worthThreshold + (s.account.priority === 3 && casual2 ? 10 : 0);
        if (r2.worth < bar2) {
          return { ok: true as const, value: { dropped: `reconsidered: worth ${r2.worth} < ${bar2} (${result.value.angleProblem})` } };
        }
        const g2 = await resolveGrounding(r2, s.post, s.theme.theme, { kb: deps.kb, facts: deps.facts, factCachePath: deps.factCachePath, topK: config.kbTopK, llm: deps.llm });
        const again = await settle(draftReply({ ...common, angle: r2.angle, authorPoint: r2.author_point, chunks: g2.chunks, move: r2.move, depth: r2.depth, posture: r2.posture, energy: r2.energy, experience: g2.experience, fact: g2.fact, unresolved: g2.unresolved, avoidMoves, avoidConcedeOpener: i > 0 }));
        if (again.ok) {
          result = again;
          reasonUsed = r2;
          groundingUsed = g2;
          log.info(`reconsidered angle for ${s.post.tweet_url}: ${r2.move}`);
        }
      }
    }
    // Alternates come from the contribution that was accepted, not the one that may have been reconsidered away.
    const accepted = reasonUsed === s.reason ? common : { ...common, angle: reasonUsed.angle, authorPoint: reasonUsed.author_point, chunks: groundingUsed.chunks, move: reasonUsed.move, depth: reasonUsed.depth, posture: reasonUsed.posture, energy: reasonUsed.energy, experience: groundingUsed.experience, fact: groundingUsed.fact, unresolved: groundingUsed.unresolved };
    const alternates: string[] = [];
    for (let v = 1; v < config.draftVariants; v += 1) {
      const alt = await settle(draftReply({ ...accepted, previousReplies: [result.value.suggested_reply, ...alternates], ...(v === 1 ? { lengthNudge: "short" as const } : {}) }));
      if (!alt.ok) {
        log.warn(`alternate draft ${v} failed for ${s.post.tweet_url}: ${alt.error.message}`);
        continue;
      }
      const text = alt.value.suggested_reply;
      if (text !== result.value.suggested_reply && !alternates.includes(text)) alternates.push(text);
    }
    return { ok: true as const, value: { ...result.value, alternates, grounding: groundingUsed, reason: reasonUsed, dropped: undefined as string | undefined } };
  });
  const ready: ScoredDraft[] = [];
  selected.forEach((s, i) => {
    const d = drafts[i]!;
    if (!d.ok) {
      markError(s.post, "draft", d.error.message);
      return;
    }
    if (d.value.dropped !== undefined || !("suggested_reply" in d.value)) {
      // The drafter flagged the point and the reasoner, asked again, found nothing worth saying.
      markFiltered(
        s.post,
        "reason",
        d.value.dropped ?? "reconsidered: none",
        { theme: s.theme.theme_score, contribution: s.reason.worth },
        { theme: s.theme.theme, theme_score: s.theme.theme_score, contribution_score: s.reason.worth, contribution_angle: s.reason.angle },
      );
      return;
    }
    const kbFiles = Array.from(new Set(d.value.grounding.chunks.map((c) => c.file)));
    const rz = d.value.reason;
    const move = rz.move;
    const depth = rz.depth === "deep" && [...s.post.tweet_text].length < 100 ? "substantive" : rz.depth;
    ready.push({
      post: s.post,
      theme: s.theme.theme,
      theme_score: s.theme_score,
      expertise_score: 0,
      contribution_score: rz.worth,
      contribution_angle: rz.angle,
      account_priority: s.account.priority,
      kb_files: kbFiles,
      suggested_reply: d.value.suggested_reply,
      ai_tell_flags: d.value.ai_tell_flags,
      move,
      depth,
      posture: rz.posture,
      energy: rz.energy,
      grounding: rz.grounding,
      worth: rz.worth,
      ...(d.value.grounding.unresolved ? { unresolved: d.value.grounding.unresolved } : {}),
    });
    if (!opts.dryRun) {
      deps.candidateLog.upsert({
        tweet_id: s.post.tweet_id,
        recorded_at: now().toISOString(),
        post: s.post,
        theme: s.theme.theme,
        theme_score: s.theme_score,
        expertise_score: 0,
        contribution_score: rz.worth,
        contribution_angle: rz.angle,
        account_priority: s.account.priority,
        kb_refs: kbFiles,
        chunk_refs: d.value.grounding.chunks.map((c) => c.ref),
        replies: [d.value.suggested_reply],
        moves: [move],
        depth,
        posture: rz.posture,
        grounding: rz.grounding,
        profile: config.promptProfile,
        ...(rz.fact_dependency ? { fact_dependency: rz.fact_dependency } : {}),
        ...(rz.author_point ? { author_point: rz.author_point } : {}),
        ...(rz.kb_query ? { kb_query: rz.kb_query } : {}),
        ...(d.value.alternates.length > 0 ? { alternates: d.value.alternates } : {}),
      });
    }
  });
  log.info(`${ready.length} replies drafted`);

  // ---- Send to Wingman -------------------------------------------------
  let sent = 0;
  if (ready.length > 0 && deps.sink !== null && !opts.dryRun) {
    const inputs = ready.map(toWingmanCandidate);
    try {
      const res = await deps.sink.postCandidates(inputs);
      sent = res.accepted;
      for (const r of ready) {
        outcomes.push({
          tweet_id: r.post.tweet_id,
          author_handle: r.post.author_handle,
          tweet_url: r.post.tweet_url,
          stage: "sent",
          decision: "candidate",
          theme: r.theme,
          theme_score: r.theme_score,
          expertise_score: r.expertise_score,
          contribution_score: r.contribution_score,
          contribution_angle: r.contribution_angle,
          suggested_reply: r.suggested_reply,
        });
        deps.processed.record({
          tweet_id: r.post.tweet_id,
          first_seen_at: deps.processed.get(r.post.tweet_id)?.first_seen_at ?? startedAt,
          processed_at: now().toISOString(),
          decision: "candidate",
          stage: "wingman",
          author_handle: r.post.author_handle,
          scores: { theme: r.theme_score, expertise: r.expertise_score, contribution: r.contribution_score },
        });
      }
    } catch (err) {
      // POST failed: nothing is marked processed, so the next scan retries.
      errors += ready.length;
      log.warn(`sending candidates to Wingman failed: ${(err as Error).message}`);
      for (const r of ready) {
        outcomes.push({
          tweet_id: r.post.tweet_id,
          author_handle: r.post.author_handle,
          tweet_url: r.post.tweet_url,
          stage: "sent",
          decision: "error",
          reason: (err as Error).message,
          suggested_reply: r.suggested_reply,
        });
      }
    }
  } else {
    for (const r of ready) {
      outcomes.push({
        tweet_id: r.post.tweet_id,
        author_handle: r.post.author_handle,
        tweet_url: r.post.tweet_url,
        stage: "draft",
        decision: "candidate",
        theme: r.theme,
        theme_score: r.theme_score,
        expertise_score: r.expertise_score,
        contribution_score: r.contribution_score,
        contribution_angle: r.contribution_angle,
        suggested_reply: r.suggested_reply,
      });
    }
  }
  log.info(opts.dryRun ? `${ready.length} candidates (dry run — not sent)` : `${sent} candidates sent to Wingman`);
  if (errors > 0) log.info(`${errors} post(s) hit errors and will be retried next scan`);

  const usage = deps.llm.usage();
  return {
    started_at: startedAt,
    completed_at: now().toISOString(),
    since: opts.since.toISOString(),
    source: fetched.source,
    dry_run: opts.dryRun,
    accounts_requested: accounts.length,
    accounts_fetched: fetched.accounts.length - failures.length,
    accounts_fetched_ok: fetched.accounts.filter((a) => a.ok).map((a) => a.handle),
    account_failures: failures.map((f) => ({ handle: f.handle, error: f.error ?? "unknown" })),
    posts_fetched: fetched.posts.length,
    raw_items: fetched.raw_count,
    unseen_posts: unseen,
    removed_by_basic_filters: removedByBasic,
    basic_filter_breakdown: breakdown,
    theme_candidates: themed.length,
    expertise_candidates: themed.length,
    contribution_candidates: scored.length,
    conversational_candidates: ready.filter((r) => r.grounding === "none").length,
    ranked_out: rankedOut.length,
    drafted: ready.length,
    sent,
    errors,
    llm: {
      provider: deps.llm.name,
      calls: usage.calls,
      failures: usage.failures,
      cost_usd: usage.costUsd,
      elapsed_ms: usage.elapsedMs,
    },
    candidates: ready.map((r) => ({
      tweet_id: r.post.tweet_id,
      tweet_url: r.post.tweet_url,
      author_handle: r.post.author_handle,
      theme: r.theme,
      theme_score: r.theme_score,
      expertise_score: r.expertise_score,
      contribution_score: r.contribution_score,
      contribution_angle: r.contribution_angle,
      suggested_reply: r.suggested_reply,
      ai_tell_flags: r.ai_tell_flags,
      ...(r.move !== undefined ? { move: r.move } : {}),
      ...(r.depth !== undefined ? { depth: r.depth } : {}),
      ...(r.posture !== undefined ? { posture: r.posture } : {}),
      ...(r.lane !== undefined ? { lane: r.lane } : {}),
      ...(r.grounding !== undefined ? { grounding: r.grounding } : {}),
      ...(r.worth !== undefined ? { worth: r.worth } : {}),
    })),
    outcomes,
  };
}
