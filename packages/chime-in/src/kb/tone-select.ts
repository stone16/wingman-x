import { selectSections } from "./sections.js";
import type { ReasonMove } from "../pipeline/stages/reason.js";

/**
 * Progressive loading of tone.md for one draft, following the skills pattern: the short
 * canonical rules always, the person's own approved replies always, and from the borrowed
 * exchanges only the few whose mechanics match the move being written. The parent posts
 * travel with the selected exchanges only.
 *
 * Exchanges in tone.md look like:
 *   @handle, date, label:
 *   Post by @author: "..."
 *   > reply
 * separated by blank lines under "## Real exchanges".
 */
const ALWAYS = ["Who is speaking", "How it reads", "Approved replies", "Udit's replies", "Drift to catch"];

/** Which borrowed-exchange labels illustrate which move. Substrings, case-insensitive. */
const MOVE_LABELS: Record<ReasonMove, string[]> = {
  agree_extend: ["concede then add", "yes plus the mechanism", "credit with a reason"],
  distinction: ["distinction", "narrowing", "two real options"],
  challenge: ["deny the conclusion", "credit fast, then narrow", "credit with a reason"],
  question: ["thinking out loud", "light reaction"],
  example: ["number then what it means", "one number"],
  operator_context: ["concede then add", "narrowing"],
  light_reaction: ["light reaction", "split verdict", "one number"],
  irony: ["light reaction", "split verdict"],
  thinking_out_loud: ["thinking out loud", "concede then add"],
  none: [],
};

export interface ToneSelection {
  text: string;
  /** Labels of the borrowed exchanges included, for logging. */
  examples: string[];
}

export function parseExchanges(section: string): Array<{ label: string; block: string }> {
  const body = section.replace(/^## [^\n]*\n/, "");
  return body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => /^@\w+, /.test(b))
    .map((block) => {
      const first = block.split("\n")[0] ?? "";
      const label = first.replace(/^@\w+, [^,]*, /, "").replace(/:$/, "").trim();
      return { label, block };
    });
}

export function toneForDraft(tone: string, move: ReasonMove | undefined, maxExamples = 3): ToneSelection {
  const core = selectSections(tone, ALWAYS);
  const exchangesSection = selectSections(tone, ["Real exchanges", "Real replies"]);
  const all = parseExchanges(exchangesSection);
  const wanted = (move ? MOVE_LABELS[move] : []).map((s) => s.toLowerCase());
  const picked: typeof all = [];
  for (const w of wanted) for (const e of all) if (picked.length < maxExamples && !picked.includes(e) && e.label.toLowerCase().includes(w)) picked.push(e);
  const examples = picked.length > 0 ? ["## Borrowed exchanges that match this move (mechanics only, stances theirs)", "", ...picked.map((p) => p.block)].join("\n") : "";
  // Keep the person's own replies ahead of the borrowed ones in the assembled text.
  const ordered = core.split(/^(?=## )/m);
  const own = ordered.filter((s) => /^## (Approved replies|Udit's replies)/.test(s));
  const rest = ordered.filter((s) => !/^## (Approved replies|Udit's replies)/.test(s));
  const text = [...rest.filter((s) => !/^## Drift/.test(s)), ...own, ...(examples ? [examples] : []), ...rest.filter((s) => /^## Drift/.test(s))].join("\n\n").trim();
  return { text, examples: picked.map((p) => p.label) };
}
