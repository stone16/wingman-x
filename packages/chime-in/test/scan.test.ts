import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CandidateInput } from "@wingman-x/agent-kit";
import { ConfigSchema, loadConfig } from "../src/config.js";
import { buildKBIndexFromDocs } from "../src/kb/kb-index.js";
import { createFakeProvider, type FakeHandler } from "../src/llm/fake.js";
import { runScan, type ScanDeps } from "../src/pipeline/scan.js";
import { DEFAULT_THEMES } from "../src/pipeline/themes.js";
import { createFixtureSource } from "../src/sources/fixture-source.js";
import { createMemoryCandidateLog } from "../src/state/candidate-log.js";
import { createMemoryProcessedStore } from "../src/state/processed-store.js";
import { silentLogger } from "../src/util/logger.js";

const fixture = resolve(__dirname, "fixtures/apify-items.json");
const SINCE = new Date("2026-09-03T00:00:00.000Z");
const NOW = () => new Date("2026-09-04T12:00:00.000Z");

const config = ConfigSchema.parse({ chimeDir: "/tmp/unused", themeBatchSize: 2, llmConcurrency: 2, maxCandidatesPerScan: 1 });
const watchlist = [
  { handle: "creditpm", priority: 1 as const },
  { handle: "infra_alice", priority: 2 as const },
  { handle: "macro_mike", priority: 3 as const },
];
const kb = buildKBIndexFromDocs("Be direct.", [
  {
    id: "private-credit",
    title: "Private credit",
    markdown: "# Private credit\n\n## Why financing utility matters\nFor tokenized private credit, secondary liquidity is not the first bottleneck; a lender financing the position is.\n",
  },
  {
    id: "securities-infrastructure",
    title: "Securities infrastructure",
    markdown: "# Securities infrastructure\n\n## Settlement legs\nSettlement is only as atomic as its slowest leg; without an onchain cash leg DvP is a promise to reconcile.\n",
  },
]);

/** Scripted model: creditpm's liquidity post is a strong candidate; alice's settlement post passes theme but reasoning finds nothing to add; macro fails theme. */
const scripted: FakeHandler = ({ label, prompt }) => {
  if (label.startsWith("theme")) {
    const ids = [...prompt.matchAll(/tweet_id="(\d+)"/g)].map((m) => m[1]!);
    return {
      results: ids.map((id) => {
        if (id === "2001000000000000005") return { tweet_id: id, relevant: false, theme: "Fintech", theme_score: 20, reason: "macro" };
        if (id === "2001000000000000002") return { tweet_id: id, relevant: true, theme: "Settlement", theme_score: 82, reason: "pilot" };
        return { tweet_id: id, relevant: true, theme: "Private credit", theme_score: 91, reason: "liquidity claim" };
      }),
    };
  }
  if (label.startsWith("reason")) {
    const settlement = /Theme[^\n]*: Settlement/.test(prompt);
    return settlement
      ? { worth: 85, reason: "nothing to add", move: "none", depth: "light", posture: "announcement", energy: "casual", angle: "agree", grounding: "none" }
      : { worth: 87, reason: "disagrees", move: "challenge", depth: "substantive", posture: "argument", energy: "serious", angle: "Challenges the liquidity-first assumption.", grounding: "kb", kb_query: "secondary liquidity lender financing" };
  }
  if (label.startsWith("verify")) return { specifics: [] };
  if (label.startsWith("draft")) return { suggested_reply: "Financing utility comes before secondary liquidity; the lender's eligibility test is the real gate." };
  throw new Error(`unexpected label ${label}`);
};

function deps(overrides: Partial<ScanDeps> = {}): ScanDeps & { posted: CandidateInput[][] } {
  const posted: CandidateInput[][] = [];
  return {
    config,
    watchlist,
    source: createFixtureSource(fixture, { now: NOW }),
    llm: createFakeProvider(scripted),
    kb,
    themes: DEFAULT_THEMES,
    processed: createMemoryProcessedStore(),
    candidateLog: createMemoryCandidateLog(),
    sink: { postCandidates: async (cs) => { posted.push(cs); return { accepted: cs.length }; } },
    log: silentLogger,
    now: NOW,
    posted,
    ...overrides,
  };
}

