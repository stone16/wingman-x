import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Policy for /options (the twitter-reply skill, adapted). Lives at `<kb>/options.md`, outside `library/`, never retrieved. */
export const DEFAULT_OPTIONS_POLICY = `# Options mode

Three fast, labeled reply options: irony, question, thinking-out-loud. One or two sentences each. Match the energy of the post. Humor beats insight beats agreement. No praise openers, no sycophancy, no dashes, no rule of three, no "not X, it's Y". Never invent a number, name, date, quote, or event; a "context" option may replace one type only when the fact comes from the post or thread. Don't plug anything.
`;

export function loadOptionsPolicy(stateDir: string): { text: string; source: "file" | "default" } {
  const p = join(stateDir, "kb", "options.md");
  if (existsSync(p)) {
    const text = readFileSync(p, "utf8");
    if (text.trim()) return { text, source: "file" };
  }
  return { text: DEFAULT_OPTIONS_POLICY, source: "default" };
}
