import { describe, expect, test } from "bun:test";
import { buildLocalClaudeArgs, buildLocalClaudeEnv } from "./claude-cli";

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
});
