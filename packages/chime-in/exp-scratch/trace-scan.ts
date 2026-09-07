/** Full scan-path traces (reconsideration, bar, drop-on-none included) for Maple and Stacy under both profiles. Every model call captured. Nothing persisted. */
import "../../../scripts/load-env.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRuntime, parseFlags } from "../src/cli/bootstrap.js";
import { NormalizedPostSchema, type NormalizedPost } from "../src/model/post.js";
import { runScan, type ScanDeps } from "../src/pipeline/scan.js";
import { createMemoryCandidateLog } from "../src/state/candidate-log.js";
import { createMemoryProcessedStore } from "../src/state/processed-store.js";
import type { LLMProvider } from "../src/llm/provider.js";
const OUT = "/private/tmp/claude-501/-Users-uditbhansali-Desktop-Chime-In/6da9911a-f570-42ac-8bf8-3b03ad28adff/scratchpad/exp";
const IDS = ["2095192834039267738", "2095780156757656035"];
const rt = await buildRuntime({ ...parseFlags([]), dryRun: true }, { needWatchlist: true });
const rows = readFileSync(join(OUT, "posts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => IDS.includes(r.post.tweet_id));
const posts: NormalizedPost[] = rows.map((r) => NormalizedPostSchema.parse(r.post));
const out: any[] = [];
for (const profile of ["baseline", "candidate"] as const) {
  const calls: any[] = [];
  const llm: LLMProvider = { ...rt.llm, complete: async (req) => { const res = await rt.llm.complete(req); calls.push({ label: req.label, tier: req.tier, system: req.system, prompt: req.prompt, response: res }); return res; } };
  const posted: any[] = [];
  const deps: ScanDeps = {
    config: { ...rt.config, promptProfile: profile },
    watchlist: rt.watchlist,
    source: { name: "trace", fetchPosts: async () => ({ source: "trace", posts, accounts: posts.map((p) => ({ handle: p.author_handle, ok: true, posts: 1 })), raw_count: posts.length }) } as never,
    llm,
    kb: rt.kb,
    themes: rt.themes,
    policy: rt.policy,
    digest: rt.digest,
    experienceIndex: rt.experienceIndex,
    facts: rt.facts,
    processed: createMemoryProcessedStore(),
    candidateLog: createMemoryCandidateLog(),
    state: { regen_handled: {}, accounts_seen: {} } as never,
    sink: { postCandidates: async (cs: unknown[]) => { posted.push(...cs); return { accepted: cs.length }; } },
    log: rt.log,
  } as unknown as ScanDeps;
  const summary = await runScan(deps, { since: new Date("2026-09-01T00:00:00Z"), dryRun: false, reprocess: true });
  for (const p of posts) {
    const outcome = summary.outcomes.find((o) => o.tweet_id === p.tweet_id);
    const card = posted.find((c) => c.tweet_id === p.tweet_id);
    const mine = calls.filter((c) => (c.label ?? "").includes(p.tweet_id) || (c.label ?? "").startsWith("theme") || c.label === "resolve:notes");
    out.push({ author: p.author_handle, tweet_id: p.tweet_id, profile, mode: "scan", priority: rt.watchlist.find((w) => w.handle.toLowerCase() === p.author_handle.toLowerCase())?.priority ?? 2, outcome, card: card ? { suggested_reply: card.suggested_reply, match_reason: card.match_reason, flags: card.ai_tell_flags ?? [], kb_refs: card.kb_refs } : null, calls: mine });
    console.log(`@${p.author_handle} ${profile}: ${outcome?.decision} ${outcome?.stage}${outcome?.reason ? " | " + outcome.reason.slice(0, 90) : ""} | calls ${mine.map((c) => c.label.split(":")[0]).join(",")}${card ? "\n   → " + card.suggested_reply + (card.ai_tell_flags?.length ? "  [" + card.ai_tell_flags.join("; ").slice(0, 120) + "]" : "") : ""}`);
  }
}
writeFileSync(join(OUT, "traces-scan-path-both-profiles.json"), JSON.stringify(out, null, 1));
console.log("written");
