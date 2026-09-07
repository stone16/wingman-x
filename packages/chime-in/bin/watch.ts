#!/usr/bin/env tsx
/**
 * `npm run watch -- [--scan-every 0|30m|2h] [--scan-now] [--sweep-every 5s] [--since ...] [--limit N]`
 *
 * The always-on mode. One process that:
 *   1. subscribes to the Wingman daemon's event stream and serves a ♻️
 *      click within seconds of it happening (no polling, no manual
 *      `npm run regen`);
 *   2. optionally runs a full scan on an interval (`--scan-every 30m`;
 *      default 0 = scans stay manual). With an interval set, the first scan
 *      runs at start; `--scan-now` forces one at start regardless.
 * Regens and scans run in separate lanes, so a ♻️ click is served right
 * away even while a scan is in progress. Stop with Ctrl+C. Reconnects to the
 * daemon if it restarts.
 */
import "../../../scripts/load-env.mjs";
import { runRegen } from "../src/pipeline/regen.js";
import { runScan } from "../src/pipeline/scan.js";
import { computeSince, saveScanState } from "../src/state/scan-state.js";
import { connectDaemon } from "../src/wingman/daemon.js";
import { buildRuntime, buildSource, parseFlags, parseSince, printCandidates, writeScanReport } from "../src/cli/bootstrap.js";
import { loadWatchlist } from "../src/watchlist.js";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NormalizedPostSchema } from "../src/model/post.js";
import { isWatcherRunning, removeWatcherPid, writeWatcherPid } from "../src/cli/watcher-process.js";
import { createTelegramClient } from "../src/telegram/client.js";
import { inQuietHours, parseCallback } from "../src/telegram/format.js";
import { createTelegramSink, type TelegramSink } from "../src/telegram/sink.js";
import type { Candidate } from "@wingman-x/agent-kit";
import { runSinglePost } from "../src/pipeline/single.js";
import { fetchTweetById, instructionAfterUrl, parseTweetUrl } from "../src/sources/single-tweet.js";
import { generateOptions, regenerateOption, similarity, type ReplyOption } from "../src/pipeline/options.js";
import { formatOptionsMessage, parseOptionRegenCallback, parseUseCallback, useKeyboard } from "../src/telegram/format.js";
import { CandidateInputSchema } from "@wingman-x/agent-kit";
import type { NormalizedPost } from "../src/model/post.js";

// ---- flags -----------------------------------------------------------
const argv = process.argv.slice(2);
function takeFlag(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, v !== undefined && !v.startsWith("--") ? 2 : 1);
  return v;
}
function takeBool(name: string): boolean {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
}
function parseInterval(v: string): number {
  const m = /^(\d+(?:\.\d+)?)(h|m|s)?$/i.exec(v.trim());
  if (!m?.[1]) throw new Error(`--scan-every expects e.g. 2h, 45m, 0 — got ${JSON.stringify(v)}`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "h").toLowerCase();
  return n * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000);
}
const scanEveryMs = parseInterval(takeFlag("--scan-every") ?? "0");
// How often to check the daemon for pending ♻️ clicks. One local GET; this is
// the primary pickup path (the event stream is a bonus that has proven laggy).
const sweepEveryMs = parseInterval(takeFlag("--sweep-every") ?? "5s");
const stamp = (): string => new Date().toISOString().slice(11, 19);
const scanNow = takeBool("--scan-now");
takeBool("--no-initial-scan"); // accepted for compatibility; no-op now that initial scans are opt-in
const flags = parseFlags(argv);
if (flags.dryRun) {
  process.stderr.write("watch mode is live by definition; drop --dry-run\n");
  process.exit(1);
}

const rt = await buildRuntime(flags, { needWatchlist: true });
const log = rt.log;
{
  const other = isWatcherRunning(rt.paths);
  if (other !== null) {
    log.info(`watch: another watcher is already running (pid ${other}); nothing to do. Stop it with npm run watch:stop.`);
    process.exit(0);
  }
  writeWatcherPid(rt.paths);
  try {
    unlinkSync(rt.paths.scanInProgress);
  } catch {
    // none
  }
  if (process.env.CHIME_WATCH_BACKGROUND === "1") log.info(`watch: started in the background at ${new Date().toISOString()}`);
}
let daemon = await connectDaemon(rt.config.daemonPort);
log.info(`watch: Wingman daemon on port ${daemon.port}; scans ${scanEveryMs > 0 ? `every ${Math.round(scanEveryMs / 60000)} min` : "manual (npm run scan)"}; ♻️ served on click`);

// ---- Telegram surface (optional) ----------------------------------------
const tg = rt.config.telegramBotToken && rt.config.telegramChatId !== undefined
  ? { client: createTelegramClient(rt.config.telegramBotToken), chatId: rt.config.telegramChatId }
  : null;
