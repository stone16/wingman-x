import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { NormalizedPostSchema } from "../model/post.js";

/**
 * Everything we knew when we drafted a candidate, so regeneration can
 * reuse the same theme, angle, KB excerpts and prior replies without
 * re-scoring. Also the raw material for Phase 2 "learn from my behaviour".
 */
export const CandidateLogRecordSchema = z.object({
  tweet_id: z.string().min(1),
  recorded_at: z.string(),
  post: NormalizedPostSchema,
  theme: z.string(),
  theme_score: z.number(),
  expertise_score: z.number(),
  contribution_score: z.number(),
  contribution_angle: z.string(),
  account_priority: z.number(),
  kb_refs: z.array(z.string()),
  /** Chunk refs (file#heading) used for drafting — used again for regen. */
  chunk_refs: z.array(z.string()),
  replies: z.array(z.string()),
  /** Conversational move used for each entry in `replies` (parallel; optional for older records). */
  moves: z.array(z.string()).optional(),
  /** The reasoner's account of what the author was saying; forwarded to the drafter on regeneration. */
  author_point: z.string().optional(),
  /** Every contribution tried for this post, oldest first; a plain ♻️ must find one that is not here. */
  angles: z.array(z.string()).optional(),
  /** The factual dependency the reasoner named for the current contribution, if any. */
  fact_dependency: z.string().optional(),
  /** Prompt profile that produced the current contribution. */
  profile: z.string().optional(),
  depth: z.string().optional(),
  posture: z.string().optional(),
  /** Pre-generated drafts not yet shown; served on ♻️ without a model call. */
  alternates: z.array(z.string()).optional(),
  /** What was live on the card when the person filled it: the only real preference signal. */
  filled_reply: z.string().optional(),
  filled_at: z.string().optional(),
  /** "expertise" (default) or "conversational". */
  lane: z.string().optional(),
  line_type: z.string().optional(),
  /** Unified engine: grounding decision and library query, for regeneration. */
  grounding: z.string().optional(),
  kb_query: z.string().optional(),
  /** Instruction waiting to be applied on the next regeneration (guided regen). */
  regen_instruction: z.string().optional(),
  /** Instructions applied so far, parallel-ish to `replies`. */
  instructions: z.array(z.string()).optional(),
});
export type CandidateLogRecord = z.infer<typeof CandidateLogRecordSchema>;

export interface CandidateLog {
  get(tweetId: string): CandidateLogRecord | undefined;
  upsert(rec: CandidateLogRecord): void;
  all(): CandidateLogRecord[];
}

export function parseCandidateLog(text: string): Map<string, CandidateLogRecord> {
  const map = new Map<string, CandidateLogRecord>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const rec = CandidateLogRecordSchema.safeParse(JSON.parse(line));
      if (rec.success) map.set(rec.data.tweet_id, rec.data);
    } catch {
      // skip torn line
    }
  }
  return map;
}

export function openCandidateLog(path: string): CandidateLog {
  const map = existsSync(path) ? parseCandidateLog(readFileSync(path, "utf8")) : new Map<string, CandidateLogRecord>();
  return {
    get: (id) => map.get(id),
    upsert(rec) {
      const v = CandidateLogRecordSchema.parse(rec);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(v)}\n`, "utf8");
      map.set(v.tweet_id, v);
    },
    all: () => [...map.values()],
  };
}

export function createMemoryCandidateLog(): CandidateLog {
  const map = new Map<string, CandidateLogRecord>();
  return {
    get: (id) => map.get(id),
    upsert(rec) {
      map.set(rec.tweet_id, CandidateLogRecordSchema.parse(rec));
    },
    all: () => [...map.values()],
  };
}
