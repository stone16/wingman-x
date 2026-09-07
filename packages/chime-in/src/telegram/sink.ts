import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Candidate } from "@wingman-x/agent-kit";
import type { TelegramClient } from "./client.js";
import { buildKeyboard, escapeHtml, formatCard, formatHandled, type TelegramCardInput } from "./format.js";

/**
 * The phone surface. One Telegram message per candidate, kept in sync with
 * the daemon: a redraft edits the text in place, a fill or dismiss (from
 * Chrome or from Telegram) collapses the message to one line. The mapping
 * tweet_id → message is persisted so restarts do not re-announce.
 */
export interface TelegramRecord {
  tweet_id: string;
  message_id: number;
  /** Reply text as last rendered, to detect redrafts. */
  reply: string;
  status: string;
  lane?: string;
  move?: string;
  theme?: string;
  announced_at: string;
  /** Set when a regen was requested from Telegram: the next redraft is sent as a NEW message (bottom of chat) instead of an edit. */
  reissue_on_change?: boolean;
  /** The person's instruction message to thread the new card under. */
  reply_to?: number;
  /** Instruction to mention on the reissued card. */
  pending_note?: string;
}

export interface SinkLogger {
  info(l: string): void;
  warn(l: string): void;
}

export interface TelegramSinkOptions {
  client: TelegramClient;
  chatId: number;
  storePath: string;
  log: SinkLogger;
  now?: () => Date;
}

export interface TelegramSink {
  /** Send cards for these candidates unless already announced. Returns how many were sent. */
  announce(candidates: Candidate[], meta?: Map<string, { lane?: string; move?: string; theme?: string }>): Promise<number>;
  /** Reflect daemon state onto existing messages: redrafts, fills, dismissals. */
  sync(candidates: Candidate[]): Promise<number>;
  /**
   * Re-issue cards at the bottom of the chat, whether or not they were sent
   * before (/pending on a long history). The old message collapses to a
   * pointer and the record moves to the new message so edits and replies land
   * on the visible card.
   */
  resend(candidates: Candidate[], meta?: Map<string, { lane?: string; move?: string; theme?: string }>): Promise<number>;
  /** Show the regenerating state on a card immediately after a click. */
  markRegenerating(tweetId: string, candidate?: Candidate, instruction?: string, replyToMessageId?: number): Promise<void>;
  /** Which card a Telegram message id belongs to (for reply-to instructions). */
  tweetIdForMessage(messageId: number): string | null;
  has(tweetId: string): boolean;
  size(): number;
}

function loadRecords(path: string): Map<string, TelegramRecord> {
  const out = new Map<string, TelegramRecord>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as TelegramRecord;
      if (r && typeof r.tweet_id === "string" && typeof r.message_id === "number") out.set(r.tweet_id, r);
    } catch {
      // torn line
    }
  }
  return out;
}

function toCard(c: Candidate, rec?: Partial<TelegramRecord>): TelegramCardInput {
  return {
    tweet_id: c.tweet_id,
    tweet_url: c.tweet_url,
    author_handle: c.author_handle,
    tweet_text: c.tweet_text,
    suggested_reply: c.suggested_reply,
    ...(rec?.theme ? { theme: rec.theme } : {}),
    ...(rec?.lane ? { lane: rec.lane } : {}),
    ...(rec?.move ? { move: rec.move } : {}),
  };
}

