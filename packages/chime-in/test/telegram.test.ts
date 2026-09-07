import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Candidate } from "@wingman-x/agent-kit";
import { buildKeyboard, formatCard, formatHandled, inQuietHours, intentUrl, parseCallback } from "../src/telegram/format.js";
import { createTelegramSink } from "../src/telegram/sink.js";
import type { TelegramClient } from "../src/telegram/client.js";

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  id: "chime-1",
  tweet_id: "2096341670451368083",
  tweet_url: "https://x.com/pitdesi/status/2096341670451368083",
  author_handle: "@pitdesi",
  tweet_text: "Would you hand all of that to <google> though? & more",
  suggested_reply: "The same permission prompt costs google way more than it costs a 1000 person alpha.",
  match_reason: "Lane: conversational | Theme: Technology and startups (70) | Line: 86 | Type: irony | Energy: casual | Angle: x",
  match_category: "topic",
  source: "handles",
  kb_refs: ["tone.md"],
  created_at: "2026-09-05T21:00:00.000Z",
  status: "pending",
  status_updated_at: "2026-09-05T21:00:00.000Z",
  ...over,
});

function fakeClient() {
  const sent: Array<{ html: string; keyboard: unknown; message_id: number }> = [];
  const edits: Array<{ messageId: number; html: string; keyboard: unknown }> = [];
  let nextId = 100;
  const client: TelegramClient = {
    async sendMessage(_chat, html, keyboard) {
      nextId += 1;
      sent.push({ html, keyboard, message_id: nextId });
      return nextId;
    },
    async editMessage(_chat, messageId, html, keyboard) {
      edits.push({ messageId, html, keyboard });
    },
    async answerCallback() {},
    async getUpdates() {
      return [];
    },
    async setCommands() {},
    async getMe() {
      return { username: "test_bot" };
    },
  };
  return { client, sent, edits };
}

describe("telegram formatting", () => {
  it("builds an X compose-intent link that replies to the tweet with the text prefilled", () => {
    const u = intentUrl("123", "he's right, & <b> too");
    expect(u.startsWith("https://twitter.com/intent/tweet?in_reply_to=123&text=")).toBe(true);
    expect(decodeURIComponent(u.split("text=")[1]!)).toBe("he's right, & <b> too");
  });

  it("escapes HTML in post and reply and tags the lane", () => {
    const html = formatCard({ ...cand(), theme: "Technology and startups", lane: "conversational", move: "irony" });
    expect(html).toContain("<b>@pitdesi</b>");
    expect(html).toContain("Technology and startups · casual · irony");
    expect(html).toContain("&lt;google&gt;");
    expect(html).toContain("&amp; more");
    expect(html).not.toContain("<google>");
  });

  it("keyboard has open, regenerate, posted, dismiss; regenerating state relabels the button", () => {
    const k = buildKeyboard("123", "reply");
    expect(k.inline_keyboard[0]?.[0]?.url).toContain("intent/tweet");
    expect(k.inline_keyboard[0]?.[1]?.url).toBe("https://x.com/i/status/123");
    expect(k.inline_keyboard[1]?.map((b) => b.callback_data)).toEqual(["regen:123", "posted:123", "dismiss:123"]);
    expect(buildKeyboard("123", "reply", { regenerating: true }).inline_keyboard[1]?.[0]?.text).toContain("Regenerating");
  });

  it("parses callbacks strictly", () => {
    expect(parseCallback("regen:2096341670451368083")).toEqual({ action: "regen", tweetId: "2096341670451368083" });
    expect(parseCallback("dismiss:abc")).toBeNull();
    expect(parseCallback("nuke:123456")).toBeNull();
  });

  it("quiet hours wrap midnight in the given zone", () => {
    // 04:30 UTC = 23:30 Chicago (CDT) → quiet under 23-8
    expect(inQuietHours(new Date("2026-09-06T04:30:00Z"), "23-8", "America/Chicago")).toBe(true);
    // 14:00 UTC = 09:00 Chicago → not quiet
    expect(inQuietHours(new Date("2026-09-06T14:00:00Z"), "23-8", "America/Chicago")).toBe(false);
    expect(inQuietHours(new Date(), undefined, "America/Chicago")).toBe(false);
    expect(inQuietHours(new Date(), "9-9", "America/Chicago")).toBe(false);
  });
});

