import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config";
import {
  buildClaudeDelegateInvocation,
  DelegateHealth,
  delegateEligibility,
  mapClaudeDelegateToolName,
  runClaudeDelegate,
  type DelegateRootSnapshot,
} from "./claude-delegate";

describe("Claude executor delegate", () => {
  test("maps stock Claude tools into canonical Jarvis tool records", () => {
    expect([
      "Edit", "Edit-file", "Write", "MultiEdit", "Read", "Grep", "Glob",
      "Bash", "WebSearch", "WebFetch", "TodoWrite", "Task", "Future Tool",
    ].map(mapClaudeDelegateToolName)).toEqual([
      "edit_file", "edit_file", "write_file", "multi_edit", "read_file", "grep", "glob",
      "bash", "web_search", "web_fetch", "todo_write", "task", "delegate_future_tool",
    ]);
  });

  test("admits only healthy full-profile write work under the configured policy", () => {
    const config = defaultConfig();
    const base = {
      config,
      profile: "full" as const,
      writeEffectRequired: true,
      nativeNoWrite: false,
      healthAvailable: true,
      allowedRoots: ["C:\\repo"],
    };
    expect(delegateEligibility(base)).toEqual({ eligible: true });
    expect(delegateEligibility({ ...base, profile: "read_only" })).toEqual({ eligible: false, reason: "profile" });
    expect(delegateEligibility({ ...base, writeEffectRequired: false })).toEqual({ eligible: false, reason: "write_not_required" });
    expect(delegateEligibility({ ...base, healthAvailable: false })).toEqual({ eligible: false, reason: "cooldown" });
    expect(delegateEligibility({ ...base, allowedRoots: [] })).toEqual({ eligible: false, reason: "no_allowed_root" });
    config.claude_cli.enabled = false;
    expect(delegateEligibility(base)).toEqual({ eligible: false, reason: "claude_cli_disabled" });
    config.claude_cli.enabled = true;
    config.claude_cli.delegate.enabled = false;
    expect(delegateEligibility(base)).toEqual({ eligible: false, reason: "delegate_disabled" });
    config.claude_cli.delegate.enabled = true;
    config.claude_cli.delegate.policy = "escalation";
    expect(delegateEligibility(base)).toEqual({ eligible: false, reason: "awaiting_native_no_write" });
    expect(delegateEligibility({ ...base, nativeNoWrite: true })).toEqual({ eligible: true });
  });

  test("builds only installed stock-CLI flags, auth environment, and P0 root cwd", () => {
    const config = defaultConfig();
    config.claude_cli.auth_mode = "subscription";
    config.claude_cli.delegate.model = "sonnet";
    config.claude_cli.delegate.permission_mode = "bypassPermissions";
    config.claude_cli.delegate.allowed_tools = ["Read", "Bash(git *)"];
    const invocation = buildClaudeDelegateInvocation({
      config,
      prompt: "make the change",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\primary", "D:\\extra"],
      stageRemainingMs: 500_000,
      executable: "claude",
      baseEnv: {
        PATH: "test-path",
        ANTHROPIC_API_KEY: "subscription-secret",
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      },
    });

    expect(invocation.cwd).toBe("C:\\primary");
    expect(invocation.timeoutMs).toBe(420_000);
    expect(invocation.env.ANTHROPIC_API_KEY).toBe("subscription-secret");
    expect(invocation.args).toEqual([
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", "bypassPermissions",
      "--session-id", "123e4567-e89b-42d3-a456-426614174000",
      "--no-session-persistence",
      "--model", "sonnet",
      "--add-dir", "D:\\extra",
      "--allowedTools", "Read,Bash(git *)",
      "make the change",
    ]);
    expect(invocation.args).not.toContain("--bare");
  });

  test("uses Task 3 proxy projection while leaving an empty delegate model to the proxy default", () => {
    const config = defaultConfig();
    config.claude_cli.auth_mode = "proxy";
    config.claude_cli.delegate.model = "";
    const invocation = buildClaudeDelegateInvocation({
      config,
      prompt: "make the change",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\primary"],
      stageRemainingMs: 12_000,
      executable: "claude",
      baseEnv: { ANTHROPIC_API_KEY: "must-be-scrubbed" },
    });

    expect(invocation.args).toContain("--bare");
    expect(invocation.args).not.toContain("--model");
    expect(invocation.env.ANTHROPIC_API_KEY).toBe("ollama");
    expect(invocation.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:19878");
    expect(invocation.timeoutMs).toBe(12_000);
  });

  test("cools down for ten minutes after delegate integrity strikes", () => {
    let now = 1_000;
    const health = new DelegateHealth(() => now);
    expect(health.isAvailable()).toBe(true);
    health.strike("unverified_write");
    expect(health.snapshot()).toEqual({
      strikes: 1,
      cooldownUntil: 601_000,
      lastReason: "unverified_write",
    });
    expect(health.isAvailable()).toBe(false);
    now = 600_999;
    expect(health.isAvailable()).toBe(false);
    now = 601_000;
    expect(health.isAvailable()).toBe(true);
    health.markHealthy();
    expect(health.snapshot().strikes).toBe(0);
  });

  test("downgrades each claimed write without matching ground-truth change before effect gating", async () => {
    const config = defaultConfig();
    const before: DelegateRootSnapshot = {
      root: "C:\\repo",
      kind: "git",
      status: " M other.ts",
      diffStat: " other.ts | 1 +",
      fingerprint: "same",
      files: { "c:\\repo\\claimed.ts": "100:10" },
    };
    const after = { ...before };
    let captures = 0;
    const health = new DelegateHealth(() => 10_000);
    const output = await runClaudeDelegate({
      config,
      prompt: "write claimed.ts",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 30_000,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health,
      snapshotFactory: {
        capture: async () => (++captures === 1 ? [before] : [after]),
      },
      processFactory: async () => ({
        events: (async function* () {
          yield {
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "write-1", name: "Write", input: { file_path: "claimed.ts" } }] },
          };
          yield {
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: "write-1", content: "x".repeat(20_000) }] },
          };
          yield { type: "result", result: "done" };
        })(),
        exit: Promise.resolve({ code: 0, signal: null }),
        kill: () => {},
      }),
    });

    expect(output.ok).toBe(false);
    expect(output.errorCode).toBe("delegate_write_unverified");
    expect(output.toolCalls[0]).toMatchObject({
      name: "write_file",
      is_error: true,
      error_code: "delegate_write_unverified",
    });
    expect(output.toolCalls[0].output.length).toBeLessThanOrEqual(6_000);
    expect(output.toolCalls.filter((record) => record.name === "git_metadata")).toHaveLength(1);
    expect(health.snapshot().lastReason).toBe("unverified_write");
  });

  test("accepts verified writes and truncates delegate tool output with the shared context policy", async () => {
    const config = defaultConfig();
    const snapshots: DelegateRootSnapshot[][] = [[{
      root: "C:\\repo",
      kind: "git",
      status: "",
      diffStat: "",
      fingerprint: "before",
      files: { "c:\\repo\\claimed.ts": "100:10" },
    }], [{
      root: "C:\\repo",
      kind: "git",
      status: " M claimed.ts",
      diffStat: " claimed.ts | 2 ++",
      fingerprint: "after",
      files: { "c:\\repo\\claimed.ts": "200:12" },
    }]];
    const health = new DelegateHealth();
    const output = await runClaudeDelegate({
      config,
      prompt: "write claimed.ts",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 30_000,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health,
      snapshotFactory: { capture: async () => snapshots.shift()! },
      processFactory: async () => ({
        events: (async function* () {
          yield { type: "assistant", message: { content: [
            { type: "text", text: "Applied the change." },
            { type: "tool_use", id: "write-1", name: "Write", input: { file_path: "claimed.ts" } },
          ] } };
          yield { type: "user", message: { content: [{
            type: "tool_result",
            tool_use_id: "write-1",
            content: "x".repeat(20_000),
          }] } };
          yield { type: "result" };
        })(),
        exit: Promise.resolve({ code: 0, signal: null }),
        kill: () => {},
      }),
    });

    expect(output.ok).toBe(true);
    expect(output.narrative).toBe("Applied the change.");
    expect(output.toolCalls[0].is_error).toBe(false);
    expect(output.toolCalls[0].output.length).toBeLessThanOrEqual(6_000);
    expect(output.toolCalls[0].output).toContain("truncated");
    expect(output.toolCalls.at(-1)?.output).toContain("claimed.ts | 2 ++");
  });

  test("terminates then kills a timed-out child and cools down when it produced zero writes", async () => {
    const config = defaultConfig();
    const kills: string[] = [];
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo",
      kind: "git",
      status: "",
      diffStat: "",
      fingerprint: "same",
      files: {},
    };
    const health = new DelegateHealth();
    let finish!: (exit: { code: number | null; signal: string | null }) => void;
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => { finish = resolve; });
    const output = await runClaudeDelegate({
      config,
      prompt: "change it",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 5,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health,
      terminationGraceMs: 5,
      snapshotFactory: { capture: async () => [snapshot] },
      processFactory: async () => ({
        events: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
        exit,
        kill: (signal) => {
          kills.push(signal);
          if (signal === "SIGKILL") finish({ code: null, signal });
        },
      }),
    });

    expect(output).toMatchObject({ ok: false, terminalStatus: "timed_out", errorCode: "delegate_timeout" });
    expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(health.snapshot().lastReason).toBe("timeout_without_write");
  }, 200);

  test("wires caller abort to child termination and returns cancelled output", async () => {
    const config = defaultConfig();
    const controller = new AbortController();
    const kills: string[] = [];
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "same", files: {},
    };
    let finish!: (exit: { code: number | null; signal: string | null }) => void;
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => { finish = resolve; });
    const outputPromise = runClaudeDelegate({
      config,
      prompt: "change it",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 30_000,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health: new DelegateHealth(),
      signal: controller.signal,
      terminationGraceMs: 5,
      snapshotFactory: { capture: async () => [snapshot] },
      processFactory: async () => ({
        events: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
        exit,
        kill: (signal) => {
          kills.push(signal);
          finish({ code: null, signal });
        },
      }),
    });
    setTimeout(() => controller.abort(), 1);
    const output = await outputPromise;

    expect(output).toMatchObject({ ok: false, terminalStatus: "cancelled", errorCode: "delegate_aborted" });
    expect(kills).toEqual(["SIGTERM"]);
  });

  test("strikes health on spawn errors and clean no-event exits", async () => {
    const config = defaultConfig();
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "same", files: {},
    };
    const base = {
      config,
      prompt: "change it",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 30_000,
      profile: "full" as const,
      writeEffectRequired: true,
      nativeNoWrite: false,
      snapshotFactory: { capture: async () => [snapshot] },
    };
    const spawnHealth = new DelegateHealth();
    const spawn = await runClaudeDelegate({
      ...base,
      health: spawnHealth,
      processFactory: async () => { throw new Error("ENOENT"); },
    });
    expect(spawn.errorCode).toBe("delegate_spawn_error");
    expect(spawnHealth.snapshot().lastReason).toBe("spawn_error");

    const exitHealth = new DelegateHealth();
    const noEvents = await runClaudeDelegate({
      ...base,
      health: exitHealth,
      processFactory: async () => ({
        events: (async function* () {})(),
        exit: Promise.resolve({ code: 0, signal: null }),
        kill: () => {},
      }),
    });
    expect(noEvents.errorCode).toBe("delegate_no_events");
    expect(exitHealth.snapshot().lastReason).toBe("no_event_exit");
  });
});
