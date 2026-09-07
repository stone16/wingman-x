import { describe, expect, it } from "vitest";
import { parseExchanges, toneForDraft } from "../src/kb/tone-select.js";
import { buildDraftSystemPrompt } from "../src/pipeline/stages/draft.js";

const tone = [
  "# Voice",
  "",
  "## Who is speaking",
  "Udit.",
  "",
  "## How it reads",
  "Plain sentences.",
  "",
  "## Real exchanges (mechanics only, stances theirs)",
  "",
  "Each reply is shown under its post.",
  "",
  "@mdudas, 2026-09-04, distinction plus aside:",
  'Post by @a: "one"',
  "> no, those are different instruments",
  "",
  "@mdudas, 2026-09-04, the light reaction:",
  'Post by @b: "two"',
  "> everything is a meme",
  "",
  "@jdorman81, 2026-06-07, yes plus the mechanism:",
  'Post by @c: "three"',
  "> Yes. Convert investors only care about vol.",
  "",
  "@jdorman81, 2026-06-05, one number, flat closer:",
  'Post by @d: "four"',
  "> Lost $15 bn buying back $1.5 bn. So dumb",
  "",
  "## Approved replies (drafted by GPT, approved by Udit on 2026-09-06)",
  "",
  'Post by @KyleSamani: "five"',
  "> I like that you can move the shares to a regular broker.",
  "",
  "## Drift to catch",
  "Em dashes.",
  "",
].join("\n");

describe("progressive tone loading", () => {
  it("parses labelled exchanges with their parent posts", () => {
    const ex = parseExchanges(tone.split("## Approved")[0]!.split("## Real exchanges")[1]!.replace(/^/, "## Real exchanges\n"));
    expect(ex.map((e) => e.label)).toEqual(["distinction plus aside", "the light reaction", "yes plus the mechanism", "one number, flat closer"]);
    expect(ex[0]!.block).toContain('Post by @a: "one"');
  });

  it("always carries the rules, the drift list, and the person's own replies; borrows only exchanges that match the move", () => {
    const light = toneForDraft(tone, "light_reaction");
    expect(light.text).toContain("Plain sentences.");
    expect(light.text).toContain("Em dashes.");
    expect(light.text).toContain("move the shares to a regular broker");
    expect(light.examples).toEqual(["the light reaction", "one number, flat closer"]);
    expect(light.text).toContain("everything is a meme");
    expect(light.text).not.toContain("Convert investors");
    const agree = toneForDraft(tone, "agree_extend");
    expect(agree.examples).toEqual(["yes plus the mechanism"]);
    expect(agree.text).not.toContain("everything is a meme");
    const none = toneForDraft(tone, undefined);
    expect(none.examples).toEqual([]);
    expect(none.text).toContain("move the shares to a regular broker");
  });

  it("the candidate drafter receives the progressive tone; the baseline receives the whole file", () => {
    const cand = buildDraftSystemPrompt(tone, 280, { profile: "candidate", move: "distinction" });
    expect(cand).toContain("those are different instruments");
    expect(cand).not.toContain("everything is a meme");
    expect(cand).toContain("move the shares to a regular broker");
    const base = buildDraftSystemPrompt(tone, 280, {});
    expect(base).toContain("everything is a meme");
    expect(base).toContain("those are different instruments");
  });
});
