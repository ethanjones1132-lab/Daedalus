import { describe, expect, test } from "bun:test";
import { COORDINATOR_ROUTE_JSON_SCHEMA, extractConductorRoutingJson, stripGemmaThinkingArtifacts } from "./conductor-routing";

describe("conductor-routing", () => {
  test("route schema is compact and does not ask the conductor to author worker prompts", () => {
    expect(COORDINATOR_ROUTE_JSON_SCHEMA.properties.worker_instructions).toBeUndefined();
    expect(COORDINATOR_ROUTE_JSON_SCHEMA.properties.shared_context).toBeUndefined();
    expect(COORDINATOR_ROUTE_JSON_SCHEMA.properties.pipeline.maxItems).toBe(5);
  });
  test("extractConductorRoutingJson prefers route_pipeline tool call arguments", () => {
    const json = extractConductorRoutingJson({
      role: "assistant",
      content: "",
      tool_calls: [{
        function: {
          name: "route_pipeline",
          arguments: {
            task_type: "debug",
            pipeline: ["planner", "executor", "synthesizer"],
            topology: "linear",
            context: {
              needs_workspace_inspection: true,
              needs_memory: true,
              estimated_complexity: "high",
            },
            coordinator_rationale: "Needs tools.",
          },
        },
      }],
    });

    const parsed = JSON.parse(json);
    expect(parsed.task_type).toBe("debug");
    expect(parsed.pipeline).toEqual(["planner", "executor", "synthesizer"]);
  });

  test("extractConductorRoutingJson falls back to structured content", () => {
    const json = extractConductorRoutingJson({
      role: "assistant",
      content: '{"task_type":"general","pipeline":["synthesizer"],"topology":"linear","context":{"needs_workspace_inspection":false,"needs_memory":true,"estimated_complexity":"low"},"coordinator_rationale":"ok"}',
    });
    expect(JSON.parse(json).pipeline).toEqual(["synthesizer"]);
  });

  test("extractConductorRoutingJson preserves worker_instructions from tool calls", () => {
    const json = extractConductorRoutingJson({
      role: "assistant",
      content: "",
      tool_calls: [{
        function: {
          name: "route_pipeline",
          arguments: {
            task_type: "general",
            pipeline: ["executor", "synthesizer"],
            topology: "linear",
            context: {
              needs_workspace_inspection: true,
              needs_memory: true,
              estimated_complexity: "medium",
            },
            coordinator_rationale: "File read required.",
            worker_instructions: {
              executor: "Start with read_file on README.md.",
            },
          },
        },
      }],
    });

    const parsed = JSON.parse(json);
    expect(parsed.worker_instructions.executor).toContain("README.md");
  });

  test("stripGemmaThinkingArtifacts removes thinking channel blocks", () => {
    const cleaned = stripGemmaThinkingArtifacts(
      '<|channel>thought\nreasoning here<channel|>{"task_type":"general","pipeline":["synthesizer"],"topology":"linear","context":{"needs_workspace_inspection":false,"needs_memory":true,"estimated_complexity":"low"},"coordinator_rationale":"ok"}',
    );
    expect(cleaned.startsWith("{")).toBe(true);
    expect(cleaned).not.toContain("thought");
  });

  // ── Track B / B-01: conductor_replan decision type ────────────────────
  // B-01 acceptance: the JSON schema for `route_pipeline` must accept
  // `conductor_replan` as a valid `pipeline` array entry. This is the
  // Gemma-side contract for the new meta decision.
  test("B-01: schema includes conductor_replan in the pipeline string enum", () => {
    // The schema is intentionally a readonly `as const` object. Walk into it
    // and assert that the conductor model can emit `conductor_replan` from
    // at least one of the `anyOf` string entries. (There are two string
    // entries — the stage enum and the meta-decision enum — so we union
    // their allowed values rather than expecting one of them to be the new
    // meta decision.) If the schema drifts (e.g. someone narrows the anyOf
    // and drops the meta entry), this test fails immediately.
    const items = COORDINATOR_ROUTE_JSON_SCHEMA.properties.pipeline.items as {
      anyOf: Array<{ type?: string; enum?: string[]; pattern?: string }>;
    };
    const stringEnums = items.anyOf
      .filter((e) => e.type === "string" && Array.isArray(e.enum))
      .flatMap((e) => e.enum ?? []);
    expect(stringEnums).toContain("conductor_replan");
    // And the original stage enum must remain so we don't regress what the
    // conductor model can already emit.
    expect(stringEnums).toContain("executor");
    expect(stringEnums).toContain("synthesizer");
  });

  test("B-01: extractConductorRoutingJson preserves a conductor_replan pipeline entry", () => {
    // The schema + extractor must round-trip a `conductor_replan` decision
    // through the wire body of an Ollama `route_pipeline` tool call. This is
    // the exact failure mode that motivated B-01: the conductor's recursive
    // self-selection needs the meta decision to survive JSON extraction
    // untouched.
    const json = extractConductorRoutingJson({
      role: "assistant",
      content: "",
      tool_calls: [{
        function: {
          name: "route_pipeline",
          arguments: {
            task_type: "debug",
            pipeline: ["planner", "executor", "conductor_replan", "synthesizer"],
            topology: "linear",
            context: {
              needs_workspace_inspection: true,
              needs_memory: true,
              estimated_complexity: "high",
            },
            coordinator_rationale: "Replan mid-pipeline after executor discovers an unexpected schema.",
          },
        },
      }],
    });

    const parsed = JSON.parse(json);
    expect(parsed.task_type).toBe("debug");
    expect(parsed.pipeline).toEqual([
      "planner",
      "executor",
      "conductor_replan",
      "synthesizer",
    ]);
  });

  test("B-01: extractConductorRoutingJson preserves conductor_replan when emitted as content", () => {
    // Some conductor models (Gemma 4 in particular) emit the routing JSON as
    // a raw content string rather than a tool call. The extractor must
    // preserve the meta decision in that path too.
    const json = extractConductorRoutingJson({
      role: "assistant",
      content:
        '{"task_type":"research","pipeline":["planner","conductor_replan","synthesizer"],' +
        '"topology":"recursive","context":{"needs_workspace_inspection":false,' +
        '"needs_memory":true,"estimated_complexity":"medium"},"coordinator_rationale":"recursive research"}',
    });
    const parsed = JSON.parse(json);
    expect(parsed.pipeline).toEqual(["planner", "conductor_replan", "synthesizer"]);
    expect(parsed.topology).toBe("recursive");
  });
});
