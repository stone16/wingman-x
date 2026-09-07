#!/usr/bin/env tsx
/**
 * `npm run link -- <x.com status url> [instruction...]` — draft a reply for one
 * post by link, exactly as pasting the link into Telegram would: no worth gate,
 * same reasoning, grounding, drafting, and verification. Posts to the daemon
 * (the watcher's sweep announces it to Telegram) and prints the result.
 *   --dry-run   print only; do not post or log
 */
import "../../../scripts/load-env.mjs";
import { runSinglePost } from "../src/pipeline/single.js";
import { fetchTweetById, parseTweetUrl, instructionAfterUrl } from "../src/sources/single-tweet.js";
import { connectDaemon } from "../src/wingman/daemon.js";
import { buildRuntime, parseFlags } from "../src/cli/bootstrap.js";
import { createMemoryCandidateLog } from "../src/state/candidate-log.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const text = argv.filter((a) => a !== "--dry-run").join(" ");
  const parsed = parseTweetUrl(text);
  if (!parsed) {
    process.stderr.write("usage: npm run link -- <x.com/…/status/ID> [instruction] [--dry-run]\n");
    process.exit(2);
  }
  const instruction = instructionAfterUrl(text);
  const flags = parseFlags([]);
  const rt = await buildRuntime({ ...flags, dryRun }, { needWatchlist: false });
  const post = await fetchTweetById(parsed.tweetId);
  rt.log.info(`@${post.author_handle}: ${post.tweet_text.replace(/\s+/g, " ").slice(0, 200)}${post.thread.length ? ` (thread: ${post.thread.length} above)` : ""}`);
  const postCandidates = dryRun
    ? async (cs: unknown[]) => ({ accepted: cs.length })
    : await connectDaemon(rt.config.daemonPort).then((d) => (cs: Parameters<typeof d.client.postCandidates>[0]) => d.client.postCandidates(cs));
  const r = await runSinglePost(
    post,
    {
      config: rt.config,
      llm: rt.llm,
      kb: rt.kb,
      themes: rt.themes,
      policy: rt.policy,
      digest: rt.digest,
      experienceIndex: rt.experienceIndex,
      facts: rt.facts,
      factCachePath: rt.paths.factCache,
      candidateLog: dryRun ? createMemoryCandidateLog() : rt.candidateLog,
      postCandidates,
    },
    instruction,
  );
  rt.log.info("");
  rt.log.info(`theme ${r.theme} · move ${r.move} · grounding ${r.grounding}`);
  rt.log.info(r.candidate.match_reason);
  if (r.candidate.ai_tell_flags?.length) rt.log.info(`flags: ${r.candidate.ai_tell_flags.join(", ")}`);
  rt.log.info("");
  rt.log.info(r.reply);
  if (dryRun) rt.log.info("(dry run: not posted, not logged)");
}

main().catch((err: unknown) => {
  process.stderr.write(`link failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
