// DD-035 / DS-30 + DS-31: process-level guards for the Bun server entrypoint.
//
// DS-30 — Bun exits on an unhandled promise rejection by default (reproduced on
// Bun 1.3.12: `Promise.reject(...)` + a pending timer → exit code 1, timer never
// fires). `streamJarvis` is thousands of lines with floating promises, so one
// stray rejection could take down a live server mid-turn. The listener here
// keeps the process alive and records one bounded line.
//
// DS-31 — `serve()` throws synchronously on a taken port *before* the module
// finishes evaluating, so the process died with a raw stack. This module turns
// that one case into a named diagnostic and leaves every other bind failure
// exactly as it was thrown.
//
// Everything here is pure or dependency-injected so the regression suite can
// import it without starting the production server.

import { isNativeError } from "node:util/types";

/** Bun's documented default hostname for `Bun.serve`. */
export const DEFAULT_BIND_HOSTNAME = "0.0.0.0";

/** Content budget for a rejection reason, excluding the log prefix/ellipsis. */
export const MAX_REJECTION_REASON_CHARS = 200;

export const REJECTION_LOG_PREFIX = "[Jarvis guard]";
export const BIND_LOG_PREFIX = "[Jarvis API]";
export const ADDRESS_IN_USE_HINT = "another Jarvis instance is probably running";

export type GuardLogger = (line: string) => void;

function defaultLog(line: string): void {
  try {
    // Resolved at call time so the self-log tee installed by the entrypoint is
    // in place. A string line is required: the tee expands Error arguments
    // into full stacks, which would defeat the bounded-line contract.
    console.error(line);
  } catch {
    /* logging must never be able to break the guard */
  }
}

function defaultExit(code: number): void {
  process.exit(code);
}

/**
 * Collapse arbitrary text into one bounded, control-character-free line.
 *
 * - CR/LF/U+2028/U+2029 and every C0/C1 control character (including NUL and
 *   ESC, so ANSI sequences cannot rewrite a terminal) become a single space.
 * - Runs of whitespace collapse; leading/trailing whitespace is dropped.
 * - Longer text is truncated with an ASCII ellipsis, without splitting a
 *   surrogate pair.
 */
