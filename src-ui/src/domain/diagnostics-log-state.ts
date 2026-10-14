// The Diagnostics log panel's whole vocabulary, kept out of the component.
//
// Every Native rejection in this app is deliberately withheld behind one authored
// sentence, because a native error string can embed a store path or a session id
// (`lib/read-error-guard.ts` polices it). This read is the one deliberate
// exception, and it is an exception in a specific direction: a *log line* is raw
// server output that an operator opened this panel to read, so it is shown
// verbatim and the cost of that is stated on screen above it in
// `LOG_RAW_CONTENT_NOTICE`. The rule still governs what the app says about its
// own failures — a read that could not be made is `Could not load …` and a
// `Retry`, with the reason withheld, exactly as its two siblings in Diagnostics
// do.
//
// A log line is also the one place a level can be *invented* by accident, so the
// level travels with the line and `null` is a first-class value: `server-jarvis.
// self.log` is written as `<ISO> <LEVEL> <text>` and a partial write mid-line is
// the common case, while the supervisor's stdio files are unstructured child
// output. `format` is carried on the payload and `logLevelTone(null)` is `null`,
// so a line that has no level is never given one.
//
// Pure: no React, no fetch, no Tauri, and no caught value can reach any of it —
// the decoder takes the unknown payload and returns either a tail or `null`.

/** One line, exactly as the writer left it, with the parts it supplied. */
export interface DiagnosticsLogLine {
  text: string;
  /** The writer's ISO timestamp, or null when the line is not its shape. */
  timestamp: string | null;
  /** The writer's level, or null when the line is not its shape. */
  level: string | null;
}

export interface DiagnosticsLogTail {
  /** The file this tail was read from, by name only. */
  source: string;
  /** The line shape the server parsed under. */
  format: string;
  /** The bound the server applied after its own clamp. */
  limit: number;
  /**
   * True when the read did not reach the beginning of the file, so these are the
   * newest lines of an unknown number. False means these are every line the file
   * held, which is the only case in which the count may be called the file's.
   */
  truncated: boolean;
  /** Oldest first, in the order the file wrote them. */
  lines: DiagnosticsLogLine[];
}

/**
 * The one sentence that makes this section the read-error rule's exception, in
 * the app's own copy rather than in a comment.
 */
export const LOG_RAW_CONTENT_NOTICE =
  'These lines are the raw output of the server process. They are not sanitised, and they can contain file paths and session ids.';

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * Decode the unknown result of the log route.
 *
 * Returns `null` when the payload is not a tail at all, which the caller reads as
 * a failed read — the honest reading, because there is then nothing on screen to
 * show and a panel with no rows would claim the log is empty. A payload that *is*
 * a tail but carries one unreadable line drops that line and keeps the rest: a
 * partial write, a hand-edited line, or a server that grew a field this build
 * does not know must cost the line, never the section.
 */
export function parseDiagnosticsLogTail(value: unknown): DiagnosticsLogTail | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (!Array.isArray(payload.lines)) return null;
  if (typeof payload.source !== 'string' || payload.source.length === 0) return null;
  if (typeof payload.format !== 'string' || payload.format.length === 0) return null;
  if (typeof payload.truncated !== 'boolean') return null;
  if (typeof payload.limit !== 'number' || !Number.isInteger(payload.limit) || payload.limit <= 0) return null;

  const lines: DiagnosticsLogLine[] = [];
  for (const entry of payload.lines) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const candidate = entry as Record<string, unknown>;
    // The text is the line. Without it there is nothing to render, and a line
    // with no renderable content is not a line this read can show.
    if (typeof candidate.text !== 'string') continue;
    if (!isNullableString(candidate.timestamp) || !isNullableString(candidate.level)) continue;
    lines.push({ text: candidate.text, timestamp: candidate.timestamp, level: candidate.level });
  }

  return {
    source: payload.source,
    format: payload.format,
    limit: payload.limit,
    truncated: payload.truncated,
    lines,
  };
}

const WHOLE_FILE_BOUND = 'Every line the file held when this was read.';
const BOUNDED_BOUND = (count: number) =>
  `The newest ${count} lines, oldest first. The file held more, and this read does not say how many more.`;
const UNREACHED_BOUND =
  'This read did not reach the start of the file, so it does not say how many lines the file holds.';

/**
 * The bound this read can support, in one fixed sentence per case.
 *
 * The only number in either sentence is the count of lines this read confirmed,
 * which is the one number it is entitled to state. A read that did not reach the
 * start of the file never claims the count is the file's, and a bounded read of
 * no lines says so about the file rather than announcing `The newest 0 lines`,
 * which is arithmetic talking.
 */
export function logTailBound(tail: DiagnosticsLogTail): string {
  if (!tail.truncated) return WHOLE_FILE_BOUND;
  return tail.lines.length > 0 ? BOUNDED_BOUND(tail.lines.length) : UNREACHED_BOUND;
}

/** The tone a stated level is printed in, as a subset of `Pill`'s variants. */
export type LogLevelTone = 'default' | 'warn' | 'error';

/** `null` for a line with no level, so the section renders no pill at all. */
export function logLevelTone(level: string | null): LogLevelTone | null {
  if (level === 'ERROR') return 'error';
  if (level === 'WARN') return 'warn';
  if (level === 'INFO') return 'default';
  return null;
}
