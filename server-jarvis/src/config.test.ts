import { describe, expect, test } from "bun:test";
import { defaultConfig, normalizeConfig, normalizeSettingMutation } from "./config";

describe("normalizeSettingMutation", () => {
  test("rejects an unknown key", () => {
    expect(() => normalizeSettingMutation({ key: "unknown", value: true })).toThrow("unknown_setting");
  });

  test("accepts a known key and serializes a string", () => {
    const result = normalizeSettingMutation({ key: "system_prompt", value: "be terse" });
    expect(result).toEqual({ key: "system_prompt", value: "be terse" });
  });

  test("serializes an object value", () => {
    const result = normalizeSettingMutation({ key: "ollama", value: { model: "qwen3:8b" } });
    expect(result.key).toBe("ollama");
    expect(JSON.parse(result.value)).toEqual({ model: "qwen3:8b" });
  });

  test("serializes a number value", () => {
    const result = normalizeSettingMutation({ key: "temperature", value: 0.5 });
    expect(result).toEqual({ key: "temperature", value: "0.5" });
  });
});

describe("review repair budget", () => {
  test("clamps configured repair rounds to the safe 0..3 range", () => {
    // A3: ceiling raised to 3 (base cap) so the progress-gated bonus round has
    // headroom; default raised to 2.
    expect(normalizeConfig({ orchestrator: { max_review_repair_rounds: 99 } }).orchestrator.max_review_repair_rounds).toBe(3);
    expect(normalizeConfig({ orchestrator: { max_review_repair_rounds: -3 } }).orchestrator.max_review_repair_rounds).toBe(0);
    expect(normalizeConfig({ orchestrator: { max_review_repair_rounds: "not-a-number" } }).orchestrator.max_review_repair_rounds).toBe(2);
  });

  test("defaults the base repair cap to 2", () => {
    expect(defaultConfig().orchestrator.max_review_repair_rounds).toBe(2);
  });

  // B1: gate-green fast path is opt-out (default on); an explicit false survives
  // normalization so operators can force the model reviewer to always run.
  test("defaults gate_green_skips_reviewer to true and preserves an explicit false", () => {
    expect(defaultConfig().orchestrator.gate_green_skips_reviewer).toBe(true);
    expect(
      normalizeConfig({ orchestrator: { gate_green_skips_reviewer: false } }).orchestrator.gate_green_skips_reviewer,
    ).toBe(false);
  });
});

describe("Claude CLI auth mode config", () => {
  test("defaults legacy config inputs to proxy mode", () => {
    expect(defaultConfig().claude_cli.auth_mode).toBe("proxy");
    expect(normalizeConfig({ claude_cli: { enabled: true } }).claude_cli.auth_mode).toBe("proxy");
  });

  test("round-trips an explicit subscription mode", () => {
    const config = normalizeConfig({ claude_cli: { auth_mode: "subscription" } });
    const roundTrip = normalizeConfig(JSON.parse(JSON.stringify(config)));
    expect(roundTrip.claude_cli.auth_mode).toBe("subscription");
  });
});

describe("Claude CLI delegate config", () => {
  test("projects safe delegate defaults into legacy Claude CLI config", () => {
    const delegate = normalizeConfig({ claude_cli: { enabled: true } }).claude_cli.delegate;

    expect(delegate).toEqual({
      enabled: true,
      policy: "delegate_first",
      permission_mode: "acceptEdits",
      allowed_tools: [
        "Read", "Edit", "Write", "MultiEdit", "Grep", "Glob",
        "WebSearch", "WebFetch", "TodoWrite",
      ],
      model: "deepseek-v4-pro",
      timeout_ms: 420_000,
    });
  });

  test("projects the strongest proxy-routable model into an unset delegate", () => {
    const delegate = normalizeConfig({ claude_cli: { enabled: true, delegate: { model: "" } } }).claude_cli.delegate;
    expect(delegate.model).toBe("deepseek-v4-pro");
  });

  test("round-trips explicit delegate settings", () => {
    const config = normalizeConfig({
      claude_cli: {
        delegate: {
          enabled: false,
          policy: "escalation",
          permission_mode: "bypassPermissions",
          allowed_tools: ["Read", "Edit", "Bash(powershell:*)"],
          model: "opus",
          timeout_ms: 12_345,
        },
      },
    });

    expect(normalizeConfig(JSON.parse(JSON.stringify(config))).claude_cli.delegate).toEqual(
      config.claude_cli.delegate,
    );
  });
});

describe("skill distillation config", () => {
  test("enables judge-gated automatic promotion by default", () => {
    const config = defaultConfig().orchestrator.skill_distillation;
    expect(config.auto_promote).toBe(true);
    expect(config.min_judge_score).toBe(0.75);
  });
});

describe("stale jarvis_path warning dedupe (Task 3.5)", () => {
  test("warns once per distinct stale path per process, not on every normalization", () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
    try {
      const options = { platform: "win32" as NodeJS.Platform, exists: () => false };
      const stale = { jarvis_path: "/root/.openclaw/agents/task35-dedupe-fixture/workspace" };
      normalizeConfig(stale, options);
      normalizeConfig(stale, options);
      normalizeConfig(stale, options);
      const staleWarnings = warnings.filter((w) => w.includes("task35-dedupe-fixture"));
      expect(staleWarnings.length).toBe(1);
      // A DIFFERENT stale path is new information and warns again.
      normalizeConfig({ jarvis_path: "/root/.openclaw/agents/task35-other-fixture/workspace" }, options);
      expect(warnings.filter((w) => w.includes("task35-other-fixture")).length).toBe(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("the stale path is still corrected in memory on every call", () => {
    const options = { platform: "win32" as NodeJS.Platform, exists: () => false };
    const cfg = normalizeConfig({ jarvis_path: "/root/.openclaw/agents/task35-dedupe-fixture/workspace" }, options);
    expect(cfg.jarvis_path).not.toContain("/root/");
  });
});