describe("telegram sink", () => {
  it("announces once, edits on redraft, collapses on fill, and survives a restart without re-announcing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-"));
    const store = join(dir, "telegram.jsonl");
    const f = fakeClient();
    const log = { info: () => {}, warn: () => {} };
    const sink = createTelegramSink({ client: f.client, chatId: 42, storePath: store, log });

    expect(await sink.announce([cand()], new Map([["2096341670451368083", { lane: "conversational", move: "irony" }]]))).toBe(1);
    expect(await sink.announce([cand()])).toBe(0);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.html).toContain("casual · irony");

    // Redraft from anywhere → edit in place with the new reply and a fresh Open-in-X link.
    expect(await sink.sync([cand({ suggested_reply: "New shape entirely." })])).toBe(1);
    expect(f.edits[0]?.html).toContain("New shape entirely.");
    expect(f.edits[0]?.html).toContain("regenerated");
    expect(JSON.stringify(f.edits[0]?.keyboard)).toContain(encodeURIComponent("New shape entirely."));

    // Same state again → no edit.
    expect(await sink.sync([cand({ suggested_reply: "New shape entirely." })])).toBe(0);

    // Filled in Chrome → message collapses to one line, buttons removed.
    expect(await sink.sync([cand({ suggested_reply: "New shape entirely.", status: "filled" })])).toBe(1);
    expect(f.edits[1]?.html).toContain("✅ posted");
    expect(f.edits[1]?.html).toContain("<s>@pitdesi</s>");

    // Restart: records reload from disk, nothing re-sent, filled card ignored.
    const sink2 = createTelegramSink({ client: f.client, chatId: 42, storePath: store, log });
    expect(sink2.has("2096341670451368083")).toBe(true);
    expect(await sink2.announce([cand({ status: "filled" })])).toBe(0);
    expect(f.sent).toHaveLength(1);
  });

  it("resend re-issues a card that was already sent, moves the record to the new message, and collapses the old one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-"));
    const f = fakeClient();
    const sink = createTelegramSink({ client: f.client, chatId: 42, storePath: join(dir, "t.jsonl"), log: { info: () => {}, warn: () => {} } });
    expect(await sink.announce([cand()], new Map([["2096341670451368083", { lane: "conversational", move: "irony" }]]))).toBe(1);
    const firstId = f.sent[0]!.message_id;
    expect(await sink.resend([cand(), cand({ status: "filled", tweet_id: "9", id: "chime-9" })])).toBe(1);
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]?.html).toContain("casual · irony"); // meta carried over from the first record
    expect(sink.tweetIdForMessage(f.sent[1]!.message_id)).toBe("2096341670451368083");
    expect(sink.tweetIdForMessage(firstId)).toBeNull();
    expect(f.edits.at(-1)?.html).toContain("re-sent below");
  });

  it("never announces already-handled candidates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-"));
    const f = fakeClient();
    const sink = createTelegramSink({ client: f.client, chatId: 42, storePath: join(dir, "t.jsonl"), log: { info: () => {}, warn: () => {} } });
    expect(await sink.announce([cand({ status: "dismissed" }), cand({ tweet_id: "9", id: "chime-9", status: "filled" })])).toBe(0);
    expect(f.sent).toHaveLength(0);
  });

  it("formatHandled strikes the handle", () => {
    expect(formatHandled(cand(), "dismissed")).toContain("👎 dismissed");
  });
});

describe("telegram regen from the phone", () => {
  it("re-issues the card as a new message threaded under the instruction and collapses the old one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-"));
    const f = fakeClient();
    const sink = createTelegramSink({ client: f.client, chatId: 42, storePath: join(dir, "t.jsonl"), log: { info: () => {}, warn: () => {} } });
    await sink.announce([cand()]);
    const oldId = 101;
    await sink.markRegenerating(cand().tweet_id, cand(), "make it longer", 900);
    expect(f.edits[0]?.html).toContain('regenerating with: "make it longer"');
    // The redraft lands → new message, old one collapsed.
    await sink.sync([cand({ suggested_reply: "A longer, more engaging version of the point." })]);
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]?.html).toContain("A longer, more engaging version");
    expect(f.sent[1]?.html).toContain('redrafted: "make it longer"');
    expect(f.edits.at(-1)?.messageId).toBe(oldId);
    expect(f.edits.at(-1)?.html).toContain("redrafted below");
    // Record now points at the new message; a Chrome-side redraft later edits in place again.
    expect(sink.tweetIdForMessage(102)).toBe(cand().tweet_id);
    expect(sink.tweetIdForMessage(oldId)).toBeNull();
    await sink.sync([cand({ suggested_reply: "Edited quietly from Chrome." })]);
    expect(f.sent).toHaveLength(2);
  });
});

describe("telegram ♻️ button", () => {
  it("edits the card in place; only a reply-with-instruction re-issues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-"));
    const f = fakeClient();
    const sink = createTelegramSink({ client: f.client, chatId: 42, storePath: join(dir, "t.jsonl"), log: { info: () => {}, warn: () => {} } });
    await sink.announce([cand()]);
    await sink.markRegenerating(cand().tweet_id, cand()); // button: no instruction, no reply-to
    await sink.sync([cand({ suggested_reply: "Button redraft." })]);
    expect(f.sent).toHaveLength(1);
    expect(f.edits.at(-1)?.messageId).toBe(101);
    expect(f.edits.at(-1)?.html).toContain("Button redraft.");
  });
});
