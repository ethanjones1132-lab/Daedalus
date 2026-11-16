// DD-080 (server half): a failing request must leave evidence.
//
// The Rust supervisor now sends this process's stdout/stderr to a durable log
// file, so a line written here is the only record a packaged user can send us.
// Before this module a 5xx on /status, /health or /health/readiness was
// deliberately silent: the entrypoint suppressed every log for those paths so
// routine liveness probes could not flood the log. The suppression also
// swallowed the one case that matters — "health is broken" was reported to the
// native probe and to the user, never to the log file.
//
// The rule now:
//   - success stays silent on every path (a probe 200 is not an event);
//   - any response with status >= 500 is logged once at error level with
//     method, path, status and the message, quiet path or not;
//   - writes are rate limited per path (default one line / 30s) so a probe
//     crash-loop cannot grow the log without bound. Suppressed failures are
//     counted and reported on the next emitted line, so a burst is still
//     visible as `suppressed=N` instead of disappearing.
//
// This is observability only: `observeRequestFailure` returns the very same
// Response object it was given, so no status, body, header or auth decision
// changes here.

/** One line per path per window by default. */
export const FAILURE_LOG_WINDOW_MS = 30_000;

/** Upper bound on how long a failure line may wait for the response body peek. */
const BODY_PEEK_TIMEOUT_MS = 250;

export interface RequestFailure {
  method: string;
  path: string;
  status: number;
  message: string;
  elapsedMs?: number;
}

export interface RequestErrorLoggerOptions {
  windowMs?: number;
  now?: () => number;
  /** Injectable sink; defaults to console.error (the structured ERROR line). */
  emit?: (line: string) => void;
}

export interface RequestErrorLogger {
  /** Emits and returns the line, or returns null when rate limited. */
  record(failure: RequestFailure): string | null;
  /** Failures dropped since the last emitted line for this path. */
  suppressedCount(path: string): number;
}

/** Keep a log line a single line even if the message carries newlines. */
export function sanitizeFailureMessage(message: string): string {
  return message.replace(/\r?\n/g, " ↵ ").trim();
}

export function formatFailureLine(
  failure: RequestFailure,
  suppressed: number,
): string {
  const elapsed = failure.elapsedMs === undefined ? "" : ` (${failure.elapsedMs.toFixed(2)}ms)`;
  const suffix = suppressed > 0 ? ` suppressed=${suppressed}` : "";
  const message = sanitizeFailureMessage(failure.message) || `HTTP ${failure.status}`;
  return `[Jarvis API] ${failure.method} ${failure.path} -> ${failure.status} Error: ${message}${elapsed}${suffix}`;
}

export function createRequestErrorLogger(
  options: RequestErrorLoggerOptions = {},
): RequestErrorLogger {
  const windowMs = options.windowMs ?? FAILURE_LOG_WINDOW_MS;
  const now = options.now ?? Date.now;
  // Resolved per call so the entrypoint's structured console override is used.
  const emit = options.emit ?? ((line: string) => console.error(line));

  const lastEmittedAt = new Map<string, number>();
  const suppressed = new Map<string, number>();

  return {
    record(failure: RequestFailure): string | null {
      const key = failure.path;
      const at = now();
      const last = lastEmittedAt.get(key);
      if (last !== undefined && at - last < windowMs) {
        suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
        return null;
      }
      const pending = suppressed.get(key) ?? 0;
      suppressed.set(key, 0);
      lastEmittedAt.set(key, at);
      const line = formatFailureLine(failure, pending);
      // Logging must never break the request it is reporting on.
      try {
        emit(line);
      } catch {}
      return line;
    },

    suppressedCount(path: string): number {
      return suppressed.get(path) ?? 0;
    },
  };
}

/** The logger the server entrypoint uses for every request outcome. */
export const requestErrorLog = createRequestErrorLogger();

function withTimeout(text: Promise<string>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), ms);
  });
  return Promise.race([text, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Best-effort message for a 5xx response. The body is cloned, so the caller and
 * the client still receive the original response untouched; a non-JSON or
 * oversized body simply falls back to `HTTP <status>`.
 */
export async function requestFailureMessage(
  response: Response,
): Promise<string> {
  // Deliberately not Response.statusText: its default differs by runtime, and a
  // log line a user mails us must read the same everywhere.
  const fallback = `HTTP ${response.status}`;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json") || !response.body) return fallback;
  try {
    const text = await withTimeout(
      response.clone().text().catch(() => ""),
      BODY_PEEK_TIMEOUT_MS,
    );
    if (!text) return fallback;
    const parsed: any = JSON.parse(text);
    const error = typeof parsed?.error === "string" ? parsed.error : undefined;
    const detail = typeof parsed?.detail === "string" ? parsed.detail : undefined;
    if (error && detail) return `${error}: ${detail}`;
    if (error) return error;
    if (typeof parsed?.message === "string") return parsed.message;
    return fallback;
  } catch {
    return fallback;
  }
}

export interface ObserveRequestFailureOptions<R extends Response> {
  method: string;
  path: string;
  response: R;
  logger?: RequestErrorLogger;
  elapsedMs?: number;
}

/**
 * The one place a request outcome becomes a log line. Returns `response`
 * unchanged, so callers can wrap a handler without altering its behaviour.
 */
export async function observeRequestFailure<R extends Response>(
  options: ObserveRequestFailureOptions<R>,
): Promise<R> {
  const { method, path, response } = options;
  if (response.status < 500) return response;
  const logger = options.logger ?? requestErrorLog;
  try {
    logger.record({
      method,
      path,
      status: response.status,
      message: await requestFailureMessage(response),
      elapsedMs: options.elapsedMs,
    });
  } catch {
    // Observability only: a logging fault must not turn a reported 5xx into a
    // thrown one, and must never delay or alter the response.
  }
  return response;
}
