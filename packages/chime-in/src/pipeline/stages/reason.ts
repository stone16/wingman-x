import { selectSections } from "../../kb/sections.js";
import { CLAIM_STANDARD } from "./verify.js";
import { z } from "zod";
import type { LLMProvider } from "../../llm/provider.js";
import type { NormalizedPost } from "../../model/post.js";
import { SAFETY_PREAMBLE, renderPost } from "../prompts.js";
import { PostPostureSchema, ReplyDepthSchema } from "./contribution.js";

/**
 * The unified reasoning stage. Replaces expertise + contribution + line.
 * One call answers: what is this person saying, do I have something worth
 * posting, what kind of response is it, and how much grounding does it
 * need. Themes and the watchlist only decided that the post was worth
 * looking at; from here the post decides.
 */
export const ReasonMoveSchema = z.enum([
  "agree_extend",
  "distinction",
  "challenge",
  "question",
  "example",
  "operator_context",
  "light_reaction",
  "irony",
  "thinking_out_loud",
  "none",
]);
export type ReasonMove = z.infer<typeof ReasonMoveSchema>;

export const GroundingSchema = z.enum(["none", "kb", "experience", "verify", "hybrid"]);
export type Grounding = z.infer<typeof GroundingSchema>;

export const EnergySchema = z.enum(["shitpost", "casual", "serious"]);

export const ReasonResultSchema = z.object({
  /** Would this person plausibly post the response? 0-100. */
  worth: z.number().int().min(0).max(100),
  reason: z.string(),
  move: ReasonMoveSchema,
  depth: ReplyDepthSchema.default("substantive"),
  posture: PostPostureSchema.default("other"),
  energy: EnergySchema.default("casual"),
  /** The specific thing this author is saying or doing, in one sentence. Written before the angle. */
  author_point: z.string().optional(),
  /** What the reply would say to this author, in one plain sentence of about 20 words. */
  angle: z.string(),
  grounding: GroundingSchema.default("none"),
  /** When grounding needs the library: what to look up, in the person's terms. */
  kb_query: z.string().optional(),
  /** When the argument depends on a current external fact: the exact question to verify. */
  fact_dependency: z.string().optional(),
  /** The response wants to make a specific first-person claim (must be checked against approved context). */
  wants_first_person: z.boolean().default(false),
});
export type ReasonResult = z.infer<typeof ReasonResultSchema>;

/** Moves describe the function of the reply, never its wording. */
export const MOVE_GUIDE: Record<ReasonMove, string> = {
  agree_extend: "agree_extend: the author is basically right, and you add a consequence or implication they did not draw. No correction.",
  distinction: "distinction: separating two concepts genuinely changes the conclusion. Say what changes, in plain words.",
  challenge: "challenge: you materially disagree with one assumption. Say which, and why, respectfully.",
  question: "question: the most valuable contribution is surfacing something unresolved. The question is the reply.",
  example: "example: one concrete example makes the argument more useful, from the post, the thread, or a verified source.",
  operator_context: "operator_context: firsthand experience adds something the post does not contain. Only as approved context allows.",
  light_reaction: "light_reaction: worth engaging, no expertise required. A short human response.",
  irony: "irony: name the contradiction already sitting in the post. Dry, one clause, do not explain it.",
  thinking_out_loud: "thinking_out_loud: an observation or question being worked through in the open, uncertainty allowed. Not a maxim.",
  none: "none: nothing worth posting.",
};

export interface ReasonContext {
  /** Always present: the person's working views. */
  digest: string;
  /** Always present: where firsthand grounding may exist. */
  experienceIndex: string;
  /** Hard boundaries (confidentiality, lane discipline). */
  boundaries?: string;
  /** Response policy: energy matching, casual moves. */
  policy?: string;
  /** 1 = person I want to know, 2 = normal, 3 = organization / official feed. */
  authorPriority?: 1 | 2 | 3;
  /** The person already chose to reply (pasted the link): "none" is not an option; find the best angle. */
  mustReply?: boolean;
  /** What the person asked for with the link, if anything; it shapes the move and angle. */
  instruction?: string;
  /** Regeneration without an instruction: contributions the person rejected for this post. The new one must differ. */
  avoidAngles?: string[];
  /** Regeneration with an instruction: earlier contributions, kept unless the instruction asks for something else. */
  priorAngles?: string[];
  /** Instructions given on earlier drafts of this reply; they still apply to the next one. */
  standingInstructions?: string[];
  /** "candidate" = consolidated prompt set (see config.promptProfile). */
  profile?: "baseline" | "candidate";
  /** The discovery theme, used by the candidate to select which digest section the post can bear on. */
  theme?: string;
  /** Reconsideration: the drafter could not write the previous angle without an unsupported assumption. */
  angleProblem?: string;
  /** Reconsideration: what evidence was available when the problem surfaced (excerpt files, unresolved dependency). */
  evidence?: string;
  /** Context only: contributions recently made on other posts. Repeating one is fine when it fits this post. */
  recentAngles?: string[];
}

