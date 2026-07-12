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
