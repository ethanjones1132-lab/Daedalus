import type { HarnessModule } from "../module";

/**
 * Plan-only rounds. The read-only authority is a module declaration, not a
 * prompt: the engine reads `tool_access` and the execution boundary composes
 * the maker's tools without any mutator. The round policy text is a hint to
 * the model, never the thing that keeps the workspace safe.
 *
 * `orchestration_candidate` is deliberately absent. The harness evidence
 * available to a module (round, sensor results, history) cannot establish that
 * a plan is large and parallelizable, so the module omits the claim instead of
 * asserting one it cannot support.
 */
export const planner: HarnessModule = {
  id: "planner",
  version: "1.0.0",
  description: "Inspect read-only, draft an ordered plan, then hand the work to the worker.",
  good_for: ["planning before implementation", "multi-step work that needs a written plan"],
  bad_for: ["work that must edit files in the planning round", "single-step tasks"],
  params_schema: { type: "object", properties: {}, additionalProperties: false },
  limits: { max_rounds: 1 },
  tool_access: "read_only",
  beforeRound: () => ({
    instructions: [
      "Plan only. Inspect the workspace with the read-only tools, then finish with a concrete,",
      "ordered plan and the evidence that will show each step is complete.",
      "Do not attempt an edit: this round exposes no mutating tool.",
    ].join(" "),
    skip_checker: true,
  }),
  afterSensors: () => ({
    kind: "suggest_switch",
    id: "worker",
    why: "plan drafted; hand off to the worker for implementation",
  }),
};
