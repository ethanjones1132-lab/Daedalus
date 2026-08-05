import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { defaultConfig, type JarvisConfig } from "../config";
import { readFileSync } from "fs";
import {
  buildClaudeDelegateInvocation,
  canonicalizeDelegateToolArguments,
  ClaudeDelegateAvailabilityCache,
  createPlatformDelegateProcessTreeKiller,
  DELEGATE_API_RETRY_ABORT_THRESHOLD,
  DELEGATE_REQUEST_ID_HEADER,
  DelegateHealth,
  delegateEligibility,
  isPermittedDelegateTool,
  mapClaudeDelegateToolName,
  nodeDelegateProcessFactory,
  nodeDelegateSnapshotFactory,
  normalizeDelegateReadFileOutput,
  runClaudeDelegate,
  sanitizeDelegateDiagnosticText,
  shouldSnapshotRelPath,
  withDelegateRequestCorrelation,
  type DelegateRootSnapshot,
} from "./claude-delegate";
import { toolCallIdentityKey } from "./pipeline";
import { delegateToolResultContextChars, WRITE_TURN_TOOL_RESULT_CONTEXT_CHARS } from "./context-budget";
import {
  DELEGATE_MCP_SERVER_NAME,
  DELEGATE_MCP_SESSION_GRANTS_ENV,
  DELEGATE_MCP_WORKSPACE_ENV,
} from "../mcp-adapter";

/** Default delegate model is Anthropic-native (minimax-m3); give tests a Go key. */
function testConfig(): JarvisConfig {
  const config = defaultConfig();
  config.opencode_go.api_key = "go-test-key";
  return config;
}

/**
 * 2026-08-05 live: configuring a CMake build in the Perihelion workspace put
 * 336 untracked artifact files (255 MB) under build/. The repo has no
 * .gitignore, so `git ls-files -co --exclude-standard` returned all of them and
 * the delegate snapshot SHA-256'd every one before the process could launch —
 * throwing delegate_snapshot_error, killing the delegate, and producing a
 * zero-tool turn.
 *
 * This is structurally coupled to the build gate: the CMake detector only fires
 * when build/CMakeCache.txt exists, so the gate's precondition is exactly what
 * broke the snapshot. Build output is never a source mutation — exclude it.
 */
describe("snapshot excludes build output", () => {
  test("excludes common build/artifact directories", () => {
    for (const p of [
      "build/Perihelion.vcxproj",
      "out/x64/thing.obj",
      "dist/bundle.js",
      "target/debug/app.exe",
      "node_modules/pkg/index.js",
      "cmake-build-debug/CMakeCache.txt",
      "JUCE_BUILD/juceaide.exe",
      ".vs/slnx.sqlite",
    ]) {
      expect(shouldSnapshotRelPath(p)).toBe(false);
    }
  });

  test("keeps source files, including nested ones", () => {
    for (const p of [
      "PluginProcessor.cpp",
      "Source/DSPEngine.h",
      "tests/Test_Perihelion.cpp",
      "CMakeLists.txt",
      "docs/rebuild-notes.md",
    ]) {
      expect(shouldSnapshotRelPath(p)).toBe(true);
    }
  });

  test("does not exclude a source file merely because a segment is a prefix", () => {
    expect(shouldSnapshotRelPath("builder/Builder.cpp")).toBe(true);
    expect(shouldSnapshotRelPath("Source/outbound.cpp")).toBe(true);
  });

  test("handles backslash-separated paths (Windows git output)", () => {
    expect(shouldSnapshotRelPath("build\\Perihelion.vcxproj")).toBe(false);
    expect(shouldSnapshotRelPath("Source\\DSPEngine.h")).toBe(true);
  });
});

describe("delegateToolResultContextChars (W1.5)", () => {
  test("uses the write-turn 24k cap, not the 6k read-turn executor cap", () => {
    expect(delegateToolResultContextChars()).toBe(WRITE_TURN_TOOL_RESULT_CONTEXT_CHARS);
    expect(delegateToolResultContextChars()).toBe(24_000);
    expect(delegateToolResultContextChars()).toBeGreaterThan(6_000);
  });
});

describe("normalizeDelegateReadFileOutput (W1.5 EISDIR)", () => {
  test("rewrites raw EISDIR into list_directory guidance", () => {
    const out = normalizeDelegateReadFileOutput(
      "read_file",
      "EISDIR: illegal operation on a directory, read",
      { path: "src" },
    );
    expect(out).toContain("is a directory");
    expect(out).toContain("list_directory");
    expect(out).toContain("src");
  });

  test("leaves already-guided directory errors unchanged", () => {
    const guided = 'Error: "src" is a directory, not a file. Use list_directory to see its contents.';
    expect(normalizeDelegateReadFileOutput("read_file", guided, { path: "src" })).toBe(guided);
  });

  test("does not rewrite non-read tools or ordinary read errors", () => {
    expect(normalizeDelegateReadFileOutput("bash", "EISDIR: x", { path: "src" })).toBe("EISDIR: x");
    expect(normalizeDelegateReadFileOutput("read_file", "ENOENT: no such file", { path: "x" }))
      .toBe("ENOENT: no such file");
  });
});

describe("canonicalizeDelegateToolArguments", () => {
  test("maps Claude CLI file_path to native path for deflection identity", () => {
    const canon = canonicalizeDelegateToolArguments({ file_path: "src/pipeline.ts", offset: 1 });
    expect(canon).toEqual({ path: "src/pipeline.ts", offset: 1 });
    // run_8e930248: delegate-seeded cache key must match native re-query.
    const delegateKey = toolCallIdentityKey({ name: "read_file", arguments: canon });
    const nativeKey = toolCallIdentityKey({
      name: "read_file",
      arguments: { path: "src/pipeline.ts" },
    });
    expect(delegateKey).toBe(nativeKey);
  });
});