export function sanitizeOneLine(value: string, maxChars: number = MAX_REJECTION_REASON_CHARS): string {
  const flat = value
    .replace(/\r\n|[\r\n\u2028\u2029]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= maxChars) return flat;
  let cut = flat.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}...`;
}

/**
 * Best-effort text for a rejection reason, without ever touching `.stack`.
 *
 * Only own data properties of native errors are read. Arbitrary objects are
 * summarized by type: invoking their conversion hooks or getters could block
 * the server in the very handler that is meant to preserve it.
 */
function rejectionReasonText(reason: unknown): string {
  if (typeof reason === "string") return reason.slice(0, MAX_REJECTION_REASON_CHARS * 4);
  if (isNativeError(reason)) {
    try {
      const nameValue = Object.getOwnPropertyDescriptor(reason, "name")?.value;
      const messageValue = Object.getOwnPropertyDescriptor(reason, "message")?.value;
      const name = typeof nameValue === "string" && nameValue
        ? nameValue.slice(0, MAX_REJECTION_REASON_CHARS) : "Error";
      const message = typeof messageValue === "string"
        ? messageValue.slice(0, MAX_REJECTION_REASON_CHARS * 4) : "";
      return message ? `${name}: ${message}` : name;
    } catch {
      return "Error";
    }
  }
  if (reason === null) return "null";
  if (reason === undefined) return "undefined";
  const kind = typeof reason;
  if (kind === "boolean" || kind === "number") return String(reason);
  return `[${kind}]`;
}

/** One-line, bounded rendering that never exposes a path-bearing reason. */
export function describeRejectionReason(reason: unknown): string {
  const text = rejectionReasonText(reason);
  // Paths may occur in messages as well as stacks. Suppress the whole reason
  // when it contains a separator, including paths with spaces and UNC paths;
  // partial token redaction could leave part of a private path behind.
  if (/[\\/]/.test(text)) return "[redacted path-bearing reason]";
  return sanitizeOneLine(text);
}

/** The exact single line logged for an unhandled rejection (tests assert its shape). */
export function formatUnhandledRejectionLine(reason: unknown): string {
  return `${REJECTION_LOG_PREFIX} unhandled rejection (server keeps running): ${describeRejectionReason(reason)}`;
}

/** Minimal surface of `process` the guard needs, so tests can use a plain emitter. */
export interface RejectionHost {
  on(event: "unhandledRejection", listener: (reason: unknown, promise: unknown) => void): unknown;
}

const guardedHosts = new WeakSet<object>();

/**
 * Install the single `unhandledRejection` listener. Returns true when this call
 * installed it, false when the host was already guarded (idempotent).
 *
 * Contract: locally handled rejections never reach this listener, the server
 * keeps running for the unhandled ones, and this listener never throws and
 * never exits the process.
 */
export function installRejectionGuard(
  log: GuardLogger = defaultLog,
  host: RejectionHost = process as unknown as RejectionHost,
): boolean {
  if (guardedHosts.has(host as object)) return false;
  guardedHosts.add(host as object);
  host.on("unhandledRejection", (reason: unknown) => {
    // No `promise` inspection: it is an arbitrary thenable graph and nothing in
    // it belongs in a log line. No rethrow either — an exception here would
    // reintroduce the crash this listener exists to prevent.
    try {
      log(formatUnhandledRejectionLine(reason));
    } catch {
      /* never surface a guard failure */
    }
  });
  return true;
}

/** The host/port pair the server is actually asked to bind. */
export interface BindTarget {
  readonly hostname: string;
  readonly port: number;
}

/** Resolve the effective bind target, defaulting to Bun's default hostname. */
export function resolveBindTarget(port: number, hostname: string = DEFAULT_BIND_HOSTNAME): BindTarget {
  return { hostname: hostname.trim() || DEFAULT_BIND_HOSTNAME, port };
}

/** `host:port` for diagnostics; IPv6 literals are bracketed. */
export function formatBindAddress(target: BindTarget): string {
  const host = target.hostname.includes(":") && !target.hostname.startsWith("[")
    ? `[${target.hostname}]`
    : target.hostname;
  return `${host}:${target.port}`;
}

/** The explicit `code` of a thrown value, when it has a non-empty string one. */
export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && code.trim().length > 0 ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort scalar message, never a stack. */
export function errorMessageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    try {
      return typeof error.message === "string" ? error.message : "";
    } catch {
      return "";
    }
  }
  if (typeof error === "object" && error !== null) {
    try {
      const message = (error as { message?: unknown }).message;
      return typeof message === "string" ? message : "";
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * True only for an address-in-use bind failure.
 *
 * An explicit error `code` is authoritative: anything else (EACCES, ENOTFOUND,
 * a malformed option) is *not* reclassified just because its message happens to
 * mention a busy port. Message matching is a fallback for codeless wrapper
 * errors only, and it includes Bun's own bind wording ("Is port N in use?").
 */
export function isAddressInUseError(error: unknown): boolean {
  const code = errorCodeOf(error);
  if (code !== undefined) return code.trim().toUpperCase() === "EADDRINUSE";
  return /\bEADDRINUSE\b|address already in use|is port \d+ in use\?/i.test(errorMessageOf(error));
}

/** The operator-facing line for a taken port; names the real host and port. */
export function formatAddressInUseMessage(target: BindTarget): string {
  return `${BIND_LOG_PREFIX} cannot start: ${formatBindAddress(target)} is already in use (EADDRINUSE); `
    + `${ADDRESS_IN_USE_HINT} — stop it, or set JARVIS_SERVER_PORT to a free port.`;
}

export interface BindGuardDeps {
  log?: GuardLogger;
  exit?: (code: number) => void;
}

/**
 * Run the real HTTP bind, translating only EADDRINUSE.
 *
 * Every other failure is rethrown as the exact original object, so Bun's own
 * stack and error identity survive. The fetch/idleTimeout/options contract is
 * untouched: `bind` is the same call the entrypoint made before, and its return
 * value (the `Bun.Server`) is passed through unchanged.
 */
export function guardServerBind<T>(
  bind: () => T,
  target: BindTarget,
  deps: BindGuardDeps = {},
): T {
  const log = deps.log ?? defaultLog;
  const exit = deps.exit ?? defaultExit;
  try {
    return bind();
  } catch (error) {
    if (!isAddressInUseError(error)) throw error;
    try {
      log(formatAddressInUseMessage(target));
    } catch {
      /* a logging failure must not hide the bind failure */
    }
    exit(1);
    // `exit` is expected not to return (process.exit). If an injected exit does
    // return, report the bind failure rather than pretending it succeeded.
    throw error;
  }
}
