import { describe, expect, test } from "bun:test";
import { Coordinator, CoordinatorError, type ChatMessage } from "./coordinator";

describe("Coordinator", () => {
  test("parses skip and re-enter decisions from coordinator JSON", async () => {
    const calls: ChatMessage[][] = [];
    const coordinator = new Coordinator(async (messages) => {
      calls.push(messages);
      return {
        content: JSON.stringify({
          task_type: "debug",
          pipeline: ["planner", null, "re-enter:planner", "synthesizer"],
          topology: "linear",
          context: {
            needs_workspace_inspection: true,
            needs_memory: true,
            estimated_complexity: "high",
          },
          coordinator_rationale: "Executor failed, re-enter planning with the error context.",
        }),
      };
    });

    const result = await coordinator.route("Fix the failing chat stream", {
      sessionId: "session-1",
      history: [{ role: "assistant", content: "Previous investigation found a stream error." }],
      lastOutcome: "executor failed: API 503",
    });

    expect(result.task_type).toBe("debug");
    expect(result.pipeline).toEqual(["planner", null, "re-enter:planner", "synthesizer"]);
    expect(result.topology).toBe("linear");
    expect(result.context.estimated_complexity).toBe("high");
    expect(result.coordinator_rationale).toContain("re-enter");
    expect(calls[0][0].role).toBe("system");
    expect(calls[0][1].content).toContain("session-1");
    expect(calls[0][1].content).toContain("executor failed: API 503");
  });

  test("surfaces coordinator failure instead of silently defaulting", async () => {
    const coordinator = new Coordinator(async () => ({ content: "not json" }));

    await expect(coordinator.route("hello", { sessionId: "session-2" })).rejects.toBeInstanceOf(CoordinatorError);
  });
});
