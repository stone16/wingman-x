import { describe, expect, it } from "vitest";
import { selectSections } from "../src/kb/sections.js";
import { buildReasonSystemPrompt } from "../src/pipeline/stages/reason.js";
import { buildDraftSystemPrompt, buildDraftPrompt } from "../src/pipeline/stages/draft.js";
import { buildVerifySystemPrompt } from "../src/pipeline/stages/verify.js";
import type { NormalizedPost } from "../src/model/post.js";

const identity = `# Identity\n\n## Who is speaking\nUdit.\n\n## What can legitimately be claimed\n- Securitize: BUIDL.\n\n## Confidentiality\nNo deal terms.\n\n## Facts and verification\nNo figures without a source.\n\n## Diplomatic floor\nRelationship over win.\n\n## Lane discipline\nSkip price takes.\n`;
const policy = `# Conversational\n\n## North star\nBe a person.\n\n## Reply types\n- Irony.\n\n## Rules\nShort.\n\n## Examples (shape only)\n> ex\n\n## Do not reply when\nthe line is generic.\n`;
const tone = `# Voice\n\n## How it reads\nPlain.\n\n## Choosing what to say\nRead the post and decide.\n\n## Drift to catch\nEm dashes.\n`;
const post: NormalizedPost = { tweet_id: "1", tweet_url: "https://x.com/a/status/1", author_handle: "a", author_name: "A", tweet_text: "hi", created_at: "2026-09-06T00:00:00.000Z", reply_count: 0, repost_count: 0, like_count: 0, view_count: 0, is_reply: false, is_repost: false, is_quote: false, quoted_tweet: null, thread: [], scraped_at: "2026-09-06T00:00:00.000Z" };

