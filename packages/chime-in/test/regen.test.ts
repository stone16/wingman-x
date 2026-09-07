import { describe, expect, it } from "vitest";
import type { Candidate, CandidateInput } from "@wingman-x/agent-kit";
import { ConfigSchema } from "../src/config.js";
import { buildKBIndexFromDocs } from "../src/kb/kb-index.js";
import { createFakeProvider } from "../src/llm/fake.js";
import { NormalizedPostSchema } from "../src/model/post.js";
import { pendingRegens, runRegen } from "../src/pipeline/regen.js";
import { createMemoryCandidateLog } from "../src/state/candidate-log.js";
import { silentLogger } from "../src/util/logger.js";

const config = ConfigSchema.parse({ chimeDir: "/tmp/unused" });
const kb = buildKBIndexFromDocs("tone", [
  { id: "custody", title: "Custody", markdown: "# Custody\n\n## Control\nControl agreements decide what a lender can enforce.\n" },
]);

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: "chime-1",
  tweet_id: "1",
  tweet_url: "https://x.com/a/status/1",
  author_handle: "@a",
  tweet_text: "Custody is solved.",
  suggested_reply: "first draft",
  match_reason: "Theme: Custody (80) | Expertise: 80 | Contribution: 80 | Angle: Custody is not solved for securities.",
  match_category: "topic",
  source: "handles",
  kb_refs: ["library/custody.md", "tone.md"],
  created_at: "2026-09-04T00:00:00.000Z",
  status: "regen_requested",
  status_updated_at: "2026-09-04T01:00:00.000Z",
  ...over,
});

describe("pendingRegens", () => {
  it("selects only our regen_requested candidates not yet served for that click", () => {
    const state = { regen_handled: { "2": "2026-09-04T01:00:00.000Z" } };
    const list = [
      candidate(),
      candidate({ tweet_id: "2", id: "chime-2" }),
      candidate({ tweet_id: "3", id: "chime-3", status: "pending" }),
      candidate({ tweet_id: "4", id: "other-4" }),
    ];
    expect(pendingRegens(list, state).map((c) => c.tweet_id)).toEqual(["1"]);
  });
});

