import type { CandidateInput } from "@wingman-x/agent-kit";
import type { Config } from "../config.js";
import type { KBIndex } from "../kb/kb-index.js";
import type { LLMProvider } from "../llm/provider.js";
import type { NormalizedPost } from "../model/post.js";
import type { CandidateLog } from "../state/candidate-log.js";
import { toWingmanCandidate, type ScoredDraft } from "../wingman/candidate-map.js";
import { resolveGrounding, type FactArchive } from "./ground.js";
import { draftReply } from "./stages/draft.js";
import { reasonAboutPost } from "./stages/reason.js";
import { describeEvidence, reconsiderAngle } from "./reconsider.js";
import { classifyThemes } from "./stages/theme.js";

/**
 * "I want in on this one." The person hands us a post; there is no worth
 * gate (they already decided), but the same reasoning, grounding, drafting,
 * and verification run, so the card is as good as a scanned one.
 */
export interface SingleDeps {
  config: Config;
  llm: LLMProvider;
  kb: KBIndex;
  themes: readonly string[];
  digest: string;
  experienceIndex: string;
  policy?: string;
  facts?: FactArchive;
  factCachePath?: string;
  candidateLog: CandidateLog;
  postCandidates(cs: CandidateInput[]): Promise<{ accepted: number }>;
  now?: () => Date;
}

export interface SingleResult {
  candidate: CandidateInput;
  theme: string;
  move: string;
  grounding: string;
  reply: string;
}

export async function runSinglePost(post: NormalizedPost, deps: SingleDeps, instruction?: string): Promise<SingleResult> {
  const now = deps.now ?? (() => new Date());
  const { config } = deps;

  // Theme is a label here, nothing more.
  const themed = await classifyThemes([post], { llm: deps.llm, themes: deps.themes, batchSize: 1 });
  const t = themed.get(post.tweet_id);
  const theme = t?.ok ? t.result.theme : deps.themes[0] ?? "General";
  const themeScore = t?.ok ? t.result.theme_score : 0;

  const reasonCtx = { digest: deps.digest, experienceIndex: deps.experienceIndex, boundaries: deps.kb.constraints, policy: deps.policy, profile: config.promptProfile, authorPriority: 1 as const, mustReply: true, ...(instruction ? { instruction } : {}) };
  let reason = await reasonAboutPost(post, theme, reasonCtx, { llm: deps.llm });
  // The person asked for a reply, so none cannot stand; it is written as a light reaction and marked for review rather than relabelled silently.
  const reviewFlags: string[] = [];
  if (reason.move === "none") reviewFlags.push("review:reasoner-none");
  let move = reason.move === "none" ? "light_reaction" : reason.move;
  let depth = reason.depth === "deep" && [...post.tweet_text].length < 100 ? "substantive" : reason.depth;
  let g = await resolveGrounding({ ...reason, move }, post, theme, { kb: deps.kb, facts: deps.facts, factCachePath: deps.factCachePath, topK: config.kbTopK, llm: deps.llm });
  const draftOnce = () => draftReply({
    post,
    theme,
    angle: reason.angle,
    authorPoint: reason.author_point,
    chunks: g.chunks,
    tone: deps.kb.tone,
    digest: deps.digest,
    boundaries: deps.kb.constraints,
    policy: deps.policy,
    profile: config.promptProfile,
    maxChars: config.replyMaxChars,
    move,
    depth,
    posture: reason.posture,
    energy: reason.energy,
    experience: g.experience,
    fact: g.fact,
    unresolved: g.unresolved,
    ...(instruction ? { instruction } : {}),
    llm: deps.llm,
  });
  let d = await draftOnce();
  if (config.promptProfile === "candidate" && d.angleProblem) {
    const outcome = await reconsiderAngle(post, theme, reason, d.angleProblem, reasonCtx, { llm: deps.llm }, describeEvidence(g));
    if (outcome.kind === "none") reviewFlags.push("review:reconsidered-none");
    if (outcome.kind === "unavailable") reviewFlags.push("review:reconsideration-unavailable");
    if (outcome.kind === "reasoned") {
      const r2 = outcome.reason;
      reason = r2;
      move = r2.move === "none" ? "light_reaction" : r2.move;
      depth = r2.depth === "deep" && [...post.tweet_text].length < 100 ? "substantive" : r2.depth;
      g = await resolveGrounding({ ...r2, move }, post, theme, { kb: deps.kb, facts: deps.facts, factCachePath: deps.factCachePath, topK: config.kbTopK, llm: deps.llm });
      d = await draftOnce();
    }
  }

  const draft: ScoredDraft = {
    post,
    theme,
    theme_score: themeScore,
    expertise_score: 0,
    contribution_score: reason.worth,
    contribution_angle: reason.angle,
    account_priority: 1,
    kb_files: Array.from(new Set(g.chunks.map((k) => k.file))),
    suggested_reply: d.suggested_reply,
    ai_tell_flags: [...d.ai_tell_flags, ...reviewFlags],
    move,
    depth,
    posture: reason.posture,
    energy: reason.energy,
    grounding: reason.grounding,
    worth: reason.worth,
    ...(g.unresolved ? { unresolved: g.unresolved } : {}),
  };
  deps.candidateLog.upsert({
    tweet_id: post.tweet_id,
    recorded_at: now().toISOString(),
    post,
    theme,
    theme_score: themeScore,
    expertise_score: 0,
    contribution_score: reason.worth,
    contribution_angle: reason.angle,
    account_priority: 1,
    kb_refs: draft.kb_files,
    chunk_refs: g.chunks.map((k) => k.ref),
    replies: [d.suggested_reply],
    moves: [move],
    depth,
    posture: reason.posture,
    grounding: reason.grounding,
    profile: config.promptProfile,
    ...(reason.fact_dependency ? { fact_dependency: reason.fact_dependency } : {}),
    ...(reason.author_point ? { author_point: reason.author_point } : {}),
    ...(reason.kb_query ? { kb_query: reason.kb_query } : {}),
    ...(instruction ? { instructions: [instruction] } : {}),
  });

  const candidate = toWingmanCandidate(draft);
  await deps.postCandidates([candidate]);
  return { candidate, theme, move, grounding: reason.grounding, reply: d.suggested_reply };
}
