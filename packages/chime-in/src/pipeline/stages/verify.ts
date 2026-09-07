import { z } from "zod";
import type { LLMProvider } from "../../llm/provider.js";
import type { NormalizedPost } from "../../model/post.js";
import { renderExcerpts, type KBChunk } from "../../kb/kb-index.js";
import { SAFETY_PREAMBLE, renderPost } from "../prompts.js";
import type { VerifiedFact } from "../ground.js";

/**
 * Provenance check after drafting. Reasoning is free; specifics are not.
 * Lists every specific in the reply and whether the sources support it.
 * The caller rewrites once (unsupported first-person → professional
 * judgment; unsupported external specifics → removed or generalized) and
 * flags whatever survives so the card shows what to check.
 */
export const SpecificKindSchema = z.enum(["number", "name", "date", "deal", "quote", "first_person", "legal_status", "product_mechanic", "mechanism", "current_state", "causal", "other"]);
/** Claims about how a specific named thing works or stands today: general knowledge cannot support them. */
export const PRODUCT_SPECIFIC_KINDS: ReadonlySet<string> = new Set(["product_mechanic", "mechanism", "current_state"]);
export const SupportSchema = z.enum(["post", "thread", "kb", "fact", "experience", "common_knowledge", "none"]);

export const VerifyResultSchema = z.object({
  specifics: z.array(
    z.object({
      claim: z.string(),
      kind: SpecificKindSchema,
      support: SupportSchema,
    }),
  ),
});
export type VerifyResult = z.infer<typeof VerifyResultSchema>;

export interface VerifyContext {
  post: NormalizedPost;
  chunks: KBChunk[];
  fact?: VerifiedFact;
  experience?: string;
  profile?: "baseline" | "candidate";
}

/** The one claim standard. Consumed by the verifier, the candidate reasoner, and the candidate drafter. */
export const CLAIM_STANDARD =
  "Keep factual assertions within what their supporting material establishes. This includes product mechanics, current conditions, legal status, explanations of events or people's behavior, and factual premises inside questions or hedges. General knowledge about a category does not establish a fact about a particular product. Udit's views may support an evaluation; they do not establish another product's terms. Personal experience requires approved context for that exact experience. Pure preferences and evaluations need no external proof, but any factual premise they rely on still needs support.";

export type VerifyStatus = "passed" | "unsupported" | "unavailable";

export interface Verdict {
  /** True only when the audit ran and found every specific supported. */
  ok: boolean;
  /** passed: audited clean. unsupported: audited, specifics lack a source. unavailable: the audit did not run or did not return usable output. */
  status: VerifyStatus;
  unsupported: Array<{ claim: string; kind: string }>;
  unsupportedFirstPerson: string[];
}

export function buildVerifySystemPrompt(profile: "baseline" | "candidate" = "baseline"): string {
  const candidate = profile === "candidate";
  return [
    candidate
      ? "You audit a short reply written on behalf of a specific person for provenance. You are not judging quality. The standard: " + CLAIM_STANDARD
      : "You audit a short reply written on behalf of a specific person for provenance. You are not judging quality or opinion. Opinions, inferences, and general professional judgment are free and are NOT specifics.",
    "List every SPECIFIC in the reply: a number or percentage, a date or year, a named person, firm, product, protocol, or deal, a quote, a claimed legal or regulatory status, a claimed product mechanic (e.g. who gets voting rights), and any first-person experience claim (\"we saw\", \"when I worked on\", \"at Figure\").",
    "Also list every LOAD-BEARING CLAIM the reply depends on, even when it is phrased as reasoning: mechanism (how a named product, protocol, or market works: \"the oracle only adjusts the mark\"), current_state (what a named thing does or lacks today: \"supply is what's holding Waymo back\", \"deposits can leave at any time\"), and causal (why a specific named thing happened or will happen, stated as fact: \"people muted because there was no human\"). A general opinion about how markets tend to work is not one of these; a claim about THIS product or THIS company is.",
    "For mechanism, current_state, and product_mechanic claims about a named thing, common_knowledge is NOT valid support: general knowledge of how oracles or lenders usually work does not establish how this one works. Use post, thread, kb, or fact, else none.",
    ...(candidate
      ? [
          "Causal also covers why the people in the post's story (its audience, users, readers, customers, counterparties) behaved or will behave.",
          "Follow the meaning, not the form. A hedge (\"my read is\", \"probably\", \"I think\", \"I suspect\") does not change what a claim is: a hedged claim about other people's motives is still causal, and a hedged description of what a product does, guarantees, or how it is structured is still a product_mechanic or current_state claim: \"my understanding is the tokens are backed 1:1 through an SPV and only authorized participants can redeem\" is a product_mechanic claim about a named product and is listed with support none unless a source states it. List them with the support they actually have. Check the premise inside a question too, but only a premise that is a specific fact the post does not give or clearly imply: \"why does this vault block withdrawals?\" asserts that it blocks withdrawals, so list that premise. A question that asks how something works, or how two things line up, asserts only that those things exist in the post's own description; \"how does the maturity profile on these line up with how deposits come out?\" under a post about lending strategies and a deposit base presupposes nothing beyond the post, and is not a claim. A pure preference or evaluation (\"I like that\", \"this is the interesting part\") needs no provenance. An explanation the AUTHOR gave in the post, repeated as the author's, is supported by the post; any further inference the writer adds on top of it is a separate claim and is listed on its own.",
        ]
      : []),
    "For each, say what supports it: post (the post text), thread (earlier posts), kb (the excerpts), fact (the verified fact), experience (the approved firsthand context), common_knowledge (a widely known, stable fact any practitioner would accept without a source, e.g. that DTC is the US central depository), or none.",
    "Names that appear in the post itself are supported by the post. Standard vocabulary (transfer agent, borrowing base, T+1) is not a specific. A first-person claim is supported ONLY by the approved firsthand context, never by common knowledge.",
    "Be literal and complete. If the reply contains no specifics, return an empty list.",
    'Return JSON: {"specifics": [{"claim", "kind", "support"}]}.',
    SAFETY_PREAMBLE,
  ].join("\n");
}

