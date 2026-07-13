import { describe, expect, test } from "bun:test";
import { normalizeConfig, normalizeSettingMutation } from "./config";

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