describe("prompt profiles", () => {
  it("selectSections keeps named sections in order and drops the rest", () => {
    const s = selectSections(identity, ["Confidentiality", "Facts and verification"]);
    expect(s).toContain("No deal terms.");
    expect(s).toContain("No figures without a source.");
    expect(s).not.toContain("BUIDL");
    expect(s.indexOf("Confidentiality")).toBeLessThan(s.indexOf("Facts"));
  });

  it("baseline reasoner is unchanged; candidate drops the fit test, adds the motive rule, redefines agree_extend, splits boundaries and policy", () => {
    const base = buildReasonSystemPrompt({ digest: "views", experienceIndex: "map", boundaries: identity, policy });
    const cand = buildReasonSystemPrompt({ digest: "views", experienceIndex: "map", boundaries: identity, policy, profile: "candidate" });
    expect(base).toContain("would this angle fit just as well under a different post");
    expect(cand).not.toContain("would this angle fit just as well under a different post");
    expect(cand).toContain("Do not assert why the author's audience");
    expect(cand).toContain("the acknowledgment is the reply");
    expect(base).toContain("add a consequence or implication they did not draw");
    expect(cand).toContain("price takes"); // lane discipline lives in the skip rules now, not the identity block
    expect(cand).not.toContain("BUIDL");
    expect(cand).not.toContain("Be a person."); // casual policy retired as a runtime input in the candidate
    expect(cand).not.toContain("the line is generic.");
    expect(cand).toContain("Keep factual assertions within what their supporting material establishes");
    expect(cand).toContain("Acknowledgment may refer to something the author already said");
    expect(cand).not.toContain("already knows or already said, it is not the angle");
    expect(cand).toContain("Skip when the best available line is generic");
    expect(cand).toContain("Plain agreement or acknowledgment counts");
  });

  it("candidate drafter carries tone.md minus selection, only the shared constraints, and no casual policy", () => {
    const base = buildDraftSystemPrompt(tone, 280, { boundaries: identity, policy });
    const cand = buildDraftSystemPrompt(tone, 280, { boundaries: identity, policy, profile: "candidate" });
    expect(base).toContain("Read the post and decide.");
    expect(cand).not.toContain("Read the post and decide.");
    expect(cand).toContain("Em dashes.");
    expect(cand).toContain("No deal terms.");
    expect(cand).not.toContain("Relationship over win.");
    expect(cand).not.toContain("Be a person.");
    expect(cand).not.toContain("How a reply sits in the conversation");
    expect(cand).toContain("The point of the reply has already been decided");
  });

  it("the drafter describes agree_extend the same way the reasoner does, per profile", () => {
    const base = buildDraftPrompt({ post, theme: "t", angle: "a", chunks: [], maxChars: 280, move: "agree_extend" });
    const cand = buildDraftPrompt({ post, theme: "t", angle: "a", chunks: [], maxChars: 280, move: "agree_extend", profile: "candidate" });
    expect(base).toContain("implication they did not draw");
    expect(cand).not.toContain("implication they did not draw");
    expect(cand).toContain("the acknowledgment is the reply");
  });

  it("the candidate repair prompt does not offer hedging as a way to keep an unsupported claim", () => {
    const fix = { text: "x", claims: ["deposits can leave at any time"], firstPerson: [] };
    expect(buildDraftPrompt({ post, theme: "t", angle: "a", chunks: [], maxChars: 280, fixSpecificsFrom: fix })).toContain("state them as your reading");
    const cand = buildDraftPrompt({ post, theme: "t", angle: "a", chunks: [], maxChars: 280, fixSpecificsFrom: fix, profile: "candidate" });
    expect(cand).not.toContain("your reading");
    expect(cand).toContain("does not make them acceptable");
    expect(cand).toContain("it must not add anything");
  });

  it("candidate drafter prompt drops the other-replies block and the second-point rule for longer", () => {
    const common = { post, theme: "t", angle: "a", chunks: [], maxChars: 280, avoidPoints: ["other point"], instruction: "make it longer" };
    expect(buildDraftPrompt(common)).toContain("<other_reply");
    expect(buildDraftPrompt(common)).toContain("add a second, different point");
    const cand = buildDraftPrompt({ ...common, profile: "candidate" });
    expect(cand).not.toContain("<other_reply");
    expect(cand).toContain("explain the existing point better");
  });

  it("candidate verifier treats hedged motive claims as claims and questions as not claims", () => {
    expect(buildVerifySystemPrompt()).not.toContain("does not change what a claim is");
    expect(buildVerifySystemPrompt("candidate")).toContain("does not change what a claim is");
    expect(buildVerifySystemPrompt("candidate")).toContain("Check the premise inside a question too");
    expect(buildVerifySystemPrompt("candidate")).toContain("asserts only that those things exist in the post's own description");
    expect(buildVerifySystemPrompt("candidate")).toContain("only authorized participants can redeem");
    const compact = buildReasonSystemPrompt({ digest: "views", experienceIndex: "map", boundaries: identity, policy, profile: "candidate" });
    expect(compact.trim().split(/\s+/).length).toBeLessThan(buildReasonSystemPrompt({ digest: "views", experienceIndex: "map", boundaries: identity, policy }).trim().split(/\s+/).length);
    expect(compact).toContain("# How to decide");
    expect(compact).not.toContain("1. Read the post");
  });

  it("the candidate loads only the digest section the theme can bear on, never the How-I-reason paragraph", () => {
    const digest = "# Beliefs digest\n\nIntro.\n\n## How I reason\n\nJudge the lifecycle, not the token.\n\n## Tokenization and market structure\n\nRegister matters.\n\n## Credit and collateral\n\nReal credit has a date.\n\n## What I am not\n\nNot a price commentator.\n";
    const credit = buildReasonSystemPrompt({ digest, experienceIndex: "", profile: "candidate", theme: "Credit and collateral" });
    expect(credit).toContain("Real credit has a date.");
    expect(credit).toContain("Not a price commentator.");
    expect(credit).not.toContain("Register matters.");
    expect(credit).not.toContain("Judge the lifecycle");
    const tech = buildReasonSystemPrompt({ digest, experienceIndex: "", profile: "candidate", theme: "Technology and startups" });
    expect(tech).not.toContain("Real credit has a date.");
    expect(tech).toContain("None of the person's recorded views or firsthand experience bear on this topic");
    expect(tech).toContain("Not a price commentator.");
    const infra = buildReasonSystemPrompt({ digest, experienceIndex: "", profile: "candidate", theme: "Securities infrastructure" });
    expect(infra).toContain("Register matters.");
    // Progressive identity and experience: domain posts get the diplomatic floor and the experience map; others get the identity line only.
    const identity2 = "# I\n\n## Who is speaking\nUdit.\n\n## Confidentiality\nNo deal terms.\n\n## Facts and verification\nNo figures.\n\n## Diplomatic floor\nRelationship over win.\n\n## Lane discipline\nSkip price takes.\n";
    const domain = buildReasonSystemPrompt({ digest, experienceIndex: "Securitize: BUIDL.", boundaries: identity2, profile: "candidate", theme: "Credit and collateral" });
    expect(domain).toContain("Relationship over win.");
    expect(domain).toContain("Securitize: BUIDL.");
    expect(domain).not.toContain("No deal terms.");
    expect(domain).not.toContain("No figures.");
    const general = buildReasonSystemPrompt({ digest, experienceIndex: "Securitize: BUIDL.", boundaries: identity2, profile: "candidate", theme: "General and internet culture" });
    expect(general).toContain("Udit.");
    expect(general).not.toContain("Relationship over win.");
    expect(general).not.toContain("Securitize: BUIDL.");
    expect(general).toContain("first person is not available here");
    // Baseline still loads the whole digest.
    expect(buildReasonSystemPrompt({ digest, experienceIndex: "", theme: "Credit and collateral" })).toContain("Judge the lifecycle");
    expect(buildVerifySystemPrompt("candidate")).toContain("A pure preference or evaluation");
    expect(buildReasonSystemPrompt({ digest: "", experienceIndex: "", profile: "candidate" })).toContain("does not supply evidence");
    expect(buildReasonSystemPrompt({ digest: "", experienceIndex: "", profile: "candidate" })).toContain("is a conversation, not tribalism");
    expect(buildDraftSystemPrompt("tone", 280, { profile: "candidate" })).toContain("do not substitute a different point");
  });
});

