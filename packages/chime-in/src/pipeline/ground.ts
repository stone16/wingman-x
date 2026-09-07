import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { KBChunk, KBIndex } from "../kb/kb-index.js";
import { tokenize } from "../kb/kb-index.js";
import type { NormalizedPost } from "../model/post.js";
import { retrievalQuery } from "./stages/expertise.js";
import type { ReasonResult } from "./stages/reason.js";
import type { LLMProvider } from "../llm/provider.js";
import { renderPost } from "./prompts.js";
import { z } from "zod";

const PostAnswerSchema = z.object({ answered: z.boolean(), answer: z.string().optional() });
const NotesAnswerSchema = z.object({ answered: z.boolean(), answer: z.string().optional(), note: z.number().int().min(1).optional() });

/**
 * Does the post, its thread, or the quoted post state the answer to the question?
 * Only what is written counts; no inference. Returns the answer text or null.
 * Replaces an earlier word-overlap shortcut that marked facts "answered by the
 * post itself" without extracting anything.
 */
/** Same extraction over research-note candidates: an overlapping note is evidence, not an answer, until it states one. */
export async function answerFromNotes(question: string, notes: string[], llm: LLMProvider): Promise<{ answer: string; note: number } | null> {
  if (notes.length === 0) return null;
  try {
    const res = await llm.complete({
      tier: "cheap",
      system: "You check whether any of the supplied research notes states the answer to a short question. Only what a note says counts; do not infer or combine. A note saying the answer is unknown is not an answer. If answered, return it in one sentence that quotes or closely paraphrases the note. Otherwise answered=false.",
      prompt: [notes.map((n, i) => `<note n="${i + 1}">\n${n}\n</note>`).join("\n"), "", `Question: ${question}`, "", 'Return JSON: {"answered": boolean, "answer": string, "note": the n of the note that answers}.'].join("\n"),
      schema: NotesAnswerSchema,
      label: "resolve:notes",
      maxTokens: 300,
    });
    if (!(res.answered && res.answer && res.answer.trim())) return null;
    // The answer must be bound to the note that supplied it; without a valid identifier it is not a verified answer.
    if (!res.note || res.note < 1 || res.note > notes.length) return null;
    return { answer: res.answer.trim(), note: res.note - 1 };
  } catch {
    return null;
  }
}

export async function answerFromPost(question: string, post: NormalizedPost, llm: LLMProvider): Promise<string | null> {
  try {
    const res = await llm.complete({
      tier: "cheap",
      system: "You check whether a short question is answered by the text of a post, its thread, or the post it quotes. Only what is written counts; do not infer, do not add outside knowledge. If it is answered, return the answer in one sentence that quotes or closely paraphrases the text. If it is not answered, or only partly, return answered=false.",
      prompt: [renderPost(post), "", `Question: ${question}`, "", 'Return JSON: {"answered": boolean, "answer": string}.'].join("\n"),
      schema: PostAnswerSchema,
      label: `resolve:${post.tweet_id}`,
      maxTokens: 300,
    });
    return res.answered && res.answer && res.answer.trim() ? res.answer.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Grounding resolution: fetch only what the reasoning stage asked for.
 *   kb         → library excerpts for the stated query
 *   experience → the approved first-person context (identity file), on demand
 *   verify     → resolve the exact factual dependency: post/thread first, then
 *                the dated research archive, then (not yet) the web
 * Anything unresolved is reported so the draft can proceed without it and the
 * card can say what was not verified.
 */
export interface VerifiedFact {
  question: string;
  claim: string;
  source: string;
  /** ISO date or "YYYY-MM" the fact is good as of. */
  as_of: string;
  verified_at: string;
}

export interface GroundingBundle {
  chunks: KBChunk[];
  experience?: string;
  fact?: VerifiedFact;
  unresolved?: string;
  wantsFirstPerson: boolean;
}

/**
 * The research notes as a searchable archive of dated facts. Each bullet is
 * one entry, tagged with the date of the section it sits under. Consulted only
 * for a specific question; never loaded as context.
 */
export interface FactArchive {
  size: number;
  lookup(question: string): VerifiedFact | null;
  /** Overlapping notes as candidate evidence, best first; nothing is verified by this alone. */
  candidates(question: string, limit?: number): Array<{ text: string; as_of: string }>;
}

export function buildFactArchive(markdown: string, source = "research-notes"): FactArchive {
  const entries: Array<{ text: string; as_of: string; tokens: Set<string> }> = [];
  let currentDate = "";
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      const m = /\((\d{4}-\d{2}(?:-\d{2})?)\)|\b(\d{4}-\d{2}(?:-\d{2})?)\b/.exec(line);
      currentDate = m?.[1] ?? m?.[2] ?? currentDate;
      continue;
    }
    if (!line.startsWith("-")) continue;
    const text = line.replace(/^-\s*/, "").trim();
    if (text.length < 12) continue;
    entries.push({ text, as_of: currentDate || "undated", tokens: new Set(tokenize(text)) });
  }
  return {
    size: entries.length,
    candidates(question, limit = 3) {
      const q = tokenize(question).filter((t) => t.length > 2);
      if (q.length === 0) return [];
      return entries
        .map((e) => { let hit = 0; for (const t of q) if (e.tokens.has(t)) hit += 1; return { e, score: hit / q.length }; })
        .filter((x) => x.score >= 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => ({ text: x.e.text, as_of: x.e.as_of }));
    },
    lookup(question) {
      const q = tokenize(question).filter((t) => t.length > 2);
      if (q.length === 0) return null;
      let best: { e: (typeof entries)[number]; score: number } | null = null;
      for (const e of entries) {
        let hit = 0;
        for (const t of q) if (e.tokens.has(t)) hit += 1;
        const score = hit / q.length;
        if (!best || score > best.score) best = { e, score };
      }
      // Require a real overlap: at least half the question's terms.
      if (!best || best.score < 0.5) return null;
      return { question, claim: best.e.text, source, as_of: best.e.as_of, verified_at: new Date().toISOString() };
    },
  };
}

