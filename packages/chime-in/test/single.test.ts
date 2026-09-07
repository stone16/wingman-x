import { describe, expect, it } from "vitest";
import type { CandidateInput } from "@wingman-x/agent-kit";
import { ConfigSchema } from "../src/config.js";
import { buildKBIndexFromDocs } from "../src/kb/kb-index.js";
import { createFakeProvider, type FakeHandler } from "../src/llm/fake.js";
import { NormalizedPostSchema } from "../src/model/post.js";
import { runSinglePost } from "../src/pipeline/single.js";
import { fetchTweetById, instructionAfterUrl, parseTweetUrl, syndicationToken } from "../src/sources/single-tweet.js";
import { createMemoryCandidateLog } from "../src/state/candidate-log.js";

const config = ConfigSchema.parse({ chimeDir: "/tmp/unused" });
const kb = buildKBIndexFromDocs("tone", [
  { id: "custody", title: "Custody", markdown: "# Custody\n\n## Control\nControl agreements decide what a lender can enforce.\n" },
]);
const post = NormalizedPostSchema.parse({
  tweet_id: "2096341670451368083",
  tweet_url: "https://x.com/pitdesi/status/2096341670451368083",
  author_handle: "pitdesi",
  tweet_text: "More context makes a personal assistant dramatically better.",
  created_at: "2026-09-05T20:56:17.000Z",
  scraped_at: "2026-09-05T21:00:00.000Z",
});

describe("single tweet by link", () => {
  it("parses x.com and twitter.com status links, with or without a handle, and separates the instruction", () => {
    expect(parseTweetUrl("https://x.com/pitdesi/status/2096341670451368083")).toMatchObject({ tweetId: "2096341670451368083", handle: "pitdesi" });
    expect(parseTweetUrl("look https://twitter.com/i/status/123456789?s=20 make it funny")).toMatchObject({ tweetId: "123456789", handle: null });
    expect(parseTweetUrl("no link here")).toBeNull();
    expect(instructionAfterUrl("https://x.com/a/status/123456 make it a question")).toBe("make it a question");
    expect(instructionAfterUrl("https://x.com/a/status/123456")).toBeUndefined();
    // share-sheet links carry a tracking suffix; it is part of the link, not an instruction
    expect(instructionAfterUrl("https://x.com/a/status/123456?s=46&t=hhRao0BpDk8K43YxPDQX5Q")).toBeUndefined();
    expect(instructionAfterUrl("https://x.com/a/status/123456?s=46&t=abc Write a quote retweet response")).toBe("Write a quote retweet response");
    expect(parseTweetUrl("https://x.com/a/status/123456?s=46&t=abc")).toMatchObject({ tweetId: "123456", handle: "a" });
  });

  it("derives the syndication token the embed script uses", () => {
    expect(syndicationToken("2096341670451368083")).toMatch(/^[0-9a-z]+$/);
  });

  it("normalises a syndication payload into a post", async () => {
    const fake: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          __typename: "Tweet",
          id_str: "1",
          text: "hello",
          created_at: "2026-09-05T20:56:17.000Z",
          favorite_count: 3,
          conversation_count: 2,
          user: { screen_name: "a", name: "A" },
          quoted_tweet: { id_str: "9", text: "q", user: { screen_name: "b" } },
        }),
        { status: 200 },
      );
    const p = await fetchTweetById("1", fake, () => new Date("2026-09-05T21:00:00.000Z"));
    expect(p).toMatchObject({ tweet_id: "1", author_handle: "a", tweet_text: "hello", like_count: 3, reply_count: 2, is_quote: true });
    expect(p.quoted_tweet?.text).toBe("q");
    await expect(fetchTweetById("2", async () => new Response(JSON.stringify({ __typename: "TweetTombstone" }), { status: 200 }))).rejects.toThrow(/unavailable/);
  });

  it("runs without a worth gate, applies an instruction, posts to the daemon, and logs", async () => {
    const posted: CandidateInput[][] = [];
    const prompts: string[] = [];
    const handler: FakeHandler = ({ label, prompt, system }) => {
      prompts.push(system + "\n" + prompt);
      if (label.startsWith("theme")) return { results: [{ tweet_id: post.tweet_id, relevant: false, theme: "AI in financial workflows", theme_score: 30, reason: "thin" }] };
      if (label.startsWith("reason")) return { worth: 50, reason: "r", move: "question", depth: "light", posture: "observation", energy: "casual", angle: "ask what changed", grounding: "kb", kb_query: "control agreements" };
      if (label.startsWith("verify")) return { specifics: [] };
      if (label.startsWith("draft")) return { suggested_reply: "What changed for you when the context got bigger?" };
      throw new Error(`unexpected ${label}`);
    };
    const log = createMemoryCandidateLog();
    const r = await runSinglePost(
      post,
      {
        config,
        llm: createFakeProvider(handler),
        kb,
        themes: ["AI in financial workflows", "Technology and startups"],
        digest: "Judge the lifecycle, not the token.",
        experienceIndex: "Custody: firsthand.",
        policy: "casual policy",
        candidateLog: log,
        postCandidates: async (cs) => {
          posted.push(cs);
          return { accepted: cs.length };
        },
      },
      "ask a question",
    );
    expect(r.grounding).toBe("kb");
    expect(r.move).toBe("question");
    expect(prompts.some((p) => p.includes("Judge the lifecycle, not the token."))).toBe(true);
    expect(prompts.some((p) => p.includes("already decided to reply") && p.includes("instruction for this reply (it outranks the defaults above): ask a question"))).toBe(true);
    expect(posted[0]?.[0]).toMatchObject({ id: "chime-2096341670451368083", suggested_reply: "What changed for you when the context got bigger?", match_category: "selected" });
    expect(prompts.some((p) => p.includes("<instruction>\nask a question\n</instruction>"))).toBe(true);
    expect(log.get(post.tweet_id)).toMatchObject({ grounding: "kb", kb_query: "control agreements", moves: ["question"], instructions: ["ask a question"] });
    expect(log.get(post.tweet_id)?.kb_refs).toEqual(["library/custody.md"]);
  });

  it("a move of none becomes a light reaction and needs no grounding", async () => {
    const handler: FakeHandler = ({ label }) => {
      if (label.startsWith("theme")) return { results: [{ tweet_id: post.tweet_id, relevant: true, theme: "Technology and startups", theme_score: 70, reason: "tech" }] };
      if (label.startsWith("reason")) return { worth: 40, reason: "meh", move: "none", depth: "light", posture: "observation", energy: "casual", angle: "the assistant that needs more context", grounding: "none" };
      if (label.startsWith("verify")) return { specifics: [] };
      if (label.startsWith("draft")) return { suggested_reply: "The assistant that needs more context is the assistant." };
      throw new Error(`unexpected ${label}`);
    };
    const log = createMemoryCandidateLog();
    const r = await runSinglePost(post, {
      config,
      llm: createFakeProvider(handler),
      kb,
      themes: ["AI in financial workflows", "Technology and startups"],
      digest: "",
      experienceIndex: "",
      policy: "casual policy",
      candidateLog: log,
      postCandidates: async (cs) => ({ accepted: cs.length }),
    });
    expect(r.grounding).toBe("none");
    expect(r.move).toBe("light_reaction");
    expect(r.candidate.match_reason).toContain("Grounding: none");
    expect(r.candidate.kb_refs).toEqual(["tone.md"]);
    expect(log.get(post.tweet_id)).toMatchObject({ grounding: "none", moves: ["light_reaction"] });
  });
});