import { createFakeProvider } from "../src/llm/fake.js";
import { draftReply, isRealAngleProblem } from "../src/pipeline/stages/draft.js";
import { runSinglePost } from "../src/pipeline/single.js";
import { ConfigSchema } from "../src/config.js";
import { buildKBIndexFromDocs } from "../src/kb/kb-index.js";
import { createMemoryCandidateLog } from "../src/state/candidate-log.js";
import { NormalizedPostSchema } from "../src/model/post.js";

describe("angle flagging and reconsideration (candidate profile)", () => {
  it("draftReply surfaces angle_problem as an outcome field and a card flag", async () => {
    const llm = createFakeProvider(({ label }) => (label.startsWith("verify") ? { specifics: [] } : { suggested_reply: "Solved for whom?", angle_problem: "The angle assumes deposits are redeemable on demand and nothing supports that." }));
    const out = await draftReply({ post, theme: "t", angle: "a", chunks: [], tone: "tone", maxChars: 280, profile: "candidate", llm });
    expect(out.angleProblem).toContain("redeemable on demand");
    expect(out.ai_tell_flags.some((f) => f.startsWith("angle-unsupported:"))).toBe(true);
  });

  it("a pasted link reconsiders once with the flagged angle excluded and uses the second contribution", async () => {
    const reasonPrompts: string[] = [];
    let drafts = 0;
    const llm = createFakeProvider(({ label, prompt }) => {
      if (label.startsWith("theme")) return { results: [{ tweet_id: "1", relevant: true, theme: "Credit and collateral", theme_score: 80, reason: "r" }] };
      if (label.startsWith("reason")) {
        reasonPrompts.push(prompt);
        return reasonPrompts.length === 1
          ? { worth: 80, reason: "r", move: "distinction", depth: "substantive", posture: "announcement", energy: "serious", angle: "deposits can leave any time", grounding: "none" }
          : { worth: 78, reason: "r", move: "question", depth: "light", posture: "announcement", energy: "serious", angle: "how do withdrawals work", grounding: "none" };
      }
      if (label.startsWith("verify")) return { specifics: [] };
      drafts += 1;
      return drafts === 1 ? { suggested_reply: "first", angle_problem: "assumes on-demand redemption" } : { suggested_reply: "How do withdrawals work against these?" };
    });
    const kb = buildKBIndexFromDocs("tone", [{ id: "credit", title: "Credit", markdown: "# Credit\n\n## A\nReal credit has a date.\n" }]);
    const config = ConfigSchema.parse({ chimeDir: "/tmp/unused", promptProfile: "candidate" });
    const log = createMemoryCandidateLog();
    const r = await runSinglePost(post, { config, llm, kb, themes: ["Credit and collateral"], digest: "", experienceIndex: "", candidateLog: log, postCandidates: async (cs) => ({ accepted: cs.length }) });
    expect(reasonPrompts).toHaveLength(2);
    expect(reasonPrompts[1]).toContain("could not write the previous contribution");
    expect(reasonPrompts[1]).toContain("- deposits can leave any time");
    expect(r.reply).toBe("How do withdrawals work against these?");
    expect(r.move).toBe("question");
    expect(log.get("1")).toMatchObject({ contribution_angle: "how do withdrawals work", moves: ["question"] });
  });
});