const sink: TelegramSink | null = tg ? createTelegramSink({ client: tg.client, chatId: tg.chatId, storePath: rt.paths.telegram, log }) : null;
/** Cards drafted during quiet hours wait here until the window ends. */
const heldForMorning = new Map<string, { lane?: string; move?: string; theme?: string }>();
/** Guided regen instructions by tweet_id (also persisted to the candidate log when a record exists). */
const guidedInstructions = new Map<string, string>();
/** Set by a bare /options (tapped from the command menu): the next pasted link runs options mode. */
let awaitingOptionsLinkUntil = 0;
/** /options results by tweet_id, waiting for a Use tap. */
type OptionsSession = { post: NormalizedPost; options: Array<ReplyOption & { redone?: number }>; messageId: number; instruction?: string; history: string[] };
const pendingOptions = new Map<string, OptionsSession>();
// Sessions survive a watcher restart (deploys happen mid-conversation): one JSON line per post, rewritten on change.
const OPTIONS_STORE = join(dirname(rt.paths.telegram), "options.jsonl");
try {
  if (existsSync(OPTIONS_STORE)) {
    for (const line of readFileSync(OPTIONS_STORE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line) as OptionsSession & { tweet_id: string };
        if (s.tweet_id && s.post && Array.isArray(s.options)) pendingOptions.set(s.tweet_id, { post: NormalizedPostSchema.parse(s.post), options: s.options, messageId: s.messageId, instruction: s.instruction, history: s.history ?? [] });
      } catch {
        // torn line
      }
    }
    if (pendingOptions.size > 0) log.info(`watch: restored ${pendingOptions.size} /options session(s)`);
  }
} catch (err) {
  log.warn(`watch: could not restore /options sessions: ${(err as Error).message}`);
}
function persistOptions(): void {
  try {
    writeFileSync(OPTIONS_STORE, [...pendingOptions.entries()].map(([tweet_id, s]) => JSON.stringify({ tweet_id, ...s })).join("\n") + (pendingOptions.size ? "\n" : ""));
  } catch (err) {
    log.warn(`watch: could not persist /options sessions: ${(err as Error).message}`);
  }
}

/** The post a reply-to points at: a bot card, an options message, or any message (yours or the bot's) that contains a post link. */
function tweetIdFromRepliedMessage(reply: { message_id: number; text?: string } | undefined): string | null {
  if (!reply || !sink) return null;
  const card = sink.tweetIdForMessage(reply.message_id);
  if (card) return card;
  const opt = [...pendingOptions.values()].find((p) => p.messageId === reply.message_id);
  if (opt) return opt.post.tweet_id;
  const link = reply.text ? parseTweetUrl(reply.text) : null;
  return link?.tweetId ?? null;
}

// ---- durable request journal ----------------------------------------------
// Every request from Telegram (link draft, options, guided regen) is written
// here when it arrives and marked done when it finishes. On start, unfinished
// ones are replayed, so a deploy or crash mid-job never loses a request.
type Req = { id: string; kind: "link" | "options" | "guided"; tweetId: string; instruction?: string; ts: string; done?: boolean };
const requestsPath = join(rt.config.chimeDir, "requests.jsonl");
function journal(req: Req): void {
  try {
    appendFileSync(requestsPath, `${JSON.stringify(req)}\n`);
  } catch {
    // best effort
  }
}
function markDone(id: string): void {
  journal({ id, kind: "link", tweetId: "", ts: new Date().toISOString(), done: true });
}
function unfinishedRequests(): Req[] {
  if (!existsSync(requestsPath)) return [];
  const byId = new Map<string, Req>();
  for (const line of readFileSync(requestsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Req;
      if (r.done) byId.delete(r.id);
      else byId.set(r.id, r);
    } catch {
      // torn line
    }
  }
  // Only replay recent ones; a request from hours ago is stale.
  const cutoff = Date.now() - 6 * 3600_000;
  return [...byId.values()].filter((r) => Date.parse(r.ts) > cutoff);
}
function newReqId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function draftFromLink(tweetId: string, instruction: string | undefined, reqId: string): Promise<void> {
  if (!tg || !sink) return;
  try {
    const existing = (await daemon.client.getCandidates()).find((c) => c.tweet_id === tweetId);
    if (existing && sink.has(tweetId) && !instruction) {
      await tg.client.sendMessage(tg.chatId, "That post already has a card above.");
      return;
    }
    const post = await fetchTweetById(tweetId);
    const r = await runSinglePost(post, { config: rt.config, llm: rt.llm, kb: rt.kb, themes: rt.themes, policy: rt.policy, digest: rt.digest, experienceIndex: rt.experienceIndex, facts: rt.facts, factCachePath: rt.paths.factCache, candidateLog: rt.candidateLog, postCandidates: (cs) => daemon.client.postCandidates(cs) }, instruction);
    log.info(`watch: ${stamp()} drafted from link ${tweetId} (${r.grounding}, ${r.move})`);
    const all = await daemon.client.getCandidates();
    const c = all.find((x) => x.tweet_id === tweetId);
    if (c) {
      if (sink.has(tweetId)) await sink.sync(all);
      else await sink.announce([c], new Map([[c.tweet_id, { lane: r.grounding === "none" ? "conversational" : "expertise", move: r.move, theme: r.theme }]]));
    }
  } catch (err) {
    log.warn(`watch: link draft failed: ${(err as Error).message}`);
    await tg.client.sendMessage(tg.chatId, `Could not draft for that link: ${(err as Error).message}`).catch(() => {});
  } finally {
    markDone(reqId);
  }
}

