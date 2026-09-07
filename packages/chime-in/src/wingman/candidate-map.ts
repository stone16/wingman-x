import { CandidateInputSchema, type CandidateInput } from "@wingman-x/agent-kit";
import type { NormalizedPost } from "../model/post.js";

/**
 * Map a scored, drafted post onto Wingman's existing `CandidateInput`
 * without touching its schema. Reasoning goes into `match_reason`; KB
 * files into `kb_refs`; priority-1 accounts become `selected` so the
 * popup pill distinguishes them.
 */
export interface ScoredDraft {
  post: NormalizedPost;
  theme: string;
  theme_score: number;
  expertise_score: number;
  contribution_score: number;
  contribution_angle: string;
  account_priority: 1 | 2 | 3;
  kb_files: string[];
  suggested_reply: string;
  ai_tell_flags: string[];
  move?: string;
  depth?: string;
  posture?: string;
  lane?: "expertise" | "conversational";
  line_type?: string;
  energy?: string;
  /** Unified engine: how much grounding the reply used, and the worth score. */
  grounding?: string;
  worth?: number;
  /** A factual dependency that could not be verified; shown on the card. */
  unresolved?: string;
}

export function candidateId(tweetId: string): string {
  return `chime-${tweetId}`;
}

export function formatMatchReason(s: {
  theme: string;
  theme_score: number;
  expertise_score: number;
  contribution_score: number;
  contribution_angle: string;
  lane?: "expertise" | "conversational";
  line_type?: string;
  energy?: string;
  grounding?: string;
  worth?: number;
  unresolved?: string;
}): string {
  if (s.worth !== undefined) {
    return [
      `Theme: ${s.theme} (${Math.round(s.theme_score)})`,
      `Worth: ${Math.round(s.worth)}`,
      `Move: ${s.line_type ?? "?"}`,
      `Grounding: ${s.grounding ?? "none"}`,
      ...(s.unresolved ? [`Unverified: ${s.unresolved}`] : []),
      `Angle: ${s.contribution_angle.trim()}`,
    ].join(" | ");
  }
  if (s.lane === "conversational") {
    return [
      "Lane: conversational",
      `Theme: ${s.theme} (${Math.round(s.theme_score)})`,
      `Line: ${Math.round(s.contribution_score)}`,
      `Type: ${s.line_type ?? "?"}`,
      `Energy: ${s.energy ?? "?"}`,
      `Angle: ${s.contribution_angle.trim()}`,
    ].join(" | ");
  }
  return [
    `Theme: ${s.theme} (${Math.round(s.theme_score)})`,
    `Expertise: ${Math.round(s.expertise_score)}`,
    `Contribution: ${Math.round(s.contribution_score)}`,
    `Angle: ${s.contribution_angle.trim()}`,
  ].join(" | ");
}

/** Parse the angle back out of a stored match_reason (for regen without a log). */
export function parseAngleFromMatchReason(reason: string): string | null {
  const m = /Angle:\s*(.+)$/s.exec(reason);
  return m?.[1]?.trim() || null;
}

export function toWingmanCandidate(s: ScoredDraft): CandidateInput {
  const kbRefs = Array.from(new Set([...s.kb_files, "tone.md"]));
  const input: CandidateInput = {
    id: candidateId(s.post.tweet_id),
    tweet_id: s.post.tweet_id,
    tweet_url: s.post.tweet_url,
    author_handle: `@${s.post.author_handle}`,
    tweet_text: s.post.tweet_text,
    suggested_reply: s.suggested_reply,
    match_reason: formatMatchReason({ ...s, line_type: s.line_type ?? s.move }),
    match_category: s.account_priority === 1 ? "selected" : "topic",
    source: "handles",
    kb_refs: kbRefs,
    ...(s.ai_tell_flags.length > 0 ? { ai_tell_flags: s.ai_tell_flags } : {}),
  };
  // Validate against Wingman's own schema so a 400 from the daemon is
  // impossible to reach — mapping bugs fail here, loudly.
  return CandidateInputSchema.parse(input);
}
