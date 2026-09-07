import type { LLMProvider } from "../llm/provider.js";
import type { NormalizedPost } from "../model/post.js";
import { reasonAboutPost, type ReasonContext, type ReasonResult } from "./stages/reason.js";

/**
 * The drafter said the given angle could not be written without an unsupported
 * assumption. Ask the reasoner once more, with that angle excluded, the problem,
 * and the evidence that exposed it in view.
 *   { kind: "reasoned", reason }  a new contribution
 *   { kind: "none" }              the reasoner now says there is nothing worth saying
 *   { kind: "unavailable", error } the call failed; the caller keeps the flagged draft
 * One reconsideration is the limit; callers do not loop.
 */
export type Reconsideration = { kind: "reasoned"; reason: ReasonResult } | { kind: "none" } | { kind: "unavailable"; error: string };

export async function reconsiderAngle(
  post: NormalizedPost,
  theme: string,
  previous: ReasonResult,
  problem: string,
  ctx: ReasonContext,
  deps: { llm: LLMProvider },
  evidence?: string,
): Promise<Reconsideration> {
  try {
    const r = await reasonAboutPost(post, theme, { ...ctx, avoidAngles: [...(ctx.avoidAngles ?? []), previous.angle], angleProblem: problem, ...(evidence ? { evidence } : {}) }, deps);
    return r.move === "none" ? { kind: "none" } : { kind: "reasoned", reason: r };
  } catch (err) {
    return { kind: "unavailable", error: (err as Error).message };
  }
}

/**
 * What the drafter had in hand when the premise failed, for the reasoner's reconsideration:
 * the passages themselves with their references, not filenames. Bounded so the payload stays
 * proportional to one attempt.
 */
export function describeEvidence(g: { chunks: Array<{ ref: string; text: string }>; fact?: { claim: string; source?: string; as_of?: string }; unresolved?: string; experience?: string }): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const parts: string[] = [];
  for (const c of g.chunks.slice(0, 4)) parts.push(`[${c.ref}] ${clip(c.text.replace(/\s+/g, " ").trim(), 400)}`);
  if (g.fact) parts.push(`verified fact (${g.fact.source ?? "source"}${g.fact.as_of ? `, as of ${g.fact.as_of}` : ""}): ${g.fact.claim}`);
  if (g.unresolved) parts.push(`unresolved: ${g.unresolved}`);
  if (g.experience) parts.push(`approved firsthand context: ${clip(g.experience.replace(/\s+/g, " ").trim(), 600)}`);
  return parts.length > 0 ? parts.join("\n") : "no excerpts, no verified fact, no firsthand context";
}
