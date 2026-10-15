// The tail of the log the app actually writes, as a decision rather than a read.
//
// The `SystemStore.logs` vector looked like this app's log and was not: nothing in
// the repository ever constructs a `LogEntry`, so `get_logs` answers `Ok(vec![])`
// on every install this build has written (see the `[!]` row in .sprint/BACKLOG.md
// that recorded it). The log that does exist is a file, and the process that
// writes it already serves the UI over HTTP — so this row needed no Rust.
//
// The file is `server-jarvis.self.log`: `installSelfLog` tees the server's own
// console to it, creating the directory, before any other module logs
// (`self-log.ts`, installed at `index.ts:10-11`). It is the one log guaranteed to
// exist whichever way the process was started, and the 2026-07-12 incident window
// is why that guarantee was written down at all.
//
// Its sibling files — `server-jarvis.log`, `claude-proxy.log` and their `.err.log`
// pairs — are the supervisor's append-mode pipes of a child's stdio
// (`src-tauri/src/lib.rs` `jarvis_server_log_stdio`). They are unstructured child
// output, they can be empty for a whole session, and this module does not serve
// them. That is decision (c) made in code rather than in prose: the payload names
// the `format` it was parsed under, so a second source can never be read with the
// self-log's parser and acquire invented timestamps and levels.
//
// Pure: no `fs`, no route, no clock, no console. The route supplies text it has
// already read and gets back either a tail or a named read failure. The
// alternative — a module that opens the file itself — is the thing that cannot be
// unit-tested on a host where the file may not exist, which is how a read ends up
// tested only through the surface that renders it.

/** Lines returned when the caller states no usable limit. */
export const LOG_TAIL_LIMIT_DEFAULT = 200;

/**
 * The cap is the server's, not the client's. A log is append-only and unbounded
 * in principle, so "give me the log" has to be answered with a window; a request
 * for a million lines is clamped here rather than trusted, because the clamp is
 * what makes the read bounded instead of a way to pull a file into memory.
 */
export const LOG_TAIL_LIMIT_MAX = 200;

/**
 * How much of the file the route is willing to read to serve one window. A busy
 * server appends faster than an operator scrolls, so the byte read is bounded
 * too: past this the route reads the trailing window and reports the read as
 * truncated, which is honest about not having reached the beginning.
 */
export const LOG_TAIL_READ_BYTES = 256 * 1024;

/** The one line shape this module parses, named so the payload can declare it. */
export const LOG_TAIL_FORMAT = "self-log";

/**
 * Why a log read did not happen. Both are failures, and neither is an empty list:
 * `ok: true` with zero lines is the app saying "this log is empty", which for a
 * file that was never opened is the one sentence this read must never produce.
 */
export type LogReadFailure = "missing" | "unreadable";

/** The status each failure is answered with, so no failure can pass for a read. */
export const LOG_READ_FAILURE_STATUS: Record<LogReadFailure, number> = {
  missing: 404,
  unreadable: 500,
};

/**
 * The limit this read will actually use.
 *
 * A limit at or below zero, a fractional one, a `NaN`, an infinity and an absent
 * one are all the same request: the caller did not state a usable limit, so it
 * gets the default. The alternative — honouring `limit=0` — would return a
 * confirmed empty log produced by arithmetic, which is exactly the failure this
 * module exists to prevent.
 *
 * It takes the string form too because that is how the limit arrives: it is a
 * query parameter, and a client that sent `?limit=abc` has not stated a limit
 * rather than having asked for a strange one.
 */
export function resolveLogLimit(requested: number | string | null | undefined): number {
  const value = typeof requested === "string" ? Number(requested.trim()) : requested;
  if (typeof value !== "number") return LOG_TAIL_LIMIT_DEFAULT;
  if (!Number.isFinite(value)) return LOG_TAIL_LIMIT_DEFAULT;
  if (!Number.isInteger(value) || value <= 0) return LOG_TAIL_LIMIT_DEFAULT;
  return Math.min(value, LOG_TAIL_LIMIT_MAX);
}

/**
 * The offset a bounded read of `windowBytes` starts at, never negative and never
 * past the end. Exposed so the arithmetic that decides whether the read reached
 * the beginning of the file is a contract rather than an expression inside a
 * route handler.
 */
