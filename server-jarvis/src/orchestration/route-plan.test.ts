import { describe, expect, test } from "bun:test";
import { RoutePlan, routeAttemptSseFrame } from "./route-plan";

describe("route plan", () => {
  test("a local fallback chain names the model that actually answered, not the configured one", () => {
    const plan = new RoutePlan();
    plan.add({ stage: "planner", provider: "llama_cpp", model: "qwen-local", choice: "configured", outcome: "success", duration_ms: 900 });
    plan.add({ stage: "synthesizer", provider: "llama_cpp", model: "qwen-local", choice: "configured", outcome: "timeout", duration_ms: 22_000, error: "First-token timeout" });
    plan.add({ stage: "synthesizer", provider: "ollama", model: "qwen3.5-9b", choice: "fallback", outcome: "success", duration_ms: 4_000, first_token_ms: 800, fallback_reason: "first_token_timeout" });
    const summary = plan.summary();
    expect(summary.answered_by).toEqual({ stage: "synthesizer", provider: "ollama", model: "qwen3.5-9b", cloud: false });
    expect(summary.left_machine).toBe(false);
    expect(summary.attempts).toHaveLength(3);
    expect(summary.attempts[1]).toMatchObject({ answered: false, error: "First-token timeout" });
  });

  test("any cloud hop is disclosed, even when a local model gave the final answer", () => {
    const plan = new RoutePlan();
    plan.add({ stage: "planner", provider: "opencode_zen", model: "deepseek-v4-flash-free", choice: "pool", outcome: "http_error", duration_ms: 300, error: "HTTP 400 model unavailable" });
    plan.add({ stage: "synthesizer", provider: "llama_cpp", model: "qwen-local", choice: "configured", outcome: "success", duration_ms: 5_000 });
    const summary = plan.summary();
    expect(summary.left_machine).toBe(true);
    expect(summary.attempts[0].cloud).toBe(true);
    expect(summary.answered_by?.provider).toBe("llama_cpp");
  });

  test("an answer stage wins over a later non-answer stage", () => {
    const plan = new RoutePlan();
    plan.add({ stage: "synthesizer", provider: "llama_cpp", model: "a", choice: "configured", outcome: "success", duration_ms: 1 });
    plan.add({ stage: "reviewer", provider: "ollama", model: "b", choice: "pool", outcome: "success", duration_ms: 1 });
    expect(plan.answeredBy()?.model).toBe("a");
  });

  test("a stopped attempt is recorded but never names the answer", () => {
    const plan = new RoutePlan();
    plan.add({ stage: "synthesizer", provider: "llama_cpp", model: "a", choice: "configured", outcome: "stopped", answered: false, duration_ms: 10 });
    expect(plan.summary().answered_by).toBeUndefined();
    expect(plan.attempts).toHaveLength(1);
  });

  test("incomplete attempts are ignored, errors are bounded and the plan is capped", () => {
    const plan = new RoutePlan();
    expect(plan.add({ stage: "", provider: "x", model: "y", choice: "pool", outcome: "success", duration_ms: 1 })).toBeUndefined();
    const long = plan.add({ stage: "s", provider: "x", model: "y", choice: "pool", outcome: "http_error", duration_ms: -5, error: "e".repeat(1000) });
    expect(long?.error?.length).toBe(240);
    expect(long?.duration_ms).toBe(0);
    for (let i = 0; i < 100; i++) plan.add({ stage: "s", provider: "x", model: "y", choice: "pool", outcome: "success", duration_ms: 1 });
    expect(plan.attempts.length).toBe(64);
  });

  test("the live frame carries the attempt and the session", () => {
    const plan = new RoutePlan();
    const attempt = plan.add({ stage: "synthesizer", provider: "llama_cpp", model: "a", choice: "configured", outcome: "success", duration_ms: 5 })!;
    const frame = routeAttemptSseFrame("s1", attempt);
    expect(frame.startsWith("data: ")).toBe(true);
    expect(JSON.parse(frame.slice(6))).toMatchObject({ type: "route_attempt", stage: "synthesizer", provider: "llama_cpp", answered: true, session_id: "s1" });
  });
});
