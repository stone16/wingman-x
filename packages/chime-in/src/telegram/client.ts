import type { InlineKeyboard } from "./format.js";

/**
 * Thin Telegram Bot API client over fetch. Long polling only: the VM sits
 * behind NAT with no public URL, and getUpdates needs none.
 */
export interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string; reply_to_message?: { message_id: number; text?: string } };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number } } };
}

export interface TelegramClient {
  sendMessage(chatId: number, html: string, keyboard?: InlineKeyboard, replyToMessageId?: number): Promise<number>;
  editMessage(chatId: number, messageId: number, html: string, keyboard?: InlineKeyboard): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  getUpdates(offset: number, timeoutSecs: number): Promise<TelegramUpdate[]>;
  setCommands(commands: Array<{ command: string; description: string }>): Promise<void>;
  getMe(): Promise<{ username: string }>;
}

export function createTelegramClient(token: string, fetchImpl: typeof fetch = fetch): TelegramClient {
  const base = `https://api.telegram.org/bot${token}`;
  async function call<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
      if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
      return json.result as T;
    } finally {
      clearTimeout(t);
    }
  }
  return {
    async sendMessage(chatId, html, keyboard, replyToMessageId) {
      const r = await call<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
        ...(replyToMessageId !== undefined ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
      });
      return r.message_id;
    },
    async editMessage(chatId, messageId, html, keyboard) {
      try {
        await call("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard ?? { inline_keyboard: [] },
        });
      } catch (err) {
        // "message is not modified" is Telegram's way of saying no-op.
        if (!/not modified/i.test((err as Error).message)) throw err;
      }
    },
    async answerCallback(callbackId, text) {
      await call("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
    },
    async getUpdates(offset, timeoutSecs) {
      return call<TelegramUpdate[]>(
        "getUpdates",
        { offset, timeout: timeoutSecs, allowed_updates: ["message", "callback_query"] },
        (timeoutSecs + 10) * 1000,
      );
    },
    async setCommands(commands) {
      await call("setMyCommands", { commands });
    },
    async getMe() {
      return call<{ username: string }>("getMe", {});
    },
  };
}
