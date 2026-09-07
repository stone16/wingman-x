/** Replacement KB: candidate profile, new library. Variant current = frozen digest; variant proposed = companion digest from the replacement bundle. Real runScan controller, 31 posts. */
import "../../../scripts/load-env.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRuntime, parseFlags } from "../src/cli/bootstrap.js";
import { NormalizedPostSchema, type NormalizedPost } from "../src/model/post.js";
import { runScan, type ScanDeps } from "../src/pipeline/scan.js";
import { createMemoryCandidateLog } from "../src/state/candidate-log.js";
import { createMemoryProcessedStore } from "../src/state/processed-store.js";
const OUT = "/private/tmp/claude-501/-Users-uditbhansali-Desktop-Chime-In/6da9911a-f570-42ac-8bf8-3b03ad28adff/scratchpad/exp";
const rt = await buildRuntime({ ...parseFlags([]), dryRun: true }, { needWatchlist: true });
const load = (f: string, fresh: boolean) => readFileSync(join(OUT, f), "utf8").trim().split("\n").map((l) => { const o = JSON.parse(l); return { post: NormalizedPostSchema.parse(o.post) as NormalizedPost, theme: o.theme_hint as string, fresh }; });
const rows = [...load("posts.jsonl", false), ...load("posts-fresh.jsonl", true), ...load("posts-finance5.jsonl", true)];
const posts = rows.map((r) => r.post);
const results: Record<string, any> = {};
const proposed = readFileSync("/private/tmp/claude-501/-Users-uditbhansali-Desktop-Chime-In/6da9911a-f570-42ac-8bf8-3b03ad28adff/scratchpad/kb_replacement/companion/beliefs-digest.md", "utf8");
for (const variant of ["current", "proposed"] as const) { const profile = "candidate" as const;
  const posted: any[] = [];
  const deps = {
    config: { ...rt.config, promptProfile: profile },
    watchlist: rt.watchlist,
    source: { name: "compare", fetchPosts: async () => ({ source: "compare", posts, accounts: posts.map((p) => ({ handle: p.author_handle, ok: true, posts: 1 })), raw_count: posts.length }) },
    llm: rt.llm, kb: rt.kb, themes: rt.themes, policy: rt.policy, digest: variant === "current" ? rt.digest : proposed, experienceIndex: rt.experienceIndex, facts: rt.facts,
    processed: createMemoryProcessedStore(), candidateLog: createMemoryCandidateLog(), state: { regen_handled: {}, accounts_seen: {} },
    sink: { postCandidates: async (cs: unknown[]) => { posted.push(...cs); return { accepted: cs.length }; } },
    log: rt.log,
  } as unknown as ScanDeps;
  const t0 = Date.now();
  const summary = await runScan(deps, { since: new Date("2026-09-01T00:00:00Z"), dryRun: false, reprocess: true });
  console.log(`digest ${variant}: sent ${summary.sent}, ${Math.round((Date.now() - t0) / 1000)}s`);
  for (const p of posts) {
    const o = summary.outcomes.find((x) => x.tweet_id === p.tweet_id);
    const c = posted.find((x) => x.tweet_id === p.tweet_id);
    results[p.tweet_id] ??= {};
    results[p.tweet_id][variant] = c ? { decision: "reply", reply: c.suggested_reply, flags: c.ai_tell_flags ?? [], match_reason: c.match_reason } : { decision: o?.decision === "filtered" ? "skip" : (o?.decision ?? "unknown"), skip_reason: o?.reason ?? "", stage: o?.stage };
  }
}
const out = rows.map((r) => ({ tweet_id: r.post.tweet_id, author: r.post.author_handle, theme: r.theme, fresh: r.fresh, text: r.post.tweet_text, quoted: r.post.quoted_tweet ? `@${r.post.quoted_tweet.author_handle}: ${r.post.quoted_tweet.text}` : null, A: results[r.post.tweet_id]!.current, B: results[r.post.tweet_id]!.proposed }));
writeFileSync(join(OUT, "results-replacement.jsonl"), out.map((r) => JSON.stringify(r)).join("\n") + "\n");
const key: Record<string, { col1: string; col2: string }> = {};
const md = ["# Replacement KB: frozen digest vs companion digest (candidate profile, new library), 31 posts", "", "Same code and same everything else; only the beliefs digest differs. Real runScan controller with reconsideration and skipping. Column order random per post.", "", "## Decisions", "", "| # | Post | Column 1 | Column 2 |", "|---|---|---|---|"];
out.forEach((r, i) => { const flip = Math.random() < 0.5; key[r.tweet_id] = { col1: flip ? "B" : "A", col2: flip ? "A" : "B" }; const c1 = flip ? r.B : r.A, c2 = flip ? r.A : r.B; md.push(`| ${i + 1} | @${r.author}${r.fresh ? " (fresh)" : ""} | ${c1.decision} | ${c2.decision} |`); });
md.push("", "## Replies", "");
out.forEach((r, i) => { const k = key[r.tweet_id]!; const c1 = k.col1 === "A" ? r.A : r.B, c2 = k.col2 === "A" ? r.A : r.B; const txt = (x: any) => x.decision === "skip" ? `_(skipped: ${(x.skip_reason || "").slice(0, 160)})_` : x.reply + (x.flags?.length ? `\n\n_flags: ${x.flags.join("; ")}_` : ""); md.push(`### ${i + 1}. @${r.author} · ${r.theme}${r.fresh ? " · fresh" : ""}`, "", `> ${r.text.replace(/\n+/g, "\n> ")}`); if (r.quoted) md.push(">", `> *quoting* ${r.quoted.replace(/\n+/g, " ")}`); md.push("", "**Column 1**", "", txt(c1), "", "**Column 2**", "", txt(c2), "", "**Post:** 1 / 2 / both / neither  **Edit needed:** ___  **Factual issues:** ___", "", "---", ""); });
writeFileSync(join(OUT, "blind-replacement.md"), md.join("\n")); writeFileSync(join(OUT, "key-replacement.json"), JSON.stringify(key, null, 2));
console.log("done");
