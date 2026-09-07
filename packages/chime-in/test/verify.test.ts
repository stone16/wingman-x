import { describe, expect, it } from "vitest";
import { createFakeProvider } from "../src/llm/fake.js";
import type { NormalizedPost } from "../src/model/post.js";
import { draftReply } from "../src/pipeline/stages/draft.js";
import { judge, verdictFlags, verifyReply } from "../src/pipeline/stages/verify.js";

const post: NormalizedPost = {
  tweet_id: "1",
  tweet_url: "https://x.com/a/status/1",
  author_handle: "a",
  author_name: "A",
  tweet_text: "we launched fixed term lending today",
  created_at: "2026-09-04T00:00:00.000Z",
  reply_count: 0,
  repost_count: 0,
  like_count: 0,
  view_count: 0,
  is_reply: false,
  is_repost: false,
  is_quote: false,
  quoted_tweet: null,
  thread: [],
  scraped_at: "2026-09-04T00:00:00.000Z",
};

describe("provenance verifier: statuses and enforcement", () => {
  it("a first-person claim is unsupported unless its source is approved experience, whatever the model labelled it", () => {
    const v = judge({
      specifics: [
        { claim: "at Figure we saw this", kind: "first_person", support: "kb" },
        { claim: "T+1", kind: "other", support: "common_knowledge" },
      ],
    });
    expect(v.status).toBe("unsupported");
    expect(v.unsupportedFirstPerson).toEqual(["at Figure we saw this"]);
    expect(judge({ specifics: [{ claim: "at Figure we saw this", kind: "first_person", support: "experience" }] }).status).toBe("passed");
  });

  it("a mechanism or current-state claim about a named thing is not supported by common knowledge", () => {
    const v = judge({
      specifics: [
        { claim: "the oracle only adjusts the mark", kind: "mechanism", support: "common_knowledge" },
        { claim: "deposits can leave at any time", kind: "current_state", support: "common_knowledge" },
        { claim: "T+1 is standard", kind: "other", support: "common_knowledge" },
        { claim: "the oracle runs on Chainlink CRE", kind: "mechanism", support: "post" },
      ],
    });
    expect(v.status).toBe("unsupported");
    expect(v.unsupported.map((u) => u.claim)).toEqual(["the oracle only adjusts the mark", "deposits can leave at any time"]);
  });

  it("a verifier failure is reported as unavailable and flagged, never as a pass", async () => {
    const llm = createFakeProvider(() => { throw new Error("model down"); });
    const v = await verifyReply("Some reply.", { post, chunks: [] }, { llm });
    expect(v.ok).toBe(false);
    expect(v.status).toBe("unavailable");
    expect(verdictFlags(v)).toEqual(["verify:unavailable"]);
  });

  it("the final text is audited even when mechanical rewrites used the whole retry budget", async () => {
    const audited: string[] = [];
    let drafts = 0;
    const llm = createFakeProvider(({ label, prompt }) => {
      if (label.startsWith("verify")) {
        audited.push(/<reply>\n([\s\S]*?)\n<\/reply>/.exec(prompt)?.[1] ?? "");
        return { specifics: [] };
      }
      drafts += 1;
      // Four dashed drafts exhaust the loop's rewrite budget; the fifth is clean.
      return { suggested_reply: drafts < 5 ? "Still — dashed." : "Clean at last." };
    });
    const out = await draftReply({ post, theme: "t", angle: "a", chunks: [], tone: "tone", maxChars: 280, llm });
    expect(out.suggested_reply).toBe("Clean at last.");
    expect(audited).toContain("Clean at last.");
    expect(out.ai_tell_flags).not.toContain("verify:unavailable");
  });

  it("an unsupported final draft gets one repair even after the loop, and the repaired text is what gets audited and flagged", async () => {
    const audited: string[] = [];
    let drafts = 0;
    const llm = createFakeProvider(({ label, prompt }) => {
      if (label.startsWith("verify")) {
        const text = /<reply>\n([\s\S]*?)\n<\/reply>/.exec(prompt)?.[1] ?? "";
        audited.push(text);
        return text.includes("40%") ? { specifics: [{ claim: "40% of the yield is a subsidy", kind: "number", support: "none" }] } : { specifics: [] };
      }
      drafts += 1;
      if (label.endsWith(":specifics")) return { suggested_reply: "What makes up the yield?" };
      return { suggested_reply: drafts < 5 ? "Still — dashed." : "40% of the yield is a subsidy." };
    });
    const out = await draftReply({ post, theme: "t", angle: "a", chunks: [], tone: "tone", maxChars: 280, llm });
    expect(out.suggested_reply).toBe("What makes up the yield?");
    expect(audited.at(-1)).toBe("What makes up the yield?");
    expect(out.ai_tell_flags.some((f) => f.startsWith("unverified:"))).toBe(false);
  });

  it("a draft whose verifier is down ships with the unavailable flag", async () => {
    const llm = createFakeProvider(({ label }) => {
      if (label.startsWith("verify")) throw new Error("down");
      return { suggested_reply: "A plain reply." };
    });
    const out = await draftReply({ post, theme: "t", angle: "a", chunks: [], tone: "tone", maxChars: 280, llm });
    expect(out.ai_tell_flags).toContain("verify:unavailable");
  });

  it("the author's point reaches the drafter", async () => {
    const prompts: string[] = [];
    const llm = createFakeProvider(({ label, prompt }) => {
      if (label.startsWith("verify")) return { specifics: [] };
      prompts.push(prompt);
      return { suggested_reply: "ok" };
    });
    await draftReply({ post, theme: "t", angle: "ask about rollover", authorPoint: "They are announcing fixed-term lending.", chunks: [], tone: "tone", maxChars: 280, llm });
    expect(prompts[0]).toContain("The author's point, which the reply answers: They are announcing fixed-term lending.");
    expect(prompts[0]!.indexOf("The author's point")).toBeLessThan(prompts[0]!.indexOf("What the reply should say"));
  });
});

