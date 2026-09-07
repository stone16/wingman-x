/** Pick named "## " sections out of a markdown file, in the file's order. Heading match is case-insensitive prefix. */
export function selectSections(markdown: string, headings: readonly string[]): string {
  const wanted = headings.map((h) => h.toLowerCase());
  const parts = markdown.split(/^(?=## )/m);
  const out: string[] = [];
  for (const part of parts) {
    const m = /^## ([^\n]+)\n/.exec(part);
    if (!m) continue;
    const title = m[1]!.trim().toLowerCase();
    if (wanted.some((w) => title.startsWith(w))) out.push(part.trim());
  }
  return out.join("\n\n");
}
