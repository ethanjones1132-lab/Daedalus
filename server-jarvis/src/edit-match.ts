// ─── Whitespace-tolerant edit matching ───────────────────────────────────────
// `edit_file`/`multi_edit` require the model to reproduce an exact substring of
// the file. Free-tier models routinely reproduce the right code with slightly
// different whitespace — trailing spaces, CRLF vs LF, or shifted indentation —
// and the exact-match `content.includes(oldStr)` then fails with "old_string
// not found". On the 2026-07-24 tier-2B run this was the mechanism behind the
// benchmark misses: the model localized and diagnosed the bug correctly, then
// the edit never landed because the string match was off by whitespace.
//
// locateEditMatch tries an exact match first (preserving the historical
// ambiguity semantics), then falls back to a per-line-trimmed contiguous block
// match that tolerates trailing whitespace, line-ending style, and a uniform
// indentation shift. The tolerant path only applies when it maps to exactly one
// location in the file, so it can never silently patch the wrong place.

export type EditMatch =
  | { kind: "match"; start: number; end: number; tolerant: boolean }
  | { kind: "not_found" }
  | { kind: "ambiguous" };

/** Locate the span in `content` to replace for a given `oldStr`. */
export function locateEditMatch(content: string, oldStr: string): EditMatch {
  // 1. Exact substring — unchanged behavior, including >1 occurrence ambiguity.
  const firstExact = content.indexOf(oldStr);
  if (firstExact >= 0) {
    const second = content.indexOf(oldStr, firstExact + Math.max(1, oldStr.length));
    if (second >= 0) return { kind: "ambiguous" };
    return { kind: "match", start: firstExact, end: firstExact + oldStr.length, tolerant: false };
  }

  // 2. Tolerant, line-based match. Splitting on "\n" keeps any trailing "\r" on
  // each element, so char offsets reconstructed from element lengths stay
  // correct against the original `content` (CRLF files included).
  const contentLines = content.split("\n");
  const needleLines = oldStr.split("\n");

  // Drop blank leading/trailing needle lines so a stray newline at either end
  // does not defeat the match.
  while (needleLines.length && needleLines[0].trim() === "") needleLines.shift();
  while (needleLines.length && needleLines[needleLines.length - 1].trim() === "") needleLines.pop();
  if (needleLines.length === 0) return { kind: "not_found" };

  const needle = needleLines.map((line) => line.trim());
  const windows: number[] = [];
  for (let i = 0; i + needle.length <= contentLines.length; i++) {
    let matches = true;
    for (let j = 0; j < needle.length; j++) {
      if (contentLines[i + j].trim() !== needle[j]) {
        matches = false;
        break;
      }
    }
    if (matches) windows.push(i);
  }

  if (windows.length === 0) return { kind: "not_found" };
  if (windows.length > 1) return { kind: "ambiguous" };

  const startLine = windows[0];
  const endLine = startLine + needle.length - 1;
  let start = 0;
  for (let k = 0; k < startLine; k++) start += contentLines[k].length + 1; // +1 for the "\n"
  let end = start;
  for (let k = startLine; k <= endLine; k++) end += contentLines[k].length + (k < endLine ? 1 : 0);
  return { kind: "match", start, end, tolerant: true };
}

/** Apply a located match, returning the updated content. */
export function applyEditMatch(content: string, match: Extract<EditMatch, { kind: "match" }>, newStr: string): string {
  return content.slice(0, match.start) + newStr + content.slice(match.end);
}