import { buildKBIndexFromDocs } from "../src/kb/kb-index.js";

describe("retrieval selectivity", () => {
  const kb = buildKBIndexFromDocs("tone", [
    { id: "credit", title: "Credit", markdown: "# Credit\n\n## Funding\nCommitted funding and available liquidity are different numbers for a lender facility.\n" },
    { id: "ai", title: "AI", markdown: "# AI\n\n## Upstream\nNormalize the data upstream so deterministic rules can run; accountable execution stays with a person.\n" },
  ]);
  it("returns nothing when the query shares only a stray word with the library", () => {
    expect(kb.search("the channel got muted because nobody was accountable", 8)).toHaveLength(1);
    expect(kb.search("the channel got muted because nobody was accountable", 8, { minRelative: 0.45, minMatched: 3 })).toHaveLength(0);
  });
  it("keeps a chunk that carries the query", () => {
    expect(kb.search("committed funding versus available liquidity for a lender", 8, { minRelative: 0.45, minMatched: 3 }).map((c) => c.file)).toEqual(["library/credit.md"]);
  });
});

describe("candidate claim standard in code", () => {
  it("behavioral explanations and a named product's legal status need a real source under the candidate; general background still passes", () => {
    const specifics = [
      { claim: "readers muted because nobody was accountable", kind: "causal" as const, support: "common_knowledge" as const },
      { claim: "the token is an unregistered security", kind: "legal_status" as const, support: "common_knowledge" as const },
      { claim: "T+1 is the US settlement cycle", kind: "other" as const, support: "common_knowledge" as const },
    ];
    expect(judge({ specifics }).status).toBe("passed");
    const v = judge({ specifics }, "candidate");
    expect(v.status).toBe("unsupported");
    expect(v.unsupported.map((u) => u.kind)).toEqual(["causal", "legal_status"]);
  });
});
