# Chime In — X expertise reply assistant

Finds the few posts each day where *your* knowledge gives you something
worth adding, drafts a reply in your voice, and hands it to the Wingman-X
Chrome extension for you to review, edit, and post yourself.

This is not a reply bot. Zero candidates is a valid result. Nothing is
ever posted automatically.

```text
watchlist.csv ──▶ Apify (PostSource) ──▶ normalise ──▶ dedupe (processed.jsonl)
      ──▶ mechanical filters ──▶ theme (cheap model, discovery label only)
      ──▶ reason (strong model + beliefs digest + experience index: worth, move, depth, posture, energy, grounding)
      ──▶ gate on WORTH_THRESHOLD ──▶ rank ──▶ ground (library / approved experience / dated fact archive, only as asked)
      ──▶ draft (tone.md; reason freely, source every specific) ──▶ verify (cheap model; one repair, then `unverified:` flags)
      ──▶ POST /candidates
      ──▶ Wingman extension: review → open post → fill composer → you press Post
```

Wingman's daemon, extension, candidate schema, and KB layout are used
unchanged. The only edits to Wingman are: this package added to the
workspace list, four root scripts, one export line in `agent-kit`
(`detectAiTells`), and a Chime In section in `.env.template`.

## Setup (once)

```bash
# from the wingman-x repo root
npm install && npm run build:no-bump          # workspace packages resolve via dist/
cp .env.template .env                          # then edit: APIFY_TOKEN at minimum
npm run kb:init                                # seeds ~/.wingman-x/kb + watchlist + themes
```

Then:

1. **Edit the knowledge base** at `~/.wingman-x/kb/`. `tone.md` is the
   drafting system prompt; `library/*.md` is what you know and believe.
   Sections marked `DRAFT` are generic framing — confirm, sharpen, or
   delete. The model only cites what is written there and never claims
   experience that is not.
2. **Fill the watchlist** at `~/.wingman-x/chime-in/watchlist.csv`
   (`handle,priority,category,notes`; only `handle` is required;
   priority 1 = important, 2 = normal, 3 = peripheral).
3. **Start the daemon** in its own terminal and load the extension
   (see the root README): `npm --workspace @wingman-x/daemon run dev`.

## Running a scan

```bash
npm run scan                         # fetch → score → draft → send to Wingman
npm run scan -- --dry-run            # full pipeline, sends nothing, marks nothing processed
npm run scan -- --handles a,b        # subset of the watchlist
npm run scan -- --since 12h          # override the lookback
npm run scan -- --reprocess          # ignore the processed log
npm run scan -- --fixture dump.json  # scan a saved Apify dump instead of calling Apify
npm run regen                        # only serve ♻️ regeneration requests
npm run watch                        # foreground watcher: serve ♻️ clicks within seconds (add --scan-every 30m to also scan)
npm run watch:stop                   # stop the background watcher that `npm run scan` starts
npm run apify:probe -- --handles a,b --max 10   # one small actor run; saves the raw dump
npm run kb:sync-substack             # save new Substack essays to kb/sources/substack/ (memory, not retrieved)
npm run kb:sync-x -- --handle you    # save an account's X history to kb/sources/x/ (source material for tone.md)
```

### Knowledge base layout

```text
~/.wingman-x/kb/
  tone.md            canonical reply voice: behaviors, register, avoid-list, do-not-reply-when, calibration examples
  library/*.md       claim-first topic files (what I believe / differentiated view / why / first-hand / reply angles / boundaries / time-sensitive refs)
  library/boundaries.md   hard constraints; excluded from retrieval, injected into contribution + draft prompts
  sources/           full essays and X history used to write the above; never read at scan time
```

Wingman's adapter reads only `tone.md` and `library/*.md`, so `sources/` is free
recalibration material. Voice comes from X history (replies teach conversational
phrasing; quote posts teach reaction). Beliefs come from essays and experience.
Keep them separate: a reply is one move, not a miniature essay.

