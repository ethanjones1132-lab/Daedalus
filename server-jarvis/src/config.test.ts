import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { InvalidConfigError, defaultConfig, normalizeConfig, normalizeSettingMutation, saveConfig, validateConfig } from "./config";

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
  test("clamps configured repair rounds to the safe 0..2 range", () => {
    expect(normalizeConfig({ orchestrator: { max_review_repair_rounds: 99 } }).orchestrator.max_review_repair_rounds).toBe(2);
    expect(normalizeConfig({ orchestrator: { max_review_repair_rounds: -3 } }).orchestrator.max_review_repair_rounds).toBe(0);
    expect(normalizeConfig({ orchestrator: { max_review_repair_rounds: "not-a-number" } }).orchestrator.max_review_repair_rounds).toBe(1);
  });
});

describe("trajectory snapshot retention config", () => {
  test.each([-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid limit %p", (limit) => {
    const cfg = normalizeConfig(
      { orchestrator: { conductor_learning: { max_trajectory_snapshots: limit } } },
      { healInvalidTrajectorySnapshots: false },
    );
    const validation = validateConfig(cfg);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((error) => error.includes("max_trajectory_snapshots"))).toBe(true);
  });

  test("heals legacy invalid values to the documented default", () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
    try {
      const cfg = normalizeConfig({
        orchestrator: { conductor_learning: { max_trajectory_snapshots: -1 } },
      });
      expect(cfg.orchestrator.conductor_learning.max_trajectory_snapshots).toBe(500);
      expect(warnings.some((warning) => warning.includes("max_trajectory_snapshots"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("accepts finite positive integer limits", () => {
    for (const limit of [1, 500, 10_000]) {
      const cfg = normalizeConfig(
        { orchestrator: { conductor_learning: { max_trajectory_snapshots: limit } } },
        { healInvalidTrajectorySnapshots: false },
      );
      expect(validateConfig(cfg).valid).toBe(true);
    }
  });

  test("rejects an invalid save without replacing the existing config", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-config-retention-"));
    const file = join(dir, "config.json");
    const before = JSON.stringify(defaultConfig(), null, 2);
    writeFileSync(file, before);
    let thrown: unknown;
    let after: string | null = null;
    try {
      saveConfig(
        {
          orchestrator: { conductor_learning: { max_trajectory_snapshots: -1 } },
        } as any,
        { currentConfig: defaultConfig(), configFile: file },
      );
    } catch (error) {
      thrown = error;
    } finally {
      after = readFileSync(file, "utf8");
      rmSync(dir, { recursive: true, force: true });
    }
    expect(thrown).toBeInstanceOf(InvalidConfigError);
    expect(after).toBe(before);
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
    // Post-2026-07-26 free-first delegate work: when no model is set, the
    // delegate defaults to "auto" (free-first, thrash → cheap Go). The
    // Anthropic-native OpenCode Go primary is the fallback after thrash.
    const delegate = normalizeConfig({ claude_cli: { enabled: true } }).claude_cli.delegate;

    expect(delegate).toEqual({
      enabled: true,
      policy: "delegate_first",
      permission_mode: "acceptEdits",
      allowed_tools: [
        "Read", "Edit", "Write", "MultiEdit", "Grep", "Glob", "Bash",
        "WebSearch", "WebFetch", "TodoWrite",
      ],
      model: "auto",
      free_thrash_threshold: 2,
      exploration_limit_ms: 45_000,
      native_fallback_reserve_ms: 30_000,
      thrash_ttl_ms: 30 * 60_000,
      timeout_ms: 420_000,
    });
  });

  test("projects auto into an unset delegate", () => {
    // After the free-first change, an explicit empty delegate.model merges
    // through deepMerge's blank-string guard and stays on the "auto" default;
    // the migration only kicks in when the merged value is missing entirely
    // (not when an explicit empty string is overridden by a non-empty default).
    const delegate = normalizeConfig({ claude_cli: { enabled: true, delegate: { model: "" } } }).claude_cli.delegate;
    expect(delegate.model).toBe("auto");
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

  test("stale on-disk allowlist without Bash is re-unioned with the floor (2026-08-04 live)", () => {
    // Production config had dropped Bash after deepMerge replaced the default
    // array wholesale — verification greps via shell were then policy-denied.
    const delegate = normalizeConfig({
      claude_cli: {
        delegate: {
          allowed_tools: [
            "Read", "Edit", "Write", "MultiEdit", "Grep", "Glob",
            "WebSearch", "WebFetch", "TodoWrite",
          ],
        },
      },
    }).claude_cli.delegate;
    expect(delegate.allowed_tools).toContain("Bash");
    expect(delegate.allowed_tools).toContain("Read");
    expect(delegate.allowed_tools).toContain("Write");
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

describe("conductor fallback default", () => {
  test("the conductor fallback default is not the 85%-error model", () => {
    // model_attributions 2026-07-29: gemma4:e2b n=67, 85.1% error. It was
    // picked at config.ts:596 on latency alone (~1.8s vs ~4.4s) with no
    // error-rate input. A fallback that fails 85% of the time is not a fallback.
    const cfg = defaultConfig();
    expect(cfg.orchestrator.conductor.fallback_model).not.toBe("gemma4:e2b");
  });

  test("the conductor primary and fallback default to distinct models", () => {
    // 2026-07-29: an earlier pass fixed the 85%-error fallback by matching it
    // to the (then) primary, which silently collapsed model === fallback_model
    // — a no-op fallback with nothing left to fall back to. Structural guard so
    // a future edit can't reintroduce that degeneracy without failing loudly.
    const cfg = defaultConfig();
    expect(cfg.orchestrator.conductor.fallback_model).not.toBe(cfg.orchestrator.conductor.model);
  });
});
