// The one `fs` in this read: a bounded tail of a log file, as a decision the
// route can hand to `Response.json`.
//
// It exists as its own module so its failure modes can be tested against a real
// filesystem. A reader that is only reachable through the surface that renders
// it is a reader whose "file is not there" path is never taken, and a file that is
// not there is the case that must never be reported as an empty log. The pure
// decisions it makes — the limit, the window offset, the tail, the parse, whether
// the read reached the beginning of the file — all live in `./log-tail` and are
// tested there; this file does `stat`, does a bounded `read`, and drops the
// fragment a windowed read starts on.

import { closeSync, openSync, readSync, statSync } from "fs";
import { basename } from "path";
import {
  LOG_READ_FAILURE_STATUS,
  LOG_TAIL_READ_BYTES,
  buildLogTail,
  logLineCount,
  resolveLogLimit,
  tailReadStart,
  type LogReadFailure,
  type LogTail,
} from "./log-tail";

/** A confirmed read, or the named reason there was not one. Never an empty list. */
export type LogReadResult = { ok: true; tail: LogTail } | { ok: false; failure: LogReadFailure };

/** Read `path`'s trailing window and answer either a tail or a named failure. */
export function readLogTail(
  path: string,
  requestedLimit: number | string | null | undefined,
  readBytes: number = LOG_TAIL_READ_BYTES,
): LogReadResult {
  const limit = resolveLogLimit(requestedLimit);
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    return { ok: false, failure: failureFor(error) };
  }

  const start = tailReadStart(size, readBytes);
  const window = readWindow(path, start, readBytes);
  if (!window.ok) return window;

  // A windowed read begins in the middle of whatever line the boundary landed in.
  // That fragment is not a line, so it is dropped — unless it is the only content
  // in the window, in which case it is the newest thing in the file and the
  // operator is better served by its tail than by an empty panel. `truncated`
  // already says the read did not reach the beginning, so neither case overstates.
  let text = window.text;
  if (start > 0) {
    const firstBreak = text.indexOf("\n");
    if (firstBreak !== -1) text = text.slice(firstBreak + 1);
  }

  return {
    ok: true,
    tail: buildLogTail(basename(path), text, {
      limit,
      truncated: start > 0 || logLineCount(text) > limit,
    }),
  };
}

type Window = { ok: true; text: string } | { ok: false; failure: LogReadFailure };

function readWindow(path: string, start: number, readBytes: number): Window {
  const length = Math.max(0, Math.min(readBytes, Number.isFinite(readBytes) ? readBytes : 0));
  if (length === 0) return { ok: true, text: "" };
  const buffer = Buffer.allocUnsafe(length);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const read = readSync(fd, buffer, 0, length, start);
    return { ok: true, text: buffer.subarray(0, read).toString("utf8") };
  } catch (error) {
    return { ok: false, failure: failureFor(error) };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A descriptor that will not close is not a read failure: the bytes are
        // already in hand, and the alternative is to report a good read as a
        // broken one.
      }
    }
  }
}

/**
 * Which named failure an `fs` error is. The error itself never leaves this
 * function: a path or an errno in a response body is a store detail in a place
 * the operator may screenshot, which is what the read-error rule in the UI exists
 * to prevent. A developer reads the server's own log for the reason.
 */
function failureFor(error: unknown): LogReadFailure {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable";
}

/**
 * The response for one read. A failure is a non-2xx whose body names the failure
 * and carries no `lines` at all, so a client that checks `response.ok` — and the
 * four mounted surfaces that already call this server all do — cannot mistake a
 * file that was never opened for a log that is empty.
 */
export function logReadResponse(result: LogReadResult): Response {
  if (!result.ok) {
    return Response.json(
      { ok: false, failure: result.failure },
      { status: LOG_READ_FAILURE_STATUS[result.failure] },
    );
  }
  return Response.json({ ok: true, ...result.tail });
}
