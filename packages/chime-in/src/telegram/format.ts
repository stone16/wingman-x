/**
 * Pure formatting for the Telegram surface: card text, buttons, the X
 * compose-intent link, callback parsing, quiet hours. No I/O, fully tested.
 */
export interface TelegramCardInput {
  tweet_id: string;
  tweet_url: string;
  author_handle: string;
  tweet_text: string;
  suggested_reply: string;
  /** e.g. "Tokenization and market structure" */
  theme?: string;
  /** "expertise" | "conversational" */
  lane?: string;
  /** move (expertise) or reply type (conversational) */
  move?: string;
}

const MAX_POST_CHARS = 420;
const MAX_MESSAGE_CHARS = 3900; // Telegram caps at 4096; leave room for markup.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function trim(s: string, max: number): string {
  const t = s.replace(/\s+\n/g, "\n").trim();
  if ([...t].length <= max) return t;
  return [...t].slice(0, max - 1).join("").trimEnd() + "…";
}

/**
 * Opens the X app (or web) with the reply composer prefilled as a reply to
 * this tweet. The person still taps Post: nothing is sent on their behalf.
 */
export function intentUrl(tweetId: string, reply: string): string {
  // The legacy twitter.com/intent/tweet path is the one the X app maps to its
  // native composer; x.com/intent/post falls into the app's web view.
  return `https://twitter.com/intent/tweet?in_reply_to=${encodeURIComponent(tweetId)}&text=${encodeURIComponent(reply)}`;
}

export function formatCard(c: TelegramCardInput, note?: string): string {
  const handle = c.author_handle.replace(/^@/, "");
  const tag = [c.theme, c.lane === "conversational" ? "casual" : undefined, c.move?.replace(/_/g, " ")].filter(Boolean).join(" · ");
  const lines = [
    `<b>@${escapeHtml(handle)}</b>${tag ? ` · <i>${escapeHtml(tag)}</i>` : ""}`,
    `<blockquote>${escapeHtml(trim(c.tweet_text, MAX_POST_CHARS))}</blockquote>`,
    `<b>Reply</b> <i>(tap to copy)</i>`,
    `<code>${escapeHtml(c.suggested_reply.trim())}</code>`,
    ...(note ? ["", `<i>${escapeHtml(note)}</i>`] : []),
  ];
  const text = lines.join("\n");
  return [...text].length > MAX_MESSAGE_CHARS ? [...text].slice(0, MAX_MESSAGE_CHARS).join("") : text;
}

/** Final state of a card once it has been handled somewhere. */
export function formatHandled(c: TelegramCardInput, status: "filled" | "dismissed"): string {
  const handle = c.author_handle.replace(/^@/, "");
  const verb = status === "filled" ? "✅ posted" : "👎 dismissed";
  return `<s>@${escapeHtml(handle)}</s> · ${verb}\n<i>${escapeHtml(trim(c.suggested_reply, 140))}</i>`;
}

export type CallbackAction = "regen" | "dismiss" | "posted";

/** /options output: three labeled options with Use buttons. */
export function formatOptionsMessage(
  post: { author_handle: string; tweet_text: string },
  options: Array<{ type: string; text: string; flags: string[]; redone?: number }>,
  instruction?: string,
): string {
  const handle = post.author_handle.replace(/^@/, "");
  const lines = [
    `<b>Options for @${escapeHtml(handle)}</b>${instruction ? ` · <i>${escapeHtml(instruction)}</i>` : ""}`,
    `<blockquote>${escapeHtml(trim(post.tweet_text, 240))}</blockquote>`,
  ];
  options.forEach((o, i) => {
    lines.push("", `<b>${i + 1} · ${escapeHtml(o.type.replace(/_/g, " "))}</b>${o.redone ? ` <i>↻${o.redone}</i>` : ""}${o.flags.length ? " ⚠️" : ""}`, `<code>${escapeHtml(o.text)}</code>`);
  });
  lines.push("", "<i>Reply in X opens the composer with that option prefilled. Use puts it on the card. ↻ redoes that one. Reply to this message with an instruction to redo all three.</i>");
  return lines.join("\n");
}

/** One row per option: open X with that text prefilled (edit, add a link, post), or make it the card's reply. */
export function useKeyboard(tweetId: string, options: Array<{ text: string }>): InlineKeyboard {
  return {
    inline_keyboard: options.map((o, i) => [
      { text: `Reply in X · ${i + 1}`, url: intentUrl(tweetId, o.text) },
      { text: `Use ${i + 1} on card`, callback_data: `use:${tweetId}:${i + 1}` },
      { text: `↻ ${i + 1}`, callback_data: `optregen:${tweetId}:${i + 1}` },
    ]),
  };
}

export function parseUseCallback(data: string): { tweetId: string; index: number } | null {
  const m = /^use:(\d{5,}):([123])$/.exec(data);
  if (!m) return null;
  return { tweetId: m[1]!, index: Number(m[2]) };
}

export function parseOptionRegenCallback(data: string): { tweetId: string; index: number } | null {
  const m = /^optregen:(\d{5,}):([123])$/.exec(data);
  if (!m) return null;
  return { tweetId: m[1]!, index: Number(m[2]) };
}

export interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>>;
}

export function buildKeyboard(tweetId: string, reply: string, opts: { regenerating?: boolean } = {}): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "Reply in X", url: intentUrl(tweetId, reply) },
        { text: "Open post", url: `https://x.com/i/status/${tweetId}` },
      ],
      [
        { text: opts.regenerating ? "⏳ Regenerating" : "♻️ Regenerate", callback_data: `regen:${tweetId}` },
        { text: "✅ Posted", callback_data: `posted:${tweetId}` },
        { text: "👎 Dismiss", callback_data: `dismiss:${tweetId}` },
      ],
    ],
  };
}

export function parseCallback(data: string): { action: CallbackAction; tweetId: string } | null {
  const m = /^(regen|dismiss|posted):(\d{5,})$/.exec(data);
  if (!m) return null;
  return { action: m[1] as CallbackAction, tweetId: m[2]! };
}

/**
 * Quiet hours as "23-8" (start hour to end hour, wrapping midnight) in a
 * named time zone. Cards drafted inside the window are held until it ends.
 */
export function inQuietHours(now: Date, range: string | undefined, timeZone: string): boolean {
  if (!range) return false;
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(range.trim());
  if (!m) return false;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start === end) return false;
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone }).format(now)) % 24;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