export function createTelegramSink(opts: TelegramSinkOptions): TelegramSink {
  const { client, chatId, storePath, log } = opts;
  const now = opts.now ?? (() => new Date());
  mkdirSync(dirname(storePath), { recursive: true });
  const records = loadRecords(storePath);

  function persist(rec: TelegramRecord): void {
    records.set(rec.tweet_id, rec);
    appendFileSync(storePath, `${JSON.stringify(rec)}\n`);
  }
  // Compact occasionally so the jsonl does not grow without bound.
  function compact(): void {
    writeFileSync(storePath, [...records.values()].map((r) => JSON.stringify(r)).join("\n") + (records.size ? "\n" : ""));
  }

  return {
    has: (id) => records.has(id),
    size: () => records.size,
    tweetIdForMessage: (messageId) => {
      for (const r of records.values()) if (r.message_id === messageId) return r.tweet_id;
      return null;
    },

    async announce(candidates, meta) {
      let sent = 0;
      for (const c of candidates) {
        if (records.has(c.tweet_id)) continue;
        if (c.status === "filled" || c.status === "dismissed") continue;
        const m = meta?.get(c.tweet_id) ?? {};
        try {
          const messageId = await client.sendMessage(chatId, formatCard(toCard(c, m)), buildKeyboard(c.tweet_id, c.suggested_reply));
          persist({ tweet_id: c.tweet_id, message_id: messageId, reply: c.suggested_reply, status: c.status, ...m, announced_at: now().toISOString() });
          sent += 1;
        } catch (err) {
          log.warn(`telegram: send failed for ${c.tweet_id}: ${(err as Error).message}`);
        }
      }
      if (sent > 0) log.info(`telegram: sent ${sent} card(s)`);
      return sent;
    },

    async resend(candidates, meta) {
      let sent = 0;
      for (const c of candidates) {
        if (c.status === "filled" || c.status === "dismissed") continue;
        const prev = records.get(c.tweet_id);
        const m = { ...(prev ? { lane: prev.lane, move: prev.move, theme: prev.theme } : {}), ...(meta?.get(c.tweet_id) ?? {}) };
        try {
          const messageId = await client.sendMessage(chatId, formatCard(toCard(c, m)), buildKeyboard(c.tweet_id, c.suggested_reply));
          persist({ tweet_id: c.tweet_id, message_id: messageId, reply: c.suggested_reply, status: c.status, ...m, announced_at: now().toISOString() });
          sent += 1;
          if (prev && prev.message_id !== messageId) {
            await client.editMessage(chatId, prev.message_id, `↓ re-sent below · @${escapeHtml(c.author_handle)}`).catch(() => {});
          }
          // Telegram allows roughly one message per second to a chat before it starts refusing.
          await new Promise((r) => setTimeout(r, 350));
        } catch (err) {
          log.warn(`telegram: resend failed for ${c.tweet_id}: ${(err as Error).message}`);
        }
      }
      if (sent > 0) log.info(`telegram: re-sent ${sent} card(s)`);
      return sent;
    },

    async sync(candidates) {
      let edits = 0;
      const byId = new Map(candidates.map((c) => [c.tweet_id, c] as const));
      for (const rec of [...records.values()]) {
        const c = byId.get(rec.tweet_id);
        if (!c) continue;
        const handled = c.status === "filled" || c.status === "dismissed";
        const alreadyHandled = rec.status === "filled" || rec.status === "dismissed";
        if (handled && !alreadyHandled) {
          try {
            await client.editMessage(chatId, rec.message_id, formatHandled(toCard(c, rec), c.status as "filled" | "dismissed"));
            persist({ ...rec, status: c.status, reply: c.suggested_reply });
            edits += 1;
          } catch (err) {
            log.warn(`telegram: edit failed for ${c.tweet_id}: ${(err as Error).message}`);
          }
          continue;
        }
        if (!handled && c.suggested_reply !== rec.reply) {
          try {
            if (rec.reissue_on_change) {
              // Requested from Telegram: a fresh card at the bottom, threaded
              // under the instruction, and the old card collapses to a pointer.
              const note = rec.pending_note ? `redrafted: "${rec.pending_note}"` : "redrafted";
              const newId = await client.sendMessage(chatId, formatCard(toCard(c, rec), note), buildKeyboard(c.tweet_id, c.suggested_reply), rec.reply_to);
              await client.editMessage(chatId, rec.message_id, `<s>@${escapeHtml(c.author_handle.replace(/^@/, ""))}</s> · ↻ redrafted below`).catch(() => {});
              const { reissue_on_change: _r, reply_to: _t, pending_note: _n, ...rest } = rec;
              persist({ ...rest, message_id: newId, status: c.status, reply: c.suggested_reply });
            } else {
              await client.editMessage(chatId, rec.message_id, formatCard(toCard(c, rec), "regenerated"), buildKeyboard(c.tweet_id, c.suggested_reply));
              persist({ ...rec, status: c.status, reply: c.suggested_reply });
            }
            edits += 1;
          } catch (err) {
            log.warn(`telegram: edit failed for ${c.tweet_id}: ${(err as Error).message}`);
          }
        } else if (c.status !== rec.status) {
          persist({ ...rec, status: c.status });
        }
      }
      if (edits > 0) {
        log.info(`telegram: updated ${edits} card(s)`);
        if (records.size > 50) compact();
      }
      return edits;
    },

    async markRegenerating(tweetId, candidate, instruction, replyToMessageId) {
      const rec = records.get(tweetId);
      if (!rec) return;
      // Only a reply-with-instruction re-issues the card as a new message (it
      // is the response to what the person typed). The ♻️ button edits in place.
      if (replyToMessageId !== undefined) {
        persist({ ...rec, reissue_on_change: true, reply_to: replyToMessageId, ...(instruction ? { pending_note: instruction } : {}) });
      }
      const c = candidate;
      const card: TelegramCardInput = c
        ? toCard(c, rec)
        : { tweet_id: tweetId, tweet_url: `https://x.com/i/status/${tweetId}`, author_handle: "", tweet_text: "", suggested_reply: rec.reply };
      try {
        const note = instruction ? `regenerating with: "${instruction}"… about 25 seconds` : "regenerating… about 25 seconds";
        await client.editMessage(chatId, rec.message_id, formatCard(card, note), buildKeyboard(tweetId, rec.reply, { regenerating: true }));
      } catch (err) {
        log.warn(`telegram: edit failed for ${tweetId}: ${(err as Error).message}`);
      }
    },
  };
}
