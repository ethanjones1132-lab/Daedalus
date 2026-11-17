// Task 4.3: guaranteed server log, independent of spawn method.
//
// The 2026-07-12 incident window (13:39-13:42Z) has ZERO lines in
// server-jarvis.log: the Tauri supervisor pipes child stdout/stderr to that
// file, but a server started any other way (manual `bun index.js`, a deploy
// script, a stale instance) logs only to its own console — so the one
// session that mattered was served by a runtime whose output went nowhere.
//
// Rather than trying to fix every spawn path, the server now tees its own
// console output to a dedicated file (`server-jarvis.self.log`) in the same
// canonical log directory. A separate file avoids double-writing into
// server-jarvis.log when the Tauri pipe IS active; disk cost is trivial and
// the operator gets one log that exists no matter how the process started.
//
// DD-105: that guaranteed file is bounded. It rotates into a single `.1`
// sibling at `SELF_LOG_MAX_BYTES` (5 MB), so a reader of the live path — the
// log-tail route, a cold-start probe — sees the newest generation, and the
// operator keeps one archive beside it. Size is tracked in memory per writer,
// so the per-line cost stays a byte count instead of a stat or a whole-file
// read; a rotation that cannot happen leaves a growing file but never a broken
// turn.

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

/**
 * DD-105: the self-log is a guaranteed writer, so it must not grow without
 * bound. The live file is capped at 5 MB; when the next line would cross the
 * cap the file is rotated once into a `.1` sibling (the older generation is
 * overwritten — one archive, never a directory of them) and the newest line
 * starts a fresh live file.
 */
export const SELF_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Suffix of the single rotated generation, next to the live self-log. */
export const SELF_LOG_ROTATED_SUFFIX = ".1";

/** Mirrors the Rust supervisor's log-dir resolution (lib.rs jarvis_server_log_stdio). */
export function selfLogDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA && env.LOCALAPPDATA.trim() ? env.LOCALAPPDATA : tmpdir();
    return join(base, "com.jarvis.desktop", "logs");
  }
  return join(homedir(), ".openclaw", "jarvis", "logs");
}

export function selfLogPath(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(selfLogDir(platform, env), "server-jarvis.self.log");
}

function formatLine(level: string, args: unknown[]): string {
  const text = args
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : safeJson(a)))
    .join(" ");
  return `${new Date().toISOString()} ${level} ${text}\n`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** The append-only part of the tee: one line in, one line out, never throws. */
export interface SelfLogWriter {
  /** Append one formatted line, rotating first when it would cross the cap. */
  write(level: string, args: unknown[]): void;
  /** The writer's belief about the live file's size, in bytes. */
  size(): number;
}

/**
 * Build a bounded, synchronous writer for one self-log path.
 *
 * The size is tracked in memory: the file is measured once (lazily, on the
 * first line) and from then on each append adds the line's own byte length, so
 * the hot path is a comparison, not a stat or a read of the whole file. A
 * rotation is attempted only at the boundary.
 *
 * Nothing here throws. If the size cannot be measured, logging starts from
 * zero; if appending fails, the line is dropped (console output already
 * happened); if the rotation fails — the rotated name is a directory, the
 * directory is read-only, the live path is not a file — the file keeps growing
 * and logging continues. A broken log must never break a turn, so bounded disk
 * is what we aim for, guaranteed logging is what we keep.
 */
export function createSelfLogWriter(
  logPath: string,
  maxBytes: number = SELF_LOG_MAX_BYTES,
): SelfLogWriter {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : SELF_LOG_MAX_BYTES;
  /** Live file size in bytes; -1 until it has been measured once. */
  let size = -1;
  /**
   * The size at which the next line rotates. Equal to `cap` until a rotation
   * fails, at which point it moves one more cap ahead so a permanently
   * unrotatable file is retried once per cap instead of once per line.
   */
  let rotateAt = cap;

  const ensureSize = (): void => {
    if (size >= 0) return;
    try {
      size = statSync(logPath).size;
    } catch {
      size = 0; // absent, unreadable, or not a regular file — start from the top
    }
  };

  const rotate = (): boolean => {
    try {
      const previous = logPath + SELF_LOG_ROTATED_SUFFIX;
      try {
        unlinkSync(previous); // Windows cannot rename onto an existing name
      } catch { /* ENOENT, or a directory we cannot replace — rename decides */ }
      renameSync(logPath, previous);
      size = 0;
      rotateAt = cap;
      return true;
    } catch {
      return false;
    }
  };

  return {
    write(level, args) {
      const line = formatLine(level, args);
      const bytes = Buffer.byteLength(line, "utf8");
      ensureSize();
      if (size + bytes > rotateAt && !rotate()) {
        // Rotation failed: keep the line (guaranteed log wins) and back the
        // boundary off by one cap so we do not retry on every single line.
        rotateAt = size + cap;
      }
      try {
        appendFileSync(logPath, line);
        size += bytes;
        // A single line larger than the cap cannot be rotated away; move the
        // boundary past it so it does not force a rotation on every line.
        if (size > rotateAt) rotateAt = size + cap;
      } catch {
        // Drop the line; the console already has it. Never throw out of a tee.
      }
    },
    size: () => (size >= 0 ? size : 0),
  };
}

let installed = false;

/**
 * Wrap console.log/warn/error so every line is also appended to the
 * guaranteed self-log. Idempotent; a failed append never breaks logging
 * (falls back to console-only silently — the tee is best-effort by design).
 */
export function installSelfLog(logPath: string = selfLogPath()): void {
  if (installed) return;
  installed = true;
  try {
    mkdirSync(join(logPath, ".."), { recursive: true });
  } catch { /* best effort */ }

  const writer = createSelfLogWriter(logPath);

  const tee = (level: string, original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      original(...args);
      writer.write(level, args);
    };

  console.log = tee("INFO", console.log.bind(console));
  console.warn = tee("WARN", console.warn.bind(console));
  console.error = tee("ERROR", console.error.bind(console));
  console.log(`[SelfLog] guaranteed server log active: ${logPath}`);
}
