import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config";
import {
  buildClaudeDelegateInvocation,
  ClaudeDelegateAvailabilityCache,
  createPlatformDelegateProcessTreeKiller,
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

  test("maps canonical Jarvis names to themselves (not delegate_* fallback)", () => {
    // Models that read native TOOL_GUIDELINES emit write_file rather than Write.
    // Without self-aliases those become delegate_write_file and fail policy.
    expect([
      "write_file", "edit_file", "multi_edit", "read_file",
      "web_search", "web_fetch", "todo_write", "apply_patch",
      "list_directory", "git_metadata",
    ].map(mapClaudeDelegateToolName)).toEqual([
      "write_file", "edit_file", "multi_edit", "read_file",
      "web_search", "web_fetch", "todo_write", "apply_patch",
      "list_directory", "git_metadata",
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

  test("refuses subscription mode so the automated delegate never spends Claude quota", () => {
    // Free-routing imperative: the delegate is automated, so subscription mode
    // (which bypasses the local proxy and bills the user's Anthropic quota) must
    // make it ineligible — the free native local loop runs instead. Subscription
    // remains a manual, interactive opt-in; it is never auto-selected here.
    const config = defaultConfig();
    config.claude_cli.auth_mode = "subscription";
    const base = {
      config,
      profile: "full" as const,
      writeEffectRequired: true,
      nativeNoWrite: false,
      healthAvailable: true,
      allowedRoots: ["C:\\repo"],
    };
    expect(delegateEligibility(base)).toEqual({ eligible: false, reason: "subscription_mode" });

    config.claude_cli.auth_mode = "proxy";
    expect(delegateEligibility(base)).toEqual({ eligible: true });
  });

  test("proxy-mode spawn env is routed to the local proxy and carries no real credential", () => {
    // The single regression that would silently route to Anthropic is a spawn
    // env missing the local BASE_URL (or leaking a real key). Pin both: the CLI
    // this invocation launches can only reach 127.0.0.1:19878, and --bare is
    // present so the CLI restricts auth to the (dummy) key we inject.
    const config = defaultConfig();
    expect(config.claude_cli.auth_mode).toBe("proxy");
    const invocation = buildClaudeDelegateInvocation({
      config,
      prompt: "make the change",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\primary"],
      stageRemainingMs: 500_000,
      executable: "claude",
      baseEnv: {
        PATH: "test-path",
        ANTHROPIC_API_KEY: "real-secret-should-be-dropped",
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        CLAUDE_CODE_OAUTH_TOKEN: "real-oauth-should-be-dropped",
      },
    });

    expect(invocation.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:19878");
    expect(invocation.env.ANTHROPIC_API_KEY).not.toBe("real-secret-should-be-dropped");
    expect(invocation.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(invocation.args).toContain("--bare");
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
      "--tools", "Read",
      "--allowedTools", "Read",
      "--",
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

  test("normalizes Jarvis run identifiers to the UUID format required by stock Claude", () => {
    const invocation = buildClaudeDelegateInvocation({
      config: defaultConfig(),
      prompt: "make the change",
      sessionId: "run_07f80253-0f76-4184-8f30-bfdcccecfc2a",
      allowedRoots: ["C:\\primary"],
      stageRemainingMs: 12_000,
      executable: "claude",
      baseEnv: {},
    });
    const index = invocation.args.indexOf("--session-id");
    expect(invocation.args[index + 1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test("default invocation exposes only root-confinable direct tools and strips configured shell auto-allows", () => {
    const config = defaultConfig();
    config.claude_cli.delegate.allowed_tools.push("Bash(powershell:*)");
    const invocation = buildClaudeDelegateInvocation({
      config,
      prompt: "make the change",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\primary"],
      stageRemainingMs: 12_000,
      executable: "claude",
      baseEnv: {},
    });
    const serialized = invocation.args.join(" ");

    expect(serialized).toContain("--tools Read,Edit,Write,MultiEdit,Grep,Glob,WebSearch,WebFetch,TodoWrite");
    expect(invocation.args[invocation.args.indexOf("--allowedTools") + 2]).toBe("--");
    expect(serialized).not.toContain("Bash(");
    expect(config.claude_cli.delegate.allowed_tools).toContain("Bash(powershell:*)");
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

  test("availability caches for five minutes and requires port 19878 in proxy mode", async () => {
    let now = 10_000;
    let cliChecks = 0;
    let proxyChecks = 0;
    let proxyListening = false;
    const availability = new ClaudeDelegateAvailabilityCache({
      now: () => now,
      checkCli: async () => {
        cliChecks += 1;
        return true;
      },
      checkProxyPort: async (port) => {
        proxyChecks += 1;
        expect(port).toBe(19_878);
        return proxyListening;
      },
    });
    const config = defaultConfig();
    config.claude_cli.auth_mode = "proxy";

    expect(await availability.isAvailable(config)).toBe(false);
    proxyListening = true;
    now += 299_999;
    expect(await availability.isAvailable(config)).toBe(false);
    expect(cliChecks).toBe(1);
    expect(proxyChecks).toBe(1);

    now += 1;
    expect(await availability.isAvailable(config)).toBe(true);
    expect(cliChecks).toBe(2);
    expect(proxyChecks).toBe(2);

    config.claude_cli.auth_mode = "subscription";
    expect(await availability.isAvailable(config)).toBe(true);
    expect(cliChecks).toBe(3);
    expect(proxyChecks).toBe(2);
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
    const streamedText: string[] = [];
    const streamedTools: string[] = [];
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
      onTextDelta: (text) => streamedText.push(text),
      onToolUse: (record) => streamedTools.push(record.name),
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
    expect(streamedText).toEqual(["Applied the change."]);
    expect(streamedTools).toEqual(["write_file"]);
  });

  test("rejects an out-of-root Bash write as unverifiable policy evidence", async () => {
    const config = defaultConfig();
    config.claude_cli.delegate.allowed_tools.push("Bash(python:*)");
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "same", files: {},
    };
    const output = await runClaudeDelegate({
      config,
      prompt: "write outside",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 30_000,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health: new DelegateHealth(),
      snapshotFactory: { capture: async () => [snapshot] },
      processFactory: async () => ({
        events: (async function* () {
          yield { type: "assistant", message: { content: [{
            type: "tool_use",
            id: "bash-1",
            name: "Bash",
            input: { command: "python -c write C:\\outside\\escape.txt" },
          }] } };
          yield { type: "user", message: { content: [{
            type: "tool_result", tool_use_id: "bash-1", content: "wrote outside",
          }] } };
          yield { type: "result", result: "done" };
        })(),
        exit: Promise.resolve({ code: 0, signal: null }),
        kill: () => {},
      }),
    });

    expect(output).toMatchObject({ ok: false, errorCode: "delegate_tool_not_permitted" });
    expect(output.toolCalls[0]).toMatchObject({ name: "bash", is_error: true, error_code: "policy_denied" });
  });

  test("rejects a safe stock tool event that was not enabled in delegate config", async () => {
    const config = defaultConfig();
    config.claude_cli.delegate.allowed_tools = ["Read"];
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "same", files: {},
    };
    const output = await runClaudeDelegate({
      config,
      prompt: "read only",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 30_000,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health: new DelegateHealth(),
      snapshotFactory: { capture: async () => [snapshot] },
      processFactory: async () => ({
        events: (async function* () {
          yield { type: "assistant", message: { content: [{
            type: "tool_use", id: "write-1", name: "Write", input: { file_path: "forged.ts" },
          }] } };
          yield { type: "user", message: { content: [{
            type: "tool_result", tool_use_id: "write-1", content: "claimed write",
          }] } };
          yield { type: "result", result: "done" };
        })(),
        exit: Promise.resolve({ code: 0, signal: null }),
        kill: () => {},
      }),
    });

    expect(output).toMatchObject({ ok: false, errorCode: "delegate_tool_not_permitted" });
    expect(output.toolCalls[0]).toMatchObject({ name: "write_file", is_error: true, error_code: "policy_denied" });
  });

  test("permits canonical write_file when Write is in allowed_tools (F1 vocabulary mismatch)", async () => {
    // Eval 2026-07-21 T1: model emitted write_file; permit gate only checked
    // stock names → delegate_tool_not_permitted. Canonical identity must pass
    // when the corresponding stock tool is allowed.
    const config = defaultConfig();
    // Default allowed_tools includes Write (root-confinable set).
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
            { type: "text", text: "Applied via canonical name." },
            { type: "tool_use", id: "write-1", name: "write_file", input: { file_path: "claimed.ts" } },
          ] } };
          yield { type: "user", message: { content: [{
            type: "tool_result",
            tool_use_id: "write-1",
            content: "wrote claimed.ts",
          }] } };
          yield { type: "result" };
        })(),
        exit: Promise.resolve({ code: 0, signal: null }),
        kill: () => {},
      }),
    });

    expect(output.ok).toBe(true);
    expect(output.toolCalls[0]).toMatchObject({
      name: "write_file",
      is_error: false,
    });
    expect(output.toolCalls[0].error_code).toBeUndefined();
    expect(health.snapshot().lastReason).toBeUndefined();
  });

  test("still denies Bash when only Read is allowed (canonical permit is not a free pass)", async () => {
    const config = defaultConfig();
    config.claude_cli.delegate.allowed_tools = ["Read"];
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "same", files: {},
    };
    const output = await runClaudeDelegate({
      config,
      prompt: "no shell",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 30_000,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health: new DelegateHealth(),
      snapshotFactory: { capture: async () => [snapshot] },
      processFactory: async () => ({
        events: (async function* () {
          yield { type: "assistant", message: { content: [{
            type: "tool_use", id: "bash-1", name: "Bash",
            input: { command: "echo hi" },
          }] } };
          yield { type: "user", message: { content: [{
            type: "tool_result", tool_use_id: "bash-1", content: "hi",
          }] } };
          yield { type: "result", result: "done" };
        })(),
        exit: Promise.resolve({ code: 0, signal: null }),
        kill: () => {},
      }),
    });

    expect(output).toMatchObject({ ok: false, errorCode: "delegate_tool_not_permitted" });
    expect(output.toolCalls[0]).toMatchObject({ name: "bash", is_error: true, error_code: "policy_denied" });
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
    let captures = 0;
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
      snapshotFactory: { capture: async () => { captures += 1; return [snapshot]; } },
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
    expect(captures).toBe(1);
    expect(output.toolCalls).toContainEqual(expect.objectContaining({
      name: "delegate_cleanup",
      arguments: { status: "terminated" },
      is_error: false,
    }));
  }, 1_000);

  test("verifies a claimed write after execution timeout using a separate bounded snapshot", async () => {
    const config = defaultConfig();
    const before: DelegateRootSnapshot = {
      root: "C:\\repo",
      kind: "git",
      status: "",
      diffStat: "",
      fingerprint: "before",
      files: { "c:\\repo\\claimed.ts": "100:10" },
    };
    const after: DelegateRootSnapshot = {
      ...before,
      status: " M claimed.ts",
      diffStat: " claimed.ts | 2 ++",
      fingerprint: "after",
      files: { "c:\\repo\\claimed.ts": "200:12" },
    };
    let captures = 0;
    let finish!: (exit: { code: number | null; signal: string | null }) => void;
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => { finish = resolve; });
    const output = await runClaudeDelegate({
      config,
      prompt: "change it",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 15,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health: new DelegateHealth(),
      terminationGraceMs: 1,
      cleanupTimeoutMs: 20,
      verificationTimeoutMs: 30,
      snapshotFactory: {
        capture: async () => {
          captures += 1;
          return captures === 1 ? [before] : [after];
        },
      },
      processFactory: async () => ({
        events: (async function* () {
          yield { type: "assistant", message: { content: [{
            type: "tool_use", id: "write-1", name: "Write", input: { file_path: "claimed.ts" },
          }] } };
          yield { type: "user", message: { content: [{
            type: "tool_result", tool_use_id: "write-1", content: "claimed write",
          }] } };
          await new Promise(() => {});
        })(),
        exit,
        kill: (signal) => {
          if (signal === "SIGKILL") finish({ code: null, signal });
        },
      }),
    });

    expect(captures).toBe(2);
    expect(output).toMatchObject({ ok: false, terminalStatus: "timed_out", errorCode: "delegate_timeout" });
    expect(output.toolCalls).toContainEqual(expect.objectContaining({
      name: "write_file",
      is_error: false,
    }));
    expect(output.toolCalls.at(-1)).toMatchObject({ name: "git_metadata", is_error: false });
    // 250ms was tight under suite load — this test runs two snapshot captures plus
    // a SIGTERM-then-SIGKILL teardown under a 15ms stage budget. The behavior
    // under test is the verification-snapshot path, not the timing precision, so
    // 1000ms gives the same signal without flaking.
  }, 1000);

  test("abort remains terminal after bounded verification of an already-claimed write", async () => {
    const config = defaultConfig();
    const controller = new AbortController();
    const before: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "before",
      files: { "c:\\repo\\claimed.ts": "100:10" },
    };
    const after: DelegateRootSnapshot = {
      ...before, fingerprint: "after", status: " M claimed.ts", diffStat: " claimed.ts | 1 +",
      files: { "c:\\repo\\claimed.ts": "200:11" },
    };
    let captures = 0;
    let finish!: (exit: { code: number | null; signal: string | null }) => void;
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => { finish = resolve; });
    const output = await runClaudeDelegate({
      config,
      prompt: "change it",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 1_000,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health: new DelegateHealth(),
      signal: controller.signal,
      terminationGraceMs: 1,
      cleanupTimeoutMs: 20,
      verificationTimeoutMs: 30,
      snapshotFactory: { capture: async () => (++captures === 1 ? [before] : [after]) },
      processFactory: async () => ({
        events: (async function* () {
          yield { type: "assistant", message: { content: [{
            type: "tool_use", id: "write-1", name: "Write", input: { file_path: "claimed.ts" },
          }] } };
          yield { type: "user", message: { content: [{
            type: "tool_result", tool_use_id: "write-1", content: "claimed write",
          }] } };
          controller.abort("user_stop");
          await new Promise(() => {});
        })(),
        exit,
        kill: (signal) => { if (signal === "SIGKILL") finish({ code: null, signal }); },
      }),
    });

    expect(captures).toBe(2);
    expect(output).toMatchObject({ ok: false, terminalStatus: "cancelled", errorCode: "delegate_aborted" });
    expect(output.toolCalls).toContainEqual(expect.objectContaining({ name: "write_file", is_error: false }));
  }, 250);

  test("unconfirmed cleanup makes a timed-out claimed write unsafe without post-run verification", async () => {
    const config = defaultConfig();
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "before",
      files: { "c:\\repo\\claimed.ts": "100:10" },
    };
    const health = new DelegateHealth();
    let captures = 0;
    const started = Date.now();
    const output = await runClaudeDelegate({
      config,
      prompt: "change it",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 15,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health,
      terminationGraceMs: 1,
      cleanupTimeoutMs: 10,
      verificationTimeoutMs: 30,
      treeKiller: { signalTree: async () => {} },
      snapshotFactory: { capture: async () => { captures += 1; return [snapshot]; } },
      processFactory: async () => ({
        events: (async function* () {
          yield { type: "assistant", message: { content: [{
            type: "tool_use", id: "write-1", name: "Write", input: { file_path: "claimed.ts" },
          }] } };
          yield { type: "user", message: { content: [{
            type: "tool_result", tool_use_id: "write-1", content: "claimed write",
          }] } };
          await new Promise(() => {});
        })(),
        exit: new Promise(() => {}),
        kill: () => {},
      }),
    });

    expect(Date.now() - started).toBeLessThan(250);
    expect(captures).toBe(1);
    expect(output).toMatchObject({
      ok: false,
      terminalStatus: "failed",
      errorCode: "delegate_cleanup_unconfirmed",
    });
    expect(output.toolCalls).toContainEqual(expect.objectContaining({
      name: "write_file",
      error_code: "delegate_write_unverified",
    }));
    expect(health.snapshot().lastReason).toBe("termination_unconfirmed");
  }, 300);

  test("uses the injected tree killer for TERM then forced KILL so grandchildren cannot leak", async () => {
    const config = defaultConfig();
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "same", files: {},
    };
    const signals: string[] = [];
    let parentAlive = true;
    let grandchildAlive = true;
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
      health: new DelegateHealth(),
      terminationGraceMs: 5,
      snapshotFactory: { capture: async () => [snapshot] },
      treeKiller: {
        signalTree: async (_process, signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") {
            parentAlive = false;
            finish({ code: null, signal });
            grandchildAlive = false;
          }
        },
      },
      processFactory: async () => ({
        events: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
        exit,
        kill: () => { throw new Error("direct-child kill must not be used"); },
      }),
    });

    expect(output.terminalStatus).toBe("timed_out");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(parentAlive).toBe(false);
    expect(grandchildAlive).toBe(false);
  });

  test("treats a failed Windows forced taskkill as uncertain termination", async () => {
    const config = defaultConfig();
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "same", files: {},
    };
    const health = new DelegateHealth();
    const taskkillCalls: string[][] = [];
    const treeKiller = createPlatformDelegateProcessTreeKiller({
      platform: "win32",
      execute: async (executable, args) => {
        expect(executable).toBe("taskkill");
        taskkillCalls.push(args);
        if (args.includes("/F")) throw new Error("Access is denied");
        return "TERM sent";
      },
    });
    const output = await runClaudeDelegate({
      config,
      prompt: "change it",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 1,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health,
      terminationGraceMs: 2,
      cleanupTimeoutMs: 300,
      snapshotFactory: { capture: async () => [snapshot] },
      treeKiller,
      processFactory: async () => ({
        pid: 424_242,
        events: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
        exit: new Promise(() => {}),
        kill: () => { throw new Error("Windows tree killer must use taskkill"); },
      }),
    });

    expect(taskkillCalls).toEqual([
      ["/PID", "424242", "/T"],
      ["/PID", "424242", "/T", "/F"],
    ]);
    expect(output).toMatchObject({ ok: false, terminalStatus: "failed", errorCode: "delegate_cleanup_unconfirmed" });
    expect(output.toolCalls).toContainEqual(expect.objectContaining({
      name: "delegate_cleanup",
      arguments: { status: "signal_error" },
      is_error: true,
      error_code: "delegate_cleanup_signal_error",
    }));
    expect(output.toolCalls).not.toContainEqual(expect.objectContaining({
      name: "delegate_cleanup",
      arguments: { status: "terminated" },
    }));
    expect(health.snapshot().lastReason).toBe("termination_unconfirmed");
  }, 1_000);

  test("forces KILL and reports uncertainty when TERM fails despite direct child exit", async () => {
    const config = defaultConfig();
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "same", files: {},
    };
    const health = new DelegateHealth();
    const signals: string[] = [];
    const output = await runClaudeDelegate({
      config,
      prompt: "change it",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 1,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health,
      terminationGraceMs: 2,
      cleanupTimeoutMs: 300,
      snapshotFactory: { capture: async () => [snapshot] },
      treeKiller: {
        signalTree: async (_process, signal) => {
          signals.push(signal);
          if (signal === "SIGTERM") throw new Error("TERM tree signal failed");
        },
      },
      processFactory: async () => ({
        events: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
        exit: Promise.resolve({ code: 0, signal: null }),
        kill: () => {},
      }),
    });

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(output).toMatchObject({ ok: false, terminalStatus: "failed", errorCode: "delegate_cleanup_unconfirmed" });
    expect(output.toolCalls).toContainEqual(expect.objectContaining({
      name: "delegate_cleanup",
      arguments: { status: "signal_error" },
      is_error: true,
      error_code: "delegate_cleanup_signal_error",
    }));
    expect(output.toolCalls).not.toContainEqual(expect.objectContaining({
      name: "delegate_cleanup",
      arguments: { status: "terminated" },
    }));
    expect(health.snapshot().lastReason).toBe("termination_unconfirmed");
  }, 1_000);

  test("bounds teardown after forced KILL when the child exit promise never settles", async () => {
    const config = defaultConfig();
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "same", files: {},
    };
    const signals: string[] = [];
    const health = new DelegateHealth();
    const started = Date.now();
    const output = await Promise.race([
      runClaudeDelegate({
        config,
        prompt: "change it",
        sessionId: "123e4567-e89b-42d3-a456-426614174000",
        allowedRoots: ["C:\\repo"],
        stageRemainingMs: 1,
        profile: "full",
        writeEffectRequired: true,
        nativeNoWrite: false,
        health,
        terminationGraceMs: 2,
        cleanupTimeoutMs: 8,
        snapshotFactory: { capture: async () => [snapshot] },
        treeKiller: {
          signalTree: async (_process, signal) => { signals.push(signal); },
        },
        processFactory: async () => ({
          events: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
          exit: new Promise(() => {}),
          kill: () => {},
        }),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("delegate teardown did not resolve")), 500)),
    ]);

    expect(Date.now() - started).toBeLessThan(500);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(output).toMatchObject({ ok: false, terminalStatus: "failed", errorCode: "delegate_cleanup_unconfirmed" });
    expect(output.toolCalls).toContainEqual(expect.objectContaining({
      name: "delegate_cleanup",
      is_error: true,
      error_code: "delegate_cleanup_unconfirmed",
    }));
    expect(health.snapshot().lastReason).toBe("termination_unconfirmed");
  }, 1_000);

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
    expect(output.toolCalls).toContainEqual(expect.objectContaining({
      name: "delegate_cleanup",
      arguments: { status: "terminated" },
      is_error: false,
    }));
  });

  test("abort during the pre-snapshot cancels the whole operation without launching a child", async () => {
    const config = defaultConfig();
    const controller = new AbortController();
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "same", files: {},
    };
    let launches = 0;
    const outputPromise = runClaudeDelegate({
      config,
      prompt: "change it",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 100,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health: new DelegateHealth(),
      signal: controller.signal,
      snapshotFactory: {
        capture: async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return [snapshot];
        },
      },
      processFactory: async () => {
        launches += 1;
        return {
          events: (async function* () { yield { type: "result", result: "too late" }; })(),
          exit: Promise.resolve({ code: 0, signal: null }),
          kill: () => {},
        };
      },
    });
    setTimeout(() => controller.abort(), 1);
    const output = await outputPromise;

    expect(output).toMatchObject({ ok: false, terminalStatus: "cancelled", errorCode: "delegate_aborted" });
    expect(launches).toBe(0);
  });

  test("an already-aborted operation starts neither snapshots nor child launch", async () => {
    const config = defaultConfig();
    const controller = new AbortController();
    controller.abort();
    let captures = 0;
    let launches = 0;
    const output = await runClaudeDelegate({
      config,
      prompt: "change it",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 100,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health: new DelegateHealth(),
      signal: controller.signal,
      snapshotFactory: { capture: async () => { captures += 1; return []; } },
      processFactory: async () => {
        launches += 1;
        throw new Error("must not launch");
      },
    });

    expect(output).toMatchObject({ terminalStatus: "cancelled", errorCode: "delegate_aborted" });
    expect(captures).toBe(0);
    expect(launches).toBe(0);
  });

  test("deadline covers a non-cancellable delayed pre-snapshot and prevents launch", async () => {
    const config = defaultConfig();
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "same", files: {},
    };
    let launches = 0;
    const started = Date.now();
    const output = await runClaudeDelegate({
      config,
      prompt: "change it",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 10,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health: new DelegateHealth(),
      snapshotFactory: {
        capture: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return [snapshot];
        },
      },
      processFactory: async () => {
        launches += 1;
        throw new Error("must not launch");
      },
    });

    expect(output).toMatchObject({ terminalStatus: "timed_out", errorCode: "delegate_timeout" });
    expect(launches).toBe(0);
    expect(Date.now() - started).toBeLessThan(50);
  });

  test("deadline covers delayed process-factory launch and fences a late child", async () => {
    const config = defaultConfig();
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "same", files: {},
    };
    const kills: string[] = [];
    let resolveLaunch!: (process: {
      events: AsyncIterable<unknown>;
      exit: Promise<{ code: number | null; signal: string | null }>;
      kill: (signal: "SIGTERM" | "SIGKILL") => void;
    }) => void;
    const launch = new Promise<{
      events: AsyncIterable<unknown>;
      exit: Promise<{ code: number | null; signal: string | null }>;
      kill: (signal: "SIGTERM" | "SIGKILL") => void;
    }>((resolve) => { resolveLaunch = resolve; });
    const output = await runClaudeDelegate({
      config,
      prompt: "change it",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 10,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health: new DelegateHealth(),
      terminationGraceMs: 1,
      snapshotFactory: { capture: async () => [snapshot] },
      processFactory: async () => launch,
    });
    expect(output).toMatchObject({ terminalStatus: "timed_out", errorCode: "delegate_timeout" });
    expect(output.toolCalls).toContainEqual(expect.objectContaining({
      name: "delegate_cleanup",
      arguments: { status: "factory_unsettled" },
      is_error: true,
    }));

    let finish!: (exit: { code: number | null; signal: string | null }) => void;
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => { finish = resolve; });
    resolveLaunch({
      events: (async function* () {})(),
      exit,
      kill: (signal) => {
        kills.push(signal);
        if (signal === "SIGKILL") finish({ code: null, signal });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("observes a late factory cleanup rejection and returns a bounded known outcome", async () => {
    const config = defaultConfig();
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "same", files: {},
    };
    const signals: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const started = Date.now();
      const output = await Promise.race([
        runClaudeDelegate({
          config,
          prompt: "change it",
          sessionId: "123e4567-e89b-42d3-a456-426614174000",
          allowedRoots: ["C:\\repo"],
          stageRemainingMs: 1,
          profile: "full",
          writeEffectRequired: true,
          nativeNoWrite: false,
          health: new DelegateHealth(),
          terminationGraceMs: 2,
          cleanupTimeoutMs: 300,
          snapshotFactory: { capture: async () => [snapshot] },
          processFactory: async () => {
            await new Promise((resolve) => setTimeout(resolve, 4));
            return {
              events: (async function* () {})(),
              exit: new Promise<{ code: number | null; signal: string | null }>(() => {}),
              kill: () => {},
            };
          },
          treeKiller: {
            signalTree: async (_process, signal) => {
              signals.push(signal);
              if (signal === "SIGKILL") throw new Error("forced tree kill failed");
            },
          },
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late cleanup did not resolve")), 1_000)),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(Date.now() - started).toBeLessThan(1_000);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(unhandled).toEqual([]);
      expect(output).toMatchObject({ ok: false, terminalStatus: "timed_out", errorCode: "delegate_timeout" });
      expect(output.toolCalls).toContainEqual(expect.objectContaining({
        name: "delegate_cleanup",
        is_error: true,
        error_code: "delegate_cleanup_signal_error",
      }));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 1_000);

  test("deadline covers delayed post-snapshot and downgrades unverifiable writes", async () => {
    const config = defaultConfig();
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo",
      kind: "git",
      status: "",
      diffStat: "",
      fingerprint: "before",
      files: { "c:\\repo\\claimed.ts": "100:10" },
    };
    let captures = 0;
    const output = await runClaudeDelegate({
      config,
      prompt: "change it",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 100,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health: new DelegateHealth(),
      verificationTimeoutMs: 25,
      snapshotFactory: {
        capture: async () => {
          captures += 1;
          if (captures > 1) await new Promise((resolve) => setTimeout(resolve, 150));
          return [snapshot];
        },
      },
      processFactory: async () => ({
        events: (async function* () {
          yield { type: "assistant", message: { content: [{
            type: "tool_use", id: "write-1", name: "Write", input: { file_path: "claimed.ts" },
          }] } };
          yield { type: "user", message: { content: [{
            type: "tool_result", tool_use_id: "write-1", content: "claimed write",
          }] } };
          yield { type: "result", result: "done" };
        })(),
        exit: Promise.resolve({ code: 0, signal: null }),
        kill: () => {},
      }),
    });

    expect(output).toMatchObject({ terminalStatus: "timed_out", errorCode: "delegate_timeout" });
    expect(output.toolCalls[0]).toMatchObject({
      name: "write_file", is_error: true, error_code: "delegate_write_unverified",
    });
    expect(output.toolCalls.at(-1)).toMatchObject({ name: "git_metadata", is_error: true });
    expect(output.toolCalls.at(-1)?.output).toContain("verification unavailable");
  }, 250);

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
