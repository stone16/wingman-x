import { readFileSync, writeFileSync } from "node:fs";
import { NormalizedPostSchema } from "../src/model/post.js";
import { expandTruncated } from "../src/sources/full-text.js";
const OUT = "/private/tmp/claude-501/-Users-uditbhansali-Desktop-Chime-In/6da9911a-f570-42ac-8bf8-3b03ad28adff/scratchpad/exp";
for (const f of ["posts.jsonl", "posts-fresh.jsonl", "posts-finance5.jsonl"]) {
  const rows = readFileSync(`${OUT}/${f}`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const posts = rows.map((r) => NormalizedPostSchema.parse(r.post));
  const n = await expandTruncated(posts);
  rows.forEach((r, i) => { r.post = posts[i]; });
  writeFileSync(`${OUT}/${f}`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(f, "expanded", n, posts.filter((p) => p.tweet_text.length > 280).map((p) => `@${p.author_handle} ${p.tweet_text.length}`).join(", "));
}