/** Candidate wording: acknowledgment tied to one specific is a valid extension; no manufactured implication. */
const AGREE_EXTEND_CANDIDATE = "agree_extend: the author is basically right, and you say so with one thing they would want to hear back: a consequence you can actually support, a question about the next step, or a plain acknowledgment tied to one specific in their post. No correction. Do not invent an implication the post does not support; if there is none, the acknowledgment is the reply.";
/** Eligibility rules that used to live in tone.md and conversational.md, kept here because only this stage can skip. */
const CANDIDATE_SKIP_RULES = "Skip when the best available line is generic, when the reply would only paraphrase the post, when the point needs knowledge the person does not have or only generic industry knowledge applies, when the post is engagement bait, a link with no take, or a personal update only a friend should answer, when a joke needs a fact you do not have, and for price takes, chain tribalism (arguing one chain is better), airdrop or yield-farming meta, and generic AI model-release takes. A post about builders, traders, or products across chains is a conversation, not tribalism.";
const CANDIDATE_MOTIVE_RULE = "Do not assert why the author's audience, users, customers, or counterparties behaved or will behave unless the post states it. Hedging it (\"my read is\") or wrapping it in a question that assumes the answer does not supply evidence. If the point depends on it, ask an open question that does not presuppose it, or choose a different contribution.";

/** The move definitions a profile uses. The drafter must import this, not MOVE_GUIDE, so both stages describe the same move. */
export function moveGuideFor(profile: "baseline" | "candidate" | undefined): Record<ReasonMove, string> {
  return profile === "candidate" ? { ...MOVE_GUIDE, agree_extend: AGREE_EXTEND_CANDIDATE } : MOVE_GUIDE;
}

/** Theme labels that map onto a digest section under a different name. */
const DIGEST_ALIASES: Record<string, string> = {
  "securities infrastructure": "Tokenization and market structure",
  "payments and fintech": "Stablecoins",
};

/**
 * Selective loading of the digest: only the section a post can bear on, plus "What I am not".
 * The "How I reason" paragraph and unrelated domain sections are not shown. A post with no
 * matching section gets no views at all; the post decides what the reply is about.
 */
export function digestForTheme(digest: string, theme: string | undefined): string {
  if (!digest.trim()) return "";
  const t = (theme ?? "").trim().toLowerCase();
  const heading = DIGEST_ALIASES[t] ?? theme ?? "";
  const wanted = heading ? [heading, "What I am not"] : ["What I am not"];
  const picked = selectSections(digest, wanted);
  return picked.trim();
}

/**
 * Candidate reasoner. Same experience map, boundaries, and claim standard as the baseline; the digest
 * is loaded by section; the decision procedure is one short statement instead of a six-step walkthrough.
 */
