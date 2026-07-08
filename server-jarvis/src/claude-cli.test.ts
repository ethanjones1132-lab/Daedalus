import { describe, expect, test } from "bun:test";
import {
  buildLocalClaudeArgs,
  buildLocalClaudeEnv,
  compactTurnHistoryForCli,
  estimateCommandLineLength,
  prepareClaudeCliInvocation,
} from "./claude-cli";

describe("Claude CLI local-only launch contract", () => {
  test("replaces inherited Anthropic and Claude credentials with local proxy settings", () => {
    const env = buildLocalClaudeEnv({
      PATH: "/usr/bin",
      HOME: "/home/tester",
      ANTHROPIC_API_KEY: "real-api-key",
      ANTHROPIC_AUTH_TOKEN: "real-auth-token",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      CLAUDE_CODE_OAUTH_TOKEN: "real-oauth-token",
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "4",
      CLAUDE_CONFIG_DIR: "/home/tester/.claude",
    });

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

  test("adds hermetic Claude flags without duplicating them", () => {
    expect(buildLocalClaudeArgs(["--print"])).toEqual(["--bare", "--print", "--no-telemetry"]);
    expect(buildLocalClaudeArgs(["--bare", "--print", "--no-telemetry"])).toEqual([
      "--bare",
      "--print",
      "--no-telemetry",
    ]);
  });

  test("prepareClaudeCliInvocation moves large append-system-prompt to a file on Windows", () => {
    const longSystem = "x".repeat(2000);
    const inv = prepareClaudeCliInvocation("claude.exe", ["--print", "--append-system-prompt", longSystem], "hi");
    expect(inv.args).not.toContain(longSystem);
    expect(inv.args).toContain("--append-system-prompt-file");
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
