import { describe, test, expect } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, rmSync, symlinkSync } from "fs";
import { basename, join } from "path";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import {
  inspectBashProgram,
  registerShellBundle,
  resolveBashProgram,
  type BashProgramDeps,
} from "./shell-bundle";
import { defaultConfig } from "./config";

function makeRuntime() {
  const rt = createToolRuntime();
  registerShellBundle(rt);
  return rt;
}

function makeCtx() {
  const cfg = defaultConfig();
  cfg.jarvis_path = tmpdir();
  cfg.tools.enabled = true;
  cfg.tools.sandbox_mode = "off";
  // Auto-approving hook stands in for a real interactive surface where the user
  // approved the bash call. Without a hook, the approval-gated bash tool is now
  // correctly DENIED rather than silently executed.
  return makeExecutionContext("chat", cfg, { requestApproval: async () => true });
}

describe("ShellBundle", () => {
  test("registers a dangerous, approval-required bash tool", () => {
    const def = makeRuntime().listTools().find((t) => t.function.name === "bash")!;
    expect(def).toBeDefined();
    expect(def.dangerous).toBe(true);
    expect(def.requires_approval).toBe(true);
  });

  test("executes a command and returns stdout", async () => {
    const result = await makeRuntime().execute(
      { id: "t", name: "bash", arguments: { command: "echo hi" } },
      makeCtx(),
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("hi");
  }, { timeout: 15_000 });

  test("resolves cwd inside a session-granted root under strict policy", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "jarvis-shell-workspace-"));
    // Use a unique subdirectory under tmpdir as the granted root so the cwd
    // assertion works across platforms: on Windows MSYS, `bash` reports the
    // POSIX path mapping of the Windows temp dir (typically `/tmp`), not the
    // literal Windows basename — so asserting on `tmpdir()` directly would be
    // a false negative. A unique grant-leaf name is portable: bash on any
    // platform will include the leaf in its `pwd` output.
    const granted = mkdtempSync(join(tmpdir(), "jarvis-shell-grant-"));
    try {
      const cfg = defaultConfig();
      cfg.jarvis_path = workspace;
      cfg.tools.enabled = true;
      cfg.tools.sandbox_mode = "strict";
      const ctx = makeExecutionContext("chat", cfg, {
        session_grants: [granted],
        requestApproval: async () => true,
      });
      const result = await makeRuntime().execute(
        { id: "cwd-grant", name: "bash", arguments: { command: "pwd; cd /", cwd: granted } },
        ctx,
      );
      expect(result.is_error).toBe(false);
      expect(result.output.replace(/\\/g, "/").toLowerCase()).toContain(
        basename(granted).toLowerCase(),
      );
    } finally {
      rmSyncRetry(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      rmSyncRetry(granted, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, { timeout: 15_000 });

  test("rejects cwd outside allowed roots under strict policy", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "jarvis-shell-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "jarvis-shell-outside-"));
    try {
      const cfg = defaultConfig();
      cfg.jarvis_path = workspace;
      cfg.tools.enabled = true;
      cfg.tools.sandbox_mode = "strict";
      const ctx = makeExecutionContext("chat", cfg, { requestApproval: async () => true });
      const result = await makeRuntime().execute(
        { id: "cwd-outside", name: "bash", arguments: { command: "pwd", cwd: outside } },
        ctx,
      );
      expect(result.is_error).toBe(true);
      expect(result.output).toContain("outside the workspace");
    } finally {
      rmSyncRetry(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      rmSyncRetry(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, { timeout: 15_000 });

  test("rejects cwd reached through an outside directory link", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "jarvis-shell-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "jarvis-shell-outside-"));
    symlinkSync(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
    try {
      const cfg = defaultConfig();
      cfg.jarvis_path = workspace;
      cfg.tools.enabled = true;
      cfg.tools.sandbox_mode = "strict";
      const ctx = makeExecutionContext("chat", cfg, { requestApproval: async () => true });
      const result = await makeRuntime().execute(
        { id: "cwd-link", name: "bash", arguments: { command: "pwd", cwd: join(workspace, "escape") } },
        ctx,
      );
      expect(result.is_error).toBe(true);
      expect(result.output).toContain("outside the workspace");
    } finally {
      rmSyncRetry(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      rmSyncRetry(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, { timeout: 15_000 });
});

describe("resolveBashProgram", () => {
  const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
  const SYSTEM32_BASH = "C:\\Windows\\System32\\bash.exe";

  /** Stub the Windows filesystem so tests never depend on this machine's installs. */
  function windowsDeps(present: string[], pathValue: string): BashProgramDeps {
    const files = new Set(present.map((p) => p.toLowerCase()));
    return {
      platform: "win32",
      env: { PATH: pathValue },
      exists: (candidate) => files.has(candidate.toLowerCase()),
    };
  }

  test("refuses the WSL launcher on PATH instead of returning a bare bash", () => {
    const deps = windowsDeps([SYSTEM32_BASH], "C:\\Windows\\System32");
    const inspection = inspectBashProgram({ tools: {} }, deps);

    expect(inspection.resolved).toBe(false);
    if (inspection.resolved) throw new Error("expected the WSL launcher to be refused");
    expect(inspection.wslLauncherPath).toBe(SYSTEM32_BASH);
    expect(inspection.reason).toContain("WSL launcher");
    expect(inspection.reason).toContain("requires Git Bash");
    expect(inspection.reason).toContain("tools.bash_path");

    // Today's implementation never refuses: it returns the bare string "bash"
    // (or an installed Git Bash path), so this throw assertion fails against it
    // and the pin catches the silent-WSL regression.
    expect(() => resolveBashProgram({ tools: {} }, deps)).toThrow(/requires Git Bash/);
  });

  test("reports no usable interpreter when Windows has neither Git Bash nor bash on PATH", () => {
    const deps = windowsDeps([], "C:\\Windows\\System32");
    const inspection = inspectBashProgram({ tools: {} }, deps);

    expect(inspection.resolved).toBe(false);
    if (inspection.resolved) throw new Error("expected no usable interpreter");
    expect(inspection.wslLauncherPath).toBeUndefined();
    expect(inspection.reason).toContain("No Git Bash");
    expect(inspection.reason).toContain("tools.bash_path");
    expect(() => resolveBashProgram({ tools: {} }, deps)).toThrow(/No Git Bash/);
  });

  test("keeps resolving a real Git Bash install exactly as before", () => {
    const deps = windowsDeps([GIT_BASH], "C:\\Windows\\System32");

    expect(resolveBashProgram({ tools: {} }, deps)).toBe(GIT_BASH);
    expect(inspectBashProgram({ tools: {} }, deps)).toEqual({
      resolved: true,
      program: GIT_BASH,
      source: "candidate",
    });
  });

  test("resolves a real Git Bash found on PATH to an explicit path", () => {
    const gitOnPath = "D:\\Tools\\Git\\bin\\bash.exe";
    // A quoted PATH entry is common on Windows; the resolved value is unquoted.
    const deps = windowsDeps([gitOnPath], `"D:\\Tools\\Git\\bin";C:\\Windows\\System32`);
    const inspection = inspectBashProgram({ tools: {} }, deps);

    expect(inspection).toEqual({ resolved: true, program: gitOnPath, source: "path" });
    expect(resolveBashProgram({ tools: {} }, deps)).toBe(gitOnPath);
    expect(resolveBashProgram({ tools: {} }, deps)).not.toBe("bash");
  });

  test("a configured bash_path still wins and still rejects the WSL launcher", () => {
    const deps = windowsDeps([GIT_BASH, SYSTEM32_BASH], "C:\\Windows\\System32");

    expect(inspectBashProgram({ tools: { bash_path: GIT_BASH } }, deps)).toEqual({
      resolved: true,
      program: GIT_BASH,
      source: "configured",
    });
    expect(() => resolveBashProgram({ tools: { bash_path: SYSTEM32_BASH } }, deps)).toThrow(
      /WSL launcher/,
    );
    expect(() =>
      resolveBashProgram({ tools: { bash_path: "C:/Windows/System32/bash.exe" } }, deps),
    ).toThrow(/WSL launcher/);
  });

  test("non-Windows still returns the bare bash without touching PATH", () => {
    const deps: BashProgramDeps = {
      platform: "linux",
      env: { PATH: "/usr/bin" },
      exists: () => {
        throw new Error("POSIX resolution must not consult PATH candidates");
      },
    };

    expect(resolveBashProgram({ tools: {} }, deps)).toBe("bash");
    expect(inspectBashProgram({ tools: {} }, deps)).toEqual({
      resolved: true,
      program: "bash",
      source: "posix-fallback",
    });
  });
});