function buildReasonSystemPromptCandidate(ctx: ReasonContext): string {
  const digest = digestForTheme(ctx.digest, ctx.theme);
  const themeKey = (ctx.theme ?? "").trim().toLowerCase();
  const themeHeading = DIGEST_ALIASES[themeKey] ?? ctx.theme ?? "";
  const hasTopicViews = !!themeHeading && ctx.digest.toLowerCase().includes(("## " + themeHeading).toLowerCase());
  // Progressive loading: the identity line always; the diplomatic floor (operators in the lane, filings neutrality) only on domain posts.
  // Confidentiality is enforced downstream by the drafter and verifier, the facts rule is the claim standard, lane discipline is the skip rules.
  const boundaries = ctx.boundaries ? selectSections(ctx.boundaries, hasTopicViews ? ["Who is speaking", "Diplomatic floor"] : ["Who is speaking"]) : "";
  // The experience map only where firsthand context could exist: the person's finance and AI domains.
  const experienceIndex = hasTopicViews ? ctx.experienceIndex.trim() : "";
  return [
    "You decide, on behalf of one specific person, whether a post on X deserves a reply from them and what that reply contributes. You do not write it.",
    "",
    "# The person's working views (a check on what gets said, not a menu of things to say)",
    ...(hasTopicViews ? [] : ["None of the person's recorded views or firsthand experience bear on this topic. Reason from the post alone; first person is not available here."]),
    ...(digest ? [digest] : []),
    "",
    ...(experienceIndex ? ["# Where firsthand experience may exist (a map; specific claims are checked against approved context before drafting)", experienceIndex, ""] : []),
    ...(boundaries.trim() ? ["# Hard boundaries", boundaries.trim(), ""] : []),
    "# Claim standard (shared with the drafter and the verifier)",
    CLAIM_STANDARD,
    "",
    "# How to decide",
    "Read the post and any thread above it. Note what the author is doing (posture) and the energy (shitpost, casual, serious). Form the person's most natural reaction to what this author actually said, reasoning freely; the views above tell you where they stand and may be qualified by the post.",
    "A reply is worth posting when it adds something this author would want to hear back. Plain agreement or acknowledgment counts when it is what the person would actually post; so do a consequence you can support, a useful question, a concrete example, approved firsthand context, a light reaction, irony, or thinking out loud. Empty praise and manufactured corrections do not count. Contrarianism is not higher value; if the author is basically right, build on them.",
    ctx.mustReply
      ? "The person has ALREADY decided to reply to this post, so none is not available: if nothing substantive fits, choose the best light move and give an angle that can actually be written. If the post depends on media you cannot see, react to what the text gives you."
      : CANDIDATE_SKIP_RULES + " Silence beats a forced reply.",
    CANDIDATE_MOTIVE_RULE,
    "",
    "# Moves (what the reply does, never its wording)",
    "agree_extend: the author is basically right; add one thing they would want to hear back, or a plain acknowledgment tied to one specific. If there is no supportable extension, the acknowledgment is the reply. | distinction: separating two things changes the conclusion. | challenge: you materially disagree with one assumption. | question: the open question is the reply. | example: one concrete, sourced example. | operator_context: approved firsthand context only. | light_reaction: a short human response. | irony: name the contradiction in the post, one clause. | thinking_out_loud: an observation or question worked through in the open; not a maxim. | none: nothing worth posting.",
    "",
    "# Grounding the reply needs",
    "none (a reaction or plain reasoning) | kb (one of the views is directly relevant; give kb_query in the person's terms) | experience (firsthand context would materially help; set wants_first_person if the reply would say so) | verify (the argument depends on a specific current external fact; give fact_dependency as the exact question) | hybrid. Most replies need none. Facts strengthen an argument; they are not mandatory ingredients.",
    "",
    "# Output",
    "author_point: the specific thing THIS author is saying or doing, in one sentence.",
    "angle: the contribution Udit would make in this conversation, as it would be said to the author, in one plain sentence of about 20 words. Acknowledgment may refer to something the author already said. Avoid merely summarizing the post. Keep an essential qualifier if the point needs one.",
    "depth: light (one clause or short sentence; the default for announcements, personal updates, and posts under about 100 characters), substantive (one clear point, the norm), deep (technical, only when the post asks for it). Match the energy of the post.",
    "worth (0-100): whether Udit would plausibly post this contribution, not how much it demonstrates. 85-100 he would post it with little or no editing; 70-84 worth posting; 50-69 forgettable or slightly off the post's energy; below 50 generic, sycophantic, a reach, or the post deserves no reply." + (ctx.authorPriority === 3 ? " This author is an organization or official feed: a casual reply must be exceptional to be worth posting; substantive replies are judged normally." : ""),
    'Return JSON: {"worth", "reason", "move", "depth", "posture", "energy", "author_point", "angle", "grounding", "kb_query", "fact_dependency", "wants_first_person"}.',
    SAFETY_PREAMBLE,
  ].join("\n");
}