describe("angle flag hygiene", () => {
  it("the baseline ignores a filled angle_problem, and placeholder values never count in either profile", async () => {
    const llm = createFakeProvider(({ label }) => (label.startsWith("verify") ? { specifics: [] } : { suggested_reply: "Fine.", angle_problem: "None. The only issue was a contrast construction." }));
    const base = await draftReply({ post, theme: "t", angle: "a", chunks: [], tone: "tone", maxChars: 280, llm });
    expect(base.angleProblem).toBeUndefined();
    expect(base.ai_tell_flags.some((f) => f.startsWith("angle-unsupported"))).toBe(false);
    const cand = await draftReply({ post, theme: "t", angle: "a", chunks: [], tone: "tone", maxChars: 280, profile: "candidate", llm });
    expect(cand.angleProblem).toBeUndefined();
    expect(isRealAngleProblem("n/a")).toBe(false);
    expect(isRealAngleProblem("assumes deposits are redeemable on demand")).toBe(true);
  });
});

describe("angle flag survives later rewrites", () => {
  it("a dash rewrite or a specifics repair after the flag does not clear it", async () => {
    let drafts = 0;
    const llm = createFakeProvider(({ label }) => {
      if (label.startsWith("verify")) return drafts === 2 ? { specifics: [{ claim: "40%", kind: "number", support: "none" }] } : { specifics: [] };
      drafts += 1;
      if (drafts === 1) return { suggested_reply: "Still — dashed.", angle_problem: "assumes on-demand redemption" };
      if (drafts === 2) return { suggested_reply: "40% of deposits can leave." };
      return { suggested_reply: "How much of the book can leave on demand?" };
    });
    const out = await draftReply({ post, theme: "t", angle: "a", chunks: [], tone: "tone", maxChars: 280, profile: "candidate", llm });
    expect(out.suggested_reply).toBe("How much of the book can leave on demand?");
    expect(out.angleProblem).toBe("assumes on-demand redemption");
    expect(out.ai_tell_flags.some((f) => f.startsWith("angle-unsupported:"))).toBe(true);
  });
});

import { runScan, type ScanDeps } from "../src/pipeline/scan.js";
import { createMemoryProcessedStore } from "../src/state/processed-store.js";
import { silentLogger } from "../src/util/logger.js";

describe("scan drops a post when reconsideration returns none", () => {
  it("a flagged angle followed by a none from the reasoner filters the post instead of shipping the flagged draft", async () => {
    const fixture = { posts: [{ ...post, tweet_id: "77", tweet_url: "https://x.com/a/status/77", tweet_text: "Maple adds three allocation strategies, capped at 5% of deposits." }] };
    const reasonPrompts: string[] = [];
    const llm = createFakeProvider(({ label, prompt }) => {
      if (label.startsWith("theme")) return { results: [{ tweet_id: "77", relevant: true, theme: "Credit and collateral", theme_score: 85, reason: "r" }] };
      if (label.startsWith("reason")) {
        reasonPrompts.push(prompt);
        return reasonPrompts.length === 1
          ? { worth: 80, reason: "r", move: "distinction", depth: "substantive", posture: "announcement", energy: "serious", angle: "deposits can leave any time", grounding: "none" }
          : { worth: 20, reason: "nothing without the assumption", move: "none", depth: "light", posture: "announcement", energy: "serious", angle: "", grounding: "none" };
      }
      if (label.startsWith("verify")) return { specifics: [] };
      return { suggested_reply: "provisional", angle_problem: "assumes on-demand redemption" };
    });
    const posted: unknown[] = [];
    const deps: ScanDeps = {
      config: ConfigSchema.parse({ chimeDir: "/tmp/unused", promptProfile: "candidate", themeBatchSize: 4, llmConcurrency: 2 }),
      watchlist: [{ handle: "a", priority: 2 }],
      source: { name: "stub", fetchPosts: async () => ({ posts: fixture.posts as never, accounts: [{ handle: "a", ok: true, posts: 1 }], raw_count: 1 }) } as never,
      llm,
      kb: buildKBIndexFromDocs("tone", [{ id: "credit", title: "Credit", markdown: "# Credit\n\n## A\nReal credit has a date.\n" }]),
      themes: ["Credit and collateral"],
      digest: "views",
      experienceIndex: "",
      processed: createMemoryProcessedStore(),
      candidateLog: createMemoryCandidateLog(),
      state: { regen_handled: {}, accounts_seen: {} } as never,
      sink: { postCandidates: async (cs: unknown[]) => { posted.push(...cs); return { accepted: cs.length }; } },
      log: silentLogger,
    } as unknown as ScanDeps;
    const s = await runScan(deps, { since: new Date("2026-09-06T00:00:00Z"), dryRun: false, reprocess: false });
    expect(reasonPrompts).toHaveLength(2);
    expect(posted).toHaveLength(0);
    expect(s.sent).toBe(0);
    expect(s.outcomes.find((o) => o.tweet_id === "77")).toMatchObject({ decision: "filtered", stage: "reason" });
    expect(s.outcomes.find((o) => o.tweet_id === "77")?.reason).toContain("reconsidered: none");
  });
});

