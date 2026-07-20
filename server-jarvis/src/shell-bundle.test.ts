import { describe, test, expect } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { basename, join } from "path";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import { registerShellBundle } from "./shell-bundle";
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
      rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      rmSync(granted, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
      rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, { timeout: 15_000 });
});
