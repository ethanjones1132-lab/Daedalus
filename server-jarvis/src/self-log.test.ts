import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  SELF_LOG_MAX_BYTES,
  SELF_LOG_ROTATED_SUFFIX,
  createSelfLogWriter,
  installSelfLog,
  selfLogDir,
  selfLogPath,
} from "./self-log";

describe("selfLogDir", () => {
  test("windows resolves under LOCALAPPDATA/com.jarvis.desktop/logs (matches the Rust supervisor)", () => {
    const dir = selfLogDir("win32", { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" });
    expect(dir).toBe(join("C:\\Users\\test\\AppData\\Local", "com.jarvis.desktop", "logs"));
  });

  test("windows without LOCALAPPDATA falls back to the temp dir", () => {
    const dir = selfLogDir("win32", {});
    expect(dir).toContain("com.jarvis.desktop");
  });

  test("non-windows resolves under ~/.openclaw/jarvis/logs", () => {
    const dir = selfLogDir("linux", {});
    expect(dir).toContain(join(".openclaw", "jarvis", "logs"));
  });

  test("selfLogPath appends the dedicated self-log filename", () => {
    expect(selfLogPath("win32", { LOCALAPPDATA: "C:\\x" })).toContain("server-jarvis.self.log");
  });
});

describe("installSelfLog", () => {
  test("tees console output to the log file and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "selflog-"));
    const logPath = join(dir, "server-jarvis.self.log");
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    try {
      installSelfLog(logPath);
      installSelfLog(logPath); // second call must be a no-op (no double-tee)
      console.log("selflog-test-info-line");
      console.warn("selflog-test-warn-line");
      console.error("selflog-test-error-line");
      const content = readFileSync(logPath, "utf-8");
      expect(content).toContain("INFO selflog-test-info-line");
      expect(content).toContain("WARN selflog-test-warn-line");
      expect(content).toContain("ERROR selflog-test-error-line");
      // Idempotence: exactly one occurrence of each despite two installs.
      expect(content.split("selflog-test-info-line").length - 1).toBe(1);
      expect(existsSync(logPath)).toBe(true);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
      rmSyncRetry(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});

// DD-105: the guaranteed self-log stays bounded on disk. `installSelfLog` is
// idempotent for the life of the process, so the bounded writer it installs is
// exercised directly — the same object the tee calls on every line.
describe("createSelfLogWriter", () => {
  const tempLog = (prefix: string): { dir: string; logPath: string } => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    return { dir, logPath: join(dir, "server-jarvis.self.log") };
  };

  const lineIndexes = (text: string): number[] =>
    [...text.matchAll(/rotation-line-(\d+)/g)].map((match) => Number(match[1]));

  test("the cap is a documented constant, not an accidental default", () => {
    expect(SELF_LOG_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(SELF_LOG_ROTATED_SUFFIX).toBe(".1");
  });

  test("writing past the cap rotates to the .1 sibling and the live file is small again", () => {
    const { dir, logPath } = tempLog("selflog-rot-");
    const cap = 400;
    try {
      const writer = createSelfLogWriter(logPath, cap);
      for (let i = 0; i < 200; i++) writer.write("INFO", [`rotation-line-${i}`]);

      // The live file never grew past the cap...
      expect(statSync(logPath).size).toBeLessThanOrEqual(cap);
      // ...a single older generation exists beside it...
      const archive = logPath + SELF_LOG_ROTATED_SUFFIX;
      expect(existsSync(archive)).toBe(true);
      const live = readFileSync(logPath, "utf-8");
      const previous = readFileSync(archive, "utf-8");
      // ...and it is the older half of the same stream: the archive ends where
      // the live file begins, with no line lost or duplicated at the seam.
      const archived = lineIndexes(previous);
      const kept = lineIndexes(live);
      expect(archived.length).toBeGreaterThan(0);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept[0]).toBe(archived[archived.length - 1] + 1);
      expect(kept[kept.length - 1]).toBe(199);
    } finally {
      rmSyncRetry(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  test("the newest line survives the rotation that follows it", () => {
    const { dir, logPath } = tempLog("selflog-newest-");
    try {
      const writer = createSelfLogWriter(logPath, 200);
      // A cap small enough that the stream rotates several times; whichever
      // line is newest must end up in the live file, never only in the archive.
      for (let i = 0; i < 20; i++) writer.write("INFO", [`rotation-line-${i}`]);
      const live = readFileSync(logPath, "utf-8");
      const lines = live.trimEnd().split("\n");
      expect(lines[lines.length - 1]).toContain("rotation-line-19");
      expect(lineIndexes(live)).toContain(19);
      // The newest line is in the live file, not stranded in the archive.
      expect(readFileSync(logPath + SELF_LOG_ROTATED_SUFFIX, "utf-8")).not.toContain("rotation-line-19");
    } finally {
      rmSyncRetry(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  test("a pre-existing oversized file is rotated on the first line, not appended to forever", () => {
    const { dir, logPath } = tempLog("selflog-legacy-");
    try {
      writeFileSync(logPath, "legacy-line\n".repeat(200));
      const cap = 256;
      const writer = createSelfLogWriter(logPath, cap);
      writer.write("INFO", ["after-upgrade-line"]);
      const live = readFileSync(logPath, "utf-8");
      expect(live).toContain("after-upgrade-line");
      expect(statSync(logPath).size).toBeLessThanOrEqual(cap);
      expect(readFileSync(logPath + SELF_LOG_ROTATED_SUFFIX, "utf-8")).toContain("legacy-line");
    } finally {
      rmSyncRetry(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  test("a rotation that cannot happen keeps logging and does not throw", () => {
    const { dir, logPath } = tempLog("selflog-blocked-");
    try {
      // The live file is writable, but the rotated name is taken by a non-empty
      // directory, so replacing the older generation is impossible on any OS.
      writeFileSync(logPath, "x".repeat(300) + "\n");
      const archive = logPath + SELF_LOG_ROTATED_SUFFIX;
      mkdirSync(archive, { recursive: true });
      writeFileSync(join(archive, "keep.txt"), "occupied");

      const writer = createSelfLogWriter(logPath, 100);
      expect(() => {
        for (let i = 0; i < 5; i++) writer.write("INFO", [`still-logging-${i}`]);
      }).not.toThrow();

      // Logging continued past the cap instead of failing the turn.
      const live = readFileSync(logPath, "utf-8");
      expect(live).toContain("still-logging-0");
      expect(live).toContain("still-logging-4");
      // Nothing on disk was destroyed to make room for a rotation that failed.
      expect(readFileSync(join(archive, "keep.txt"), "utf-8")).toBe("occupied");
    } finally {
      rmSyncRetry(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  test("an unwritable path does not throw out of the writer", () => {
    const { dir, logPath } = tempLog("selflog-unwritable-");
    try {
      // The log path is a directory: neither append nor rotate can succeed.
      mkdirSync(logPath);
      const writer = createSelfLogWriter(logPath, 64);
      expect(() => writer.write("ERROR", ["unwritable-line"])).not.toThrow();
      expect(() => writer.write("ERROR", ["unwritable-line-again"])).not.toThrow();
    } finally {
      rmSyncRetry(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});
