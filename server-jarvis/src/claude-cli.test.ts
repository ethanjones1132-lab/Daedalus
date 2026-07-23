import { describe, expect, test } from "bun:test";
import {
  buildClaudeCliChatArgs,
  buildLocalClaudeArgs,
  buildLocalClaudeEnv,
  compactTurnHistoryForCli,
  decodeClaudeCliMessage,
  estimateCommandLineLength,
  prepareClaudeCliInvocation,
  resolveClaudeCliLaunchOptions,
} from "./claude-cli";

describe("Claude CLI local-only launch contract", () => {
  test("proxy mode replaces inherited Anthropic and Claude credentials with local proxy settings", () => {
    const env = buildLocalClaudeEnv({
      PATH: "/usr/bin",
      HOME: "/home/tester",
      ANTHROPIC_API_KEY: "real-api-key",
      ANTHROPIC_AUTH_TOKEN: "real-auth-token",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      CLAUDE_CODE_OAUTH_TOKEN: "real-oauth-token",
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "4",
      CLAUDE_CONFIG_DIR: "/home/tester/.claude",
    }, { authMode: "proxy" });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/tester");
    expect(env.ANTHROPIC_API_KEY).toBe("ollama");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ollama");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:19878");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toContain(".openclaw");
    expect(env.CLAUDE_CODE_SIMPLE).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  test("subscription mode preserves credentials without proxy overrides", () => {
    const env = buildLocalClaudeEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "subscription-api-key",
      ANTHROPIC_AUTH_TOKEN: "subscription-auth-token",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "4",
      CLAUDE_CONFIG_DIR: "/home/tester/.claude",
    }, { authMode: "subscription" });

    expect(env.ANTHROPIC_API_KEY).toBe("subscription-api-key");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("subscription-auth-token");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBe("4");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/tester/.claude");
    expect(env.CLAUDE_CODE_SIMPLE).toBeUndefined();
  });

  test("subscription mode removes inherited Jarvis proxy overrides but retains real credentials", () => {
    const proxyEnv = buildLocalClaudeEnv({ PATH: "/usr/bin" }, { authMode: "proxy" });
    const env = buildLocalClaudeEnv({
      ...proxyEnv,
      ANTHROPIC_API_KEY: "subscription-api-key",
      ANTHROPIC_AUTH_TOKEN: "subscription-auth-token",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
    }, { authMode: "subscription" });

    expect(env.ANTHROPIC_API_KEY).toBe("subscription-api-key");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("subscription-auth-token");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  test("opencode_go mode points at OpenCode Go with the configured key and strips inherited credentials", () => {
    const env = buildLocalClaudeEnv({
      PATH: "/usr/bin",
      HOME: "/home/tester",
      ANTHROPIC_API_KEY: "real-api-key",
      ANTHROPIC_AUTH_TOKEN: "real-auth-token",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:19878",
      CLAUDE_CODE_OAUTH_TOKEN: "real-oauth-token",
      CLAUDE_CONFIG_DIR: "/home/tester/.openclaw/jarvis/hermes/claude-local-config",
    }, {
      authMode: "opencode_go",
      opencodeGoApiKey: "go-test-key",
      opencodeGoBaseUrl: "https://opencode.ai/zen/go/v1/",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/tester");
    expect(env.ANTHROPIC_API_KEY).toBe("go-test-key");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://opencode.ai/zen/go/v1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CLAUDE_CODE_SIMPLE).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_LOCAL_MODEL).toBeUndefined();
  });

  test("resolveClaudeCliLaunchOptions routes Anthropic-native models to opencode_go under proxy mode", () => {
    expect(resolveClaudeCliLaunchOptions({
      authMode: "proxy",
      modelId: "minimax-m3",
      opencodeGoApiKey: "go-key",
      opencodeGoBaseUrl: "https://opencode.ai/zen/go/v1",
    })).toEqual({
      authMode: "opencode_go",
      opencodeGoApiKey: "go-key",
      opencodeGoBaseUrl: "https://opencode.ai/zen/go/v1",
    });
    expect(resolveClaudeCliLaunchOptions({
      authMode: "proxy",
      modelId: "deepseek-v4-pro",
      opencodeGoApiKey: "go-key",
    })).toEqual({ authMode: "proxy" });
    expect(resolveClaudeCliLaunchOptions({
      authMode: "subscription",
      modelId: "minimax-m3",
      opencodeGoApiKey: "go-key",
    })).toEqual({ authMode: "subscription" });
  });

  test("proxy args add bare and strip only the retired telemetry flag", () => {
    expect(buildLocalClaudeArgs(["--print"], { authMode: "proxy" })).toEqual(["--bare", "--print"]);
    expect(buildLocalClaudeArgs(["--bare", "--print", "--no-telemetry"], { authMode: "proxy" })).toEqual([
      "--bare",
      "--print",
    ]);
  });

  test("subscription and opencode_go args preserve caller flags without adding bare", () => {
    expect(buildLocalClaudeArgs(["--bare", "--print", "--model", "sonnet", "--no-telemetry"], {
      authMode: "subscription",
    })).toEqual(["--print", "--model", "sonnet"]);
    expect(buildLocalClaudeArgs(["--bare", "--print", "--model", "minimax-m3", "--no-telemetry"], {
      authMode: "opencode_go",
    })).toEqual(["--print", "--model", "minimax-m3"]);
  });

  test("both auth modes remove persisted max-turns pairs", () => {
    expect(buildLocalClaudeArgs(
      ["--print", "--max-turns", "4", "--model", "sonnet"],
      { authMode: "proxy" },
    )).toEqual(["--bare", "--print", "--model", "sonnet"]);
    expect(buildLocalClaudeArgs(
      ["--print", "--max-turns", "2", "--model", "opus"],
      { authMode: "subscription" },
    )).toEqual(["--print", "--model", "opus"]);
  });

  test("chat model args use Claude config for subscription and Ollama for proxy", () => {
    expect(buildClaudeCliChatArgs(["--print"], {
      authMode: "subscription",
      claudeModel: "claude-opus-4-6",
      proxyModel: "qwen3.5-9b:latest",
    })).toEqual(["--print", "--model", "claude-opus-4-6"]);
    expect(buildClaudeCliChatArgs(["--print"], {
      authMode: "subscription",
      claudeModel: "",
      proxyModel: "qwen3.5-9b:latest",
    })).toEqual(["--print"]);
    expect(buildClaudeCliChatArgs(["--print"], {
      authMode: "proxy",
      claudeModel: "claude-opus-4-6",
      proxyModel: "qwen3.5-9b:latest",
    })).toEqual(["--print", "--model", "qwen3.5-9b:latest"]);
  });

  test("prepareClaudeCliInvocation never emits unsupported prompt-file flags", () => {
    const longSystem = "x".repeat(2000);
    const inv = prepareClaudeCliInvocation("claude.exe", ["--print", "--append-system-prompt", longSystem], "hi");
    expect(inv.args).toContain(longSystem);
    expect(inv.args).not.toContain("--append-system-prompt-file");
    expect(inv.args).not.toContain("--system-prompt-file");
    inv.cleanup();
  });

  test("compactTurnHistoryForCli keeps recent turns within char budget", () => {
    const history = [
      { role: "user", content: "a".repeat(100) },
      { role: "assistant", content: "b".repeat(100) },
      { role: "user", content: "latest" },
    ];
    const compact = compactTurnHistoryForCli(history, 80);
    expect(compact.length).toBeGreaterThan(0);
    expect(compact[compact.length - 1].content).toBe("latest");
  });

  test("estimateCommandLineLength accounts for quoting", () => {
    const len = estimateCommandLineLength("claude.exe", ["--print", "hello world"]);
    expect(len).toBeGreaterThan(20);
  });
});

describe("Claude CLI stream-json decoder", () => {
  test("decodes stock system, assistant, user, stream_event, and result records", () => {
    expect(decodeClaudeCliMessage({
      type: "system",
      subtype: "init",
      session_id: "stock-session",
      tools: ["Read", "Bash"],
      model: "claude-sonnet-4-6",
    })).toEqual([{
      type: "init",
      session_id: "stock-session",
      tools: ["Read", "Bash"],
      model: "claude-sonnet-4-6",
    }]);

    expect(decodeClaudeCliMessage({
      type: "assistant",
      session_id: "stock-session",
      message: {
        content: [
          { type: "text", text: "I will inspect it." },
          { type: "tool_use", id: "toolu_123", name: "Read", input: { file_path: "README.md" } },
        ],
      },
    })).toEqual([
      { type: "stream_event", delta: { text: "I will inspect it." }, session_id: "stock-session" },
      {
        type: "tool_use",
        tool_use_id: "toolu_123",
        tool_name: "Read",
        tool_input: { file_path: "README.md" },
        session_id: "stock-session",
      },
    ]);

    expect(decodeClaudeCliMessage({
      type: "user",
      session_id: "stock-session",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_123", content: "contents", is_error: false }],
      },
    })).toEqual([{
      type: "tool_result",
      tool_use_id: "toolu_123",
      tool_output: "contents",
      is_error: false,
      session_id: "stock-session",
    }]);

    expect(decodeClaudeCliMessage({
      type: "stream_event",
      session_id: "stock-session",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } },
    })).toEqual([{
      type: "stream_event",
      delta: { text: "partial" },
      session_id: "stock-session",
    }]);

    expect(decodeClaudeCliMessage({
      type: "result",
      session_id: "stock-session",
      result: "done",
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.012,
      num_turns: 2,
    })).toEqual([{
      type: "result",
      content: "done",
      session_id: "stock-session",
      usage: { input_tokens: 10, output_tokens: 5 },
      cost_usd: 0.012,
      num_turns: 2,
    }]);
  });

  test("preserves flat legacy assistant and tool event shapes", () => {
    expect(decodeClaudeCliMessage({ type: "assistant", session_id: "legacy", content: "hello" })).toEqual([{
      type: "stream_event",
      delta: { text: "hello" },
      session_id: "legacy",
    }]);
    expect(decodeClaudeCliMessage({
      type: "tool_use",
      session_id: "legacy",
      tool_use: { id: "legacy-tool", name: "search_files", input: { pattern: "auth_mode" } },
    })).toEqual([{
      type: "tool_use",
      tool_use_id: "legacy-tool",
      tool_name: "search_files",
      tool_input: { pattern: "auth_mode" },
      session_id: "legacy",
    }]);
    expect(decodeClaudeCliMessage({
      type: "tool_result",
      session_id: "legacy",
      tool_result: { tool_use_id: "legacy-tool", content: "match", is_error: true },
    })).toEqual([{
      type: "tool_result",
      tool_use_id: "legacy-tool",
      tool_output: "match",
      is_error: true,
      session_id: "legacy",
    }]);
  });

  test("does not duplicate completed assistant text after ordered partial deltas", () => {
    const state = { partialTextSeen: false };
    const fixture = [
      {
        type: "stream_event",
        session_id: "partial-session",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
      },
      {
        type: "stream_event",
        session_id: "partial-session",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
      },
      {
        type: "assistant",
        session_id: "partial-session",
        message: {
          content: [
            { type: "text", text: "Hello" },
            { type: "tool_use", id: "toolu_partial", name: "Read", input: { file_path: "README.md" } },
          ],
        },
      },
      {
        type: "user",
        session_id: "partial-session",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_partial", content: "ok", is_error: false }],
        },
      },
      {
        type: "assistant",
        session_id: "partial-session",
        message: { content: [{ type: "text", text: "Done" }] },
      },
    ];

    const events = fixture.flatMap((message) => decodeClaudeCliMessage(message, state));
    const visible = events
      .filter((event) => event.type === "stream_event")
      .map((event) => event.delta?.text ?? "")
      .join("");
    expect(visible).toBe("HelloDone");
    expect(events.filter((event) => event.type === "tool_use")).toHaveLength(1);
  });
});
