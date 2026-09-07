import type { Candidate, CandidateInput } from "@wingman-x/agent-kit";
import type { Config } from "../config.js";
import type { KBIndex } from "../kb/kb-index.js";
import { buildEditorialMemory } from "./scan.js";
import type { LLMProvider } from "../llm/provider.js";
import { NormalizedPostSchema, canonicalTweetUrl, type NormalizedPost } from "../model/post.js";
import type { CandidateLog } from "../state/candidate-log.js";
import type { ScanState } from "../state/scan-state.js";
import type { Logger } from "../util/logger.js";
import { parseAngleFromMatchReason } from "../wingman/candidate-map.js";
import { draftReply, hasConcedeOpener } from "./stages/draft.js";
import { ReplyDepthSchema, type ReplyDepth } from "./stages/contribution.js";
import { ReasonMoveSchema, reasonAboutPost, type ReasonMove, type ReasonResult } from "./stages/reason.js";
import { resolveGrounding, type FactArchive } from "./ground.js";
import { describeEvidence, reconsiderAngle } from "./reconsider.js";

/**
 * Which move the regenerated reply should use. The first regeneration keeps
 * the original move and produces a meaningfully different version of it (the
 * move was probably right and the wording was not). From the second
 * regeneration on, the move itself is switched to one not yet tried.
 */
export function nextRegenMove(previousMoves: readonly string[]): ReasonMove {
  if (previousMoves.length <= 1) return (previousMoves[0] as ReasonMove | undefined) ?? "agree_extend";
  const order: ReasonMove[] = ["agree_extend", "question", "example", "distinction", "light_reaction", "challenge", "operator_context", "thinking_out_loud", "irony"];
  const used = new Set(previousMoves);
  return order.find((m) => !used.has(m)) ?? "agree_extend";
}
import { retrievalQuery } from "./stages/expertise.js";

/**
 * Regeneration. Wingman's ♻️ button sets a candidate's status to
 * `regen_requested`; nothing in Wingman consumes that, so we do: every
 * scan (or `npm run regen`) redrafts those candidates with the original
 * post, prior reply, KB excerpts, tone guide and contribution angle,
 * then re-POSTs. The daemon's merge keeps the status, so we remember the
 * `status_updated_at` we served to avoid redrafting the same click twice.
 */
export interface RegenDeps {
  config: Config;
  llm: LLMProvider;
  kb: KBIndex;
  candidateLog: CandidateLog;
  state: ScanState;
  getCandidates(): Promise<Candidate[]>;
  postCandidates(cs: CandidateInput[]): Promise<{ accepted: number }>;
  /** Casual-reply policy. */
  policy?: string;
  /** Always-present context and fact archive for the unified drafter. */
  digest?: string;
  experienceIndex?: string;
  facts?: FactArchive;
  factCachePath?: string;
  log: Logger;
  now?: () => Date;
  /** Redraft even if the current ♻️ click was already served. */
  force?: boolean;
  /** Watch mode sweeps every minute; do not repeat the "already served" notice each time. */
  quietServed?: boolean;
  /** Guided regen: instruction per tweet_id, for candidates without a log record. Log records win. */
  instructions?: Map<string, string>;
}

export interface RegenSummary {
  requested: number;
  regenerated: number;
  failed: number;
  /** Candidates in regen_requested whose last click was already served. */
  already_served: number;
  /** Regens answered from pre-generated alternates, no model call. */
  served_from_alternates: number;
  /** Cards the person filled since last run, recorded to the candidate log. */
  fills_recorded: number;
}

/**
 * Record what was live on each card the person filled. Wingman marks the
 * candidate `filled` and keeps the suggested_reply that was showing, which
 * is the closest thing to a preference signal this system has.
 */
export function recordFills(candidates: Candidate[], log: CandidateLog): number {
  let n = 0;
  for (const c of candidates) {
    if (c.status !== "filled" || !c.id.startsWith("chime-")) continue;
    const logged = log.get(c.tweet_id);
    if (!logged || logged.filled_at === c.status_updated_at) continue;
    log.upsert({ ...logged, filled_reply: c.suggested_reply, filled_at: c.status_updated_at });
    n += 1;
  }
  return n;
}

export function pendingRegens(candidates: Candidate[], state: ScanState, force = false): Candidate[] {
  return candidates.filter(
    (c) =>
      c.status === "regen_requested" &&
      c.id.startsWith("chime-") &&
      (force || state.regen_handled[c.tweet_id] !== c.status_updated_at),
  );
}

