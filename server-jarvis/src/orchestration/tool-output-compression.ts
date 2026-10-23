// ═══════════════════════════════════════════════════════════════
// Tool output compression — keep the signal, drop the filler
// ═══════════════════════════════════════════════════════════════
// Replaces the plain `slice(0, max) + "..."` truncation that fed tool results
// into context. A hard character cut keeps whichever bytes happen to come
// first, which for most tool output is the least informative part: the
// compiler banner rather than the error, the test header rather than the
// failures. The end of tool output carries the verdict.
//
// Invariants (all covered by tests):
//   1. The output never exceeds maxChars, for any input and any budget.
//   2. The output contains only whole source lines from the input, plus
//      explicit elision markers. It never cuts mid-line and never cuts a
//      marker short.
//   3. Any dropped content is reported by a marker whose omission counts are
//      honest: exact dropped-line count, exact dropped line-content chars.
//   4. Pure and deterministic — same input, same output, no I/O, no model
//      calls, and no dependencies.
//
// Where the older plan text and these invariants conflict (it allowed a
// mid-line `slice` fallback and markers longer than the budget), this
// implementation follows the invariants: the budget is hard, lines are whole,
// and an honest marker that does not fit shrinks its detail rather than being
// cut, down to and including an empty result when even that does not fit.
//
// Budget split: roughly a quarter of the usable room for the head (context
// banner), half for the tail (verdicts, totals, error summaries), and the
// remainder reserved for rescuing diagnosis lines from the dropped middle.
// The exact shares are not a contract; the three invariants above are.

export interface CompressOptions {
  /** Tool that produced this output; selects the line-scoring profile. */
  toolName: string;
  /** Hard ceiling on the returned string length. */
  maxChars: number;
}

/** At most this many diagnosed lines are rescued from the dropped middle. */
const MAX_SIGNAL_LINES = 5;

/**
 * Generous upper bound on the "[... N signal line(s) kept from the middle ...]"
 * marker length (n is capped at MAX_SIGNAL_LINES, its real maximum is 44).
 */
const SIGNAL_MARKER_UPPER_BOUND = 50;

/**
 * Lines that carry a diagnosis. Deliberately narrow: a loose pattern promotes
 * half the output and the compression stops compressing.
 */
const SIGNAL_PATTERN =
  /^\s*(?:ERROR|Error|FAIL|FAILED|Exception|Traceback|fatal)\b|^\s*(?:panic:|error TS\d+|✗|×)|^\s*\w+Error:/;

function isSignalLine(line: string): boolean {
  return SIGNAL_PATTERN.test(line);
}

function elision(lines: number, chars: number): string {
  return `[... ${lines} line${lines === 1 ? "" : "s"} omitted (${chars} chars) ...]`;
}

function elisionLinesOnly(lines: number): string {
  return `[... ${lines} line${lines === 1 ? "" : "s"} omitted ...]`;
}

function signalKeptMarker(lines: number): string {
  return `[... ${lines} signal line${lines === 1 ? "" : "s"} kept from the middle ...]`;
}

/**
 * Everything was dropped. Emit the most informative honest marker that fits,
 * shrinking detail before ever cutting a marker short. Returns "" when even
 * the tersest marker does not fit: the budget is hard, so an over-long marker
 * or a cut marker is never emitted.
 */
function allOmittedMarker(droppedLines: number, droppedChars: number, maxChars: number): string {
  const full = elision(droppedLines, droppedChars);
  if (full.length <= maxChars) return full;
  const linesOnly = elisionLinesOnly(droppedLines);
  if (linesOnly.length <= maxChars) return linesOnly;
  const terse = "[... all output omitted ...]";
  if (terse.length <= maxChars) return terse;
  return "";
}

/**
 * Compress a tool result to `maxChars` characters without cutting a line in
 * half, keeping head context, the informative tail, and any scored failure
 * lines from the dropped middle, and saying exactly what was left out.
 * Deterministic: the same input always returns the same output.
 */