function optionsDeps() {
  return { llm: rt.llm, policy: rt.optionsPolicy, tone: rt.kb.tone, constraints: rt.kb.constraints, maxChars: rt.config.replyMaxChars };
}

async function runOptions(link: { tweetId: string }, instruction: string | undefined): Promise<void> {
  if (!tg || !sink) return;
  const post = await fetchTweetById(link.tweetId);
  const options = await generateOptions(post, optionsDeps(), instruction);
  const prior = pendingOptions.get(post.tweet_id);
  const messageId = await tg.client.sendMessage(tg.chatId, formatOptionsMessage(post, options, instruction), useKeyboard(post.tweet_id, options));
  pendingOptions.set(post.tweet_id, { post, options, messageId, instruction, history: [...(prior?.history ?? []), ...(prior?.options.map((o) => o.text) ?? [])] });
  persistOptions();
  log.info(`watch: ${stamp()} /options for ${post.tweet_id} (${options.map((o) => o.type).join(", ")})`);
}

/** Make a chosen option the card's reply: update the daemon (and create the card if this post has none). */
async function useOption(tweetId: string, index: number): Promise<string> {
  const pending = pendingOptions.get(tweetId);
  if (!pending) return "Those options expired (watcher restarted). Send /options again.";
  const chosen = pending.options[index - 1];
  if (!chosen) return "No such option.";
  const existing = (await daemon.client.getCandidates()).find((c) => c.tweet_id === tweetId);
  const { post } = pending;
  const input = CandidateInputSchema.parse({
    id: existing?.id ?? `chime-${tweetId}`,
    tweet_id: tweetId,
    tweet_url: post.tweet_url,
    author_handle: existing?.author_handle ?? `@${post.author_handle}`,
    tweet_text: existing?.tweet_text ?? post.tweet_text,
    suggested_reply: chosen.text,
    match_reason: `Lane: options | Type: ${chosen.type} | Angle: chosen from /options`,
    match_category: existing?.match_category ?? "selected",
    source: existing?.source ?? "handles",
    kb_refs: ["options.md", "tone.md"],
    ...(chosen.flags.length ? { ai_tell_flags: chosen.flags } : {}),
  });
  await daemon.client.postCandidates([input]);
  const logged = rt.candidateLog.get(tweetId);
  rt.candidateLog.upsert({
    ...(logged ?? {
      tweet_id: tweetId,
      recorded_at: new Date().toISOString(),
      post,
      theme: "options",
      theme_score: 0,
      expertise_score: 0,
      contribution_score: 0,
      contribution_angle: "chosen from /options",
      account_priority: 1,
      kb_refs: [],
      chunk_refs: [],
      replies: [],
    }),
    replies: [...(logged?.replies ?? []), chosen.text],
    moves: [...(logged?.moves ?? []), chosen.type],
    lane: logged?.lane ?? "options",
  });
  const all = await daemon.client.getCandidates();
  const c = all.find((x) => x.tweet_id === tweetId);
  if (c && sink) {
    if (sink.has(tweetId)) await sink.sync(all);
    else await sink.announce([c], new Map([[tweetId, { lane: "options", move: chosen.type }]]));
  }
  return `Using option ${index}`;
}
if (tg) {
  const me = await tg.client.getMe().catch(() => ({ username: "?" }));
  log.info(`watch: telegram on as @${me.username} → chat ${tg.chatId}${rt.config.telegramQuietHours ? `, quiet ${rt.config.telegramQuietHours} ${rt.config.telegramTz}` : ""}`);
  await tg.client
    .setCommands([
      { command: "scan", description: "Run a scan now" },
      { command: "status", description: "Pending cards and watcher state" },
      { command: "options", description: "Three fast reply options for a post link" },
      { command: "pending", description: "Push cards not yet sent here" },
      { command: "help", description: "What the buttons do" },
    ])
    .catch(() => {});
}

async function announceToTelegram(ids: Map<string, { lane?: string; move?: string; theme?: string }>): Promise<void> {
  if (!sink || !tg || ids.size === 0) return;
  if (inQuietHours(new Date(), rt.config.telegramQuietHours, rt.config.telegramTz)) {
    for (const [id, m] of ids) heldForMorning.set(id, m);
    log.info(`watch: telegram quiet hours; holding ${ids.size} card(s)`);
    return;
  }
  const all = await daemon.client.getCandidates();
  const pick = all.filter((c) => ids.has(c.tweet_id));
  await sink.announce(pick, ids);
}

async function syncTelegram(candidates?: Candidate[]): Promise<void> {
  if (!sink) return;
  const list = candidates ?? (await daemon.client.getCandidates());
  await sink.sync(list);
}