export function buildReasonSystemPrompt(ctx: ReasonContext): string {
  if (ctx.profile === "candidate") return buildReasonSystemPromptCandidate(ctx);
  const candidate: boolean = false; // the candidate returned above; what follows is the baseline
  const boundaries = candidate && ctx.boundaries ? selectSections(ctx.boundaries, ["Who is speaking", "Confidentiality", "Facts and verification", "Diplomatic floor", "Lane discipline"]) : ctx.boundaries;
  // Candidate: the casual policy file is retired as a runtime input; its reply types live in the move guide.
  const policy = candidate ? undefined : ctx.policy;
  const moveGuide = moveGuideFor(ctx.profile);
  return [
    "You decide, on behalf of one specific person, whether a post on X deserves a reply from them and what kind. You are not writing the reply. You are deciding whether there is one worth writing, and what it would do.",
    "",
    "# The person's working views (current priors, not doctrine)",
    ctx.digest.trim() || "(no digest provided)",
    "",
    "# Where firsthand experience may exist (a map, not a list of things to say)",
    ctx.experienceIndex.trim() || "(none provided)",
    "",
    ...(boundaries && boundaries.trim() ? ["# Hard boundaries", boundaries.trim(), ""] : []),
    ...(policy && policy.trim() ? ["# Response policy for casual replies", policy.trim(), ""] : []),
    ...(candidate ? ["# Claim standard (shared with the drafter and the verifier)", CLAIM_STANDARD, ""] : []),
    "# How to decide",
    "1. Read the post and any thread above it. Say what the author is actually doing (posture) and the energy of the post (shitpost, casual, serious).",
    "2. Form the person's most natural reaction, reasoning freely: infer, compare, challenge, ask, notice a consequence, draw on standard domain knowledge, or simply react. The views above tell you where they stand; they do not limit what you may think about, and they may be qualified by what the post shows.",
    candidate
      ? "3. Decide whether there is a response they would plausibly post. It counts if it adds humor, a useful question, a reaction, a connection, a mechanism, a disagreement, an implication you can support, a concrete example, or firsthand context, or if the conversation is simply worth being in. Plain agreement or acknowledgment counts when it is what the person would actually post. Empty praise and manufactured corrections do not count. " + CANDIDATE_SKIP_RULES
      : "3. Decide whether there is a response they would plausibly post. It counts if it adds humor, a useful question, a reaction, a connection, a mechanism, a disagreement, an implication, a concrete example, or firsthand context, or if the conversation is simply worth being in. Generic agreement, praise, restating the post, or a manufactured correction do not count.",
    "4. Pick the move that describes what the response does:",
    ...Object.values(moveGuide).map((m) => `   - ${m}`),
    ctx.mustReply
      ? "   Contrarianism is not higher value. If the author is basically right, build on them. The person has ALREADY decided to reply to this post, so none is not available: if nothing substantive fits, choose the best light move (light_reaction, irony, thinking_out_loud) and give an angle that can actually be written. If the post depends on media you cannot see, react to what the text gives you (the author's framing, the name, the phrasing) rather than guessing at the media."
      : "   Contrarianism is not higher value. If the author is basically right, build on them. Use none freely; silence beats a forced reply.",
    "5. Decide how much grounding the response needs:",
    "   - none: a natural reaction or a point of reasoning; nothing to look up.",
    "   - kb: one of the person's established views is directly relevant and the reply should be checked against it. Give kb_query: what to look up, in their terms.",
    "   - experience: the reply would materially benefit from firsthand context that the experience map suggests exists. Set wants_first_person if the reply would say so explicitly. That claim will be checked against approved context before it is made; if it cannot be supported the reply falls back to professional judgment.",
    "   - verify: the argument depends on a specific current external fact (a number, a product's rights, a regulatory status). Give fact_dependency: the exact question, e.g. \"Do holders of Robinhood's stock tokens receive voting rights?\" If it cannot be verified, the reply must make the point without it.",
    "   - hybrid: more than one of the above.",
    "   Facts should strengthen an argument, not be mandatory ingredients. Most replies need none.",
    "6. Match the energy of the post. Do not answer a shitpost like an analyst, a serious post with a punchline, or a casual observation with a résumé.",
    "",
    "# What the angle is",
    "First write author_point: the specific thing THIS author is saying or doing, in one sentence.",
    candidate
      ? "The angle is the contribution Udit would make in this conversation: a response to this author, not the sharpest true statement about the topic. Acknowledgment may refer to something the author already said. Avoid merely summarizing the post."
      : "Then the angle is the one thing this author would want to hear back from this person: a response to them, not the sharpest true statement about the topic. If the sharpest true statement is something the author already knows or already said, it is not the angle.",
    ...(candidate ? [CANDIDATE_MOTIVE_RULE] : ["Test it: would this angle fit just as well under a different post on the same theme? If yes, it is generic. Find the one that only makes sense here, or choose a lighter move."]),
    "The views above are a check on what gets said, not a menu. Do not steer toward them unless the post raises them.",
    "Phrase the angle as it would be said to the author, in one sentence of plain words, about 20 words. Keep an essential qualifier if the point needs one.",
    "",
    "# Scoring worth (0-100)",
    candidate
      ? "Score whether Udit would plausibly post this contribution, not how much it demonstrates. A useful acknowledgment or reaction can be complete without inviting a response."
      : "Score by whether the AUTHOR would want to respond, not by how much the reply demonstrates.",
    "- 85-100: the person would post this with little or no editing; it is funny, sharp, or genuinely useful, in their register.",
    "- 70-84: worth posting; solid, not memorable.",
    "- 50-69: fine but forgettable, or slightly off the post's energy.",
    "- below 50: generic, sycophantic, a reach, or the post deserves no reply.",
    ...(ctx.authorPriority === 3
      ? ["The author is an organization or official feed. A casual reply (light_reaction, irony, thinking_out_loud) must be exceptional to be worth posting; substantive replies are judged normally."]
      : ctx.authorPriority === 1
        ? ["The author is someone the person wants to know. Casual, human replies are welcome at the normal bar."]
        : []),
    "",
    "# Depth",
    "light: one clause or short sentence. substantive: one clear point (the norm). deep: technical, only when the post asks for it. Announcements, personal updates, and posts under about 100 characters default to light.",
    "",
    'Return JSON: {"worth", "reason", "move", "depth", "posture", "energy", "author_point", "angle", "grounding", "kb_query", "fact_dependency", "wants_first_person"}.',
    SAFETY_PREAMBLE,
  ].join("\n");
}

