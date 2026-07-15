import { describe, expect, test } from "bun:test";
import type { OrchestratorAgent } from "./agent-pool";
import { validateOrchestratorAgent, validateOrchestratorAgents } from "./agent-validation";

function base(over: Partial<OrchestratorAgent> = {}): OrchestratorAgent {
  return {
    id: "agent-a",
    provider: "openrouter",
    model_id: "test/model",
    capabilities: { code: 0.8, reasoning: 0.8, speed: 0.8, cost: 0.5, json_reliability: 0.9 },
    default_for: [],
    enabled: true,
    ...over,
  };
}

describe("validateOrchestratorAgent (T3.1)", () => {
  test("accepts a well-formed agent", () => {
    expect(validateOrchestratorAgent(base())).toEqual([]);
  });

  test("rejects unroutable provider", () => {
    const issues = validateOrchestratorAgent(base({ provider: "ollama" }));
    expect(issues.some((i) => i.message.includes("not routable"))).toBe(true);
  });

  test("rejects out-of-range capabilities", () => {
    const issues = validateOrchestratorAgent(base({
      capabilities: { code: 1.5, reasoning: 0.5, speed: 0.5, cost: 0.5, json_reliability: 0.5 },
    }));
    expect(issues.some((i) => i.message.includes("capabilities.code"))).toBe(true);
  });

  test("rejects unknown default_for stage", () => {
    const issues = validateOrchestratorAgent(base({ default_for: ["wizard"] }));
    expect(issues.some((i) => i.message.includes("unknown stage"))).toBe(true);
  });

  test("warns when coordinator pin has low json_reliability", () => {
    const issues = validateOrchestratorAgent(base({
      default_for: ["coordinator"],
      capabilities: { code: 0.5, reasoning: 0.5, speed: 0.5, cost: 0.5, json_reliability: 0.5 },
    }));
    expect(issues.some((i) => i.level === "warn" && i.message.includes("json_reliability"))).toBe(true);
  });

  test("rejects system_prompt over 4000 chars", () => {
    const issues = validateOrchestratorAgent(base({ system_prompt: "x".repeat(4001) }));
    expect(issues.some((i) => i.message.includes("system_prompt"))).toBe(true);
  });

  test("detects duplicate ids across the pool", () => {
    const a = base({ id: "dup" });
    const b = base({ id: "dup", model_id: "other" });
    const issues = validateOrchestratorAgents([a, b]);
    expect(issues.some((i) => i.message.includes("duplicate"))).toBe(true);
  });
});