/** Regen-requested candidates whose current click has already been served. */
export function servedRegens(candidates: Candidate[], state: ScanState): Candidate[] {
  return candidates.filter(
    (c) =>
      c.status === "regen_requested" &&
      c.id.startsWith("chime-") &&
      state.regen_handled[c.tweet_id] === c.status_updated_at,
  );
}

function postFromCandidate(c: Candidate, nowIso: string): NormalizedPost {
  const handle = c.author_handle.replace(/^@/, "");
  return NormalizedPostSchema.parse({
    tweet_id: c.tweet_id,
    tweet_url: c.tweet_url,
    author_handle: handle,
    tweet_text: c.tweet_text,
    created_at: c.created_at,
    scraped_at: nowIso,
  });
}

export async function runRegen(deps: RegenDeps): Promise<RegenSummary> {
  const now = deps.now ?? (() => new Date());
  const candidates = await deps.getCandidates();
  const pending = pendingRegens(candidates, deps.state, deps.force === true);
  const served = deps.force === true ? [] : servedRegens(candidates, deps.state);
  const summary: RegenSummary = {
    requested: pending.length,
    regenerated: 0,
    failed: 0,
    already_served: served.length,
    served_from_alternates: 0,
    fills_recorded: recordFills(candidates, deps.candidateLog),
  };
  if (summary.fills_recorded > 0) deps.log.info(`recorded ${summary.fills_recorded} filled reply(ies) to the candidate log`);
  if (pending.length === 0) {
    if (served.length > 0 && !deps.quietServed) {
      deps.log.info(
        `${served.length} candidate(s) still marked ♻️ but their last click was already served. Press ♻️ again in the extension, or run with --force to redraft anyway.`,
      );
    }
    return summary;
  }
  deps.log.info(`${pending.length} regeneration request(s) pending`);

  for (const c of pending) {
    const logged = deps.candidateLog.get(c.tweet_id);
    const post = logged?.post ?? postFromCandidate(c, now().toISOString());
    const theme = logged?.theme ?? "unknown";
    const angle =
      logged?.contribution_angle ?? parseAngleFromMatchReason(c.match_reason) ?? "Add the most specific, non-obvious point the knowledge base supports.";
    const previous = Array.from(new Set([...(logged?.replies ?? []), c.suggested_reply]));
    const previousMoves = (logged?.moves ?? []).filter((m): m is ReasonMove => ReasonMoveSchema.safeParse(m).success);

    // Guided regen: the person said what to change. Skip alternates (they
    // were drafted before the instruction) and keep the same move.
    const instruction = logged?.regen_instruction ?? deps.instructions?.get(c.tweet_id);
    // Earlier instructions keep applying: "make it longer" is not undone by the next ♻️ tap.
    const standing = (logged?.instructions ?? []).filter((s) => s.trim() && s.trim() !== instruction?.trim());

    // Serve a pre-generated alternate first: same move, different shape,
    // no model call. The model path below is for when they run out.
    const unusedAlternates = (logged?.alternates ?? []).filter((a) => !previous.includes(a));
    // Leftover alternates from the multi-variant era carry no verifier or angle flags; serve them only when variants are deliberately enabled.
    if (deps.config.draftVariants > 1 && logged && unusedAlternates.length > 0 && !instruction && standing.length === 0) {
      const [next, ...rest] = unusedAlternates;
      try {
        await deps.postCandidates([
          {
            id: c.id,
            tweet_id: c.tweet_id,
            tweet_url: c.tweet_url,
            author_handle: c.author_handle,
            tweet_text: c.tweet_text,
            suggested_reply: next!,
            match_reason: c.match_reason,
            match_category: c.match_category,
            source: c.source,
            kb_refs: c.kb_refs,
          },
        ]);
        deps.state.regen_handled[c.tweet_id] = c.status_updated_at;
        deps.candidateLog.upsert({
          ...logged,
          replies: [...previous, next!],
          moves: [...previousMoves, previousMoves[previousMoves.length - 1] ?? "agree_extend"],
          alternates: rest,
        });
        summary.regenerated += 1;
        summary.served_from_alternates += 1;
        deps.log.info(`served alternate draft for ${canonicalTweetUrl(post.author_handle, c.tweet_id)} (${rest.length} left)`);
      } catch (err) {
        summary.failed += 1;
        deps.log.warn(`regen failed for ${c.tweet_url}: ${(err as Error).message}`);
      }
      continue;
    }
    const lastMove = previousMoves[previousMoves.length - 1];
    // Re-think before redrafting. A plain ♻️ means the point was wrong, not only its shape, so the
    // reasoner runs again with every earlier contribution excluded. With an instruction, the reasoner
    // sees the instruction and the earlier contributions and decides whether the point changes.
    // Falls back to reshaping the logged angle when no reasoning context is available or the call fails.
    const priorAngles = Array.from(new Set([...(logged?.angles ?? []), angle].filter((a) => a && a.trim())));
    let rethought: ReasonResult | undefined;
    let reasonerNone = false;
    if (deps.digest !== undefined || deps.experienceIndex !== undefined) {
      try {
        const r = await reasonAboutPost(
          post,
          theme,
          {
            digest: deps.digest ?? "",
            experienceIndex: deps.experienceIndex ?? "",
            boundaries: deps.kb.constraints,
            policy: deps.policy,
            profile: deps.config.promptProfile,
            authorPriority: ((logged?.account_priority as 1 | 2 | 3 | undefined) ?? 2),
            mustReply: true,
            ...(standing.length > 0 ? { standingInstructions: standing } : {}),
            ...(instruction ? { instruction, priorAngles } : { avoidAngles: priorAngles }),
          },
          { llm: deps.llm },
        );
        // The person tapped regenerate, so none cannot stand; it is written as a light reaction and marked for review, never relabelled silently.
        if (r.move === "none") reasonerNone = true;
        rethought = { ...r, move: r.move === "none" ? "light_reaction" : r.move };
      } catch (err) {
        deps.log.warn(`regen: re-reasoning failed for ${c.tweet_url}, redrafting the logged angle: ${(err as Error).message}`);
      }
    }
    let move: ReasonMove = rethought ? rethought.move : instruction && lastMove !== undefined ? lastMove : nextRegenMove(previousMoves);
    const loggedDepth = ReplyDepthSchema.safeParse(logged?.depth);
    let depth: ReplyDepth = rethought
      ? rethought.depth === "deep" && [...post.tweet_text].length < 100 ? "substantive" : rethought.depth
      : loggedDepth.success ? loggedDepth.data : "substantive";
    let angleUsed = rethought ? rethought.angle : angle;
    let authorPoint = rethought?.author_point ?? logged?.author_point;
    // Re-resolve grounding the way the original draft did (grounding decision is logged).
    const libraryRefs = c.kb_refs.filter((r) => r !== "tone.md" && r !== "conversational.md");
    const grounding =
      (["none", "kb", "experience", "verify", "hybrid"] as const).find((g) => g === logged?.grounding) ??
      ((logged?.chunk_refs.length ?? 0) > 0 || libraryRefs.length > 0 ? "kb" : "none");
    const pseudoReason: ReasonResult = { worth: 0, reason: "", move, depth, posture: "other", energy: "casual", angle, grounding, kb_query: logged?.kb_query, fact_dependency: logged?.fact_dependency, wants_first_person: move === "operator_context" };
    let g = await resolveGrounding(rethought ?? pseudoReason, post, theme, { kb: deps.kb, facts: deps.facts, factCachePath: deps.factCachePath, topK: deps.config.kbTopK, llm: deps.llm });
    // A re-thought contribution grounds itself fresh; a reshaped one prefers what the first draft was grounded on.
    let chunks = rethought ? g.chunks : logged ? deps.kb.chunksByRef(logged.chunk_refs) : [];
    if (chunks.length === 0 && !rethought) chunks = g.chunks;
    if (!rethought && chunks.length === 0 && libraryRefs.length > 0) chunks = deps.kb.chunksForFiles(libraryRefs, deps.config.kbTopK);
    if (!rethought && chunks.length === 0 && grounding !== "none") chunks = deps.kb.search(retrievalQuery(post, theme), deps.config.kbTopK);

    try {
      const draftArgs = {
        post,
        theme,
        angle: angleUsed,
        authorPoint,
        chunks,
        tone: deps.kb.tone,
        digest: deps.digest,
        boundaries: deps.kb.constraints,
        policy: deps.policy,
        profile: deps.config.promptProfile,
        maxChars: deps.config.replyMaxChars,
        editorial: buildEditorialMemory(deps.candidateLog),
        move,
        depth,
        posture: rethought?.posture ?? logged?.posture,
        energy: rethought?.energy,
        experience: g.experience,
        fact: g.fact,
        unresolved: g.unresolved,
        avoidMoves: previousMoves.filter((m) => m !== move),
        avoidConcedeOpener: !instruction && hasConcedeOpener(c.suggested_reply),
        previousReplies: previous,
        ...(instruction ? { instruction } : {}),
        ...(standing.length > 0 ? { standingInstructions: standing } : {}),
        llm: deps.llm,
      };
      let draft = await draftReply(draftArgs);
      const reviewFlags: string[] = reasonerNone ? ["review:reasoner-none"] : [];
      if (deps.config.promptProfile === "candidate" && draft.angleProblem) {
        // Same rule as scans and pasted links: the drafter flagged the point, the reasoner picks again once.
        const outcome = await reconsiderAngle(post, theme, rethought ?? pseudoReason, draft.angleProblem, {
          digest: deps.digest ?? "",
          experienceIndex: deps.experienceIndex ?? "",
          boundaries: deps.kb.constraints,
          policy: deps.policy,
          profile: deps.config.promptProfile,
          authorPriority: ((logged?.account_priority as 1 | 2 | 3 | undefined) ?? 2),
          mustReply: true,
          avoidAngles: priorAngles,
          ...(instruction ? { instruction } : {}),
          ...(standing.length > 0 ? { standingInstructions: standing } : {}),
        }, { llm: deps.llm }, describeEvidence(g));
        if (outcome.kind === "none") reviewFlags.push("review:reconsidered-none");
        if (outcome.kind === "unavailable") reviewFlags.push("review:reconsideration-unavailable");
        if (outcome.kind === "reasoned") {
          const r3 = outcome.reason;
          rethought = r3;
          move = r3.move;
          depth = r3.depth === "deep" && [...post.tweet_text].length < 100 ? "substantive" : r3.depth;
          angleUsed = r3.angle;
          authorPoint = r3.author_point ?? authorPoint;
          g = await resolveGrounding(r3, post, theme, { kb: deps.kb, facts: deps.facts, factCachePath: deps.factCachePath, topK: deps.config.kbTopK, llm: deps.llm });
          draft = await draftReply({ ...draftArgs, angle: angleUsed, authorPoint, chunks: g.chunks, move, depth, posture: r3.posture, energy: r3.energy, experience: g.experience, fact: g.fact, unresolved: g.unresolved });
        }
      }
      const input: CandidateInput = {
        id: c.id,
        tweet_id: c.tweet_id,
        tweet_url: c.tweet_url,
        author_handle: c.author_handle,
        tweet_text: c.tweet_text,
        suggested_reply: draft.suggested_reply,
        match_reason: angleUsed !== angle && /Angle: /.test(c.match_reason) ? c.match_reason.replace(/Angle: [\s\S]*$/, `Angle: ${angleUsed}`) : c.match_reason,
        match_category: c.match_category,
        source: c.source,
        // Card and log describe the same accepted evidence.
        kb_refs: rethought ? Array.from(new Set([...g.chunks.map((k) => k.file), "tone.md"])) : c.kb_refs,
        ...(draft.ai_tell_flags.length > 0 || reviewFlags.length > 0 ? { ai_tell_flags: [...draft.ai_tell_flags, ...reviewFlags] } : {}),
      };
      await deps.postCandidates([input]);
      deps.state.regen_handled[c.tweet_id] = c.status_updated_at;
      if (logged) {
        const { regen_instruction: _consumed, ...rest } = logged;
        deps.candidateLog.upsert({
          ...rest,
          replies: [...previous, draft.suggested_reply],
          moves: [...previousMoves, move],
          angles: priorAngles.includes(angleUsed) ? priorAngles : [...priorAngles, angleUsed],
          contribution_angle: angleUsed,
          ...(rethought ? { contribution_score: rethought.worth } : {}),
          ...(authorPoint ? { author_point: authorPoint } : {}),
          profile: deps.config.promptProfile,
          ...(rethought
            ? {
                grounding: rethought.grounding,
                depth,
                posture: rethought.posture,
                chunk_refs: g.chunks.map((k) => k.ref),
                kb_refs: Array.from(new Set(g.chunks.map((k) => k.file))),
                // Set explicitly so a stale query or dependency from the previous point does not survive the spread above.
                kb_query: rethought.kb_query,
                fact_dependency: rethought.fact_dependency,
              }
            : {}),
          ...(instruction ? { instructions: [...(logged.instructions ?? []), instruction] } : {}),
        });
      }
      deps.instructions?.delete(c.tweet_id);
      summary.regenerated += 1;
      deps.log.info(`regenerated reply for ${canonicalTweetUrl(post.author_handle, c.tweet_id)}${rethought ? ` (re-thought: ${move})` : ""}${instruction ? ` (instruction: ${instruction.slice(0, 60)})` : standing.length > 0 ? ` (standing: ${standing.length})` : ""}`);
    } catch (err) {
      summary.failed += 1;
      deps.log.warn(`regen failed for ${c.tweet_url}: ${(err as Error).message}`);
    }
  }
  return summary;
}