describe("withDelegateRequestCorrelation", () => {
  test("sets env id and Claude CLI custom header for the long-lived proxy", () => {
    const env = withDelegateRequestCorrelation(
      { PATH: "/usr/bin", ANTHROPIC_CUSTOM_HEADERS: "X-Existing: keep" },
      "req-uuid-1234",
    );
    expect(env.JARVIS_DELEGATE_REQUEST_ID).toBe("req-uuid-1234");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain("X-Existing: keep");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain(
      `${DELEGATE_REQUEST_ID_HEADER}: req-uuid-1234`,
    );
  });
});

describe("Claude executor delegate", () => {
  test("aborts a repeated api_retry stream instead of waiting for provider backoff", async () => {
    const config = testConfig();
    let kills = 0;
    let signalTreeCalls = 0;
    let finish!: (exit: { code: number | null; signal: string | null }) => void;
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => { finish = resolve; });
    const output = await runClaudeDelegate({
      config,
      prompt: "write the target",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 30_000,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health: new DelegateHealth(),
      terminationGraceMs: 1,
      cleanupTimeoutMs: 30,
      snapshotFactory: { capture: async () => [{
        root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "same", files: {},
      }] },
      treeKiller: {
        signalTree: async (_process, signal) => {
          signalTreeCalls += 1;
          if (signal === "SIGKILL") finish({ code: null, signal });
        },
      },
      processFactory: async () => ({
        events: (async function* () {
          for (let i = 0; i < DELEGATE_API_RETRY_ABORT_THRESHOLD; i += 1) {
            yield { type: "api_retry", retry_count: i + 1 };
          }
          await new Promise(() => {});
        })(),
        exit,
        kill: () => { kills += 1; },
      }),
    });

    expect(output).toMatchObject({
      ok: false,
      errorCode: "delegate_api_retry_storm",
      terminalStatus: "failed",
    });
    expect(output.narrative).toContain("api_retry");
    expect(kills).toBe(0);
    expect(signalTreeCalls).toBeGreaterThanOrEqual(2);
  }, 500);

  test("filesystem snapshots use content hashes instead of mtime/size identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-delegate-"));
    const target = join(root, "same-size.txt");
    try {
      await writeFile(target, "aaaa");
      const before = await nodeDelegateSnapshotFactory.capture([root]);
      await writeFile(target, "bbbb");
      const after = await nodeDelegateSnapshotFactory.capture([root]);
      const beforeIdentity = Object.values(before[0]!.files)[0];
      const afterIdentity = Object.values(after[0]!.files)[0];
      expect(beforeIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(afterIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(afterIdentity).not.toBe(beforeIdentity);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
    const config = testConfig();
    // Default delegate model is Anthropic-native (minimax-m3) → needs a Go key.
    config.opencode_go.api_key = "go-test-key";
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
    const config = testConfig();
    config.opencode_go.api_key = "go-test-key";
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

  test("refuses Anthropic-native opencode_go models when the Go API key is missing", () => {
    const config = testConfig();
    config.claude_cli.auth_mode = "proxy";
    config.claude_cli.delegate.model = "minimax-m3";
    config.opencode_go.api_key = "";
    const base = {
      config,
      profile: "full" as const,
      writeEffectRequired: true,
      nativeNoWrite: false,
      healthAvailable: true,
      allowedRoots: ["C:\\repo"],
    };
    expect(delegateEligibility(base)).toEqual({ eligible: false, reason: "missing_opencode_go_key" });

    config.opencode_go.api_key = "   ";
    expect(delegateEligibility(base)).toEqual({ eligible: false, reason: "missing_opencode_go_key" });

    config.opencode_go.api_key = "go-test-key";
    expect(delegateEligibility(base)).toEqual({ eligible: true });

    // OpenAI-compatible proxy models do not need the Go key for eligibility.
    config.claude_cli.delegate.model = "deepseek-v4-pro";
    config.opencode_go.api_key = "";
    expect(delegateEligibility(base)).toEqual({ eligible: true });
  });

  test("proxy-mode OpenAI-compatible models route to the local proxy and carry no real credential", () => {
    // Non-Anthropic OpenCode Go models still use the Python proxy. Pin both the
    // local BASE_URL and --bare so the CLI cannot reach real Anthropic.
    const config = testConfig();
    config.claude_cli.delegate.model = "deepseek-v4-pro";
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

  test("Anthropic-native delegate models skip the proxy and talk to OpenCode Go directly", () => {
    const config = testConfig();
    config.claude_cli.auth_mode = "proxy";
    config.claude_cli.delegate.model = "minimax-m3";
    config.opencode_go.api_key = "go-delegate-key";
    // Config stores the OpenAI-style root; CLI env must project to host root.
    config.opencode_go.base_url = "https://opencode.ai/zen/go/v1";
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
        ANTHROPIC_BASE_URL: "http://127.0.0.1:19878",
        CLAUDE_CODE_OAUTH_TOKEN: "real-oauth-should-be-dropped",
      },
    });

    expect(invocation.env.ANTHROPIC_BASE_URL).toBe("https://opencode.ai/zen/go");
    expect(invocation.env.ANTHROPIC_API_KEY).toBe("go-delegate-key");
    expect(invocation.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(invocation.args).not.toContain("--bare");
    expect(invocation.args).toContain("minimax-m3");
  });

  test("builds only installed stock-CLI flags, auth environment, and P0 root cwd", () => {
    const config = testConfig();
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

    try {
      expect(invocation.cwd).toBe("C:\\primary");
      expect(invocation.timeoutMs).toBe(420_000);
      expect(invocation.env.ANTHROPIC_API_KEY).toBe("subscription-secret");
      const mcpConfigIdx = invocation.args.indexOf("--mcp-config");
      expect(invocation.args).toContain("--strict-mcp-config");
      expect(mcpConfigIdx).toBeGreaterThan(-1);
      const mcpConfigPath = invocation.args[mcpConfigIdx + 1];
      // Floor tools always re-union even when config listed only Read + patterned Bash
      // (2026-08-04: stale allowlists without Bash broke verification greps).
      const floor = "Read,Edit,Write,MultiEdit,Grep,Glob,Bash,WebSearch,WebFetch,TodoWrite";
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
        "--strict-mcp-config",
        "--mcp-config", mcpConfigPath,
        "--tools", floor,
        "--allowedTools", floor,
        "mcp__jarvis",
        "--",
        "make the change",
      ]);
      expect(invocation.args).not.toContain("--bare");
      // Patterned Bash(...) still never appears on --tools.
      expect(invocation.args.join(" ")).not.toContain("Bash(");
    } finally {
      invocation.cleanup();
    }
  });

  test("uses Task 3 proxy projection while leaving an empty delegate model to the proxy default", () => {
    const config = testConfig();
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
      config: testConfig(),
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

  test("default invocation exposes root-confinable direct tools including Bash and strips patterned shell auto-allows", () => {
    const config = testConfig();
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
    try {
      const serialized = invocation.args.join(" ");

      // Exact "Bash" is root-confinable (cwd = P0 root); patterned Bash(...) is stripped.
      expect(serialized).toContain("--tools Read,Edit,Write,MultiEdit,Grep,Glob,Bash,WebSearch,WebFetch,TodoWrite");
      // --allowedTools is root-confinable floor + jarvis MCP server, then `--`.
      const allowedIdx = invocation.args.indexOf("--allowedTools");
      expect(invocation.args[allowedIdx + 1]).toBe(
        "Read,Edit,Write,MultiEdit,Grep,Glob,Bash,WebSearch,WebFetch,TodoWrite",
      );
      expect(invocation.args[allowedIdx + 2]).toBe("mcp__jarvis");
      expect(invocation.args[allowedIdx + 3]).toBe("--");
      expect(serialized).not.toContain("Bash(");
      expect(serialized).not.toMatch(/(?:^|[\s,])Task(?:[\s,]|$)/);
      expect(config.claude_cli.delegate.allowed_tools).toContain("Bash");
      expect(config.claude_cli.delegate.allowed_tools).toContain("Bash(powershell:*)");
    } finally {
      invocation.cleanup();
    }
  });

  test("delegate invocation wires --mcp-config for Jarvis filesystem/git/task-control bundles", () => {
    const invocation = buildClaudeDelegateInvocation({
      config: testConfig(),
      prompt: "make the change",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\primary", "D:\\extra"],
      stageRemainingMs: 12_000,
      executable: "claude",
      baseEnv: {},
    });
    try {
      expect(invocation.args).toContain("--strict-mcp-config");
      const mcpIdx = invocation.args.indexOf("--mcp-config");
      expect(mcpIdx).toBeGreaterThan(-1);
      const mcpPath = invocation.args[mcpIdx + 1];
      expect(typeof mcpPath).toBe("string");
      const parsed = JSON.parse(readFileSync(mcpPath!, "utf-8")) as {
        mcpServers: Record<string, {
          command: string;
          args: string[];
          env?: Record<string, string>;
          type?: string;
        }>;
      };
      const server = parsed.mcpServers[DELEGATE_MCP_SERVER_NAME];
      expect(server).toBeDefined();
      expect(server!.type).toBe("stdio");
      expect(server!.command.length).toBeGreaterThan(0);
      expect(server!.args.some((arg) => arg.replace(/\\/g, "/").endsWith("mcp-stdio-server.ts"))).toBe(true);
      expect(server!.env?.[DELEGATE_MCP_WORKSPACE_ENV]).toBe("C:\\primary");
      expect(JSON.parse(server!.env?.[DELEGATE_MCP_SESSION_GRANTS_ENV] ?? "[]")).toEqual([
        "C:\\primary",
        "D:\\extra",
      ]);
      // Root confinement floor: Bash is allowed (workspace cwd); Task stays out.
      const toolsArg = invocation.args[invocation.args.indexOf("--tools") + 1] ?? "";
      expect(toolsArg.split(",")).toContain("Bash");
      expect(toolsArg).not.toContain("Task");
    } finally {
      invocation.cleanup();
    }
  });

  test("maps Jarvis MCP tool names to canonical identities and permits non-spawn tools", () => {
    expect(mapClaudeDelegateToolName("mcp__jarvis__write_file")).toBe("write_file");
    expect(mapClaudeDelegateToolName("mcp__jarvis__git_metadata")).toBe("git_metadata");
    expect(mapClaudeDelegateToolName("mcp__jarvis__task_list")).toBe("task_list");
    expect(mapClaudeDelegateToolName("mcp__other__read_file")).toBe("delegate_mcp_other_read_file");

    const stock = new Set(["Read", "Write"]);
    const canonical = new Set(["read_file", "write_file"]);
    expect(isPermittedDelegateTool("mcp__jarvis__git_metadata", "git_metadata", stock, canonical)).toBe(true);
    expect(isPermittedDelegateTool("mcp__jarvis__task_list", "task_list", stock, canonical)).toBe(true);
    expect(isPermittedDelegateTool("mcp__jarvis__run_background_command", "run_background_command", stock, canonical)).toBe(false);
    expect(isPermittedDelegateTool("mcp__jarvis__agent", "agent", stock, canonical)).toBe(false);
    expect(isPermittedDelegateTool("Bash", "bash", stock, canonical)).toBe(false);
    expect(isPermittedDelegateTool("Task", "task", stock, canonical)).toBe(false);

    // Exact Bash in the stock floor is permitted (W1.5).
    const withBash = new Set(["Read", "Write", "Bash"]);
    const withBashCanon = new Set(["read_file", "write_file", "bash"]);
    expect(isPermittedDelegateTool("Bash", "bash", withBash, withBashCanon)).toBe(true);
  });

  test("keeps the first two strikes available and escalates later cooldowns", () => {
    let now = 1_000;
    const health = new DelegateHealth(() => now);
    expect(health.isAvailable()).toBe(true);
    health.strike("unverified_write");
    expect(health.snapshot()).toEqual({
      strikes: 1,
      cooldownUntil: 0,
      lastReason: "unverified_write",
    });
    expect(health.isAvailable()).toBe(true);

    now = 2_000;
    health.strike("timeout_without_write");
    expect(health.snapshot()).toEqual({
      strikes: 2,
      cooldownUntil: 0,
      lastReason: "timeout_without_write",
    });
    expect(health.isAvailable()).toBe(true);

    now = 3_000;
    health.strike("spawn_error");
    expect(health.snapshot()).toEqual({
      strikes: 3,
      cooldownUntil: 603_000,
      lastReason: "spawn_error",
    });
    expect(health.isAvailable()).toBe(false);
    now = 602_999;
    expect(health.isAvailable()).toBe(false);
    now = 603_000;
    expect(health.isAvailable()).toBe(true);

    now = 4_000;
    health.strike("no_event_exit");
    expect(health.snapshot()).toEqual({
      strikes: 4,
      cooldownUntil: 1_204_000,
      lastReason: "no_event_exit",
    });

    now = 5_000;
    health.strike("termination_unconfirmed");
    expect(health.snapshot()).toEqual({
      strikes: 5,
      cooldownUntil: 1_805_000,
      lastReason: "termination_unconfirmed",
    });

    health.markHealthy();
    expect(health.snapshot()).toEqual({ strikes: 0, cooldownUntil: 0 });
    expect(health.isAvailable()).toBe(true);
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
    const config = testConfig();
    config.claude_cli.auth_mode = "proxy";
    // OpenAI-compatible proxy models still need the local Python proxy.
    config.claude_cli.delegate.model = "deepseek-v4-pro";

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

  test("Anthropic-native proxy-mode delegates do not require the local proxy port", async () => {
    let proxyChecks = 0;
    const availability = new ClaudeDelegateAvailabilityCache({
      checkCli: async () => true,
      checkProxyPort: async () => {
        proxyChecks += 1;
        return false;
      },
    });
    const config = testConfig();
    config.claude_cli.auth_mode = "proxy";
    config.claude_cli.delegate.model = "minimax-m3";
    config.opencode_go.api_key = "go-test-key";

    expect(await availability.isAvailable(config)).toBe(true);
    expect(proxyChecks).toBe(0);
  });

  test("Anthropic-native opencode_go delegates are unavailable without a Go API key", async () => {
    let cliChecks = 0;
    const availability = new ClaudeDelegateAvailabilityCache({
      checkCli: async () => {
        cliChecks += 1;
        return true;
      },
      checkProxyPort: async () => true,
    });
    const config = testConfig();
    config.claude_cli.auth_mode = "proxy";
    config.claude_cli.delegate.model = "minimax-m3";
    config.opencode_go.api_key = "";

    expect(await availability.isAvailable(config)).toBe(false);
    // Short-circuit before spawning a CLI probe that would only fail later.
    expect(cliChecks).toBe(0);

    config.opencode_go.api_key = "go-test-key";
    expect(await availability.isAvailable(config)).toBe(true);
    expect(cliChecks).toBe(1);
  });

  test("downgrades each claimed write without matching ground-truth change before effect gating", async () => {
    const config = testConfig();
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
            message: { content: [{ type: "tool_result", tool_use_id: "write-1", content: "x".repeat(40_000) }] },
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
    // W1.5: write-turn 24k cap (delegate always write-intent).
    expect(output.toolCalls[0].output.length).toBeLessThanOrEqual(24_000);
    expect(output.toolCalls[0].output).toContain("truncated");
    expect(output.toolCalls.filter((record) => record.name === "git_metadata")).toHaveLength(1);
    expect(health.snapshot().lastReason).toBe("unverified_write");
  }, 15_000); // 2026-07-27 evening cron: 5s vitest default was tight under full-suite load
  // (observed 5172ms = at-budget timeout on the 2026-07-27 evening pass run with 2044
  // other tests sharing the worker); consistent ~4.0s in isolation. 15s is 3.8x
  // isolated / 2.9x observed, comfortably above the 5s default and well below the
  // 30s stage budget the test exercises. Same wall-clock-budget-vs-real-work class
  // as the 2026-07-27 1pm pass `pipeline-telemetry.test.ts` `mid-loop check-runner
  // feeds CheckResult into supervision after a write` bump (5s→15s→30s), the
  // 2026-07-20 4pm claude-delegate bump (47f3c78), and the 2026-07-21 evening
  // `claude-delegate.test.ts` `claude-delegate cleanups unconfirmed termination
  // within bounded retries` bump (300ms→3000ms). The test pumps a 20k-char
  // tool_result through the synthetic process stream and exercises the snapshot
  // factory + 6k-char tool-output truncation + git_metadata emit path; behavior
  // under test (the delegate downgrades an unverified write before effect-gating
  // with the documented `delegate_write_unverified` error code and the unverified
  // `lastReason`) is orthogonal to wall-clock precision, so 5s was measuring the
  // wrong thing.

  test("accepts verified writes and truncates delegate tool output with the shared context policy", async () => {
    const config = testConfig();
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
            content: "x".repeat(40_000),
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
    // W1.5: delegate uses write-turn 24k cap, not the 6k read-turn executor cap.
    expect(output.toolCalls[0].output.length).toBeLessThanOrEqual(24_000);
    expect(output.toolCalls[0].output.length).toBeGreaterThan(6_000);
    expect(output.toolCalls[0].output).toContain("truncated");
    expect(output.toolCalls.at(-1)?.output).toContain("claimed.ts | 2 ++");
    expect(streamedText).toEqual(["Applied the change."]);
    expect(streamedTools).toEqual(["write_file"]);
  });

  test("patterned Bash(...) never reaches --tools but floor still supplies exact Bash", async () => {
    // Patterned entries remain stored for config round-trip but never enter the
    // root-confinable --tools list. Exact "Bash" is always re-unioned from the
    // floor (2026-08-04: stale configs without Bash blocked verification).
    const config = testConfig();
    config.claude_cli.delegate.allowed_tools = ["Read", "Bash(python:*)"];
    const invocation = buildClaudeDelegateInvocation({
      config,
      prompt: "verify",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 12_000,
      executable: "claude",
      baseEnv: {},
    });
    try {
      const toolsArg = invocation.args[invocation.args.indexOf("--tools") + 1] ?? "";
      expect(toolsArg.split(",")).toContain("Bash");
      expect(toolsArg).not.toContain("Bash(");
      expect(config.claude_cli.delegate.allowed_tools).toContain("Bash(python:*)");
    } finally {
      invocation.cleanup();
    }
  });

  test("rejects Task even when the floor tools are present", async () => {
    // Floor re-unions Write/Bash/etc.; Task remains permanently out of the
    // root-confinable set (shell/Task-spawning escape).
    const config = testConfig();
    config.claude_cli.delegate.allowed_tools = ["Read", "Task"];
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "same", files: {},
    };
    const output = await runClaudeDelegate({
      config,
      prompt: "spawn a task",
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
            type: "tool_use", id: "task-1", name: "Task", input: { prompt: "escape" },
          }] } };
          yield { type: "user", message: { content: [{
            type: "tool_result", tool_use_id: "task-1", content: "spawned",
          }] } };
          yield { type: "result", result: "done" };
        })(),
        exit: Promise.resolve({ code: 0, signal: null }),
        kill: () => {},
      }),
    });

    expect(output).toMatchObject({ ok: false, errorCode: "delegate_tool_not_permitted" });
    expect(output.toolCalls[0]).toMatchObject({ is_error: true, error_code: "policy_denied" });
  });

  test("permits canonical write_file when Write is in allowed_tools (F1 vocabulary mismatch)", async () => {
    // Eval 2026-07-21 T1: model emitted write_file; permit gate only checked
    // stock names → delegate_tool_not_permitted. Canonical identity must pass
    // when the corresponding stock tool is allowed.
    const config = testConfig();
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

  test("stale allowlist with only Read still permits floor Bash (2026-08-04)", async () => {
    // deepMerge used to leave production configs without Bash; the floor
    // re-unions exact Bash so verification greps can run.
    const config = testConfig();
    config.claude_cli.delegate.allowed_tools = ["Read"];
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "same", files: {},
    };
    const output = await runClaudeDelegate({
      config,
      prompt: "verify with shell",
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

    expect(output.toolCalls[0]).toMatchObject({ name: "bash", is_error: false });
    expect(output.toolCalls[0].error_code).toBeUndefined();
  });

  test("terminates then kills a timed-out child and cools down when it produced zero writes", async () => {
    const config = testConfig();
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
    const config = testConfig();
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
    // 1000ms gives the same signal without flaking. 2026-07-21 evening cron:
    // 1000ms was itself tight under load (observed 1203ms in a full-suite run) —
    // bump to 3000ms with the same 'behavior is orthogonal to wall-clock precision'
    // rationale, same precedent as the 2026-07-20 4pm pass (commit 47f3c78).
  }, 3000);

  test("abort remains terminal after bounded verification of an already-claimed write", async () => {
    const config = testConfig();
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
    let eventIteratorReturns = 0;
    let releaseBlockedNext: ((result: IteratorResult<unknown>) => void) | undefined;
    const eventValues: unknown[] = [
      { type: "assistant", message: { content: [{
        type: "tool_use", id: "write-1", name: "Write", input: { file_path: "claimed.ts" },
      }] } },
      { type: "user", message: { content: [{
        type: "tool_result", tool_use_id: "write-1", content: "claimed write",
      }] } },
    ];
    const events: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async (): Promise<IteratorResult<unknown>> => {
            if (index < eventValues.length) return { done: false, value: eventValues[index++] };
            controller.abort("user_stop");
            return new Promise((resolve) => { releaseBlockedNext = resolve; });
          },
          return: async (): Promise<IteratorResult<unknown>> => {
            eventIteratorReturns += 1;
            releaseBlockedNext?.({ done: true, value: undefined });
            return { done: true, value: undefined };
          },
        };
      },
    };
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
        events,
        exit,
        kill: (signal) => { if (signal === "SIGKILL") finish({ code: null, signal }); },
      }),
    });

    expect(eventIteratorReturns).toBe(1);
    expect(captures).toBe(2);
    expect(output).toMatchObject({ ok: false, terminalStatus: "cancelled", errorCode: "delegate_aborted" });
    expect(output.toolCalls).toContainEqual(expect.objectContaining({ name: "write_file", is_error: false }));
  }, 1_000);

  test("unconfirmed cleanup makes a timed-out claimed write unsafe without post-run verification", async () => {
    const config = testConfig();
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

    // 2026-07-21 evening cron: 250ms was too tight under full-suite load. The test's
    // design-intent sum is terminationGraceMs(1) + cleanupTimeoutMs(10) +
    // verificationTimeoutMs(30) = 41ms; 250ms gave 6x headroom, but OS scheduler
    // jitter under load occasionally pushes the run to 328ms and the assertion fails.
    // 1000ms is 24x design intent and still ≪ the 5s default vitest budget, so the
    // 'fast unconfirmed cleanup' contract is preserved (the test still asserts the
    // delegate returns in well under a second, not in multiple seconds).
    expect(Date.now() - started).toBeLessThan(1000);
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
  }, 3000); // 2026-07-21 evening cron: 300ms vitest budget was tight under load (observed
  // 328ms) — bump to 3000ms with the same rationale as the in-test 1000ms wall-clock
  // assertion above. Same pattern as the 2026-07-20 4pm claude-delegate bump (47f3c78).

  test("uses the injected tree killer for TERM then forced KILL so grandchildren cannot leak", async () => {
    const config = testConfig();
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
    const config = testConfig();
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

  test("treats a failed TERM tree signal as non-fatal after forced KILL and confirmed direct child exit", async () => {
    const config = testConfig();
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
    expect(output).toMatchObject({ ok: false, terminalStatus: "timed_out", errorCode: "delegate_timeout" });
    expect(output.toolCalls).toContainEqual(expect.objectContaining({
      name: "delegate_cleanup",
      arguments: { status: "terminated" },
      is_error: false,
    }));
    expect(health.snapshot().lastReason).not.toBe("termination_unconfirmed");
  }, 1_000);

  test("treats an unsettled TERM tree signal as non-fatal after forced KILL and confirmed direct child exit", async () => {
    const config = testConfig();
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
          if (signal === "SIGTERM") await new Promise<void>(() => {});
        },
      },
      processFactory: async () => ({
        events: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
        exit: Promise.resolve({ code: 0, signal: null }),
        kill: () => {},
      }),
    });

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(output).toMatchObject({ ok: false, terminalStatus: "timed_out", errorCode: "delegate_timeout" });
    expect(output.toolCalls).toContainEqual(expect.objectContaining({
      name: "delegate_cleanup",
      arguments: { status: "terminated" },
      is_error: false,
    }));
    expect(health.snapshot().lastReason).not.toBe("termination_unconfirmed");
  }, 1_000);

  test("bounds teardown after forced KILL when the child exit promise never settles", async () => {
    const config = testConfig();
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
    const config = testConfig();
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
    const config = testConfig();
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
    const config = testConfig();
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
    const config = testConfig();
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
    const config = testConfig();
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
    const config = testConfig();
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
    // 2026-07-28 (cron: evening) flake pin: the 1_000ms budget was
    // measuring wall-clock precision, not the behavior under test.
    // Observed 1031ms in a single full-suite run (over budget by 31ms);
    // in isolation this test runs in ~172ms, so the over-budget is
    // pure shared-worker contention. The test does real work (a 4ms
    // process-factory wait + SIGTERM→SIGKILL teardown + 300ms
    // cleanupTimeoutMs + a 1000ms race-vs-cleanup sentinel), and
    // the bounded-known-outcome contract is orthogonal to wall-clock
    // precision. Same wall-clock-budget-vs-real-work class as the
    // 2026-07-27 4pm commit (d9b04b6) that bumped the "deadline covers
    // delayed post-snapshot" test from 1500→5000ms for the same
    // reason. Bumped 1_000→3_000ms to keep headroom under full-suite
    // load (where the same test class stretches from ~170ms in
    // isolation to ~1030ms under the 2164-test shared worker).
  }, 3_000);

  test("deadline covers delayed post-snapshot and downgrades unverifiable writes", async () => {
    const config = testConfig();
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
  }, 5_000);
  // 2026-07-28 (cron: evening) flake pin: the 1_500ms budget
  // previously bumped 2026-07-24 was again over-budget under this
  // evening's host contention (observed 1516ms in a single full-suite
  // run, 16ms over). In isolation this test runs in ~125ms; under
  // the 2164-test shared worker it stretches to ~1516ms. The
  // 2026-07-24 pin kept the test stable for 4 days; today's full
  // suite is the first time the 1.5s ceiling has been observed
  // exceeded again on this host. Same wall-clock-budget-vs-real-work
  // class as the 2026-07-27 1pm commit (a1e4ae2) that bumped
  // `pipeline-telemetry > mid-loop check-runner` 5s→15s, then
  // 2026-07-27 4pm (d9b04b6) bumped it again 15s→30s under the
  // same observation pattern. Bumped 1_500→5_000ms to keep ~3.3x
  // headroom over the observed worst case. Behavior under test
  // (delayed post-snapshot + unverifiable write downgrades) is
  // orthogonal to wall-clock precision.

  test("strikes health on spawn errors and clean no-event exits", async () => {
    const config = testConfig();
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

  test("prefers decoded CLI error/result-error signals over generic delegate_no_events", async () => {
    const config = testConfig();
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

    const resultError = await runClaudeDelegate({
      ...base,
      health: new DelegateHealth(),
      processFactory: async () => ({
        events: (async function* () {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            result: "API rejected the request",
          };
        })(),
        exit: Promise.resolve({ code: 1, signal: null }),
        kill: () => {},
      }),
    });
    expect(resultError.ok).toBe(false);
    expect(resultError.errorCode).not.toBe("delegate_no_events");
    expect(resultError.errorCode).toBe("delegate_cli_error");
    expect(resultError.narrative).toMatch(/error_during_execution|API rejected the request/i);
    expect(resultError.narrative).not.toMatch(/exited without emitting stream events/i);

    const typeError = await runClaudeDelegate({
      ...base,
      health: new DelegateHealth(),
      processFactory: async () => ({
        events: (async function* () {
          yield {
            type: "error",
            subtype: "api_error",
            error: "authentication_failed",
          };
        })(),
        // Exit 0 must still fail when the CLI stream named an error.
        exit: Promise.resolve({ code: 0, signal: null }),
        kill: () => {},
      }),
    });
    expect(typeError.ok).toBe(false);
    expect(typeError.errorCode).not.toBe("delegate_no_events");
    expect(typeError.errorCode).toBe("delegate_cli_error");
    expect(typeError.narrative).toMatch(/authentication_failed|api_error/i);
    expect(typeError.narrative).not.toMatch(/exited without emitting stream events/i);

    // result + is_error with process exit 0 must still fail as delegate_cli_error
    // (not complete successfully / not generic no-events).
    const resultErrorExit0 = await runClaudeDelegate({
      ...base,
      health: new DelegateHealth(),
      processFactory: async () => ({
        events: (async function* () {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            result: "execution failed mid-turn",
          };
        })(),
        exit: Promise.resolve({ code: 0, signal: null }),
        kill: () => {},
      }),
    });
    expect(resultErrorExit0.ok).toBe(false);
    expect(resultErrorExit0.errorCode).toBe("delegate_cli_error");
    expect(resultErrorExit0.narrative).toMatch(/error_during_execution|execution failed mid-turn/i);
    expect(resultErrorExit0.narrative).not.toMatch(/exited without emitting stream events/i);
  });

  test("CLI failure narrative scrubs credential-bearing detail", async () => {
    const config = testConfig();
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "same", files: {},
    };
    const secretKey = "sk-abcdefghijklmnopqrstuvwx";
    const secretEnv = "sk-ant-secret-value-here";
    const result = await runClaudeDelegate({
      config,
      prompt: "change it",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 30_000,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      snapshotFactory: { capture: async () => [snapshot] },
      health: new DelegateHealth(),
      processFactory: async () => ({
        events: (async function* () {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            result: `auth failed with key ${secretKey} and ANTHROPIC_API_KEY=${secretEnv}`,
          };
        })(),
        exit: Promise.resolve({ code: 1, signal: null }),
        kill: () => {},
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("delegate_cli_error");
    expect(result.narrative).toMatch(/error_during_execution|auth failed/i);
    expect(result.narrative).not.toContain(secretKey);
    expect(result.narrative).not.toContain(secretEnv);
    expect(result.narrative).toContain("[REDACTED]");
  });

  test("sanitizeDelegateDiagnosticText scrubs API keys, env forms, and JSON fields", () => {
    // OpenAI / Anthropic style bare keys (sk-… / sk-ant-…)
    const openai = "error: invalid key sk-abcdefghijklmnopqrstuvwx near end";
    const openaiScrubbed = sanitizeDelegateDiagnosticText(openai);
    expect(openaiScrubbed).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(openaiScrubbed).toContain("[REDACTED]");

    const anthropic = "auth failed sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV";
    const anthropicScrubbed = sanitizeDelegateDiagnosticText(anthropic);
    expect(anthropicScrubbed).not.toContain("sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV");
    expect(anthropicScrubbed).toContain("[REDACTED]");

    // ENV-style *_API_KEY=… (underscore names that header-style patterns miss)
    const envLine =
      "ANTHROPIC_API_KEY=sk-ant-secret-value-here OPENROUTER_API_KEY=or-secret-value";
    const envScrubbed = sanitizeDelegateDiagnosticText(envLine);
    expect(envScrubbed).not.toContain("sk-ant-secret-value-here");
    expect(envScrubbed).not.toContain("or-secret-value");
    expect(envScrubbed).toMatch(/ANTHROPIC_API_KEY=\[REDACTED\]/i);
    expect(envScrubbed).toMatch(/OPENROUTER_API_KEY=\[REDACTED\]/i);

    // JSON-ish stream-json / config shapes
    const jsonish =
      '{"type":"error","api_key":"sk-live-supersecret1234","token":"tok_secret_value","x-api-key":"hdr-secret"}';
    const jsonScrubbed = sanitizeDelegateDiagnosticText(jsonish);
    expect(jsonScrubbed).not.toContain("sk-live-supersecret1234");
    expect(jsonScrubbed).not.toContain("tok_secret_value");
    expect(jsonScrubbed).not.toContain("hdr-secret");
    expect(jsonScrubbed).toContain('"api_key":"[REDACTED]"');
    expect(jsonScrubbed).toContain('"token":"[REDACTED]"');
    expect(jsonScrubbed).toContain('"x-api-key":"[REDACTED]"');
    // Non-secret structure preserved
    expect(jsonScrubbed).toContain('"type":"error"');

    // Existing Authorization header path still works
    const auth = "Authorization: Bearer secret-value";
    expect(sanitizeDelegateDiagnosticText(auth)).not.toContain("secret-value");
  });

  test("process factory retains only a sanitized 4KiB stderr tail", async () => {
    // >4 KiB of noise, then a secret header near the end so a naive dump would
    // retain it — diagnostics must keep the newest 4096 chars and scrub secrets.
    const padding = "noise-line-abcdefghijklmnopqrstuvwxyz\n".repeat(200); // ~6.8 KiB
    const secret = "Authorization: Bearer secret-value";
    const tailMarker = "DELEGATE_STDERR_TAIL_MARKER";
    const stderrPayload = `${padding}${secret}\n${tailMarker}\n`;
    const script = [
      `process.stderr.write(${JSON.stringify(stderrPayload)});`,
      `process.stdout.write(${JSON.stringify(JSON.stringify({ type: "result", result: "ok" }) + "\n")});`,
    ].join("\n");

    const child = await nodeDelegateProcessFactory({
      executable: process.execPath,
      args: ["-e", script],
      promptOnStdin: false,
      cleanup: () => {},
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 10_000,
      authMode: "proxy",
      baseUrl: "http://127.0.0.1:19878",
      prompt: "unused",
      signal: new AbortController().signal,
    });

    const events: unknown[] = [];
    for await (const event of child.events) events.push(event);
    const exit = await child.exit;
    expect(exit.code).toBe(0);
    expect(events.length).toBeGreaterThan(0);

    const diag = child.diagnostics?.();
    expect(diag).toBeDefined();
    expect(diag!.stderrTail.length).toBeLessThanOrEqual(4096);
    expect(diag!.stderrTail).toContain(tailMarker);
    expect(diag!.stderrTail).not.toContain("secret-value");
    expect(diag!.stderrTail).not.toMatch(/Authorization:\s*Bearer\s+secret-value/i);
    expect(diag!.exitCode).toBe(0);
  });

  test("process factory retains only a sanitized 4KiB stdout tail", async () => {
    // Non-JSON chatter (>4 KiB) with a secret near the end, then a valid
    // stream-json event — stdout_tail must keep the newest 4096 chars, scrub
    // secrets, and must not break protocol parsing of well-formed lines.
    const padding = "noise-line-abcdefghijklmnopqrstuvwxyz\n".repeat(200); // ~6.8 KiB
    const secret = "Authorization: Bearer secret-value";
    const tailMarker = "DELEGATE_STDOUT_TAIL_MARKER";
    const chatter = `${padding}${secret}\n${tailMarker}\n`;
    const resultLine = `${JSON.stringify({ type: "result", result: "ok" })}\n`;
    const script = [
      `process.stdout.write(${JSON.stringify(chatter)});`,
      `process.stdout.write(${JSON.stringify(resultLine)});`,
    ].join("\n");

    const child = await nodeDelegateProcessFactory({
      executable: process.execPath,
      args: ["-e", script],
      promptOnStdin: false,
      cleanup: () => {},
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 10_000,
      authMode: "proxy",
      baseUrl: "http://127.0.0.1:19878",
      prompt: "unused",
      signal: new AbortController().signal,
    });

    const events: unknown[] = [];
    for await (const event of child.events) events.push(event);
    const exit = await child.exit;
    expect(exit.code).toBe(0);
    // Protocol regression guard: well-formed JSON lines still parse.
    expect(events).toEqual([{ type: "result", result: "ok" }]);

    const diag = child.diagnostics?.();
    expect(diag).toBeDefined();
    expect(diag!.stdoutTail.length).toBeLessThanOrEqual(4096);
    expect(diag!.stdoutTail).toContain(tailMarker);
    expect(diag!.stdoutTail).not.toContain("secret-value");
    expect(diag!.stdoutTail).not.toMatch(/Authorization:\s*Bearer\s+secret-value/i);
    expect(diag!.exitCode).toBe(0);
  });

  test("runClaudeDelegate attaches request-id and process diagnostics to the result", async () => {
    const config = testConfig();
    const snapshot: DelegateRootSnapshot = {
      root: "C:\\repo", kind: "git", status: "", diffStat: "", fingerprint: "same", files: {},
    };
    let launchedEnv: Record<string, string> | undefined;
    const output = await runClaudeDelegate({
      config,
      prompt: "change it",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      allowedRoots: ["C:\\repo"],
      stageRemainingMs: 30_000,
      profile: "full",
      writeEffectRequired: true,
      nativeNoWrite: false,
      health: new DelegateHealth(),
      snapshotFactory: { capture: async () => [snapshot] },
      processFactory: async (launch) => {
        launchedEnv = launch.env;
        return {
          events: (async function* () {
            yield { type: "result", result: "no tools" };
          })(),
          exit: Promise.resolve({ code: 1, signal: null }),
          kill: () => {},
          diagnostics: () => ({
            stderrTail: "proxy refused\nAuthorization: Bearer secret-value",
            stdoutTail: "stream chatter\nAuthorization: Bearer secret-value\n{\"type\":\"error\"}",
            exitCode: 1,
          }),
        };
      },
    });

    expect(launchedEnv?.JARVIS_DELEGATE_REQUEST_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(output.diagnostics?.delegate_request_id).toBe(launchedEnv?.JARVIS_DELEGATE_REQUEST_ID);
    // Long-lived proxy reads this header per request (not process env).
    expect(launchedEnv?.ANTHROPIC_CUSTOM_HEADERS).toContain(
      `${DELEGATE_REQUEST_ID_HEADER}: ${launchedEnv?.JARVIS_DELEGATE_REQUEST_ID}`,
    );
    expect(output.diagnostics?.exit_code).toBe(1);
    expect(output.diagnostics?.stderr_tail).toContain("proxy refused");
    expect(output.diagnostics?.stderr_tail).not.toContain("secret-value");
    expect(output.diagnostics?.stdout_tail).toContain("stream chatter");
    expect(output.diagnostics?.stdout_tail).not.toContain("secret-value");
    expect(output.diagnostics?.auth_mode).toBeTruthy();
  });
});
