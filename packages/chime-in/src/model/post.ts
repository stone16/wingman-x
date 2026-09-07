import { z } from "zod";

/**
 * Our internal post model. Every `PostSource` (Apify today, X Filtered
 * Stream later) must produce exactly this shape; nothing downstream ever
 * sees a source-specific response structure.
 */
export const QuotedPostSchema = z.object({
  tweet_id: z.string().optional(),
  author_handle: z.string().optional(),
  text: z.string(),
});
export type QuotedPost = z.infer<typeof QuotedPostSchema>;

/** Must match Wingman's `TWEET_URL_RE` so candidates are accepted as-is. */
export const TWEET_URL_RE =
  /^https:\/\/(?:www\.)?(?:twitter|x)\.com\/[^/]+\/status\/\d+(?:[/?#].*)?$/;

export const NormalizedPostSchema = z.object({
  tweet_id: z.string().min(1),
  tweet_url: z.string().regex(TWEET_URL_RE, "must be an x.com/<handle>/status/<id> URL"),
  /** Handle without the leading "@". */
  author_handle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
  author_name: z.string().default(""),
  tweet_text: z.string(),
  /** ISO-8601. */
  created_at: z.string().refine((v) => Number.isFinite(Date.parse(v)), "created_at must parse as a date"),
  reply_count: z.number().int().nonnegative().default(0),
  repost_count: z.number().int().nonnegative().default(0),
  like_count: z.number().int().nonnegative().default(0),
  view_count: z.number().int().nonnegative().default(0),
  quoted_tweet: QuotedPostSchema.nullable().default(null),
  /** Earlier posts in the conversation this post replies to, oldest first. Empty for originals. */
  thread: z.array(QuotedPostSchema).default([]),
  is_reply: z.boolean().default(false),
  is_repost: z.boolean().default(false),
  is_quote: z.boolean().default(false),
  lang: z.string().optional(),
  /** ISO-8601, when our pipeline received it. */
  scraped_at: z.string(),
});
export type NormalizedPost = z.infer<typeof NormalizedPostSchema>;
export type NormalizedPostInput = z.input<typeof NormalizedPostSchema>;

export function canonicalTweetUrl(handle: string, tweetId: string): string {
  return `https://x.com/${handle}/status/${tweetId}`;
}
