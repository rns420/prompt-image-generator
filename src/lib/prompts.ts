export type ParsedPrompt = { number: number; prompt: string };

/**
 * Parses a prompt list where every prompt carries a number.
 * Supported line starts: "65.", "65)", "65 -", "65:", "Prompt 65:", "#65".
 * Continuation lines are appended to the previous prompt.
 */
export function parsePrompts(text: string): ParsedPrompt[] {
  const lines = text.split(/\r?\n/);
  const out: ParsedPrompt[] = [];
  const header = /^\s*(?:prompt\s*)?#?\s*(\d{1,4})\s*[.)\-:—]\s*(.*)$/i;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(header);
    if (m) {
      out.push({ number: Number(m[1]), prompt: (m[2] ?? "").trim() });
    } else if (out.length) {
      const last = out[out.length - 1]!;
      last.prompt = `${last.prompt} ${line}`.trim();
    }
  }

  return out.filter((p) => p.prompt.length > 0);
}

export function padNumber(n: number): string {
  return String(n).padStart(3, "0");
}