Every scan prints a funnel summary and writes a full JSON report to
`~/.wingman-x/chime-in/scans/`, including every filtered post with its
scores and the model's reason — the raw material for tuning thresholds.

```text
Starting scan
137 accounts requested (source: apify:apidojo/twitter-scraper-lite:search, since …)
134 accounts successfully fetched
3 account failures
186 posts fetched (240 raw items)
186 unseen posts
142 removed by basic filters (reposts 60, replies 70, empty 4, spam 8)
44 theme candidates
16 expertise candidates
5 contribution candidates
5 replies drafted
5 candidates sent to Wingman
```

## Regeneration

### Watch mode

`npm run watch` is the always-on mode. It subscribes to the daemon's event
stream and runs a regen within seconds of a ♻️ click (the daemon publishes
`candidate_updated` on every status change and redraft). You rarely need to
start it yourself: `npm run scan` starts a background watcher if none is
running (pid in `watch.pid`, output in `watch.log`; `--no-watch` to skip;
`npm run watch:stop` to end it). Scans stay manual
unless you pass `--scan-every 30m` (first scan at start) or `--scan-now`.
Regens and scans run in separate lanes, so a click is never stuck behind a scan.
The extension's background worker relays the same events to the popup and to
open x.com tabs, so a regenerated reply or a new card appears in place without
a reload. Stop with Ctrl+C; register it with launchd if you want it at login.

Pressing ♻️ in the extension sets the candidate's status to
`regen_requested`. Nothing in Wingman consumes that; every `npm run scan`
(and `npm run regen`) does. The scan pre-drafts `DRAFT_VARIANTS` shapes of
each reply (same move, different construction) and stores the unshown ones
in `candidates.jsonl`; the first ♻️ clicks serve those instantly. Once they
are used up, a plain ♻️ re-runs the reasoning stage with every earlier
contribution excluded, so the next draft makes a different point rather
than reshaping the same one; a reply-with-instruction re-runs it with the
instruction and the earlier contributions in view. The new contribution is
grounded fresh, drafted, verified, and re-POSTed. The daemon's merge keeps the candidate's status, so we
remember which click we served.

## Configuration

All settings are environment variables (see `.env.template`). The ones
that matter most:

| Variable | Default | Purpose |
|---|---|---|
| `APIFY_TOKEN` | — | required unless using `--fixture` |
| `APIFY_ACTOR` | `apidojo/twitter-scraper-lite` | any actor with the apidojo output shape |
| `APIFY_MODE` | `search` | `search` (batched `from:` queries, cheap, date-bounded) or `handles` (profile timelines) |
| `MAX_POSTS_PER_ACCOUNT` | 10 | |
| `INCLUDE_REPLIES` / `INCLUDE_REPOSTS` | false | |
| `SCAN_LOOKBACK_HOURS` | 36 | first scan / fallback window |
| `THEME_THRESHOLD` | 60 | discovery gate, 0–100; the theme is a label, not a lane |
| `WORTH_THRESHOLD` | 70 | the one quality gate: would the person plausibly post the response? Casual moves on organization feeds (priority 3) need +10. `EXPERTISE_THRESHOLD` / `CONTRIBUTION_THRESHOLD` are still parsed but unused |
| `MAX_CANDIDATES_PER_SCAN` | 0 (no cap) | optional ceiling on drafted candidates; by default everything above the threshold is drafted and you decide in the Dock |
| always-present context | `kb/beliefs-digest.md`, `kb/experience-index.md` | the person's working views and where firsthand grounding exists; read on every reasoning call. `kb/library/identity_and_boundaries.md` is the only source for first-person claims and is consulted on demand; `kb/sources/research-notes.md` is the dated fact archive; resolved facts cache in `<chimeDir>/verified_facts.jsonl`. Nothing is ever appended to the identity file automatically |
| `npm run link -- <url> [instruction] [--dry-run]` | | draft one post by link from the shell, the same path as pasting a link into Telegram (no worth gate, `none` not allowed) |
| `DRAFT_VARIANTS` | 1 | drafts per candidate; set 2–5 to pre-draft alternates that ♻️ serves with no model call |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | unset | watch mode sends one Telegram message per card: Open in X (compose intent, you tap Post), ♻️ Regenerate (edits in place), ✅ Posted, 👎 Dismiss; `/scan`, `/status`, and `/pending [n]` (re-sends the newest n queued cards to the bottom of the chat) commands |
| `TELEGRAM_QUIET_HOURS` / `TELEGRAM_TZ` | unset / America/Chicago | hold cards overnight, e.g. `23-8` |
| `CONVERSATIONAL_THEMES` / `CONVERSATIONAL_STRICT_THEMES` / `CONVERSATIONAL_THRESHOLD` / `MAX_CONVERSATIONAL_CANDIDATES` | | legacy of the two-lane engine (removed 2026-09-05); still parsed, no effect. `kb/conversational.md` remains the casual-reply policy handed to the reasoning and drafting prompts |
| `LLM_PROVIDER` | `auto` | `claude-cli`, `codex-cli`, `anthropic` |
| `LLM_MODEL_CHEAP` / `STRONG` / `DRAFT` | provider defaults | per-tier model override |