describe("runScan", () => {
  it("narrows the funnel, sends the survivor to Wingman, and records durable decisions", async () => {
    const d = deps();
    const s = await runScan(d, { since: SINCE, dryRun: false, reprocess: false });
    expect(s).toMatchObject({
      accounts_requested: 3,
      accounts_fetched: 3,
      posts_fetched: 6,
      unseen_posts: 6,
      removed_by_basic_filters: 3,
      basic_filter_breakdown: { seen: 0, repost: 1, reply: 1, empty: 0, spam: 1 },
      theme_candidates: 2,
      expertise_candidates: 2,
      contribution_candidates: 1,
      ranked_out: 0,
      drafted: 1,
      sent: 1,
      errors: 0,
    });
    expect(d.posted).toHaveLength(1);
    const c = d.posted[0]![0]!;
    expect(c).toMatchObject({
      id: "chime-2001000000000000001",
      author_handle: "@creditpm",
      match_category: "selected",
    });
    expect(c.kb_refs).toContain("library/private-credit.md");
    expect(c.kb_refs).toContain("tone.md");
    expect(c.match_reason).toContain("Theme: Private credit (91) | Worth: 87 | Move: challenge | Grounding: kb | Angle: Challenges");
    // Every decided post is in the processed store; the sent one is a candidate.
    expect(d.processed.get("2001000000000000001")?.decision).toBe("candidate");
    expect(d.processed.get("2001000000000000002")).toMatchObject({ decision: "filtered", stage: "reason" });
    // move "none" wins even though the score (85) clears the threshold.
    expect(d.processed.get("2001000000000000002")?.reason).toMatch(/^move none \(85\)/);
    expect(d.processed.get("2001000000000000005")).toMatchObject({ decision: "filtered", stage: "theme" });
    expect(d.processed.get("2001000000000000004")).toMatchObject({ decision: "filtered", stage: "mechanical", reason: "repost" });
    expect(d.processed.size()).toBe(6);
    expect(d.candidateLog.get("2001000000000000001")?.replies).toEqual([c.suggested_reply]);
    expect(s.candidates[0]?.suggested_reply).toBe(c.suggested_reply);
    expect(s.llm.calls).toBeGreaterThan(0);
  });

  it("second scan skips everything already processed", async () => {
    const d = deps();
    await runScan(d, { since: SINCE, dryRun: false, reprocess: false });
    const calls = d.llm.usage().calls;
    const s2 = await runScan(d, { since: SINCE, dryRun: false, reprocess: false });
    expect(s2.unseen_posts).toBe(0);
    expect(s2.basic_filter_breakdown.seen).toBe(6);
    expect(s2.sent).toBe(0);
    expect(d.llm.usage().calls).toBe(calls);
    // --reprocess re-runs them.
    const s3 = await runScan(d, { since: SINCE, dryRun: false, reprocess: true });
    expect(s3.unseen_posts).toBe(6);
  });

  it("dry run sends nothing and marks nothing processed", async () => {
    const d = deps({ sink: null });
    const s = await runScan(d, { since: SINCE, dryRun: true, reprocess: false });
    expect(s.drafted).toBe(1);
    expect(s.sent).toBe(0);
    expect(s.dry_run).toBe(true);
    expect(d.processed.size()).toBe(0);
    expect(d.candidateLog.all()).toHaveLength(0);
    expect(s.outcomes.find((o) => o.tweet_id === "2001000000000000001")).toMatchObject({ stage: "draft", decision: "candidate" });
  });

  it("an LLM failure leaves the post unprocessed so the next scan retries it", async () => {
    let failOnce = true;
    const d = deps({
      llm: createFakeProvider((args) => {
        if (args.label === "reason:2001000000000000001" && failOnce) {
          failOnce = false;
          throw new Error("model down");
        }
        return scripted(args);
      }),
    });
    const s1 = await runScan(d, { since: SINCE, dryRun: false, reprocess: false });
    expect(s1.errors).toBe(1);
    expect(s1.sent).toBe(0);
    expect(d.processed.has("2001000000000000001")).toBe(false);
    const s2 = await runScan(d, { since: SINCE, dryRun: false, reprocess: false });
    expect(s2.sent).toBe(1);
  });

  it("a failed POST to Wingman marks nothing processed", async () => {
    const d = deps({ sink: { postCandidates: async () => { throw new Error("daemon 500"); } } });
    const s = await runScan(d, { since: SINCE, dryRun: false, reprocess: false });
    expect(s.sent).toBe(0);
    expect(s.errors).toBe(1);
    expect(d.processed.has("2001000000000000001")).toBe(false);
    expect(s.outcomes.find((o) => o.tweet_id === "2001000000000000001")).toMatchObject({ stage: "sent", decision: "error" });
  });

  it("ranks out above-threshold posts beyond the cap, honours --handles and --limit, and reports account failures", async () => {
    const generous = createFakeProvider((args) => {
      if (args.label.startsWith("reason")) return { worth: 80, reason: "r", move: "agree_extend", depth: "substantive", posture: "other", energy: "serious", angle: "angle", grounding: "none" };
      return scripted(args);
    });
    const d = deps({
      llm: generous,
      source: {
        name: "stub",
        fetchPosts: async (accounts, since, opts) => {
          const res = await createFixtureSource(fixture, { now: NOW }).fetchPosts(accounts, since, opts);
          return { ...res, accounts: [...res.accounts, { handle: "ghost", ok: false, posts: 0, error: "404" }] };
        },
      },
    });
    const s = await runScan(d, { since: SINCE, dryRun: false, reprocess: false, handles: ["creditpm", "infra_alice"] });
    expect(s.accounts_requested).toBe(2);
    expect(s.account_failures).toEqual([{ handle: "ghost", error: "404" }]);
    expect(s.contribution_candidates).toBe(2);
    expect(s.ranked_out).toBe(1);
    expect(s.sent).toBe(1);
    expect(d.processed.get("2001000000000000002")).toMatchObject({ decision: "filtered", stage: "rank" });

    const limited = await runScan(deps(), { since: SINCE, dryRun: false, reprocess: false, limit: 1 });
    expect(limited.theme_candidates + limited.errors).toBeLessThanOrEqual(1);
  });

  it("drops a draft that cannot be shortened under the limit", async () => {
    const d = deps({
      config: { ...config, replyMaxChars: 20 },
      llm: createFakeProvider((args) => (args.label.startsWith("draft") ? { suggested_reply: "x".repeat(50) } : scripted(args))),
    });
    const s = await runScan(d, { since: SINCE, dryRun: false, reprocess: false });
    expect(s.drafted).toBe(0);
    expect(s.errors).toBe(1);
  });
});

describe("loadConfig", () => {
  it("reads env with defaults, booleans and numbers", () => {
    const c = loadConfig({ APIFY_TOKEN: "t", INCLUDE_REPLIES: "yes", THEME_THRESHOLD: "55", CHIME_IN_DIR: "/x" } as NodeJS.ProcessEnv);
    expect(c).toMatchObject({ apifyToken: "t", includeReplies: true, themeThreshold: 55, chimeDir: "/x", apifyMode: "search", llmProvider: "auto" });
    expect(() => loadConfig({ INCLUDE_REPLIES: "maybe" } as NodeJS.ProcessEnv)).toThrow(/boolean/);
    expect(() => loadConfig({ THEME_THRESHOLD: "abc" } as NodeJS.ProcessEnv)).toThrow(/numeric/);
    expect(loadConfig({ WINGMAN_X_STATE_DIR: "/state" } as NodeJS.ProcessEnv).chimeDir).toBe("/state/chime-in");
  });
});