export function compressToolOutput(text: string, opts: CompressOptions): string {
  const maxChars = Math.floor(opts.maxChars);
  // `!(maxChars > 0)` also rejects NaN; `maxChars: Infinity` means unlimited.
  if (!(maxChars > 0)) return "";
  if (text.length <= maxChars) return text;

  const lines = text.split("\n");
  const lineCount = lines.length;

  // The marker reports dropped line content: `droppedChars` sums the lengths
  // of the source lines absent from the output (the newlines that bind them
  // are structural, not content).
  const keptChars = (keptLines: string[]): number =>
    keptLines.reduce((sum, line) => sum + line.length, 0);

  // Upper bound on the marker that the final assembly will use. It only grows
  // with the omitted counts, so any real marker fits inside this reserve.
  const worstElision = elision(lineCount, text.length).length;
  const usable = maxChars - worstElision - 2; // 2 = bounding separators + rounding

  if (usable <= 0) {
    // No line can fit alongside the worst-case marker: drop everything.
    return allOmittedMarker(
      lineCount,
      lines.reduce((sum, line) => sum + line.length, 0),
      maxChars,
    );
  }

  // ── Head: whole lines from the start until the head share is spent. ──
  // Cost convention: `line.length + 1` counts the separator after the line.
  const headBudget = Math.floor(usable * 0.25);
  const head: string[] = [];
  let headCost = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (headCost + cost > headBudget) break;
    head.push(line);
    headCost += cost;
  }

  // ── Tail: whole lines from the end. The tail gets the largest share. ──
  const tailBudgetFloor = Math.floor(usable * 0.5);
  let tailBudget = tailBudgetFloor;
  // A long verdict/failure line on the last line outranks the fixed split and
  // the promotion reserve: let the tail borrow (still bounded by the budget)
  // so the line that answers "did it work?" survives whole when it can fit.
  const lastLine = lines[lineCount - 1];
  if (lastLine !== undefined) {
    const lastCost = lastLine.length + 1;
    if (lastCost > tailBudget && headCost + lastCost + 1 <= usable) {
      tailBudget = lastCost;
    }
  }

  const tail: string[] = [];
  let tailCost = 0;
  for (let i = lineCount - 1; i >= head.length; i--) {
    const line = lines[i];
    if (line === undefined) break;
    const cost = line.length + 1;
    if (tailCost + cost > tailBudget) break;
    tail.unshift(line);
    tailCost += cost;
  }

  // ── Promotion: rescue diagnosis lines from the dropped middle. ──
  const middleStart = head.length;
  const middleEndExcl = lineCount - tail.length;
  const signalRoom = Math.max(0, usable - headCost - tailCost - 1);
  const promoted: string[] = [];
  let promotedCost = 0;
  for (let i = middleStart; i < middleEndExcl; i++) {
    const line = lines[i];
    if (line === undefined) break;
    if (promoted.length >= MAX_SIGNAL_LINES) break;
    if (!isSignalLine(line)) continue;
    const cost = line.length + 1;
    // Reserve the marker's room up front so promoting can never bust the
    // budget; the verification loop below is the final guard.
    if (promotedCost + cost + SIGNAL_MARKER_UPPER_BOUND > signalRoom) break;
    promoted.push(line);
    promotedCost += cost;
  }

  // ── Assemble and verify against the hard budget. ──
  // Dropping is always reported exactly: the marker counts the lines and
  // line-content characters that are not present in the output.
  let tailKeep = tail.length;
  let promotedKeep = promoted.length;
  for (;;) {
    const keptTail = tail.slice(0, tailKeep);
    const keptPromoted = promoted.slice(0, promotedKeep);

    const droppedStart = head.length;
    const droppedEndExcl = lineCount - keptTail.length;
    let droppedLines = 0;
    let droppedChars = 0;
    for (let i = droppedStart; i < droppedEndExcl; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      droppedChars += line.length;
      droppedLines += 1;
    }
    droppedChars -= keptChars(keptPromoted);
    droppedLines -= keptPromoted.length;

    if (droppedLines <= 0) {
      // Nothing left to omit: the kept lines speak for themselves.
      const joined = [...head, ...keptPromoted, ...keptTail].join("\n");
      if (joined.length <= maxChars) return joined;
    } else {
      const parts: string[] = [...head];
      if (keptPromoted.length > 0) {
        parts.push(signalKeptMarker(keptPromoted.length));
        parts.push(...keptPromoted);
      }
      parts.push(elision(droppedLines, Math.max(0, droppedChars)));
      parts.push(...keptTail);
      const out = parts.join("\n");
      if (out.length <= maxChars) return out;
    }

    if (tailKeep > 0) {
      tailKeep -= 1;
      continue;
    }
    if (promotedKeep > 0) {
      promotedKeep -= 1;
      continue;
    }
    // Only the head (and at most one failing-element scenario) remains: the
    // marker itself does not fit — shrink it honestly instead of cutting it.
    return allOmittedMarker(
      Math.max(0, lineCount - head.length),
      lines.reduce((sum, line) => sum + line.length, 0) - keptChars(head),
      maxChars,
    );
  }
}
