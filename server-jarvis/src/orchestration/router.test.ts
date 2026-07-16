import { describe, expect, test } from "bun:test";
import type { CallModelFn, ChatMessage } from "./coordinator";
import { PredictiveRouter, type RoutingResult } from "./router";

function mkCallModel(reply: { content: string } | { throw: Error }): CallModelFn {
  return (async (_msgs: ChatMessage[]) => {
    if ("throw" in reply) throw reply.throw;
    return reply;
  }) as CallModelFn;
}

function capturedCallModel(reply: { content: string }): {
  callModel: CallModelFn;
  messages: ChatMessage[][];
  options: any[];
} {
  const messages: ChatMessage[][] = [];
  const options: any[] = [];
  const callModel: CallModelFn = (async (msgs, opts) => {
    messages.push(msgs);
    options.push(opts);
    return reply;
  }) as CallModelFn;
  return { callModel, messages, options };
}

describe("PredictiveRouter (compatibility shim) contract pin", () => {
  test("clean JSON parse path returns the model-provided routing result unchanged", async () => {
    const parsed: RoutingResult = {
      task_type: "debug",
      pipeline: ["planner", "executor", "synthesizer"],
      context: {
        needs_workspace_inspection: true,
        needs_memory: false,
        estimated_complexity: "high",
      },
      routing_rationale: "User asked to investigate a failure.",
    };
    const { callModel, messages, options } = capturedCallModel({
      content: JSON.stringify(parsed),
    });
    const router = new PredictiveRouter(callModel);

    const got = await router.route("Why is the bun server down?");

    // The model-provided values must be preserved verbatim.
    expect(got.task_type).toBe("debug");
    expect(got.pipeline).toEqual(["planner", "executor", "synthesizer"]);
    expect(got.context).toEqual({
      needs_workspace_inspection: true,
      needs_memory: false,
      estimated_complexity: "high",
    });
    expect(got.routing_rationale).toBe("User asked to investigate a failure.");

    // The router always wraps a 2-message system+user pair.
    expect(messages.length).toBe(1);
    expect(messages[0].length).toBe(2);
    expect(messages[0][0].role).toBe("system");
    expect(messages[0][1].role).toBe("user");
    expect(messages[0][1].content).toBe("Why is the bun server down?");
    // Deterministic low-temperature + bounded max_tokens.
    expect(options[0]).toEqual({ temperature: 0.1, max_tokens: 512 });
  });

  test("extractJson recovery path: JSON embedded in surrounding prose is recovered", async () => {
    const reply = [
      "Sure, here is the routing decision:",
      "",
      "```json",
      JSON.stringify({
        task_type: "refactor",
        pipeline: ["planner", "executor", "reviewer", "synthesizer"],
        context: { needs_workspace_inspection: true, needs_memory: true, estimated_complexity: "medium" },
        routing_rationale: "Multi-file refactor request.",
      }),
      "```",
      "",
      "Let me know if you need anything else.",
    ].join("\n");

    const router = new PredictiveRouter(mkCallModel({ content: reply }));
    const got = await router.route("refactor this module");

    expect(got.task_type).toBe("refactor");
    expect(got.pipeline).toEqual(["planner", "executor", "reviewer", "synthesizer"]);
    expect(got.routing_rationale).toBe("Multi-file refactor request.");
  });

  test("hard parse failure falls back to the documented default pipeline with an explanatory rationale", async () => {
    const router = new PredictiveRouter(mkCallModel({ content: "totally not json, no braces at all" }));
    const got = await router.route("anything");

    // Documented fallback shape (the JSDoc says this is the compatibility-shim
    // default; the live orchestrator path uses Coordinator instead).
    expect(got.task_type).toBe("general");
    expect(got.pipeline).toEqual(["planner", "executor", "reviewer", "synthesizer"]);
    expect(got.context).toEqual({
      needs_workspace_inspection: true,
      needs_memory: true,
      estimated_complexity: "medium",
    });
    expect(got.routing_rationale.startsWith("Fallback routing due to error:")).toBe(true);
    expect(got.routing_rationale).toContain("totally not json");
  });

  test("callModel throw is also caught and returns the fallback routing", async () => {
    const router = new PredictiveRouter(mkCallModel({ throw: new Error("upstream boom") }));
    const got = await router.route("trigger error path");

    expect(got.task_type).toBe("general");
    expect(got.pipeline).toEqual(["planner", "executor", "reviewer", "synthesizer"]);
    expect(got.routing_rationale).toBe("Fallback routing due to error: upstream boom");
  });

  test("normalize() partial JSON: missing task_type defaults to 'general'", async () => {
    const router = new PredictiveRouter(
      mkCallModel({
        content: JSON.stringify({
          pipeline: ["planner", "synthesizer"],
          context: { needs_workspace_inspection: false, needs_memory: true, estimated_complexity: "low" },
          routing_rationale: "Trivial conversational turn.",
        }),
      }),
    );
    const got = await router.route("hi");
    expect(got.task_type).toBe("general");
    expect(got.pipeline).toEqual(["planner", "synthesizer"]);
  });

  test("normalize() partial JSON: missing pipeline defaults to the full 4-stage default", async () => {
    const router = new PredictiveRouter(
      mkCallModel({
        content: JSON.stringify({
          task_type: "research",
          context: { needs_workspace_inspection: false, needs_memory: false, estimated_complexity: "low" },
          routing_rationale: "Research only.",
        }),
      }),
    );
    const got = await router.route("find docs for X");
    expect(got.task_type).toBe("research");
    expect(got.pipeline).toEqual(["planner", "executor", "reviewer", "synthesizer"]);
  });

  test("normalize() partial JSON: missing context fields default individually", async () => {
    const router = new PredictiveRouter(
      mkCallModel({
        content: JSON.stringify({
          task_type: "plan",
          pipeline: ["synthesizer"],
          routing_rationale: "Plan only.",
        }),
      }),
    );
    const got = await router.route("draft a plan");
    // Each missing field falls back independently:
    //   needs_workspace_inspection -> false
    //   needs_memory               -> true
    //   estimated_complexity       -> "medium"
    expect(got.context).toEqual({
      needs_workspace_inspection: false,
      needs_memory: true,
      estimated_complexity: "medium",
    });
  });

  test("normalize() partial JSON: missing routing_rationale defaults to 'Auto-routed.'", async () => {
    const router = new PredictiveRouter(
      mkCallModel({
        content: JSON.stringify({
          task_type: "general",
          pipeline: ["synthesizer"],
          context: { needs_workspace_inspection: false, needs_memory: true, estimated_complexity: "low" },
        }),
      }),
    );
    const got = await router.route("anything");
    expect(got.routing_rationale).toBe("Auto-routed.");
  });
});