import { renderPost } from "../src/pipeline/prompts.js";

describe("thread awareness", () => {
  const payloads: Record<string, unknown> = {
    "3": { __typename: "Tweet", id_str: "3", text: "third: disagree, the register is the point", created_at: "2026-09-05T20:56:17.000Z", user: { screen_name: "c", name: "C" }, in_reply_to_status_id_str: "2" },
    "2": { __typename: "Tweet", id_str: "2", text: "second: tokenized stocks are just stablecoins for equities", created_at: "2026-09-05T20:50:00.000Z", user: { screen_name: "b", name: "B" }, in_reply_to_status_id_str: "1" },
    "1": { __typename: "Tweet", id_str: "1", text: "first: robinhood launched stock tokens", created_at: "2026-09-05T20:40:00.000Z", user: { screen_name: "a", name: "A" } },
  };
  const fake: typeof fetch = async (url) => {
    const id = /id=(\d+)/.exec(String(url))?.[1] ?? "";
    return new Response(JSON.stringify(payloads[id] ?? { __typename: "TweetTombstone" }), { status: 200 });
  };

  it("walks the parent chain oldest-first and renders it as context before the post", async () => {
    const p = await fetchTweetById("3", fake, () => new Date("2026-09-05T21:00:00.000Z"));
    expect(p.is_reply).toBe(true);
    expect(p.thread.map((t) => `${t.author_handle}:${t.text.split(":")[0]}`)).toEqual(["a:first", "b:second"]);
    const rendered = renderPost(p);
    expect(rendered.indexOf("<thread")).toBeLessThan(rendered.indexOf("<post "));
    expect(rendered).toContain('<earlier author="@a">');
    expect(rendered).toContain("third: disagree");
  });

  it("respects maxDepth and can be turned off", async () => {
    expect((await fetchTweetById("3", fake, undefined, { maxDepth: 1 })).thread).toHaveLength(1);
    expect((await fetchTweetById("3", fake, undefined, { thread: false })).thread).toEqual([]);
  });
});
