import { z } from "zod";
import type { LLMProvider } from "../llm/provider.js";
import type { NormalizedPost } from "../model/post.js";
import { SAFETY_PREAMBLE, renderPost } from "./prompts.js";
import { hasContrastiveTell, hasDashTell, toSentenceCase } from "./stages/draft.js";

/**
 * /options: the twitter-reply skill as a bot command. Three labeled reply
 * options for one post, no KB, no gates. The person picks one (or none).
 */
export const OptionTypeSchema = z.enum(["irony", "question", "thinking_out_loud", "context"]);
export type OptionType = z.infer<typeof OptionTypeSchema>;

export const OptionsResultSchema = z.object({
  options: z.array(z.object({ type: OptionTypeSchema, text: z.string().min(1) })).min(3).max(3),
});

export interface ReplyOption {
  type: OptionType;
  text: string;
  flags: string[];
}

export function buildOptionsSystemPrompt(policy: string, tone: string, constraints?: string, mode: "three" | "one" = "three"): string {
  return [
    "You draft three alternative replies on X for a specific person, fast and human. Follow the options policy exactly; take register (casing, rhythm, roughness) from the tone guide.",
    "",
    "# Options policy",
    policy.trim(),
    "",
    "# Tone guide (register only; the example replies quoted in it are lowercase because that is how their authors type, which is NOT inherited: write in sentence case)",
    tone.trim(),
    "",
    ...(constraints && constraints.trim() ? ["# Hard constraints", constraints.trim(), ""] : []),
    ...(mode === "three"
      ? [
          "Produce exactly three options, each a different type. Default types: irony, question, thinking_out_loud. Use context in place of one of them only if the post or thread supplies the fact. Every fact in every option comes from the post or thread; never invent a number, name, date, quote, or event.",
          'Return JSON: {"options": [{"type", "text"}, {"type", "text"}, {"type", "text"}]}.',
        ]
      : [
          "Produce ONE option of the type the prompt names. Every fact comes from the post or thread; never invent a number, name, date, quote, or event.",
          'Return JSON: {"text": "<the reply text only, plain prose, no JSON inside it>"}.',
        ]),
    SAFETY_PREAMBLE,
  ].join("\n");
}

export function buildOptionsPrompt(post: NormalizedPost, instruction?: string): string {
  return [
    renderPost(post),
    "",
    ...(instruction ? [`The person's instruction for all three options: ${instruction}`, ""] : []),
    "Three options, three types, one or two sentences each. Return the JSON.",
  ].join("\n");
}

export async function generateOptions(
  post: NormalizedPost,
  deps: { llm: LLMProvider; policy: string; tone: string; constraints?: string; maxChars: number },
  instruction?: string,
): Promise<ReplyOption[]> {
  const res = await deps.llm.complete({
    tier: "draft",
    system: buildOptionsSystemPrompt(deps.policy, deps.tone, deps.constraints),
    prompt: buildOptionsPrompt(post, instruction),
    schema: OptionsResultSchema,
    label: `options:${post.tweet_id}`,
    maxTokens: 700,
  });
  return res.options.map((o) => {
    let text = toSentenceCase(unwrapJsonText(o.text));
    if ([...text].length > deps.maxChars) text = [...text].slice(0, deps.maxChars - 1).join("").trimEnd() + "…";
    const flags: string[] = [];
    if (hasDashTell(text)) flags.push("dash");
    if (hasContrastiveTell(text)) flags.push("contrastive-en");
    return { type: o.type, text, flags };
  });
}

export const OneOptionSchema = z.object({ text: z.string().min(1) });

/** Word-set overlap, 0..1. Used to catch a "redo" that merely paraphrased. */
export function similarity(a: string, b: string): number {
  const w = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((x) => x.length > 2));
  const A = w(a);
  const B = w(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / Math.min(A.size, B.size);
}

/** Redo one option of a fixed type, avoiding the texts already shown. */
export async function regenerateOption(
  post: NormalizedPost,
  type: OptionType,
  previous: string[],
  deps: { llm: LLMProvider; policy: string; tone: string; constraints?: string; maxChars: number },
  instruction?: string,
): Promise<ReplyOption> {
  const res = await deps.llm.complete({
    tier: "draft",
    system: buildOptionsSystemPrompt(deps.policy, deps.tone, deps.constraints, "one"),
    prompt: [
      renderPost(post),
      "",
      `Write ONE new option of type "${type}". It must be meaningfully different from these earlier attempts (different angle or shape, not a paraphrase):`,
      ...previous.map((p, i) => `<earlier n="${i + 1}">\n${p}\n</earlier>`),
      ...(instruction ? ["", `The person's instruction: ${instruction}`] : []),
      "",
      'Return JSON: {"text"}.',
    ].join("\n"),
    schema: OneOptionSchema,
    label: `options-one:${post.tweet_id}`,
    maxTokens: 300,
  });
  let text = toSentenceCase(unwrapJsonText(res.text));
  if ([...text].length > deps.maxChars) text = [...text].slice(0, deps.maxChars - 1).join("").trimEnd() + "…";
  const flags: string[] = [];
  if (hasDashTell(text)) flags.push("dash");
  if (hasContrastiveTell(text)) flags.push("contrastive-en");
  return { type, text, flags };
}

/** If a model puts JSON inside a string field ({"text": …} or {"options": [...]}), pull the prose back out. */
export function unwrapJsonText(raw: string): string {
  let s = raw.trim();
  for (let i = 0; i < 3 && /^\s*[{\[]/.test(s); i += 1) {
    try {
      const v: unknown = JSON.parse(s);
      if (typeof v === "string") s = v;
      else if (v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string") s = (v as { text: string }).text;
      else if (v && typeof v === "object" && Array.isArray((v as { options?: unknown }).options)) {
        const first = (v as { options: Array<{ text?: unknown }> }).options[0];
        if (first && typeof first.text === "string") s = first.text;
        else break;
      } else break;
    } catch {
      break;
    }
    s = s.trim();
  }
  return s;
}

export const OPTION_LABEL: Record<OptionType, string> = {
  irony: "irony",
  question: "question",
  thinking_out_loud: "thinking out loud",
  context: "context",
};
