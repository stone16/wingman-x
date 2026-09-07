import type { NormalizedPost } from "../model/post.js";

/**
 * Long posts (X Premium "note tweets") arrive truncated at the classic 280
 * characters from both the Apify actor and the syndication endpoint, with no
 * ellipsis. Six of 136 recent posts were affected, including ones every engine
 * answered as if half a tweet was the whole thing. FxTwitter's public API
 * returns the full text; this fills it in for posts that look cut off and
 * leaves everything else untouched. Best effort: any failure keeps the text
 * we have.
 */
const FX = "https://api.fxtwitter.com/status/";
const CAP = 280;

export function looksTruncated(text: string): boolean {
  const n = [...text].length;
  return n >= CAP - 10 && n <= CAP;
}

export async function fetchFullText(tweetId: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`${FX}${tweetId}`, { headers: { "user-agent": "Mozilla/5.0 (chime-in)" } });
    if (!res.ok) return null;
    const body = (await res.json()) as { code?: number; tweet?: { text?: string } };
    const text = body.tweet?.text;
    return typeof text === "string" && text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** Replace truncated post and quoted-post text in place where the full version can be fetched. Returns how many were expanded. */
export async function expandTruncated(posts: NormalizedPost[], fetchImpl: typeof fetch = fetch, concurrency = 4): Promise<number> {
  const jobs: Array<() => Promise<void>> = [];
  let expanded = 0;
  for (const p of posts) {
    if (looksTruncated(p.tweet_text)) {
      jobs.push(async () => {
        const full = await fetchFullText(p.tweet_id, fetchImpl);
        if (full && [...full].length > [...p.tweet_text].length) {
          p.tweet_text = full;
          expanded += 1;
        }
      });
    }
    const q = p.quoted_tweet;
    const qid = q?.tweet_id;
    if (q && qid && looksTruncated(q.text)) {
      jobs.push(async () => {
        const full = await fetchFullText(qid, fetchImpl);
        if (full && [...full].length > [...q.text].length) {
          q.text = full;
          expanded += 1;
        }
      });
    }
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        await jobs[i]!();
      }
    }),
  );
  return expanded;
}