// ---- two lanes: regens must never wait behind a scan --------------------
// Each lane is serial with itself. Both mutate the same in-memory state
// object and append to the same candidate log, which is safe; the only
// shared write is state.json, saved whole by whichever finishes.
const lanes: Record<"regen" | "scan", Promise<void>> = { regen: Promise.resolve(), scan: Promise.resolve() };
// Busy marker: while ANY job runs (scan, regen, link draft, options), the
// in-progress file exists and scripts/deploy-vm.sh waits before restarting.
let busy = 0;
function markBusy(delta: number): void {
  busy = Math.max(0, busy + delta);
  try {
    if (busy > 0) writeFileSync(rt.paths.scanInProgress, `${process.pid} busy=${busy} ${new Date().toISOString()}\n`);
    else unlinkSync(rt.paths.scanInProgress);
  } catch {
    // best effort
  }
}
function enqueue(lane: "regen" | "scan", job: () => Promise<void>): void {
  lanes[lane] = lanes[lane]
    .then(async () => {
      markBusy(1);
      try {
        await job();
      } finally {
        markBusy(-1);
      }
    })
    .catch((err: unknown) => log.warn(`watch: ${lane} failed: ${err instanceof Error ? err.message : String(err)}`));
}

async function doRegen(): Promise<void> {
  const client = daemon.client;
  const regen = await runRegen({
    config: rt.config,
    llm: rt.llm,
    kb: rt.kb,
    policy: rt.policy,
    digest: rt.digest,
    experienceIndex: rt.experienceIndex,
    facts: rt.facts,
    factCachePath: rt.paths.factCache,
    candidateLog: rt.candidateLog,
    state: rt.state,
    getCandidates: () => client.getCandidates(),
    postCandidates: (cs) => client.postCandidates(cs),
    log,
    quietServed: true,
    instructions: guidedInstructions,
  });
  await syncTelegram().catch((err: unknown) => log.warn(`watch: telegram sync failed: ${(err as Error).message}`));
  if (regen.requested > 0 || regen.fills_recorded > 0) {
    saveScanState(rt.paths.state, rt.state);
    log.info(`watch: ${stamp()} regenerated ${regen.regenerated}/${regen.requested}${regen.failed ? ` (failed ${regen.failed})` : ""}${regen.fills_recorded ? `, ${regen.fills_recorded} fill(s) recorded` : ""}`);
  }
}

async function doScan(opts: { notifyTelegram?: boolean; scheduled?: boolean } = {}): Promise<void> {
  const now = new Date();
  const since = flags.since ? parseSince(flags.since, now) : computeSince(rt.state, rt.config.lookbackHours, now);
  const source = buildSource(rt, flags);
  // Re-read the watchlist every scan: additions take effect without a restart.
  try {
    rt.watchlist = await loadWatchlist(rt.paths.watchlist);
  } catch (err) {
    log.warn(`watch: could not reload watchlist (${(err as Error).message}); using the previous one`);
  }
  rt.state.last_scan_started_at = now.toISOString();
  saveScanState(rt.paths.state, rt.state);
  log.info(`watch: scan starting (since ${since.toISOString()})`);
  let summary: Awaited<ReturnType<typeof runScan>>;
  try {
    summary = await runScan(
    {
      config: rt.config,
      watchlist: rt.watchlist,
      source,
      llm: rt.llm,
      kb: rt.kb,
      policy: rt.policy,
      digest: rt.digest,
      experienceIndex: rt.experienceIndex,
      facts: rt.facts,
      factCachePath: rt.paths.factCache,
      themes: rt.themes,
      processed: rt.processed,
      candidateLog: rt.candidateLog,
      sink: { postCandidates: (cs) => daemon.client.postCandidates(cs) },
      log,
    },
    {
      since,
      dryRun: false,
      reprocess: flags.reprocess,
      ...(flags.handles ? { handles: flags.handles } : {}),
      ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
      // First-timers (never fetched before) get the lookback window once.
      knownHandles: new Set(Object.keys(rt.state.accounts_seen ?? {})),
      backfillSince: new Date(now.getTime() - rt.config.lookbackHours * 3600 * 1000),
    },
  );
  } finally {
    // busy marker is handled by enqueue()
  }
  {
    const seen = (rt.state.accounts_seen ??= {});
    for (const h of summary.accounts_fetched_ok) {
      const key = h.toLowerCase();
      if (seen[key] === undefined) seen[key] = now.toISOString();
    }
  }
  rt.state.last_scan_completed_at = new Date().toISOString();
  saveScanState(rt.paths.state, rt.state);
  scheduleNextScan(opts.scheduled ? "scheduled" : "manual");
  const report = writeScanReport(rt, summary);
  printCandidates(log, summary);
  log.info(`watch: scan done — ${summary.sent} sent, ${summary.llm.calls} LLM call(s), ~${summary.llm.cost_usd.toFixed(2)}; report ${report}`);
  if (summary.sent > 0) {
    const ids = new Map(summary.candidates.map((c) => [c.tweet_id, { lane: c.lane, move: c.move, theme: c.theme }] as const));
    await announceToTelegram(ids).catch((err: unknown) => log.warn(`watch: telegram announce failed: ${(err as Error).message}`));
  }
  // A scan you asked for from Telegram always reports back, even when the
  // answer is "nothing worth replying to"; otherwise it looks stuck.
  if (opts.notifyTelegram && tg) {
    const secs = Math.round((Date.now() - now.getTime()) / 1000);
    const held = inQuietHours(new Date(), rt.config.telegramQuietHours, rt.config.telegramTz) && summary.sent > 0;
    const line =
      summary.sent > 0
        ? `Scan done in ${secs}s: ${summary.posts_fetched} posts fetched, ${summary.unseen_posts} new, <b>${summary.sent} card(s)</b>${held ? " (held until morning)" : " above"}.`
        : `Scan done in ${secs}s: ${summary.posts_fetched} posts fetched, ${summary.unseen_posts} new, nothing worth replying to.`;
    await tg.client.sendMessage(tg.chatId, line).catch((err: unknown) => log.warn(`watch: telegram notify failed: ${(err as Error).message}`));
  }
  // --since / --reprocess apply to the first scan only; later scans are incremental.
  flags.since = undefined;
  flags.reprocess = false;
}

