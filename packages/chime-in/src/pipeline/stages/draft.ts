import { selectSections } from "../../kb/sections.js";
import { toneForDraft } from "../../kb/tone-select.js";
import { z } from "zod";
import { detectAiTells } from "@wingman-x/agent-kit";
import type { NormalizedPost } from "../../model/post.js";
import type { LLMProvider } from "../../llm/provider.js";
import type { ReplyDepth } from "./contribution.js";
import { MOVE_GUIDE, moveGuideFor, type ReasonMove } from "./reason.js";
export { MOVE_GUIDE } from "./reason.js";
import { renderExcerpts, type KBChunk } from "../../kb/kb-index.js";
import { SAFETY_PREAMBLE, renderPost } from "../prompts.js";
import type { VerifiedFact } from "../ground.js";
import { CLAIM_STANDARD, verifyReply, verdictFlags, type Verdict, type VerifyContext } from "./verify.js";

/**
 * Draft one reply. The contract: reason freely from the post, the thread,
 * the person's views, and standard domain knowledge; be conservative with
 * specifics (numbers, names, dates, deals, quotes, legal status, product
 * mechanics come from the post, the thread, the excerpts, or a verified
 * fact); be strict with first person (only what the approved context
 * supports). A verifier audits the result and one rewrite repairs it; what
 * survives is flagged on the card.
 */
export const DraftResultSchema = z.object({
  suggested_reply: z.string().min(1),
  /** Model's own note on what it leaned on; not shown to the user. */
  grounding: z.string().optional(),
  /** Candidate profile: set when the given point could not be written without an assumption none of the sources support. Triggers reconsideration upstream. */
  angle_problem: z.string().optional(),
});
export type DraftResult = z.infer<typeof DraftResultSchema>;

export interface DraftOutcome {
  suggested_reply: string;
  ai_tell_flags: string[];
  attempts: number;
  /** The drafter's one-sentence account of why the given angle could not be written faithfully, when it said so. */
  angleProblem?: string;
}

export const DASH_RE = /[–—]|\s-\s/;
export function hasDashTell(text: string): boolean {
  return DASH_RE.test(text);
}

