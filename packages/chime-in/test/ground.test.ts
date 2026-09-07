import { describe, expect, it } from "vitest";
import { buildKBIndexFromDocs } from "../src/kb/kb-index.js";
import { createFakeProvider } from "../src/llm/fake.js";
import { NormalizedPostSchema } from "../src/model/post.js";
import { resolveGrounding } from "../src/pipeline/ground.js";

const kb = buildKBIndexFromDocs("tone", [{ id: "credit", title: "Credit", markdown: "# Credit\n\n## A\nReal credit has a date.\n" }]);
const post = NormalizedPostSchema.parse({ tweet_id: "1", tweet_url: "https://x.com/a/status/1", author_handle: "a", tweet_text: "Capped at 5% of the deposit base at launch. Withdrawals process within 30 days.", created_at: "2026-09-06T00:00:00Z", scraped_at: "2026-09-06T00:00:00Z" });
const reason = { worth: 80, reason: "r", move: "question" as const, depth: "substantive" as const, posture: "announcement" as const, energy: "serious" as const, angle: "a", grounding: "verify" as const, fact_dependency: "How long do withdrawals take?", wants_first_person: false };

describe("fact resolution from the post", () => {
  it("a fact is verified only when an answer is actually extracted from the post", async () => {
    const llm = createFakeProvider(({ label }) => (label.startsWith("resolve") ? { answered: true, answer: "Withdrawals process within 30 days." } : {}));
    const g = await resolveGrounding(reason, post, "Credit", { kb, topK: 4, llm });
    expect(g.fact?.claim).toBe("Withdrawals process within 30 days.");
    expect(g.fact?.source).toBe("post");
    expect(g.unresolved).toBeUndefined();
  });
  it("word overlap alone no longer counts; an unanswered question stays unresolved", async () => {
    const llm = createFakeProvider(({ label }) => (label.startsWith("resolve") ? { answered: false } : {}));
    const g = await resolveGrounding({ ...reason, fact_dependency: "Do withdrawals from the deposit base happen at launch?" }, post, "Credit", { kb, topK: 4, llm });
    expect(g.fact).toBeUndefined();
    expect(g.unresolved).toContain("withdrawals");
  });
  it("without a model the post step is skipped and the question is unresolved", async () => {
    const g = await resolveGrounding(reason, post, "Credit", { kb, topK: 4 });
    expect(g.fact).toBeUndefined();
    expect(g.unresolved).toBe("How long do withdrawals take?");
  });
});

import { buildFactArchive } from "../src/pipeline/ground.js";

describe("evidence is not verification", () => {
  it("a research note that overlaps the question but says the answer is unknown stays unresolved", async () => {
    const facts = buildFactArchive("# Notes\n\n## 2026-08\n- Vault withdrawal terms for the new sleeve: unknown, not disclosed at launch.\n");
    expect(facts.candidates("What are the vault withdrawal terms for the new sleeve?")).toHaveLength(1);
    const llm = createFakeProvider(({ label }) => (label.startsWith("resolve") ? { answered: false } : {}));
    const g = await resolveGrounding({ ...reason, fact_dependency: "What are the vault withdrawal terms for the new sleeve?" }, post, "Credit", { kb, facts, topK: 4, llm });
    expect(g.fact).toBeUndefined();
    expect(g.unresolved).toContain("withdrawal terms");
  });
  it("a note that states the answer becomes a dated fact", async () => {
    // Two overlapping notes; the second, older one is the one that answers. Its date must be the fact's date.
    const facts = buildFactArchive("# Notes\n\n## 2026-08\n- The sleeve's withdrawals were discussed; settlement timing withdrawals sleeve still pending.\n\n## 2026-06\n- The sleeve's withdrawals settle within 30 days.\n");
    const llm = createFakeProvider(({ label, prompt }) => {
      if (label !== "resolve:notes") return { answered: false };
      const n = /<note n="(\d)">\n[^\n]*settle within 30 days/.exec(prompt)?.[1];
      return { answered: true, answer: "Withdrawals settle within 30 days.", note: Number(n) };
    });
    const g = await resolveGrounding({ ...reason, fact_dependency: "How fast do the sleeve's withdrawals settle?" }, post, "Credit", { kb, facts, topK: 4, llm });
    expect(g.fact).toMatchObject({ claim: "Withdrawals settle within 30 days.", source: "research-notes", as_of: "2026-06" });
  });
  it("an extracted answer without a valid note identifier is not a verified fact", async () => {
    const facts = buildFactArchive("# Notes\n\n## 2026-08\n- The sleeve's withdrawals settle within 30 days.\n");
    const llm = createFakeProvider(({ label }) => (label === "resolve:notes" ? { answered: true, answer: "Withdrawals settle within 30 days." } : { answered: false }));
    const g = await resolveGrounding({ ...reason, fact_dependency: "How fast do the sleeve's withdrawals settle?" }, post, "Credit", { kb, facts, topK: 4, llm });
    expect(g.fact).toBeUndefined();
    expect(g.unresolved).toBeDefined();
  });
  it("a verification request with no stated dependency is visible as unresolved", async () => {
    const g = await resolveGrounding({ ...reason, fact_dependency: undefined }, post, "Credit", { kb, topK: 4 });
    expect(g.unresolved).toContain("no factual dependency was stated");
  });
});
