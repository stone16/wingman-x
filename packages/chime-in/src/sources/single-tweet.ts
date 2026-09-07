import { NormalizedPostSchema, type NormalizedPost } from "../model/post.js";
import { expandTruncated } from "./full-text.js";

/**
 * One tweet by URL, for "paste a link, get a card". Uses X's public
 * syndication endpoint (the one embedded tweets load from): free, no auth,
 * returns text, author, counts, and the quoted tweet. Falls back to nothing;
 * the caller decides what to do on failure.
 */
// Swallows a trailing query string / fragment (share links carry ?s=46&t=…) so it never leaks into the instruction.
const TWEET_URL_RE = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/(?:#!\/)?(\w{1,15}|i)\/status(?:es)?\/(\d{5,})(?:[/?#][^\s]*)?/i;

export function parseTweetUrl(text: string): { tweetId: string; handle: string | null; url: string } | null {
  const m = TWEET_URL_RE.exec(text);
  if (!m) return null;
  const handle = m[1] === "i" ? null : m[1]!;
  return { tweetId: m[2]!, handle, url: m[0] };
}

/** Everything in the message that is not the link: the person's instruction, if any. */
export function instructionAfterUrl(text: string): string | undefined {
  const rest = text.replace(TWEET_URL_RE, " ").replace(/\s+/g, " ").trim();
  return rest.length > 0 ? rest : undefined;
}

// The syndication endpoint wants a token derived from the id; this is the
// derivation the embed script uses.
export function syndicationToken(tweetId: string): string {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

interface SyndicationTweet {
  id_str: string;
  text: string;
  created_at: string;
  lang?: string;
  favorite_count?: number;
  conversation_count?: number;
  user?: { screen_name?: string; name?: string };
  quoted_tweet?: { id_str?: string; text?: string; user?: { screen_name?: string } };
  in_reply_to_status_id_str?: string;
  /** The immediate parent, included by the endpoint for replies. */
  parent?: { id_str?: string; text?: string; user?: { screen_name?: string }; in_reply_to_status_id_str?: string };
}

async function fetchRaw(tweetId: string, fetchImpl: typeof fetch): Promise<Partial<SyndicationTweet> & { __typename?: string }> {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(tweetId)}&token=${syndicationToken(tweetId)}`;
  const res = await fetchImpl(url, { headers: { "user-agent": "Mozilla/5.0", accept: "application/json" } });
  if (!res.ok) throw new Error(`syndication ${res.status} for ${tweetId}`);
  return (await res.json()) as Partial<SyndicationTweet> & { __typename?: string };
}

/**
 * Earlier posts in the conversation, oldest first, walking up
 * `in_reply_to_status_id_str` one fetch per hop (each hop is free). Stops at
 * `maxDepth` or at a post that is unavailable.
 */
export async function fetchThreadAbove(
  body: Partial<SyndicationTweet>,
  fetchImpl: typeof fetch,
  maxDepth = 4,
): Promise<Array<{ tweet_id?: string; author_handle?: string; text: string }>> {
  const chain: Array<{ tweet_id?: string; author_handle?: string; text: string }> = [];
  let parentId = body.in_reply_to_status_id_str;
  let depth = 0;
  while (parentId && depth < maxDepth) {
    let parent: Partial<SyndicationTweet>;
    try {
      parent = await fetchRaw(parentId, fetchImpl);
    } catch {
      break;
    }
    if (typeof parent.text !== "string") break;
    chain.unshift({ tweet_id: parent.id_str ?? parentId, author_handle: parent.user?.screen_name, text: parent.text });
    parentId = parent.in_reply_to_status_id_str;
    depth += 1;
  }
  return chain;
}

export async function fetchTweetById(
  tweetId: string,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
  opts: { thread?: boolean; maxDepth?: number; fullText?: boolean } = {},
): Promise<NormalizedPost> {
  const body = await fetchRaw(tweetId, fetchImpl);
  if (!body || typeof body.text !== "string" || !body.user?.screen_name) {
    throw new Error(`tweet ${tweetId} unavailable (${body?.__typename ?? "no data"}); it may be deleted or protected`);
  }
  const handle = body.user.screen_name;
  const thread = opts.thread === false ? [] : await fetchThreadAbove(body, fetchImpl, opts.maxDepth ?? 4);
  const post = NormalizedPostSchema.parse({
    thread,
    tweet_id: body.id_str ?? tweetId,
    tweet_url: `https://x.com/${handle}/status/${body.id_str ?? tweetId}`,
    author_handle: handle,
    author_name: body.user.name ?? handle,
    tweet_text: body.text,
    created_at: body.created_at ?? now().toISOString(),
    reply_count: body.conversation_count ?? 0,
    like_count: body.favorite_count ?? 0,
    is_reply: typeof body.in_reply_to_status_id_str === "string",
    is_quote: body.quoted_tweet !== undefined,
    ...(body.quoted_tweet?.text
      ? {
          quoted_tweet: {
            tweet_id: body.quoted_tweet.id_str ?? "",
            author_handle: body.quoted_tweet.user?.screen_name ?? "",
            text: body.quoted_tweet.text,
          },
        }
      : {}),
    ...(body.lang ? { lang: body.lang } : {}),
    scraped_at: now().toISOString(),
  });
  // The syndication endpoint cuts long posts at 280 too.
  if (opts.fullText !== false) await expandTruncated([post], fetchImpl);
  return post;
}
