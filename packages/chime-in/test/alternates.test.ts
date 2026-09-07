import { describe, expect, it } from "vitest";
import type { Candidate, CandidateInput } from "@wingman-x/agent-kit";
import { ConfigSchema } from "../src/config.js";
import { buildKBIndexFromDocs } from "../src/kb/kb-index.js";
import { createFakeProvider } from "../src/llm/fake.js";
import { NormalizedPostSchema } from "../src/model/post.js";
import { recordFills, runRegen } from "../src/pipeline/regen.js";
import { createMemoryCandidateLog } from "../src/state/candidate-log.js";
import { silentLogger } from "../src/util/logger.js";

const config = ConfigSchema.parse({ chimeDir: "/tmp/unused", draftVariants: 3 }); // alternates are served only when variants are enabled
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

function loggedRecord(alternates: string[]) {
  return {
    tweet_id: "1",
    recorded_at: "2026-09-04T00:00:00.000Z",
    post: NormalizedPostSchema.parse({
      tweet_id: "1",
      tweet_url: "https://x.com/a/status/1",
      author_handle: "a",
      tweet_text: "Custody is solved.",
      created_at: "2026-09-04T00:00:00.000Z",
      scraped_at: "2026-09-04T00:00:00.000Z",
    }),
    theme: "Custody",
    theme_score: 80,
    expertise_score: 80,
    contribution_score: 80,
    contribution_angle: "logged angle",
    account_priority: 1,
    kb_refs: ["library/custody.md"],
    chunk_refs: ["library/custody.md#control"],
    replies: ["first draft"],
    moves: ["distinction"],
    depth: "substantive",
    alternates,
  };
}

describe("pre-drafted alternates", () => {
  it("serves an alternate on ♻️ without a model call, then falls back to the model when they run out", async () => {
    const log = createMemoryCandidateLog();
    log.upsert(loggedRecord(["second shape", "third shape"]));
    const posted: CandidateInput[][] = [];
    let llmCalls = 0;
    const llm = createFakeProvider(() => {
      llmCalls += 1;
      return { suggested_reply: "model draft" };
    });
    const state = { regen_handled: {} as Record<string, string> };
    const deps = {
      config,
      llm,
      kb,
      candidateLog: log,
      state,
      getCandidates: async () => [candidate()],
      postCandidates: async (cs: CandidateInput[]) => {
        posted.push(cs);
        return { accepted: cs.length };
      },
      log: silentLogger,
    };

    const first = await runRegen(deps);
    expect(first).toMatchObject({ requested: 1, regenerated: 1, served_from_alternates: 1, failed: 0 });
    expect(llmCalls).toBe(0);
    expect(posted[0]?.[0]).toMatchObject({ id: "chime-1", suggested_reply: "second shape", kb_refs: ["library/custody.md", "tone.md"] });
    expect(log.get("1")).toMatchObject({ replies: ["first draft", "second shape"], alternates: ["third shape"], moves: ["distinction", "distinction"] });

    // Second click: the last alternate.
    deps.getCandidates = async () => [candidate({ suggested_reply: "second shape", status_updated_at: "2026-09-04T02:00:00.000Z" })];
    const second = await runRegen(deps);
    expect(second.served_from_alternates).toBe(1);
    expect(llmCalls).toBe(0);
    expect(log.get("1")?.alternates).toEqual([]);

    // Third click: nothing pre-drafted left, so the model runs and the move switches.
    deps.getCandidates = async () => [candidate({ suggested_reply: "third shape", status_updated_at: "2026-09-04T03:00:00.000Z" })];
    const third = await runRegen(deps);
    expect(third).toMatchObject({ regenerated: 1, served_from_alternates: 0 });
    expect(llmCalls).toBeGreaterThan(0);
    expect(posted[2]?.[0]?.suggested_reply).toBe("Model draft");
    expect(log.get("1")?.moves?.slice(-1)[0]).not.toBe("distinction");
  });

  it("records what was live on a filled card, once per fill", () => {
    const log = createMemoryCandidateLog();
    log.upsert(loggedRecord([]));
    const filled = candidate({ status: "filled", suggested_reply: "the one he used", status_updated_at: "2026-09-04T05:00:00.000Z" });
    expect(recordFills([filled, candidate({ id: "other-9", tweet_id: "9", status: "filled" })], log)).toBe(1);
    expect(log.get("1")).toMatchObject({ filled_reply: "the one he used", filled_at: "2026-09-04T05:00:00.000Z" });
    expect(recordFills([filled], log)).toBe(0);
  });
});

describe("guided regeneration", () => {
  it("applies the instruction, keeps the move, skips alternates, and clears the instruction afterwards", async () => {
    const log = createMemoryCandidateLog();
    log.upsert({ ...loggedRecord(["an alternate that predates the instruction"]), regen_instruction: "make it a question" });
    const posted: CandidateInput[][] = [];
    const prompts: string[] = [];
    const llm = createFakeProvider(({ prompt }) => {
      prompts.push(prompt);
      return { suggested_reply: "Does the control agreement actually let the lender act?" };
    });
    const deps = {
      config,
      llm,
      kb,
      candidateLog: log,
      state: { regen_handled: {} as Record<string, string> },
      getCandidates: async () => [candidate()],
      postCandidates: async (cs: CandidateInput[]) => {
        posted.push(cs);
        return { accepted: cs.length };
      },
      log: silentLogger,
    };
    const r = await runRegen(deps);
    expect(r).toMatchObject({ regenerated: 1, served_from_alternates: 0 });
    expect(prompts[0]).toContain("<instruction>\nmake it a question\n</instruction>");
    expect(prompts[0]).toContain("Keep what the instruction does not ask to change");
    expect(prompts[0]).toContain(`Move: `);
    expect(posted[0]?.[0]?.suggested_reply).toBe("Does the control agreement actually let the lender act?");
    const after = log.get("1");
    expect(after?.regen_instruction).toBeUndefined();
    expect(after?.instructions).toEqual(["make it a question"]);
    expect(after?.moves).toEqual(["distinction", "distinction"]);
    expect(after?.alternates).toEqual(["an alternate that predates the instruction"]);
  });

  it("takes the instruction from the in-memory map when there is no log record", async () => {
    const log = createMemoryCandidateLog();
    const prompts: string[] = [];
    const llm = createFakeProvider(({ prompt }) => {
      prompts.push(prompt);
      return { suggested_reply: "Shorter." };
    });
    const instructions = new Map([["1", "shorter"]]);
    await runRegen({
      config,
      llm,
      kb,
      candidateLog: log,
      state: { regen_handled: {} as Record<string, string> },
      getCandidates: async () => [candidate()],
      postCandidates: async (cs: CandidateInput[]) => ({ accepted: cs.length }),
      log: silentLogger,
      instructions,
    });
    expect(prompts[0]).toContain("<instruction>\nshorter\n</instruction>");
    expect(instructions.has("1")).toBe(false);
  });
});