export const CONTRASTIVE_RE =
  /\b(?:isn['’]t|aren['’]t|wasn['’]t|weren['’]t|is not|are not|was not|not)\b[^.?!\n]{1,80}?,\s*(?:it['’]s|they['’]re|that['’]s|but)\b/i;
export function hasContrastiveTell(text: string): boolean {
  return CONTRASTIVE_RE.test(text);
}

/** Sentence case: capitalise sentence starts and the pronoun "I"; touch nothing else. */
export function toSentenceCase(text: string): string {
  let out = text.replace(/(^|[.!?]\s+|\n\s*)([a-z])/g, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
  out = out.replace(/(^|[^A-Za-z0-9$@#])i(?=$|[^A-Za-z0-9])/g, "$1I");
  out = out.replace(/(^|[^A-Za-z0-9$@#])i(?=['’](m|d|ve|ll)\b)/g, "$1I");
  return out;
}

/** Clause chaining: ", and" / ", so" / ", but" more than once reads as generated. Counted, not banned. */
export const CLAUSE_JOIN_RE = /,\s+(and|so|but)\s+/gi;
export function clauseJoinCount(text: string): number {
  return (text.match(CLAUSE_JOIN_RE) ?? []).length;
}

/** Concede-then-pivot openers. Legitimate once; a tic when every reply starts that way. */
export const CONCEDE_OPENER_RE = /^\W*(agree(d)?|fair( enough)?|true|right|yes|yep|sure|correct)\b/i;
export function hasConcedeOpener(text: string): boolean {
  return CONCEDE_OPENER_RE.test(text);
}

export const DEPTH_GUIDE: Record<ReplyDepth, string> = {
  light: "light: one clause or one short sentence. A reaction, a question, or a small extension. No mechanism required.",
  substantive: "substantive: one clear point in one or two sentences. If one sentence says it, stop there.",
  deep: "deep: a technical response. The only depth that should approach the hard cap. Still one point.",
};

/** `digest` is accepted for compatibility but no longer injected: the reasoning stage uses it, and in the drafter it pulled replies toward its vocabulary (measured 2026-09-06). */
export function buildDraftSystemPrompt(tone: string, maxChars: number, opts: { digest?: string; boundaries?: string; policy?: string; profile?: "baseline" | "candidate"; move?: ReasonMove; toneLoading?: ToneLoading } = {}): string {
  if (opts.profile === "candidate") return buildDraftSystemPromptCandidate(tone, maxChars, opts);
  return [
    "You draft a reply on X on behalf of a specific person. Write in their voice, following the tone guide for register and rhythm.",
    "",
    "# Tone guide",
    tone.trim(),
    "",
    "Preserve natural roughness where the tone guide shows it: fragments, contractions, plain short sentences. Write in sentence case; the quoted @mdudas replies are lowercase because that is how he types, and that is not inherited. Never copy wording from the example replies; match the behavior and rhythm.",
    "",
    "# How a reply sits in the conversation",
    "Write as someone already in this conversation. Let the post carry its own setup; use \"it\", \"that\", or \"you\" when the reference is clear. Give the actual answer, reaction, question, or disagreement directly. Add a reason or detail when you have one the other person would care about. Use ordinary verbs and connecting words, including \"and\", \"but\", and \"so\". Let the thought determine the sentence breaks. Simple acknowledgment is allowed; it does not need a pivot. A short reaction can be the whole reply. Longer explanations are fine when the question needs them. Do not add filler, a closing lesson, or a stock punchline just to complete a shape. Keep sentence case and contractions. Keep factual uncertainty and provenance intact during every rewrite.",
    "",
    ...(opts.boundaries && opts.boundaries.trim() ? ["# Hard boundaries (override everything else, including a sharper reply)", opts.boundaries.trim(), ""] : []),
    ...(opts.policy && opts.policy.trim() ? ["# Policy for casual replies", opts.policy.trim(), ""] : []),
    "# The contract",
    "Reason freely. Engage the author's actual argument using the post, the thread, the person's views, and what an expert in this field knows. Infer, compare, challenge, ask, notice consequences. You do not need a source for an opinion, an inference, or general professional judgment (\"this usually gets messy once you hit servicing\").",
    "Be conservative with specifics. Any number, percentage, date, named person, firm, product, protocol or deal, quote, legal or regulatory status, or product mechanic must come from the post, the thread, the excerpts, or the verified fact given below. If you cannot source it, make the point without it. Never add a specific to sound authoritative.",
    "Be strict with first person. \"We ran into this on BUIDL\", \"at Figure we\", \"I saw\" are allowed only when the approved firsthand context below supports that exact claim. Otherwise say it as professional judgment, without claiming the event happened to you.",
    "Prefer one concrete mechanism, fact, example, or firsthand observation when it materially sharpens the point. Most replies need none. Do not manufacture a correction; if the author is basically right, build on them.",
    "",
    "# How to write it",
    "1. Read the post and the thread. Understand what the author is actually saying and the energy they said it with.",
    "2. Write the most natural reaction this person would have, in the given move and depth, as someone who holds the views above.",
    "3. If excerpts, a fact, or firsthand context were provided, use them only where they sharpen or correct the reaction. Do not let them supply the opening line, and never name a lens or taxonomy label.",
    "4. Say it in plain words, the way this person would type it in twenty seconds, then stop. Usually one or two sentences, sometimes one clause. Do not compress into maxims; do not pad toward the cap.",
    "",
    "# Non-negotiable rules",
    "- Respond to the actual argument. Never summarise or restate the post.",
    "- Follow the given move. light_reaction, irony and thinking_out_loud are one short human sentence; question means the question is the reply.",
    "- Match the energy of the post: shitpost, casual, or serious.",
    "- No empty praise, no engagement bait, no plugging. Plain agreement or acknowledgment is fine when it is what you would say.",
    "- Aim irony at the situation, never at the author. Disagree with the assumption, not the person.",
    `- Hard length limit: ${maxChars} characters. Normal length comes from the depth and any instruction; use what the point needs.`,
    "- No hashtags. No emoji unless one emoji is the whole reply. Do not address the author by name or handle.",
    "- No em dashes, en dashes, or spaced hyphens used as dashes. Ordinary punctuation otherwise; commas, colons, and connecting words are fine where the thought wants them.",
    SAFETY_PREAMBLE,
  ].join("\n");
}

/**
 * Candidate drafter: tone.md owns wording and voice; the reasoner owns what to say; the
 * verifier owns the claim standard. This prompt carries only the essential shared
 * constraints (confidentiality, approved experience, sourcing of specifics) and format.
 */
/** How much of tone.md the candidate drafter sees: "progressive" (default) or the whole file (for comparison runs). */
export type ToneLoading = "progressive" | "whole";

function buildDraftSystemPromptCandidate(tone: string, maxChars: number, opts: { boundaries?: string; policy?: string; move?: ReasonMove; toneLoading?: ToneLoading }): string {
  const toneBody = tone.replace(/^## Choosing what to say[\s\S]*?(?=^## )/m, "");
  // Progressive: rules and the person's own replies always; borrowed exchanges only for this move.
  const toneForDrafter = opts.toneLoading === "whole" ? toneBody.trim() : toneForDraft(toneBody, opts.move).text;
  const shared = opts.boundaries ? selectSections(opts.boundaries, ["Confidentiality", "Facts and verification"]) : "";
  return [
    "You write a reply on X on behalf of a specific person. The point of the reply has already been decided and is given below; your job is to say it the way this person would, following the tone guide for register and rhythm. Write in sentence case; the quoted @mdudas replies are lowercase because that is how he types, and that is not inherited. Never copy wording from the example replies.",
    "",
    "# Tone guide",
    toneForDrafter,
    "",
    ...(shared.trim() ? ["# Shared constraints", shared.trim(), ""] : []),
    "# Claim standard (shared with the reasoner and the verifier)",
    CLAIM_STANDARD,
    "Sources for this reply are the post, the thread, the excerpts, the verified fact, and the approved firsthand context given below. When they supply a mechanism or detail that sharpens the point, use it.",
    "\"We ran into this on BUIDL\", \"at Figure we\", \"I saw\" are allowed only when the approved firsthand context below supports that exact claim. Without it, do not claim the event; a professional judgment may stand only if it stands without the event. Keep the certainty of what you actually know; a hedge does not license a claim about other people's motives.",
    "If an incidental detail in the given point is unsupported, drop the detail and keep the point. If the point itself depends on an assumption none of the sources support, do not substitute a different point: write the given point as an open question that does not assume it, and set angle_problem to the missing assumption in one sentence. The reasoning stage reconsiders; until it does, the reply stays flagged.",
    "What counts as an unsupported assumption: a specific fact about this product, company, or the people involved that nothing in the sources states or clearly implies. What does not: a premise the post states or clearly implies, an ordinary professional inference about how products of this kind generally work, or an evaluation. Set angle_problem only for the first kind; otherwise leave it out entirely.",
    "",
    "# Format",
    "- Say the given point in the given move and depth. Respond to what the author said; do not restate it.",
    "- light_reaction, irony and thinking_out_loud are one short human sentence; question means the question is the reply. Aim irony at the situation, never at the author.",
    `- Hard length limit: ${maxChars} characters. Length comes from the depth and any instruction.`,
    "- No em dashes, en dashes, or spaced hyphens used as dashes. No hashtags. No emoji unless one emoji is the whole reply. Do not address the author by name or handle.",
    SAFETY_PREAMBLE,
  ].join("\n");
}

export interface DraftPromptArgs {
  post: NormalizedPost;
  theme: string;
  angle: string;
  /** The reasoner's one-sentence account of what this author is saying or doing. */
  authorPoint?: string;
  chunks: KBChunk[];
  move?: ReasonMove;
  depth?: ReplyDepth;
  posture?: string;
  energy?: string;
  /** Approved firsthand context, present only when the reply may make a first-person claim. */
  experience?: string;
  /** A fact resolved for this reply's stated dependency. */
  fact?: VerifiedFact;
  /** A dependency that could not be verified: make the point without it. */
  unresolved?: string;
  avoidMoves?: ReasonMove[];
  previousReplies?: string[];
  shortenFrom?: string;
  fixDashesFrom?: string;
  fixContrastFrom?: string;
  fixOpenerFrom?: string;
  fixJoinsFrom?: string;
  /** Verifier found unsupported specifics; rewrite without them. */
  fixSpecificsFrom?: { text: string; claims: string[]; firstPerson: string[] };
  avoidConcedeOpener?: boolean;
  lengthNudge?: "short";
  instruction?: string;
  /** Earlier instructions for this post that still apply (e.g. "longer", "funnier") when the person hits regenerate again. */
  standingInstructions?: string[];
  /** "candidate" = consolidated prompt set (see config.promptProfile). */
  profile?: "baseline" | "candidate";
  /** Candidate only: whole tone.md instead of the progressive selection (comparison runs). */
  toneLoading?: ToneLoading;
  maxChars: number;
  editorial?: string;
  avoidPoints?: string[];
}

export function buildDraftPrompt(args: DraftPromptArgs): string {
  const move = args.move ?? "agree_extend";
  const depth = args.depth ?? "substantive";
  const lines = [
    renderPost(args.post),
    "",
    `Theme: ${args.theme}`,
    ...(args.posture ? [`What the author is doing: ${args.posture.replace(/_/g, " ")}`] : []),
    ...(args.energy ? [`Energy of the post: ${args.energy}. Match it.`] : []),
    `Move: ${moveGuideFor(args.profile)[move]}`,
    `Depth: ${DEPTH_GUIDE[depth]}`,
    ...(args.authorPoint && args.authorPoint.trim() ? [`The author's point, which the reply answers: ${args.authorPoint.trim()}`] : []),
    `What the reply should say: ${args.angle}`,
    ...(args.avoidConcedeOpener
      ? ["A nearby reply already opens by agreeing or conceding before it pivots. Do not open that way here; start with the point itself."]
      : []),
    ...(args.lengthNudge === "short"
      ? ["Make this one SHORT: one sentence, or one clause if the point survives it. The recent replies have all run long and a person does not write every reply at the same length."]
      : []),
    ...(args.avoidMoves && args.avoidMoves.length > 0
      ? [`A nearby reply in this scan used the same move (${Array.from(new Set(args.avoidMoves)).join(", ")}). Keep the move if it is the right one; vary the construction so the set does not read as one template.`]
      : []),
  ];
  if (args.chunks.length > 0) {
    lines.push("", "Library excerpts, retrieved for this reply (check and sharpen against them; do not recite; do not let them supply the opening):", renderExcerpts(args.chunks));
  }
  if (args.fact) {
    lines.push("", `Verified fact you may use, carrying its date: (as of ${args.fact.as_of}, ${args.fact.source}) ${args.fact.claim}`);
  }
  if (args.unresolved) {
    lines.push(
      "",
      args.profile === "candidate"
        ? `The argument wanted this fact and it could NOT be verified: "${args.unresolved}". Do not assert it, and do not widen it into a claim about the whole category. If the point stands without it, make the point. If the point depends on it, write it as an open question that does not assume it and set angle_problem to the missing fact. Do not choose a different point.`
        : `The argument wanted this fact and it could NOT be verified: "${args.unresolved}". Do not assert it, and do not widen it into a claim about the whole category. If the point stands without it, make the point. If the point depended on it, ask it as a neutral question or make a different, supported point.`,
    );
  }
  if (args.experience) {
    lines.push("", "Approved firsthand context (the ONLY basis for a first-person claim; use one clause at most, and only where it materially helps):", args.experience.trim());
  } else {
    lines.push("", "No approved firsthand context was provided for this reply: do not make first-person experience claims. Professional judgment is fine.");
  }
  if (args.profile !== "candidate" && args.editorial && args.editorial.trim()) {
    // These are recent suggestions drafted by this system, not replies Udit is known to have posted.
    lines.push("", "Recent suggestions drafted for other posts (not necessarily posted). Do not recycle their point unless this post introduces a genuinely different mechanism or implication:", args.editorial.trim());
  }
  if (args.profile !== "candidate" && args.avoidPoints && args.avoidPoints.length > 0) {
    lines.push(
      "",
      "The other replies in this same scan will make these points. Make a different point, or approach from a different mechanism, so the set does not read as one argument repeated:",
      ...args.avoidPoints.map((r, i) => `<other_reply n="${i + 1}">\n${r}\n</other_reply>`),
    );
  }
  const standing = (args.standingInstructions ?? []).map((s) => s.trim()).filter((s) => s && s !== args.instruction?.trim());
  if (standing.length > 0) {
    lines.push(
      "",
      "The person gave these instructions on earlier drafts of this same reply. They still apply; a regeneration must not fall back to the default shape:",
      ...standing.map((s) => `<standing_instruction>\n${s}\n</standing_instruction>`),
    );
  }
  if (args.instruction && args.instruction.trim()) {
    lines.push(
      "",
      args.profile === "candidate"
        ? "The person read the previous draft and asked for this change. Follow it exactly; it outranks the move and depth above if they conflict. If it asks for longer or more, explain the existing point better or add what the instruction asks for; do not pad, and do not invent a second point to fill space."
        : "The person read the previous draft and asked for this change. Follow it exactly; it outranks the move and depth above if they conflict. If it asks for longer or more, add a second, different point (from the post, the thread, the excerpts, or the fact); never stretch the same point with more words. If there is no second point, say so in one clause rather than pad.",
      `<instruction>\n${args.instruction.trim()}\n</instruction>`,
    );
  }
  if (args.previousReplies && args.previousReplies.length > 0) {
    lines.push(
      "",
      args.instruction && args.instruction.trim()
        ? "These are the earlier drafts. Keep what the instruction does not ask to change; do not start from scratch unless it asks for that:"
        : args.profile === "candidate"
          ? "The person rejected these earlier drafts. Write the contribution given above in a meaningfully different way: a different opening and a different structure. Do not paraphrase them. What to say has already been decided; do not swap in a different point."
          : "The person rejected these earlier drafts. Produce a MEANINGFULLY different reply in the move given above: a different opening, a different structure, and where possible a different supporting point. Do not paraphrase them, and do not drift to a weaker version of the same argument.",
      ...args.previousReplies.map((r, i) => `<rejected_draft n="${i + 1}">\n${r}\n</rejected_draft>`),
    );
  }
  if (args.shortenFrom) {
    lines.push("", `This draft is too long (${args.shortenFrom.length} characters). Rewrite it under ${args.maxChars} characters, keeping the same point:`, `<too_long>\n${args.shortenFrom}\n</too_long>`);
  }
  if (args.fixDashesFrom) {
    lines.push("", "This draft uses dashes (em dash, en dash, or a spaced hyphen), which this person never uses. Rewrite it with the same point and no dashes at all. Split into two sentences:", `<has_dashes>\n${args.fixDashesFrom}\n</has_dashes>`);
  }
  if (args.fixContrastFrom) {
    lines.push(
      "",
      "This draft uses the \"isn't X, it's Y\" / \"not X, but Y\" construction, which this person's voice guide bans as an AI tell. Rewrite with the same point as two flat statements (say what it IS; drop the negated half, or put it in its own sentence without the contrast):",
      `<has_contrast>\n${args.fixContrastFrom}\n</has_contrast>`,
    );
  }
  if (args.fixJoinsFrom) {
    lines.push(
      "",
      "This draft chains clauses with \", and\" / \", so\" / \", but\" more than once, which reads as generated. Rewrite it with the same content as plain sentences: at most one comma join, otherwise a period and a new sentence:",
      `<chained>\n${args.fixJoinsFrom}\n</chained>`,
    );
  }
  if (args.fixOpenerFrom) {
    lines.push("", "This draft opens by conceding or agreeing before it pivots, and a nearby reply already did that. Rewrite it with the same content so the first clause is the point itself:", `<concede_opener>\n${args.fixOpenerFrom}\n</concede_opener>`);
  }
  if (args.fixSpecificsFrom) {
    const f = args.fixSpecificsFrom;
    lines.push(
      "",
      args.profile === "candidate"
        ? "A provenance check found assertions in this draft that the sources do not support. Repair them using the supplied sources. A repair may only remove, reframe as an open question, or keep; it must not add anything: no new claim, no first-person observation (\"the pattern I keep seeing\"), no generalization (\"everywhere\", \"always\"), no new specific. Remove incidental unsupported detail only when the remaining contribution still stands. A hedge, a broader category claim, or a question containing the same assumption does not resolve the problem. If the selected contribution depends on an unsupported premise, write it as an open question that does not assume it and set angle_problem to that premise for the reasoner to reconsider. Do not choose a replacement contribution yourself."
        : "A provenance check found specifics in this draft that none of the sources support. Rewrite. If the point survives without the specific, keep the point. If the point depended on the specific, do not generalize it into a claim about the whole category (all wrappers, all lenders, every redemption); make a different supported point or ask a neutral question instead. Keep the certainty of what you actually know.",
      ...(f.firstPerson.length > 0
        ? [
            args.profile === "candidate"
              ? `- These first-person claims cannot be supported: remove the claimed event. A professional judgment may remain only if it stands on its own without that event: ${f.firstPerson.join(" | ")}`
              : `- These first-person claims cannot be supported; say the same thing as professional judgment, not as something that happened to you: ${f.firstPerson.join(" | ")}`,
          ]
        : []),
      ...(f.claims.filter((c) => !f.firstPerson.includes(c)).length > 0
        ? [
            args.profile === "candidate"
              ? `- These claims are unsourced; drop them, or turn them into an open question that does not assume them. Hedging ("my read is", "probably") does not make them acceptable. Drop any conclusion that only they supported: ${f.claims.filter((c) => !f.firstPerson.includes(c)).join(" | ")}`
              : `- These claims are unsourced; drop them, ask them as a question, or state them as your reading rather than as fact, and drop any conclusion that only they supported: ${f.claims.filter((c) => !f.firstPerson.includes(c)).join(" | ")}`,
          ]
        : []),
      `<unsupported>\n${f.text}\n</unsupported>`,
    );
  }
  lines.push("", args.profile === "candidate" ? 'Return JSON: {"suggested_reply", "grounding", "angle_problem" (only when the point could not be written faithfully)}.' : 'Return JSON: {"suggested_reply", "grounding"}.');
  return lines.join("\n");
}

export interface DraftArgs extends Omit<DraftPromptArgs, "shortenFrom" | "fixDashesFrom" | "fixContrastFrom" | "fixOpenerFrom" | "fixJoinsFrom" | "fixSpecificsFrom"> {
  tone: string;
  /** Always-present working views. */
  digest?: string;
  /** Hard boundaries (identity file). */
  boundaries?: string;
  /** Casual-reply policy. */
  policy?: string;
  /** Run the provenance verifier (default true). */
  verify?: boolean;
  llm: LLMProvider;
}

/** An angle_problem is real only when it names a missing assumption; "none", "n/a", "no issue" and the like are noise. */
export function isRealAngleProblem(value: string | undefined): boolean {
  const v = (value ?? "").trim();
  if (v.length < 12) return false;
  return !/^(none|n\/a|no( real)? (issue|problem)|nothing)\b/i.test(v);
}

export async function draftReply(args: DraftArgs): Promise<DraftOutcome> {
  const system = buildDraftSystemPrompt(args.tone, args.maxChars, { digest: args.digest, boundaries: args.boundaries, policy: args.policy, profile: args.profile, move: args.move, toneLoading: args.toneLoading });
  let reply = "";
  let angleProblem: string | undefined;
  let attempts = 0;
  let shortenFrom: string | undefined;
  let fixDashesFrom: string | undefined;
  let fixContrastFrom: string | undefined;
  let fixOpenerFrom: string | undefined;
  let fixJoinsFrom: string | undefined;
  let fixSpecificsFrom: DraftPromptArgs["fixSpecificsFrom"];
  let joinRewrites = 0;
  let openerRewrites = 0;
  let shortenRounds = 0;
  let specificsRewrites = 0;
  const MAX_ATTEMPTS = 5;
  const verifyCtx: VerifyContext = { post: args.post, chunks: args.chunks, fact: args.fact, experience: args.experience, profile: args.profile };
  // The audit is tracked against the exact text it ran on, so the final text is always audited
  // regardless of how many mechanical rewrites the loop spent.
  let audited: { text: string; verdict: Verdict } | undefined;
  const audit = async (text: string): Promise<Verdict> => {
    if (audited && audited.text === text) return audited.verdict;
    const verdict = await verifyReply(text, verifyCtx, { llm: args.llm });
    audited = { text, verdict };
    return verdict;
  };

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    const target = shortenRounds === 0 ? args.maxChars : Math.max(60, args.maxChars - 40 * shortenRounds);
    const kind = shortenFrom ? ":shorten" : fixDashesFrom ? ":dashes" : fixContrastFrom ? ":contrast" : fixOpenerFrom ? ":opener" : fixJoinsFrom ? ":joins" : fixSpecificsFrom ? ":specifics" : "";
    const res = await args.llm.complete({
      tier: "draft",
      system,
      prompt: buildDraftPrompt({ ...args, shortenFrom, fixDashesFrom, fixContrastFrom, fixOpenerFrom, fixJoinsFrom, fixSpecificsFrom, maxChars: target }),
      schema: DraftResultSchema,
      label: `draft:${args.post.tweet_id}${kind}`,
      maxTokens: 500,
    });
    reply = toSentenceCase(res.suggested_reply.trim());
    // Sticky: a mechanical rewrite or a repair does not change what the point depends on, so a flag once raised stays until the reasoner reconsiders.
    // The baseline never asks for the field; placeholder values ("none", "n/a") never count.
    if (args.profile === "candidate" && isRealAngleProblem(res.angle_problem)) angleProblem = res.angle_problem!.trim();
    shortenFrom = undefined;
    fixDashesFrom = undefined;
    fixContrastFrom = undefined;
    fixOpenerFrom = undefined;
    fixJoinsFrom = undefined;
    fixSpecificsFrom = undefined;
    if ([...reply].length > args.maxChars) {
      shortenRounds += 1;
      shortenFrom = reply;
      continue;
    }
    if (attempts < MAX_ATTEMPTS) {
      if (hasDashTell(reply)) {
        fixDashesFrom = reply;
        continue;
      }
      if (hasContrastiveTell(reply)) {
        fixContrastFrom = reply;
        continue;
      }
      if (joinRewrites === 0 && clauseJoinCount(reply) >= 3) {
        joinRewrites += 1;
        fixJoinsFrom = reply;
        continue;
      }
      if (args.avoidConcedeOpener && openerRewrites === 0 && hasConcedeOpener(reply)) {
        openerRewrites += 1;
        fixOpenerFrom = reply;
        continue;
      }
      // Provenance: one repair round, then flag what survives.
      if (args.verify !== false && specificsRewrites === 0) {
        const verdict = await audit(reply);
        if (verdict.status === "unsupported") {
          specificsRewrites += 1;
          fixSpecificsFrom = { text: reply, claims: verdict.unsupported.map((u) => u.claim), firstPerson: verdict.unsupportedFirstPerson };
          continue;
        }
      }
    }
    break;
  }
  // The loop may have spent its budget on formatting; the text that ships still gets one audit,
  // and one repair if that audit fails and none has run yet.
  if (args.verify !== false && [...reply].length <= args.maxChars) {
    let verdict = await audit(reply);
    if (verdict.status === "unsupported" && specificsRewrites === 0) {
      specificsRewrites += 1;
      attempts += 1;
      const res = await args.llm.complete({
        tier: "draft",
        system,
        prompt: buildDraftPrompt({ ...args, fixSpecificsFrom: { text: reply, claims: verdict.unsupported.map((u) => u.claim), firstPerson: verdict.unsupportedFirstPerson } }),
        schema: DraftResultSchema,
        label: `draft:${args.post.tweet_id}:specifics`,
        maxTokens: 500,
      });
      const repaired = toSentenceCase(res.suggested_reply.trim());
      if (args.profile === "candidate" && isRealAngleProblem(res.angle_problem)) angleProblem = res.angle_problem!.trim();
      if ([...repaired].length <= args.maxChars) reply = repaired;
      verdict = await audit(reply);
    }
  }
  if ([...reply].length > args.maxChars) {
    throw new Error(`draft for ${args.post.tweet_id} still exceeds ${args.maxChars} chars after ${attempts - 1} rewrites`);
  }
  const flags = detectAiTells(reply);
  if (args.unresolved) flags.push(`unresolved:${args.unresolved.slice(0, 60)}`);
  if (hasDashTell(reply)) flags.push("dash");
  if (hasContrastiveTell(reply) && !flags.includes("contrastive-en")) flags.push("contrastive-en");
  if (clauseJoinCount(reply) >= 3) flags.push("run-on");
  // The card reflects the audit of the exact final text: unsupported claims, or the fact that no audit ran.
  if (args.verify !== false) {
    const finalVerdict = audited && audited.text === reply ? audited.verdict : await audit(reply);
    flags.push(...verdictFlags(finalVerdict));
  }
  if (angleProblem) flags.push(`angle-unsupported:${angleProblem.slice(0, 80)}`);
  return { suggested_reply: reply, ai_tell_flags: flags, attempts, ...(angleProblem ? { angleProblem } : {}) };
}
