import { describe, expect, it } from "vitest";
import { createFakeProvider } from "../src/llm/fake.js";
import { NormalizedPostSchema } from "../src/model/post.js";
import { buildOptionsPrompt, buildOptionsSystemPrompt, generateOptions, OptionsResultSchema } from "../src/pipeline/options.js";
import { formatOptionsMessage, parseOptionRegenCallback, parseUseCallback, useKeyboard } from "../src/telegram/format.js";

const post = NormalizedPostSchema.parse({
  tweet_id: "1",
  tweet_url: "https://x.com/a/status/1",
  author_handle: "a",
  tweet_text: "every founder eventually becomes a professional calendar manager",
  created_at: "2026-09-05T20:56:17.000Z",
  scraped_at: "2026-09-05T21:00:00.000Z",
});

describe("/options", () => {
  it("requires exactly three typed options", () => {
    expect(() => OptionsResultSchema.parse({ options: [{ type: "irony", text: "x" }] })).toThrow();
    expect(() => OptionsResultSchema.parse({ options: [{ type: "irony", text: "x" }, { type: "question", text: "y" }, { type: "dunk", text: "z" }] })).toThrow();
  });

  it("system prompt carries the policy and overrides lowercase; prompt carries the instruction", () => {
    const s = buildOptionsSystemPrompt("POLICY TEXT", "tone", "no plugging");
    expect(s).toContain("POLICY TEXT");
    expect(s).toContain("write in sentence case");
    expect(s).toContain("no plugging");
    expect(buildOptionsPrompt(post, "he's a friend")).toContain("instruction for all three options: he's a friend");
  });

  it("sentence-cases and flags tells, keeps types", async () => {
    const llm = createFakeProvider(() => ({
      options: [
        { type: "irony", text: "the calendar is the company now" },
        { type: "question", text: "what did you stop doing the week after?" },
        { type: "thinking_out_loud", text: "it isn't the meetings, it's the prep" },
      ],
    }));
    const out = await generateOptions(post, { llm, policy: "p", tone: "t", maxChars: 280 });
    expect(out.map((o) => o.type)).toEqual(["irony", "question", "thinking_out_loud"]);
    expect(out[0]?.text).toBe("The calendar is the company now");
    expect(out[1]?.text).toBe("What did you stop doing the week after?");
    expect(out[2]?.flags).toContain("contrastive-en");
  });

  it("formats the options message and Use buttons, and parses the callbacks", () => {
    const opts = [
      { type: "irony" as const, text: "A <b>bold</b> line", flags: [] },
      { type: "question" as const, text: "Q?", flags: [] },
      { type: "thinking_out_loud" as const, text: "T", flags: ["dash"] },
    ];
    const html = formatOptionsMessage({ author_handle: "a", tweet_text: "post" }, opts);
    expect(html).toContain("<b>1 · irony</b>");
    expect(html).toContain("A &lt;b&gt;bold&lt;/b&gt; line");
    expect(html).toContain("⚠️");
    const k = useKeyboard("1", opts);
    expect(k.inline_keyboard).toHaveLength(3);
    expect(k.inline_keyboard[0]?.[0]?.url).toContain("intent/tweet?in_reply_to=1&text=" + encodeURIComponent("A <b>bold</b> line"));
    expect(k.inline_keyboard.map((row) => row[1]?.callback_data)).toEqual(["use:1:1", "use:1:2", "use:1:3"]);
    expect(k.inline_keyboard.map((row) => row[2]?.callback_data)).toEqual(["optregen:1:1", "optregen:1:2", "optregen:1:3"]);
    expect(parseOptionRegenCallback("optregen:123456:3")).toEqual({ tweetId: "123456", index: 3 });
    expect(parseUseCallback("use:2096341670451368083:2")).toEqual({ tweetId: "2096341670451368083", index: 2 });
    expect(parseUseCallback("use:abc:2")).toBeNull();
    expect(parseUseCallback("use:123456:9")).toBeNull();
  });
});

import { unwrapJsonText } from "../src/pipeline/options.js";

describe("unwrapJsonText", () => {
  it("pulls prose out of nested JSON and leaves plain text alone", () => {
    expect(unwrapJsonText('{"text": "The calendar is the company now"}')).toBe("The calendar is the company now");
    expect(unwrapJsonText('{"text": "{\\"text\\": \\"twice wrapped\\"}"}')).toBe("twice wrapped");
    expect(unwrapJsonText('{"options": [{"type": "irony", "text": "first of three"}]}')).toBe("first of three");
    expect(unwrapJsonText("Plain sentence, with a comma.")).toBe("Plain sentence, with a comma.");
    expect(unwrapJsonText("{not json")).toBe("{not json");
  });
});

import { similarity } from "../src/pipeline/options.js";

describe("similarity", () => {
  it("flags paraphrases and passes different angles", () => {
    expect(similarity("The calendar is the company now", "The calendar is basically the company now")).toBeGreaterThan(0.7);
    expect(similarity("The calendar is the company now", "Nobody ships a roadmap from a meeting invite")).toBeLessThan(0.3);
  });
});