// ---- ♻️ clicks: debounced, one regen pass per burst ---------------------
let regenTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRegen(why: string): void {
  if (regenTimer !== null) clearTimeout(regenTimer);
  regenTimer = setTimeout(() => {
    regenTimer = null;
    log.info(`watch: ${stamp()} ${why}`);
    enqueue("regen", doRegen);
  }, 500);
}

// ---- daemon event stream ---------------------------------------------
async function listen(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/events`);
      if (!res.ok || res.body === null) throw new Error(`/events returned ${res.status}`);
      log.info("watch: listening for ♻️ clicks");
      // Anything clicked while we were disconnected is still pending in
      // the daemon; sweep it now rather than wait for the next event.
      enqueue("regen", doRegen);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          handleFrame(frame);
        }
      }
      throw new Error("event stream closed");
    } catch (err) {
      log.warn(`watch: event stream lost (${err instanceof Error ? err.message : String(err)}); reconnecting in 5s`);
      await new Promise((r) => setTimeout(r, 5_000));
      try {
        daemon = await connectDaemon(rt.config.daemonPort);
      } catch {
        // keep retrying
      }
    }
  }
}

// Primary pickup: a click is just a pending status in the daemon, and one
// local GET every few seconds costs nothing. It never triggers a model call
// unless something is actually pending, and it does not depend on the event
// stream arriving on time.
setInterval(() => enqueue("regen", doRegen), Math.max(2_000, sweepEveryMs));

function handleFrame(frame: string): void {
  const data = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trimStart())
    .join("\n");
  if (!data) return;
  type Ev = { type?: string; id?: string; tweet_id?: string; status?: string };
  let ev: Ev | null;
  try {
    ev = JSON.parse(data) as Ev | null;
  } catch {
    return;
  }
  if (ev?.type === "candidate_updated" && ev.status === "regen_requested" && typeof ev.id === "string" && ev.id.startsWith("chime-")) {
    scheduleRegen(`♻️ on ${ev.tweet_id ?? ev.id}`);
  } else if (ev?.type) {
    log.debug(`watch: event ${ev.type}${ev.tweet_id ? " " + ev.tweet_id : ""}${ev.status ? " " + ev.status : ""}`);
  }
}

// ---- Telegram: buttons and commands (long polling) ------------------------
async function pollTelegram(): Promise<void> {
  if (!tg || !sink) return;
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg.client.getUpdates(offset, 30);
      for (const u of updates) {
        offset = u.update_id + 1;
        const cb = u.callback_query;
        if (cb) {
          if (cb.message?.chat.id !== tg.chatId) {
            await tg.client.answerCallback(cb.id, "not your bot").catch(() => {});
            continue;
          }
          const optRegen = cb.data ? parseOptionRegenCallback(cb.data) : null;
          if (optRegen) {
            const pending = pendingOptions.get(optRegen.tweetId);
            if (!pending) {
              await tg.client.answerCallback(cb.id, "Those options expired. Send /options again.").catch(() => {});
              continue;
            }
            await tg.client.answerCallback(cb.id, `Redoing option ${optRegen.index}…`).catch(() => {});
            enqueue("regen", async () => {
              try {
                const i = optRegen.index - 1;
                const current = pending.options[i]!;
                const avoid = [...pending.history, ...pending.options.map((o) => o.text)];
                let fresh = await regenerateOption(pending.post, current.type, avoid, optionsDeps(), pending.instruction);
                if (similarity(fresh.text, current.text) > 0.7) {
                  // Paraphrase, not a redo. One more try with a firmer instruction.
                  fresh = await regenerateOption(pending.post, current.type, [...avoid, fresh.text], optionsDeps(), `${pending.instruction ? pending.instruction + ". " : ""}Take a genuinely different angle on the post; do not reuse the idea or the key words of the earlier attempts.`);
                }
                log.info(`watch: option ${optRegen.index} old: ${JSON.stringify(current.text.slice(0, 70))} → new: ${JSON.stringify(fresh.text.slice(0, 70))}`);
                pending.history.push(current.text);
                pending.options[i] = { ...fresh, redone: (current.redone ?? 0) + 1 };
                await tg.client.editMessage(tg.chatId, pending.messageId, formatOptionsMessage(pending.post, pending.options, pending.instruction), useKeyboard(pending.post.tweet_id, pending.options));
                persistOptions();
                log.info(`watch: ${stamp()} redid option ${optRegen.index} for ${optRegen.tweetId}`);
              } catch (err) {
                log.warn(`watch: option regen failed: ${(err as Error).message}`);
                await tg.client.sendMessage(tg.chatId, `Could not redo that option: ${(err as Error).message}`).catch(() => {});
              }
            });
            continue;
          }
          const use = cb.data ? parseUseCallback(cb.data) : null;
          if (use) {
            try {
              const msg = await useOption(use.tweetId, use.index);
              await tg.client.answerCallback(cb.id, msg);
            } catch (err) {
              log.warn(`watch: use option failed: ${(err as Error).message}`);
              await tg.client.answerCallback(cb.id, "Failed, see log").catch(() => {});
            }
            continue;
          }
          const parsed = cb.data ? parseCallback(cb.data) : null;
          if (!parsed) {
            await tg.client.answerCallback(cb.id).catch(() => {});
            continue;
          }
          const { action, tweetId } = parsed;
          try {
            if (action === "regen") {
              await daemon.client.postAction(tweetId, "regen_requested");
              const c = (await daemon.client.getCandidates()).find((x) => x.tweet_id === tweetId);
              await sink.markRegenerating(tweetId, c);
              await tg.client.answerCallback(cb.id, "Regenerating…");
              scheduleRegen(`♻️ from telegram on ${tweetId}`);
            } else if (action === "dismiss") {
              await daemon.client.postAction(tweetId, "dismissed");
              await tg.client.answerCallback(cb.id, "Dismissed");
              await syncTelegram();
            } else if (action === "posted") {
              await daemon.client.postAction(tweetId, "filled");
              await tg.client.answerCallback(cb.id, "Marked as posted");
              await syncTelegram();
            }
          } catch (err) {
            log.warn(`watch: telegram action ${action} failed: ${(err as Error).message}`);
            await tg.client.answerCallback(cb.id, "Failed, see log").catch(() => {});
          }
          continue;
        }
        const msg = u.message;
        if (!msg || msg.chat.id !== tg.chatId) continue;
        const text = (msg.text ?? "").trim();
        log.info(`watch: ${stamp()} telegram message ${msg.message_id}${msg.reply_to_message ? ` (reply to ${msg.reply_to_message.message_id} → ${sink.tweetIdForMessage(msg.reply_to_message.message_id) ?? "no card"})` : ""}: ${JSON.stringify(text.slice(0, 200))}`);
        // /options anywhere in the message (before or after the link), or as a reply to a card → three fast options.
        if (/(^|\s)\/options(@\w+)?(\s|$)/.test(text)) {
          const body = text.replace(/(^|\s)\/options(@\w+)?(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();
          const optLink = parseTweetUrl(body);
          const repliedCard = tweetIdFromRepliedMessage(msg.reply_to_message);
          const tweetId = optLink?.tweetId ?? repliedCard;
          if (!tweetId) {
            // Tapped from the command menu, which sends "/options" alone: arm the next link.
            awaitingOptionsLinkUntil = Date.now() + 5 * 60_000;
            await tg.client.sendMessage(tg.chatId, "Send me the post link (an instruction after it is optional) and I will return three options.").catch(() => {});
            continue;
          }
          const instruction = optLink ? instructionAfterUrl(body) : body || undefined;
          const reqId = newReqId();
          journal({ id: reqId, kind: "options", tweetId, instruction, ts: new Date().toISOString() });
          await tg.client.sendMessage(tg.chatId, "Three options coming… about 20 seconds.").catch(() => {});
          enqueue("regen", async () => {
            try {
              await runOptions({ tweetId }, instruction);
            } catch (err) {
              log.warn(`watch: /options failed: ${(err as Error).message}`);
              await tg.client.sendMessage(tg.chatId, `Could not build options: ${(err as Error).message}`).catch(() => {});
            } finally {
              markDone(reqId);
            }
          });
          continue;
        }
        // A pasted post link → draft a card for it, gates skipped (the person already decided).
        const link = /^\/(scan|status|pending|help|start)\b/.test(text) ? null : parseTweetUrl(text);
        if (link !== null && Date.now() < awaitingOptionsLinkUntil) {
          // The link that follows a bare /options.
          awaitingOptionsLinkUntil = 0;
          const instruction = instructionAfterUrl(text);
          await tg.client.sendMessage(tg.chatId, "Three options coming… about 20 seconds.").catch(() => {});
          enqueue("regen", async () => {
            try {
              await runOptions({ tweetId: link.tweetId }, instruction);
            } catch (err) {
              log.warn(`watch: /options failed: ${(err as Error).message}`);
              await tg.client.sendMessage(tg.chatId, `Could not build options: ${(err as Error).message}`).catch(() => {});
            }
          });
          continue;
        }
        if (link !== null) {
          const instruction = instructionAfterUrl(text);
          const reqId = newReqId();
          journal({ id: reqId, kind: "link", tweetId: link.tweetId, instruction, ts: new Date().toISOString() });
          await tg.client.sendMessage(tg.chatId, `Drafting a reply to that post${instruction ? ` (${instruction})` : ""}… about a minute.`).catch(() => {});
          enqueue("regen", () => draftFromLink(link.tweetId, instruction, reqId));
          continue;
        }
        // Reply to an options message with a sentence → redo all three options with that instruction.
        if (msg.reply_to_message !== undefined && text && !text.startsWith("/")) {
          const hit = [...pendingOptions.values()].find((p) => p.messageId === msg.reply_to_message!.message_id);
          if (hit) {
            const combined = [hit.instruction, text].filter((s): s is string => !!s && s.trim().length > 0).join(". ");
            await tg.client.sendMessage(tg.chatId, `Redoing all three (${combined})… about 20 seconds.`).catch(() => {});
            enqueue("regen", async () => {
              try {
                await runOptions({ tweetId: hit.post.tweet_id }, combined);
              } catch (err) {
                log.warn(`watch: /options redo failed: ${(err as Error).message}`);
                await tg.client.sendMessage(tg.chatId, `Could not redo the options: ${(err as Error).message}`).catch(() => {});
              }
            });
            continue;
          }
        }
        // Reply to a card with a sentence → regenerate that card with the sentence as the instruction.
        // (Replying to your own link message works too: if the post has no card yet, one is drafted with the instruction.)
        const repliedTo = msg.reply_to_message?.message_id;
        const target = repliedTo !== undefined ? tweetIdFromRepliedMessage(msg.reply_to_message) : null;
        if (target !== null && text && !text.startsWith("/") && !sink.has(target)) {
          await tg.client.sendMessage(tg.chatId, `Drafting a reply to that post (${text})… about a minute.`).catch(() => {});
          enqueue("regen", async () => {
            try {
              const post = await fetchTweetById(target);
              const r = await runSinglePost(post, { config: rt.config, llm: rt.llm, kb: rt.kb, themes: rt.themes, policy: rt.policy, digest: rt.digest, experienceIndex: rt.experienceIndex, facts: rt.facts, factCachePath: rt.paths.factCache, candidateLog: rt.candidateLog, postCandidates: (cs) => daemon.client.postCandidates(cs) }, text);
              const all = await daemon.client.getCandidates();
              const c = all.find((x) => x.tweet_id === target);
              if (c) await sink.announce([c], new Map([[target, { lane: r.grounding === "none" ? "conversational" : "expertise", move: r.move, theme: r.theme }]]));
            } catch (err) {
              log.warn(`watch: link draft failed: ${(err as Error).message}`);
              await tg.client.sendMessage(tg.chatId, `Could not draft for that link: ${(err as Error).message}`).catch(() => {});
            }
          });
          continue;
        }
        if (target !== null && text && !text.startsWith("/")) {
          try {
            guidedInstructions.set(target, text);
            const logged = rt.candidateLog.get(target);
            if (logged) rt.candidateLog.upsert({ ...logged, regen_instruction: text });
            await daemon.client.postAction(target, "regen_requested");
            const c = (await daemon.client.getCandidates()).find((x) => x.tweet_id === target);
            await sink.markRegenerating(target, c, text, msg.message_id);
            scheduleRegen(`guided ♻️ on ${target}: ${text.slice(0, 60)}`);
          } catch (err) {
            log.warn(`watch: guided regen failed: ${(err as Error).message}`);
            await tg.client.sendMessage(tg.chatId, "Could not start that regeneration, see the log.").catch(() => {});
          }
          continue;
        }
        if (/^\/scan\b/.test(text)) {
          await tg.client.sendMessage(tg.chatId, "Scanning… I will report back here when it finishes (a few minutes).");
          enqueue("scan", () => doScan({ notifyTelegram: true }));
        } else if (/^\/status\b/.test(text)) {
          const all = await daemon.client.getCandidates();
          const pending = all.filter((c) => c.status === "pending" || c.status === "regen_requested").length;
          const last = rt.state.last_scan_completed_at ?? "never";
          await tg.client.sendMessage(tg.chatId, `<b>Status</b>\npending cards: ${pending}\nlast scan: ${last}\nheld for morning: ${heldForMorning.size}\nscans: ${scanEveryMs > 0 ? `every ${Math.round(scanEveryMs / 60000)} min, next in ${nextScanAt > Date.now() ? Math.round((nextScanAt - Date.now()) / 60000) : 0} min` : "manual"}`);
        } else if (/^\/pending\b/.test(text)) {
          // Bring the queue to the bottom of the chat: newest N pending cards re-issued as fresh messages,
          // whether or not they were sent before. /pending 25 for more; default 10, cap 40.
          const all = await daemon.client.getCandidates();
          const queue = all.filter((c) => c.status === "pending" || c.status === "regen_requested").sort((a, b) => b.created_at.localeCompare(a.created_at));
          const asked = Number(/^\/pending\s+(\d+)/.exec(text)?.[1] ?? 10);
          const n = Math.min(Math.max(1, Number.isFinite(asked) ? asked : 10), 40);
          if (queue.length === 0) {
            await tg.client.sendMessage(tg.chatId, "Queue is empty: nothing pending.");
          } else {
            const batch = queue.slice(0, n);
            const oldest = queue[queue.length - 1]!.created_at.slice(0, 10);
            await tg.client.sendMessage(tg.chatId, `<b>${queue.length} pending</b> (oldest ${oldest}). Re-sending the newest ${batch.length}${queue.length > batch.length ? `; /pending ${Math.min(queue.length, 40)} for more` : ""}.`);
            await sink.resend(batch, new Map(batch.map((c) => [c.tweet_id, { lane: c.match_reason.startsWith("Lane: conversational") ? "conversational" : "expertise" }] as const)));
          }
        } else if (/^\/(help|start)\b/.test(text)) {
          await tg.client.sendMessage(
            tg.chatId,
            "<b>Reply in X</b> opens the composer with the reply prefilled under that post; you tap Post. <b>Open post</b> opens the tweet.\n<b>♻️ Regenerate</b> drafts a new reply and updates this message.\n<b>Reply to a card with a sentence</b> (swipe to reply) and it regenerates following your instruction: shorter, lead with X, less snarky, ask a question instead.\n<b>Paste a post link</b> (optionally followed by an instruction) and it drafts a card for that post, no filters.\n<b>/options &lt;link&gt;</b> (or /options as a reply to a card) gives three fast labeled options, irony / question / thinking out loud, with Use buttons; no knowledge base involved.\n<b>✅ Posted</b> marks it done after you post. <b>👎 Dismiss</b> hides it here and in Chrome.\n/scan runs a scan now and reports back. /pending re-sends the newest 10 queued cards here (/pending 25 for more). /status shows counts.",
          );
        }
      }
    } catch (err) {
      log.warn(`watch: telegram poll error: ${(err as Error).message}; retrying in 5s`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

// Held cards: deliver when quiet hours end.
if (tg) {
  setInterval(() => {
    if (heldForMorning.size === 0) return;
    if (inQuietHours(new Date(), rt.config.telegramQuietHours, rt.config.telegramTz)) return;
    const ids = new Map(heldForMorning);
    heldForMorning.clear();
    void announceToTelegram(ids).catch((err: unknown) => log.warn(`watch: telegram morning flush failed: ${(err as Error).message}`));
  }, 60_000);
}

// ---- replay requests interrupted by a restart -----------------------------
if (tg && sink) {
  const pending = unfinishedRequests();
  if (pending.length > 0) {
    log.info(`watch: replaying ${pending.length} interrupted request(s)`);
    void tg.client.sendMessage(tg.chatId, `Resuming ${pending.length} request(s) interrupted by a restart…`).catch(() => {});
    for (const r of pending) {
      if (r.kind === "link") enqueue("regen", () => draftFromLink(r.tweetId, r.instruction, r.id));
      else if (r.kind === "options")
        enqueue("regen", async () => {
          try {
            await runOptions({ tweetId: r.tweetId }, r.instruction);
          } catch (err) {
            log.warn(`watch: /options replay failed: ${(err as Error).message}`);
          } finally {
            markDone(r.id);
          }
        });
    }
  }
}

// ---- go ---------------------------------------------------------------
enqueue("regen", doRegen); // serve anything already pending
// With an interval set, scan at start only if the last completed scan is
// older than the interval. A service restart must not trigger a fresh scan.
const lastDone = rt.state.last_scan_completed_at ? Date.parse(rt.state.last_scan_completed_at) : 0;
const overdue = scanEveryMs > 0 && Date.now() - lastDone > scanEveryMs;
if (scanNow || overdue) enqueue("scan", doScan);
else if (scanEveryMs > 0) log.info(`watch: last scan completed ${rt.state.last_scan_completed_at}; next in ${Math.max(1, Math.round((scanEveryMs - (Date.now() - lastDone)) / 60000))} min`);
// The schedule is "one interval after the last completed scan", whichever
// kind it was: a manual /scan or a pasted-link run resets the clock, so the
// next scheduled scan is never a near-duplicate of one you just asked for.
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let nextScanAt = 0;
const RESET_WINDOW_MS = 20 * 60_000;
/**
 * Scheduled scans keep their cadence. A manual scan (/scan, or a run you
 * asked for) resets the clock only when the next scheduled scan is within
 * 20 minutes, since that one would be a near-duplicate; otherwise the
 * cadence stands.
 */
function scheduleNextScan(kind: "scheduled" | "manual" = "scheduled"): void {
  if (scanEveryMs <= 0) return;
  const now = Date.now();
  if (kind === "manual" && nextScanAt > now && nextScanAt - now > RESET_WINDOW_MS) {
    log.info(`watch: manual scan done; keeping the cadence, next scheduled scan in ${Math.round((nextScanAt - now) / 60000)} min`);
    return;
  }
  if (scanTimer !== null) clearTimeout(scanTimer);
  const last = rt.state.last_scan_completed_at ? Date.parse(rt.state.last_scan_completed_at) : 0;
  const wait = Math.max(60_000, scanEveryMs - (now - last));
  nextScanAt = now + wait;
  scanTimer = setTimeout(() => {
    enqueue("scan", () => doScan({ scheduled: true }));
  }, wait);
  log.info(`watch: next scheduled scan in ${Math.round(wait / 60000)} min${kind === "manual" ? " (clock reset: the scheduled one was within 20 min)" : ""}`);
}
if (scanEveryMs > 0 && !(scanNow || overdue)) scheduleNextScan();
void listen();
void pollTelegram();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("watch: stopping");
    removeWatcherPid(rt.paths);
    process.exit(0);
  });
}
process.on("exit", () => removeWatcherPid(rt.paths));