describe("runRegen", () => {
  it("redrafts with prior replies, re-POSTs preserving fields, and records the served click", async () => {
    const posted: CandidateInput[] = [];
    const prompts: string[] = [];
    const llm = createFakeProvider(({ prompt, tier }) => {
      prompts.push(prompt);
      expect(tier).toBe("draft");
      return { suggested_reply: "a meaningfully different draft" };
    });
    const state = { regen_handled: {} as Record<string, string> };
    const log = createMemoryCandidateLog();
    const summary = await runRegen({
      config,
      llm,
      kb,
      candidateLog: log,
      state,
      getCandidates: async () => [candidate()],
      postCandidates: async (cs) => { posted.push(...cs); return { accepted: cs.length }; },
      log: silentLogger,
    });
    expect(summary).toEqual({ requested: 1, regenerated: 1, failed: 0, already_served: 0, served_from_alternates: 0, fills_recorded: 0 });
    expect(posted[0]).toMatchObject({ id: "chime-1", suggested_reply: "A meaningfully different draft", match_reason: candidate().match_reason, kb_refs: ["library/custody.md", "tone.md"] });
    expect(prompts[0]).toContain("<rejected_draft n=\"1\">\nfirst draft");
    expect(prompts[0]).toContain("What the reply should say: Custody is not solved for securities.");
    expect(prompts[0]).toContain("library/custody.md#control");
    expect(state.regen_handled["1"]).toBe("2026-09-04T01:00:00.000Z");

    // Same click again → nothing to do.
    const again = await runRegen({ config, llm, kb, candidateLog: log, state, getCandidates: async () => [candidate()], postCandidates: async () => { throw new Error("should not post"); }, log: silentLogger });
    expect(again.requested).toBe(0);
    expect(again.already_served).toBe(1);
    // --force redrafts the same click again.
    const forced = await runRegen({ config, llm, kb, candidateLog: log, state, getCandidates: async () => [candidate()], postCandidates: async (cs) => ({ accepted: cs.length }), log: silentLogger, force: true });
    expect(forced.requested).toBe(1);
    expect(forced.regenerated).toBe(1);
  });

  it("keeps earlier instructions in force when the person regenerates again without a new one", async () => {
    const log = createMemoryCandidateLog();
    log.upsert({
      tweet_id: "1",
      recorded_at: "x",
      post: NormalizedPostSchema.parse({ tweet_id: "1", tweet_url: "https://x.com/a/status/1", author_handle: "a", tweet_text: "Custody is solved.", created_at: "2026-09-04T00:00:00Z", scraped_at: "2026-09-04T00:00:00Z" }),
      theme: "Custody",
      theme_score: 80,
      expertise_score: 0,
      contribution_score: 80,
      contribution_angle: "logged angle",
      account_priority: 2,
      kb_refs: ["library/custody.md"],
      chunk_refs: ["library/custody.md#control"],
      replies: ["first draft", "a longer second draft"],
      moves: ["distinction", "distinction"],
      instructions: ["make it longer"],
      alternates: ["an alternate drafted before the instruction"],
    });
    const prompts: string[] = [];
    const reasonPrompts: string[] = [];
    const llm = createFakeProvider(({ prompt, label }) => {
      if (label.startsWith("draft")) prompts.push(prompt);
      if (label.startsWith("reason")) { reasonPrompts.push(prompt); return { worth: 80, reason: "r", move: "distinction", depth: "substantive", posture: "other", energy: "casual", angle: "a fresh, longer point", grounding: "none" }; }
      return label.startsWith("verify") ? { specifics: [] } : { suggested_reply: "third draft, still long" };
    });
    const state = { regen_handled: {} };
    const summary = await runRegen({ config, llm, kb, digest: "views", experienceIndex: "", candidateLog: log, state, getCandidates: async () => [candidate()], postCandidates: async (cs) => ({ accepted: cs.length }), log: silentLogger });
    // A stale alternate must not be served over a standing instruction.
    expect(summary).toMatchObject({ regenerated: 1, served_from_alternates: 0 });
    expect(prompts[0]).toContain("<standing_instruction>\nmake it longer\n</standing_instruction>");
    expect(reasonPrompts[0]).toContain("Instructions the person gave on earlier drafts of this reply. They still apply:\n- make it longer");
    expect(reasonPrompts[0]).toContain("rejected these earlier contributions");
    expect(prompts[0]).not.toContain("<instruction>");
    expect(log.get("1")?.instructions).toEqual(["make it longer"]);
  });

  it("a plain ♻️ re-thinks with the rejected contribution excluded and drafts the new one", async () => {
    const log = createMemoryCandidateLog();
    log.upsert({
      tweet_id: "1",
      recorded_at: "x",
      post: NormalizedPostSchema.parse({ tweet_id: "1", tweet_url: "https://x.com/a/status/1", author_handle: "a", tweet_text: "Custody is solved.", created_at: "2026-09-04T00:00:00Z", scraped_at: "2026-09-04T00:00:00Z" }),
      theme: "Custody",
      theme_score: 80,
      expertise_score: 0,
      contribution_score: 80,
      contribution_angle: "logged angle",
      account_priority: 2,
      kb_refs: ["library/custody.md"],
      chunk_refs: ["library/custody.md#control"],
      replies: ["first draft"],
      moves: ["distinction"],
      grounding: "kb",
    });
    const reasonPrompts: string[] = [];
    const draftPrompts: string[] = [];
    const posted: CandidateInput[] = [];
    const llm = createFakeProvider(({ label, prompt }) => {
      if (label.startsWith("reason")) {
        reasonPrompts.push(prompt);
        return { worth: 80, reason: "r", move: "question", depth: "light", posture: "announcement", energy: "casual", author_point: "They say custody is solved.", angle: "new angle", grounding: "none" };
      }
      if (label.startsWith("verify")) return { specifics: [] };
      draftPrompts.push(prompt);
      return { suggested_reply: "Solved for whom?" };
    });
    const state = { regen_handled: {} };
    const summary = await runRegen({ config, llm, kb, digest: "views", experienceIndex: "", candidateLog: log, state, getCandidates: async () => [candidate()], postCandidates: async (cs) => { posted.push(...cs); return { accepted: cs.length }; }, log: silentLogger });
    expect(summary).toMatchObject({ regenerated: 1, failed: 0 });
    expect(reasonPrompts[0]).toContain("rejected these earlier contributions");
    expect(reasonPrompts[0]).toContain("- logged angle");
    expect(draftPrompts[0]).toContain("What the reply should say: new angle");
    expect(draftPrompts[0]).toContain("The author's point, which the reply answers: They say custody is solved.");
    expect(log.get("1")).toMatchObject({ contribution_angle: "new angle", angles: ["logged angle", "new angle"], moves: ["distinction", "question"], author_point: "They say custody is solved." });
    expect(posted[0]?.match_reason).toContain("Angle: new angle");
  });

  it("regeneration reconsiders once when the candidate drafter flags the angle, like scans do", async () => {
    const reasonPrompts: string[] = [];
    let drafts = 0;
    const llm = createFakeProvider(({ label, prompt }) => {
      if (label.startsWith("reason")) {
        reasonPrompts.push(prompt);
        return reasonPrompts.length === 1
          ? { worth: 80, reason: "r", move: "distinction", depth: "substantive", posture: "other", energy: "casual", angle: "deposits can leave any time", grounding: "none" }
          : { worth: 78, reason: "r", move: "question", depth: "light", posture: "other", energy: "casual", angle: "how do withdrawals work", grounding: "none" };
      }
      if (label.startsWith("verify")) return { specifics: [] };
      drafts += 1;
      return drafts === 1 ? { suggested_reply: "first", angle_problem: "assumes on-demand redemption" } : { suggested_reply: "How do withdrawals work against these?" };
    });
    const config = ConfigSchema.parse({ chimeDir: "/tmp/unused", promptProfile: "candidate" });
    const posted: CandidateInput[] = [];
    const log = createMemoryCandidateLog();
    const state = { regen_handled: {} };
    await runRegen({ config, llm, kb, digest: "views", experienceIndex: "", candidateLog: log, state, getCandidates: async () => [candidate()], postCandidates: async (cs) => { posted.push(...cs); return { accepted: cs.length }; }, log: silentLogger });
    expect(reasonPrompts).toHaveLength(2);
    expect(reasonPrompts[1]).toContain("could not write the previous contribution");
    expect(reasonPrompts[1]).toContain("- deposits can leave any time");
    expect(posted[0]?.suggested_reply).toBe("How do withdrawals work against these?");
    expect(posted[0]?.match_reason).toContain("Angle: how do withdrawals work");
  });

  it("a plain ♻️ whose re-thinking returns none is marked for review, not relabelled silently", async () => {
    const posted: CandidateInput[] = [];
    const llm = createFakeProvider(({ label }) => {
      if (label.startsWith("reason")) return { worth: 10, reason: "nothing", move: "none", depth: "light", posture: "other", energy: "casual", angle: "", grounding: "none" };
      if (label.startsWith("verify")) return { specifics: [] };
      return { suggested_reply: "Ha." };
    });
    await runRegen({ config, llm, kb, digest: "views", experienceIndex: "", candidateLog: createMemoryCandidateLog(), state: { regen_handled: {} }, getCandidates: async () => [candidate()], postCandidates: async (cs) => { posted.push(...cs); return { accepted: cs.length }; }, log: silentLogger });
    expect(posted[0]?.ai_tell_flags).toContain("review:reasoner-none");
  });

  it("reconsideration during a guided regen carries the current instruction and clears stale grounding fields", async () => {
    const log = createMemoryCandidateLog();
    log.upsert({ tweet_id: "1", recorded_at: "x", post: NormalizedPostSchema.parse({ tweet_id: "1", tweet_url: "https://x.com/a/status/1", author_handle: "a", tweet_text: "Custody is solved.", created_at: "2026-09-04T00:00:00Z", scraped_at: "2026-09-04T00:00:00Z" }), theme: "Custody", theme_score: 80, expertise_score: 0, contribution_score: 80, contribution_angle: "old angle", account_priority: 2, kb_refs: ["library/custody.md"], chunk_refs: ["library/custody.md#control"], replies: ["first draft"], moves: ["distinction"], grounding: "verify", kb_query: "old query", fact_dependency: "old dependency" });
    const reasonPrompts: string[] = [];
    let drafts = 0;
    const llm = createFakeProvider(({ label, prompt }) => {
      if (label.startsWith("reason")) {
        reasonPrompts.push(prompt);
        return reasonPrompts.length === 1
          ? { worth: 80, reason: "r", move: "distinction", depth: "substantive", posture: "other", energy: "casual", angle: "new angle A", grounding: "none" }
          : { worth: 79, reason: "r", move: "question", depth: "light", posture: "other", energy: "casual", angle: "new angle B", grounding: "none" };
      }
      if (label.startsWith("verify")) return { specifics: [] };
      drafts += 1;
      return drafts === 1 ? { suggested_reply: "first", angle_problem: "assumes deposits can leave on demand" } : { suggested_reply: "Second." };
    });
    const config2 = ConfigSchema.parse({ chimeDir: "/tmp/unused", promptProfile: "candidate" });
    await runRegen({ config: config2, llm, kb, digest: "views", experienceIndex: "", candidateLog: log, state: { regen_handled: {} }, getCandidates: async () => [candidate()], postCandidates: async (cs) => ({ accepted: cs.length }), log: silentLogger, instructions: new Map([["1", "make it shorter"]]) });
    expect(reasonPrompts).toHaveLength(2);
    expect(reasonPrompts[1]).toContain("instruction for this reply (it outranks the defaults above): make it shorter");
    const rec = log.get("1")!;
    expect(rec.contribution_angle).toBe("new angle B");
    expect(rec.kb_query).toBeUndefined();
    expect(rec.fact_dependency).toBeUndefined();
    expect(rec.grounding).toBe("none");
  });

  it("when re-thinking fails, the fallback keeps the logged dependency and the card keeps the logged references", async () => {
    const log = createMemoryCandidateLog();
    log.upsert({ tweet_id: "1", recorded_at: "x", post: NormalizedPostSchema.parse({ tweet_id: "1", tweet_url: "https://x.com/a/status/1", author_handle: "a", tweet_text: "Custody is solved.", created_at: "2026-09-04T00:00:00Z", scraped_at: "2026-09-04T00:00:00Z" }), theme: "Custody", theme_score: 80, expertise_score: 0, contribution_score: 80, contribution_angle: "logged angle", account_priority: 2, kb_refs: ["library/custody.md"], chunk_refs: ["library/custody.md#control"], replies: ["first draft"], grounding: "verify", fact_dependency: "What does the control agreement allow?" });
    const seen: string[] = [];
    const llm = createFakeProvider(({ label, prompt }) => {
      seen.push(label);
      if (label.startsWith("reason")) throw new Error("reasoner down");
      if (label.startsWith("resolve")) { seen.push("Q:" + /Question: (.*)/.exec(prompt)?.[1]); return { answered: false }; }
      if (label.startsWith("verify")) return { specifics: [] };
      return { suggested_reply: "Redrafted the logged angle." };
    });
    const posted: CandidateInput[] = [];
    await runRegen({ config: ConfigSchema.parse({ chimeDir: "/tmp/unused", promptProfile: "candidate" }), llm, kb, digest: "views", experienceIndex: "", candidateLog: log, state: { regen_handled: {} }, getCandidates: async () => [candidate()], postCandidates: async (cs) => { posted.push(...cs); return { accepted: cs.length }; }, log: silentLogger });
    expect(seen).toContain("Q:What does the control agreement allow?");
    expect(posted[0]?.kb_refs).toEqual(candidate().kb_refs);
    expect(posted[0]?.suggested_reply).toBe("Redrafted the logged angle.");
  });

  it("a rethought point changes the card's references to the new evidence", async () => {
    const log = createMemoryCandidateLog();
    log.upsert({ tweet_id: "1", recorded_at: "x", post: NormalizedPostSchema.parse({ tweet_id: "1", tweet_url: "https://x.com/a/status/1", author_handle: "a", tweet_text: "Custody is solved.", created_at: "2026-09-04T00:00:00Z", scraped_at: "2026-09-04T00:00:00Z" }), theme: "Custody", theme_score: 80, expertise_score: 0, contribution_score: 80, contribution_angle: "logged angle", account_priority: 2, kb_refs: ["library/custody.md"], chunk_refs: ["library/custody.md#control"], replies: ["first draft"], grounding: "kb" });
    const llm = createFakeProvider(({ label }) => {
      if (label.startsWith("reason")) return { worth: 80, reason: "r", move: "light_reaction", depth: "light", posture: "other", energy: "casual", angle: "just a reaction", grounding: "none" };
      if (label.startsWith("verify")) return { specifics: [] };
      return { suggested_reply: "Ha, fair." };
    });
    const posted: CandidateInput[] = [];
    await runRegen({ config: ConfigSchema.parse({ chimeDir: "/tmp/unused", promptProfile: "candidate" }), llm, kb, digest: "views", experienceIndex: "", candidateLog: log, state: { regen_handled: {} }, getCandidates: async () => [candidate()], postCandidates: async (cs) => { posted.push(...cs); return { accepted: cs.length }; }, log: silentLogger });
    expect(posted[0]?.kb_refs).toEqual(["tone.md"]);
    expect(log.get("1")).toMatchObject({ grounding: "none", kb_refs: [], chunk_refs: [] });
  });

  it("an instruction reaches the reasoner with the earlier contributions kept in view", async () => {
    const reasonPrompts: string[] = [];
    const llm = createFakeProvider(({ label, prompt }) => {
      if (label.startsWith("reason")) {
        reasonPrompts.push(prompt);
        return { worth: 80, reason: "r", move: "distinction", depth: "substantive", posture: "other", energy: "casual", angle: "same angle, longer", grounding: "none" };
      }
      if (label.startsWith("verify")) return { specifics: [] };
      return { suggested_reply: "A longer version of the same point." };
    });
    const state = { regen_handled: {} };
    await runRegen({ config, llm, kb, digest: "views", experienceIndex: "", candidateLog: createMemoryCandidateLog(), state, getCandidates: async () => [candidate()], postCandidates: async (cs) => ({ accepted: cs.length }), log: silentLogger, instructions: new Map([["1", "make it longer"]]) });
    expect(reasonPrompts[0]).toContain("instruction for this reply (it outranks the defaults above): make it longer");
    expect(reasonPrompts[0]).toContain("to keep unless the instruction asks for something else");
    expect(reasonPrompts[0]).not.toContain("rejected these earlier contributions");
  });

  it("uses the candidate log when present and counts failures without throwing", async () => {
    const log = createMemoryCandidateLog();
    log.upsert({
      tweet_id: "1",
      recorded_at: "x",
      post: NormalizedPostSchema.parse({ tweet_id: "1", tweet_url: "https://x.com/a/status/1", author_handle: "a", tweet_text: "Custody is solved.", created_at: "2026-09-04T00:00:00Z", scraped_at: "2026-09-04T00:00:00Z" }),
      theme: "Custody",
      theme_score: 80,
      expertise_score: 80,
      contribution_score: 80,
      contribution_angle: "logged angle",
      account_priority: 2,
      kb_refs: ["library/custody.md"],
      chunk_refs: ["library/custody.md#control"],
      replies: ["first draft"],
    });
    const prompts: string[] = [];
    const llm = createFakeProvider(({ prompt }) => { prompts.push(prompt); throw new Error("model down"); });
    const state = { regen_handled: {} };
    const summary = await runRegen({ config, llm, kb, candidateLog: log, state, getCandidates: async () => [candidate()], postCandidates: async (cs) => ({ accepted: cs.length }), log: silentLogger });
    expect(summary).toEqual({ requested: 1, regenerated: 0, failed: 1, already_served: 0, served_from_alternates: 0, fills_recorded: 0 });
    expect(prompts[0]).toContain("What the reply should say: logged angle");
    expect(state.regen_handled).toEqual({});
  });
});