### Model hosts

The pipeline talks to an `LLMProvider` interface. Three backends ship:

- **claude-cli** — `claude -p` with tools disabled and `--json-schema`
  structured output. Uses your Claude Code subscription. Default when
  no API key is set. Defaults: cheap=haiku, strong=sonnet, draft=sonnet.
- **codex-cli** — `codex exec` read-only with `--output-schema`. Uses
  your ChatGPT login.
- **anthropic** — Messages API over `fetch`; picked automatically when
  `ANTHROPIC_API_KEY` is set.

### Apify actors

Any actor emitting the `apidojo/*` tweet shape (or the simpler
feed-scraper shape) works; the normaliser is tolerant and drops anything
it cannot map. `search` mode ORs up to `APIFY_HANDLES_PER_QUERY` handles
into one `from:` query with `since:` and `-filter:replies -filter:retweets`,
so a 150-handle list costs about 13 queries. `handles` mode uses
`twitterHandles` and is more complete but cannot date-filter server-side.
Run `npm run apify:probe` once to see real output and cost before a full scan.

## State

Everything lives under `~/.wingman-x/chime-in/` (override with `CHIME_IN_DIR`):

| File | Purpose |
|---|---|
| `watchlist.csv` | accounts to scan |
| `themes.txt` | theme list for the classifier (optional; defaults built in) |
| `processed.jsonl` | append-only decision log: `tweet_id, first_seen_at, processed_at, decision, stage, reason, scores`. Written the moment a decision is final, so a crashed scan never marks undecided posts. Posts that hit an error are not recorded and are retried next scan. |
| `candidates.jsonl` | full context for every candidate sent (theme, angle, KB refs, replies) — used for regeneration and future learning |
| `state.json` | last scan time, regen requests served |
| `scans/*.json` | one report per scan |

## Replacing Apify

Implement `PostSource` (`src/sources/post-source.ts`):

```ts
interface PostSource {
  name: string;
  fetchPosts(accounts: WatchAccount[], since: Date, opts: FetchOptions): Promise<FetchPostsResult>;
}
```

Return `NormalizedPost[]` plus a per-account status list. Nothing after
ingestion changes. An X Filtered Stream adapter is the intended Phase 2.

## Tests

```bash
npm --workspace @wingman-x/chime-in test        # hermetic: fake LLM + fixture source
npm --workspace @wingman-x/chime-in run typecheck
```

Covered: Apify normalisation (both shapes, padding items, RT/reply
inference), query building and client-side bounds, watchlist parsing,
the durable processed log, the whole scan funnel (dedupe, thresholds,
ranking cap, error retry semantics, dry run, failed POST), candidate
mapping validated against Wingman's own schema, and regeneration.