export function buildVerifyPrompt(reply: string, ctx: VerifyContext): string {
  return [
    "# Sources",
    renderPost(ctx.post),
    ...(ctx.chunks.length > 0 ? ["", "Excerpts:", renderExcerpts(ctx.chunks)] : []),
    ...(ctx.fact ? ["", `Verified fact (as of ${ctx.fact.as_of}, ${ctx.fact.source}): ${ctx.fact.claim}`] : []),
    ...(ctx.experience ? ["", "Approved firsthand context:", ctx.experience] : []),
    "",
    "# Reply to audit",
    `<reply>\n${reply}\n</reply>`,
    "",
    "List the specifics and their support. Return the JSON.",
  ].join("\n");
}

/** Candidate: a behavioral explanation or a named product's legal status also needs a real source. */
export const NEEDS_SOURCE_CANDIDATE: ReadonlySet<string> = new Set([...PRODUCT_SPECIFIC_KINDS, "causal", "legal_status"]);

export function judge(result: VerifyResult, profile: "baseline" | "candidate" = "baseline"): Verdict {
  // A first-person claim is supported by approved firsthand context and nothing else; the model's
  // own "kb" or "common_knowledge" label does not count. Enforced here, not left to the prompt.
  const needsSource = profile === "candidate" ? NEEDS_SOURCE_CANDIDATE : PRODUCT_SPECIFIC_KINDS;
  const unsupported = result.specifics.filter(
    (s) =>
      s.support === "none" ||
      (s.kind === "first_person" && s.support !== "experience") ||
      (needsSource.has(s.kind) && s.support === "common_knowledge"),
  );
  return {
    ok: unsupported.length === 0,
    status: unsupported.length === 0 ? "passed" : "unsupported",
    unsupported: unsupported.map((s) => ({ claim: s.claim, kind: s.kind })),
    unsupportedFirstPerson: unsupported.filter((s) => s.kind === "first_person").map((s) => s.claim),
  };
}

export const UNAVAILABLE: Verdict = { ok: false, status: "unavailable", unsupported: [], unsupportedFirstPerson: [] };

export async function verifyReply(reply: string, ctx: VerifyContext, deps: { llm: LLMProvider }): Promise<Verdict> {
  try {
    const res = await deps.llm.complete({
      tier: "cheap",
      system: buildVerifySystemPrompt(ctx.profile),
      prompt: buildVerifyPrompt(reply, ctx),
      schema: VerifyResultSchema,
      label: `verify:${ctx.post.tweet_id}`,
      maxTokens: 500,
    });
    if (!res || !Array.isArray(res.specifics)) return UNAVAILABLE;
    return judge(res, ctx.profile);
  } catch {
    // A verifier failure must not cost the reply, but it must never look like a pass.
    return UNAVAILABLE;
  }
}

/** Flags for the card: what the person should check before posting. An audit that did not run is itself a flag. */
export function verdictFlags(v: Verdict): string[] {
  if (v.status === "unavailable") return ["verify:unavailable"];
  return v.unsupported.map((u) => `unverified:${u.claim.slice(0, 60)}`);
}
