import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyClientSideBounds,
  buildHandlesInput,
  buildSearchInput,
  buildSearchQuery,
  createApifySource,
  inferInputStyle,
  sinceStamp,
} from "../src/sources/apify/apify-source.js";
import { createFixtureSource } from "../src/sources/fixture-source.js";
import { normalizeApifyItems } from "../src/sources/apify/normalize.js";

const fixture = resolve(__dirname, "fixtures/apify-items.json");
const items = JSON.parse(readFileSync(fixture, "utf8")) as unknown[];
const SINCE = new Date("2026-09-03T00:00:00.000Z");
const opts = { maxPostsPerAccount: 5, includeReplies: false, includeReposts: false };
const accounts = [
  { handle: "creditpm", priority: 1 as const },
  { handle: "infra_alice", priority: 2 as const },
  { handle: "macro_mike", priority: 3 as const },
];

describe("query building", () => {
  it("builds a batched from: OR query with a day-early since and filters", () => {
    expect(buildSearchQuery(["a", "b"], SINCE, opts)).toBe(`(from:a OR from:b) since:${sinceStamp(SINCE)} -filter:replies -filter:retweets`);
    expect(buildSearchQuery(["a"], SINCE, { includeReplies: true, includeReposts: true })).toBe(`(from:a) since:${sinceStamp(SINCE)}`);
  });

  it("builds delicious_zebu inputs (sortBy, startDate, excludeReplies, per-search maxItems)", () => {
    expect(inferInputStyle("delicious_zebu/ultimate-x-twitter-advanced-search-scraper")).toBe("zebu");
    expect(inferInputStyle("apidojo/twitter-scraper-lite")).toBe("apidojo");
    const input = buildSearchInput(["a", "b", "c"], SINCE, opts, 2, "zebu");
    expect(input).toEqual({
      searchTerms: [
        `(from:a OR from:b) since:${sinceStamp(SINCE)} -filter:replies -filter:retweets`,
        `(from:c) since:${sinceStamp(SINCE)} -filter:replies -filter:retweets`,
      ],
      sortBy: "Latest",
      startDate: "2026-09-02",
      excludeReplies: true,
      maxItems: 10,
    });
  });

  it("chunks handles per query and sizes maxItems", () => {
    const input = buildSearchInput(["a", "b", "c"], SINCE, opts, 2);
    expect(input.searchTerms).toHaveLength(2);
    expect(input).toMatchObject({ sort: "Latest", maxItems: 15 });
    expect(buildHandlesInput(["a", "b"], opts)).toEqual({ twitterHandles: ["a", "b"], sort: "Latest", maxItems: 10, includeReplies: false });
    const withReplies = buildHandlesInput(["a"], { ...opts, includeReplies: true });
    expect(withReplies).toMatchObject({ includeReplies: true });
    expect("start" in withReplies).toBe(false);
  });
});

describe("applyClientSideBounds", () => {
  it("keeps only watchlist authors, newer than since, newest N per account", () => {
    const posts = normalizeApifyItems(items, "2026-09-04T00:00:00Z");
    const bounded = applyClientSideBounds(posts, ["creditpm", "infra_alice"], SINCE, 1);
    expect(bounded.map((p) => p.tweet_id).sort()).toEqual(["2001000000000000002", "2001000000000000003"]);
  });
});

describe("createApifySource", () => {
  it("search mode: one run, normalises, bounds, and reports per-account counts", async () => {
    const inputs: Record<string, unknown>[] = [];
    const source = createApifySource({
      actorId: "apidojo/test",
      mode: "search",
      handlesPerQuery: 2,
      handlesPerRun: 50,
      runActor: async (input) => {
        inputs.push(input);
        return items;
      },
      now: () => new Date("2026-09-04T00:00:00Z"),
    });
    const res = await source.fetchPosts(accounts, SINCE, opts);
    expect(inputs).toHaveLength(1);
    expect((inputs[0]!.searchTerms as string[]).length).toBe(2);
    expect(res.raw_count).toBe(items.length);
    expect(res.posts.every((p) => Date.parse(p.created_at) >= SINCE.getTime())).toBe(true);
    expect(res.posts.map((p) => p.tweet_id)).not.toContain("2001000000000000007");
    expect(res.posts.map((p) => p.author_handle)).not.toContain("feedbot");
    expect(res.accounts).toEqual([
      { handle: "creditpm", ok: true, posts: 2 },
      { handle: "infra_alice", ok: true, posts: 2 },
      { handle: "macro_mike", ok: true, posts: 2 },
    ]);
    expect(source.name).toBe("apify:apidojo/test:search");
  });

  it("zebu actors always take the search path, even in handles mode", async () => {
    const inputs: Record<string, unknown>[] = [];
    const source = createApifySource({
      actorId: "delicious_zebu/ultimate-x-twitter-advanced-search-scraper",
      mode: "handles",
      handlesPerQuery: 12,
      handlesPerRun: 1,
      runActor: async (input) => {
        inputs.push(input);
        return [];
      },
    });
    await source.fetchPosts(accounts, SINCE, opts);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ sortBy: "Latest", excludeReplies: true });
  });

  it("handles mode: chunks runs and isolates a failed run to its handles", async () => {
    let call = 0;
    const source = createApifySource({
      actorId: "apidojo/test",
      mode: "handles",
      handlesPerQuery: 10,
      handlesPerRun: 2,
      runActor: async (input) => {
        call += 1;
        if ((input.twitterHandles as string[]).includes("macro_mike")) throw new Error("actor exploded");
        return items;
      },
    });
    const res = await source.fetchPosts(accounts, SINCE, opts);
    expect(call).toBe(2);
    expect(res.accounts.find((a) => a.handle === "macro_mike")).toEqual({ handle: "macro_mike", ok: false, posts: 0, error: "actor exploded" });
    expect(res.accounts.find((a) => a.handle === "creditpm")?.ok).toBe(true);
    expect(res.posts.length).toBeGreaterThan(0);
  });
});

describe("createFixtureSource", () => {
  it("reads a raw dump and a {posts} file, rejecting other shapes", async () => {
    const src = createFixtureSource(fixture, { now: () => new Date("2026-09-04T00:00:00Z") });
    const res = await src.fetchPosts(accounts, SINCE, opts);
    expect(res.posts.length).toBe(6);
    expect(res.accounts.map((a) => a.ok)).toEqual([true, true, true]);

    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(resolve(tmpdir(), "chime-fx-"));
    const postsFile = resolve(dir, "posts.json");
    writeFileSync(postsFile, JSON.stringify({ posts: res.posts.slice(0, 1) }));
    const again = await createFixtureSource(postsFile).fetchPosts(accounts, SINCE, opts);
    expect(again.posts).toHaveLength(1);
    const bad = resolve(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ nope: true }));
    await expect(createFixtureSource(bad).fetchPosts(accounts, SINCE, opts)).rejects.toThrow(/expected an array/);
  });
});

describe("sinceStamp", () => {
  it("emits X's time-precise since format with a small overlap", () => {
    expect(sinceStamp(new Date("2026-09-05T21:34:08.705Z"))).toBe("2026-09-05_21:29:08_UTC");
    expect(sinceStamp(new Date("2026-09-05T00:02:00.000Z"), 0)).toBe("2026-09-05_00:02:00_UTC");
  });
});
