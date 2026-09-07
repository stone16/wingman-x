import { describe, expect, it } from "vitest";
import { NormalizedPostSchema } from "../src/model/post.js";
import { expandTruncated, looksTruncated } from "../src/sources/full-text.js";
import { fetchTweetById } from "../src/sources/single-tweet.js";

const cut = "x".repeat(279);
const full = "x".repeat(279) + " and the rest of the post that the actor dropped.";

describe("full text for truncated long posts", () => {
  it("only posts at the 280 cap look truncated", () => {
    expect(looksTruncated("short")).toBe(false);
    expect(looksTruncated(cut)).toBe(true);
    expect(looksTruncated("y".repeat(600))).toBe(false);
  });

  it("expands post and quoted text from the FxTwitter payload and leaves others alone", async () => {
    const calls: string[] = [];
    const fake: typeof fetch = async (url) => {
      calls.push(String(url));
      const id = String(url).split("/").pop();
      return new Response(JSON.stringify({ code: 200, tweet: { text: id === "1" || id === "9" ? full : "" } }), { status: 200 });
    };
    const posts = [
      NormalizedPostSchema.parse({ tweet_id: "1", tweet_url: "https://x.com/a/status/1", author_handle: "a", tweet_text: cut, created_at: "2026-09-06T00:00:00Z", scraped_at: "2026-09-06T00:00:00Z", is_quote: true, quoted_tweet: { tweet_id: "9", author_handle: "b", text: cut } }),
      NormalizedPostSchema.parse({ tweet_id: "2", tweet_url: "https://x.com/a/status/2", author_handle: "a", tweet_text: "short one", created_at: "2026-09-06T00:00:00Z", scraped_at: "2026-09-06T00:00:00Z" }),
    ];
    expect(await expandTruncated(posts, fake)).toBe(2);
    expect(posts[0]!.tweet_text).toBe(full);
    expect(posts[0]!.quoted_tweet?.text).toBe(full);
    expect(posts[1]!.tweet_text).toBe("short one");
    expect(calls).toHaveLength(2);
  });

  it("keeps the truncated text when the lookup fails", async () => {
    const posts = [NormalizedPostSchema.parse({ tweet_id: "1", tweet_url: "https://x.com/a/status/1", author_handle: "a", tweet_text: cut, created_at: "2026-09-06T00:00:00Z", scraped_at: "2026-09-06T00:00:00Z" })];
    expect(await expandTruncated(posts, async () => { throw new Error("offline"); })).toBe(0);
    expect(posts[0]!.tweet_text).toBe(cut);
  });

  it("the paste-a-link path expands too", async () => {
    const fake: typeof fetch = async (url) => {
      const u = String(url);
      if (u.includes("fxtwitter")) return new Response(JSON.stringify({ code: 200, tweet: { text: full } }), { status: 200 });
      return new Response(JSON.stringify({ __typename: "Tweet", id_str: "1", text: cut, created_at: "2026-09-06T00:00:00.000Z", user: { screen_name: "a", name: "A" } }), { status: 200 });
    };
    const p = await fetchTweetById("1", fake, () => new Date("2026-09-06T00:00:00Z"));
    expect(p.tweet_text).toBe(full);
  });
});