export function loadFactArchive(path: string): FactArchive {
  if (!existsSync(path)) return buildFactArchive("");
  return buildFactArchive(readFileSync(path, "utf8"));
}

/** Append-only cache of resolved facts. Machine-maintained; never hand-edited. */
export function rememberFact(cachePath: string, fact: VerifiedFact): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    appendFileSync(cachePath, `${JSON.stringify(fact)}\n`);
  } catch {
    // best effort
  }
}

/** Pull the "what can legitimately be claimed" section out of the identity file, when present. */
export function approvedExperience(constraints: string | undefined): string | undefined {
  if (!constraints) return undefined;
  const m = /##\s*What can legitimately be claimed[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i.exec(constraints);
  const text = (m?.[1] ?? "").trim();
  return text.length > 0 ? text : undefined;
}

export async function resolveGrounding(
  reason: ReasonResult,
  post: NormalizedPost,
  theme: string,
  deps: { kb: KBIndex; facts?: FactArchive; factCachePath?: string; topK: number; llm?: LLMProvider },
): Promise<GroundingBundle> {
  const g = reason.grounding;
  const wantsKb = g === "kb" || g === "hybrid";
  const wantsExperience = g === "experience" || g === "hybrid" || reason.wants_first_person || reason.move === "operator_context";
  const wantsVerify = (g === "verify" || g === "hybrid") && !!reason.fact_dependency;
  // An explicit verification request with no stated dependency is itself unresolved; a hybrid may legitimately mean library plus experience.
  const missingDependency = g === "verify" && !reason.fact_dependency?.trim();

  // Selective: an excerpt must carry a real share of the query, or nothing is retrieved. A post about
  // content communities must not pull card-receivables text because two words overlap.
  const chunks = wantsKb ? deps.kb.search(reason.kb_query?.trim() || retrievalQuery(post, theme), deps.topK, { minRelative: 0.45, minMatched: 3 }) : [];
  const experience = wantsExperience ? approvedExperience(deps.kb.constraints) : undefined;

  let fact: VerifiedFact | undefined;
  let unresolved: string | undefined;
  if (wantsVerify) {
    const q = reason.fact_dependency!.trim();
    // 1. the post, thread, and quoted post: verified only when an answer is actually extracted
    const fromPost = deps.llm ? await answerFromPost(q, post, deps.llm) : null;
    if (fromPost) {
      fact = { question: q, claim: fromPost, source: "post", as_of: post.created_at.slice(0, 10), verified_at: new Date().toISOString() };
    } else {
      // 2. the dated research archive: overlapping notes are evidence; only an extracted answer is a fact
      const notes = deps.facts?.candidates(q) ?? [];
      const fromNotes = deps.llm && notes.length > 0 ? await answerFromNotes(q, notes.map((n) => `(as of ${n.as_of}) ${n.text}`), deps.llm) : null;
      if (fromNotes) {
        fact = { question: q, claim: fromNotes.answer, source: "research-notes", as_of: notes[fromNotes.note]?.as_of ?? notes[0]!.as_of, verified_at: new Date().toISOString() };
        if (deps.factCachePath) rememberFact(deps.factCachePath, fact);
      } else {
        // 3. (web verification not wired yet) → proceed without it, say so.
        unresolved = q;
      }
    }
  }
  if (missingDependency && !unresolved) unresolved = "verification was requested but no factual dependency was stated";
  return { chunks, experience, fact, unresolved, wantsFirstPerson: reason.wants_first_person || reason.move === "operator_context" };
}