export function tailReadStart(fileSize: number, windowBytes: number): number {
  const size = Number.isFinite(fileSize) && fileSize > 0 ? fileSize : 0;
  const window = Number.isFinite(windowBytes) && windowBytes > 0 ? windowBytes : 0;
  return Math.max(0, Math.min(size, size - window));
}

/**
 * The newest `limit` lines of `text`, oldest first, in the order they were
 * written.
 *
 * A final line with no trailing newline is a line: the newest entry of a file
 * being appended to is almost always mid-write, and dropping it would hide the
 * reason the operator opened this read. A blank line is kept too — it is a line
 * the writer produced, and hiding it would make the count disagree with the
 * file. What is not in the file is the empty segment after a trailing newline,
 * and that one is dropped.
 *
 * A non-positive limit returns nothing rather than everything: `resolveLogLimit`
 * is what keeps that unreachable from the route, and the contract is pinned here
 * so a future caller cannot turn it into a confirmed empty log.
 */
export function tailLogLines(text: string, limit: number): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const segments = text.split("\n");
  if (segments[segments.length - 1] === "") segments.pop();
  return segments.length > limit ? segments.slice(segments.length - limit) : segments;
}

/**
 * How many lines `text` holds, counted the same way `tailLogLines` counts them.
 *
 * This is the question the payload's `truncated` answers. A consumer may call
 * its count the file's only when the read reached the first line, so the count
 * has to be a fact about the text rather than an inference from how many lines
 * came back.
 */
export function logLineCount(text: string): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  const segments = text.split("\n");
  if (segments[segments.length - 1] === "") segments.pop();
  return segments.length;
}

/** One line of a log, with the parts the writer put in it and nothing invented. */export interface LogLine {
  /** The line's own text, verbatim. Always present, even when empty. */
  text: string;
  /** The writer's ISO timestamp, or `null` when the line is not its shape. */
  timestamp: string | null;
  /** The writer's level, or `null` when the line is not its shape. */
  level: string | null;
}

export interface LogTail {
  /** The file this tail was read from. */
  source: string;
  /** The line shape `lines` was parsed under. Never inferred from the text. */
  format: typeof LOG_TAIL_FORMAT;
  /** The limit the server actually applied, after its own clamp. */
  limit: number;
  /**
   * True when the read did not reach the beginning of the file, so the lines
   * returned are the newest of an unknown number. False means these lines are
   * every line the file held, which is the only case in which a consumer may
   * call the count the file's.
   */
  truncated: boolean;
  /** Oldest first, in the order the file wrote them. */
  lines: LogLine[];
}

// `formatLine` in self-log.ts, exactly: `${new Date().toISOString()} ${level}
// ${text}\n`, with level one of the three the tee installs. The timestamp is
// matched in full so a date-shaped prefix is not mistaken for a write time, and
// the level is an enumeration so a line of child output is never given a level
// this writer could not have written.
const SELF_LOG_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z) (INFO|WARN|ERROR)(?: (.*))?$/;

/**
 * Split one line of the self-log into the parts the writer put in it.
 *
 * A line that is not the writer's shape is returned as its own text with no
 * timestamp and no level. It is not dropped and it is not guessed at: it is in
 * the file, so it is shown, and the two fields the format could have supplied
 * are `null` because the format did not supply them. A partial write mid-line
 * is the common case here, and a half-written line is still the newest thing
 * that happened.
 */
export function parseSelfLogLine(raw: string): LogLine {
  const text = typeof raw === "string" ? raw : "";
  const match = SELF_LOG_LINE.exec(text);
  if (!match) return { text, timestamp: null, level: null };
  return { text: match[3] ?? "", timestamp: match[1], level: match[2] };
}

/**
 * The payload for one confirmed read.
 *
 * `truncated` is passed in rather than derived, because the route knows two
 * reasons the read stopped short — the byte window ended before the start of the
 * file, and the file held more lines than the limit — and a consumer must not
 * have to tell them apart to be honest: either way it has the newest N of an
 * unknown total and has to say so.
 */
export function buildLogTail(
  source: string,
  text: string,
  options: { limit: number; truncated: boolean },
): LogTail {
  const limit = resolveLogLimit(options.limit);
  return {
    source,
    format: LOG_TAIL_FORMAT,
    limit,
    truncated: options.truncated,
    lines: tailLogLines(text, limit).map(parseSelfLogLine),
  };
}