describe("reconsideration re-applies the scan bar", () => {
  it("a new contribution below the bar is dropped, not shipped", async () => {
    const fixture = { posts: [{ ...post, tweet_id: "78", tweet_url: "https://x.com/a/status/78", tweet_text: "Maple adds three allocation strategies, capped at 5% of deposits." }] };
    let reasons = 0;
    const llm = createFakeProvider(({ label }) => {
      if (label.startsWith("theme")) return { results: [{ tweet_id: "78", relevant: true, theme: "Credit and collateral", theme_score: 85, reason: "r" }] };
      if (label.startsWith("reason")) {
        reasons += 1;
        return reasons === 1
          ? { worth: 80, reason: "r", move: "distinction", depth: "substantive", posture: "announcement", energy: "serious", angle: "deposits can leave any time", grounding: "none" }
          : { worth: 40, reason: "weak", move: "question", depth: "light", posture: "announcement", energy: "serious", angle: "how do withdrawals work", grounding: "none" };
      }
      if (label.startsWith("verify")) return { specifics: [] };
      return { suggested_reply: "provisional", angle_problem: "assumes on-demand redemption" };
    });
    const posted: unknown[] = [];
    const deps = {
      config: ConfigSchema.parse({ chimeDir: "/tmp/unused", promptProfile: "candidate", themeBatchSize: 4, llmConcurrency: 2 }),
      watchlist: [{ handle: "a", priority: 2 }],
      source: { name: "stub", fetchPosts: async () => ({ posts: fixture.posts as never, accounts: [{ handle: "a", ok: true, posts: 1 }], raw_count: 1 }) } as never,
      llm,
      kb: buildKBIndexFromDocs("tone", [{ id: "credit", title: "Credit", markdown: "# Credit\n\n## A\nReal credit has a date.\n" }]),
      themes: ["Credit and collateral"],
      digest: "views",
      experienceIndex: "",
      processed: createMemoryProcessedStore(),
      candidateLog: createMemoryCandidateLog(),
      state: { regen_handled: {}, accounts_seen: {} } as never,
      sink: { postCandidates: async (cs: unknown[]) => { posted.push(...cs); return { accepted: cs.length }; } },
      log: silentLogger,
    } as unknown as ScanDeps;
    const s = await runScan(deps, { since: new Date("2026-09-06T00:00:00Z"), dryRun: false, reprocess: false });
    expect(posted).toHaveLength(0);
    expect(s.outcomes.find((o) => o.tweet_id === "78")?.reason).toContain("worth 40 < 70");
  });
});

describe("pasted link never relabels none silently", () => {
  it("a reasoner none under mustReply ships as a light reaction with a review flag", async () => {
    const llm = createFakeProvider(({ label }) => {
      if (label.startsWith("theme")) return { results: [{ tweet_id: "1", relevant: true, theme: "General", theme_score: 20, reason: "r" }] };
      if (label.startsWith("reason")) return { worth: 10, reason: "nothing", move: "none", depth: "light", posture: "other", energy: "casual", angle: "", grounding: "none" };
      if (label.startsWith("verify")) return { specifics: [] };
      return { suggested_reply: "Ha." };
    });
    const config = ConfigSchema.parse({ chimeDir: "/tmp/unused", promptProfile: "candidate" });
    const r = await runSinglePost(post, { config, llm, kb: buildKBIndexFromDocs("tone", []), themes: ["General"], digest: "", experienceIndex: "", candidateLog: createMemoryCandidateLog(), postCandidates: async (cs) => ({ accepted: cs.length }) });
    expect(r.move).toBe("light_reaction");
    expect(r.candidate.ai_tell_flags).toContain("review:reasoner-none");
  });
});
