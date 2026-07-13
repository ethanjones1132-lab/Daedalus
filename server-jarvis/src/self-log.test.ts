import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { installSelfLog, selfLogDir, selfLogPath } from "./self-log";

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
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
