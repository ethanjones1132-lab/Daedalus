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

import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

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

  const tee = (level: string, original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      original(...args);
      try {
        appendFileSync(logPath, formatLine(level, args));
      } catch { /* never break console output over a log-file error */ }
    };

  console.log = tee("INFO", console.log.bind(console));
  console.warn = tee("WARN", console.warn.bind(console));
  console.error = tee("ERROR", console.error.bind(console));
  console.log(`[SelfLog] guaranteed server log active: ${logPath}`);
}