export async function reasonAboutPost(
  post: NormalizedPost,
  theme: string,
  ctx: ReasonContext,
  deps: { llm: LLMProvider },
): Promise<ReasonResult> {
  return deps.llm.complete({
    tier: "strong",
    system: buildReasonSystemPrompt({ ...ctx, theme }),
    prompt: [
      renderPost(post),
      "",
      `Theme (discovery label only; it does not decide the kind of reply): ${theme}`,
      ...(ctx.authorPriority ? [`Author priority: ${ctx.authorPriority}`] : []),
      ...(ctx.mustReply ? ["The person has already decided to reply to this post. Find the best reply, do not return none."] : []),
      ...(ctx.instruction && ctx.instruction.trim() ? ["", `The person's instruction for this reply (it outranks the defaults above): ${ctx.instruction.trim()}`] : []),
      ...(ctx.standingInstructions && ctx.standingInstructions.length > 0
        ? ["", "Instructions the person gave on earlier drafts of this reply. They still apply:", ...ctx.standingInstructions.map((s) => `- ${s}`)]
        : []),
      ...(ctx.angleProblem
        ? ["", `The drafter could not write the previous contribution without an assumption none of the sources support: ${ctx.angleProblem}. Choose a contribution that does not depend on it (an open question that does not assume it, or a plain acknowledgment, is fine), or none.`, ...(ctx.evidence ? ["Evidence the drafter had when this surfaced:", ctx.evidence] : [])]
        : []),
      ...(ctx.recentAngles && ctx.recentAngles.length > 0
        ? ["", "Recent suggestions this system drafted for other posts (not necessarily approved or posted), for context only. Repeating a useful point is fine when it fits this post; do not vary for variety's sake.", ...ctx.recentAngles.map((a) => `- ${a}`)]
        : []),
      ...(ctx.avoidAngles && ctx.avoidAngles.length > 0
        ? ["", "The person rejected these earlier contributions for this post. Find a different one: a different point, question, or reaction, not a restatement of these.", ...ctx.avoidAngles.map((a) => `- ${a}`)]
        : []),
      ...(ctx.priorAngles && ctx.priorAngles.length > 0
        ? ["", "Earlier contributions for this post, to keep unless the instruction asks for something else:", ...ctx.priorAngles.map((a) => `- ${a}`)]
        : []),
      "",
      "Decide. Return the JSON.",
    ].join("\n"),
    schema: ReasonResultSchema,
    label: `reason:${post.tweet_id}`,
    maxTokens: 600,
  });
}
