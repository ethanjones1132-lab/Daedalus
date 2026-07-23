import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PersistentConductor,
  __resetPersistentConductorCachesForTests,
  delegateBackendHealthFields,
  emptyTaskPlanHealthFields,
  policyStagingHealthFields,
  resolveActiveGradingMode,
  taskPlanHealthFields,
} from "./persistent-conductor";
import { defaultConfig, type JarvisConfig } from "../config";
import { __resetOllamaHealthCacheForTests } from "../ollama";
import {
  proposePolicy,
  resetPolicyStagingForTests,
} from "../self-tuning/policy-staging";
import {
  createTaskRun,
  incrementPlanItemRepairCycle,
  getActivePlanItem,
} from "./task-run";

const originalFetch = globalThis.fetch;

function makeConfig(overrides: Partial<JarvisConfig["orchestrator"]["conductor"]> = {}): JarvisConfig {
  const cfg = defaultConfig();
  cfg.orchestrator.conductor = {
    ...cfg.orchestrator.conductor,
    ...overrides,
  };
  return cfg;
}

beforeEach(() => {
  resetPolicyStagingForTests();
  __resetPersistentConductorCachesForTests();
  __resetOllamaHealthCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetPolicyStagingForTests();
  __resetPersistentConductorCachesForTests();
  __resetOllamaHealthCacheForTests();
});

describe("taskPlanHealthFields", () => {
  test("returns null ledger fields when no task is provided", () => {
    expect(taskPlanHealthFields()).toEqual(emptyTaskPlanHealthFields());
    expect(taskPlanHealthFields(null)).toEqual(emptyTaskPlanHealthFields());
  });

  test("returns null ledger fields for terminal task runs", () => {
    const contract = createTaskRun({
      taskRunId: "task_done",
      sessionId: "sess_a",
      objective: "done work",
      requirement: "full_execution",
      estimatedComplexity: "low",
      planItems: [{ title: "write file" }],
    });
    contract.status = "completed";
    expect(taskPlanHealthFields(contract, "sess_a")).toEqual(emptyTaskPlanHealthFields());
  });

  test("exposes active plan item, grading mode, and repair cycle count", () => {
    let contract = createTaskRun({
      taskRunId: "task_live",
      sessionId: "sess_b",
      objective: "implement the feature",
      requirement: "full_execution",
      estimatedComplexity: "low",
      planItems: [{ title: "add cache layer" }],
    });
    const active = getActivePlanItem(contract)!;
    expect(active).toBeTruthy();

    contract = incrementPlanItemRepairCycle(contract, active.id);

    const fields = taskPlanHealthFields(contract, "sess_b");
    expect(fields.active_task_run_id).toBe("task_live");
    expect(fields.active_task_session_id).toBe("sess_b");
    expect(fields.active_task_status).toBe("active");
    expect(fields.active_task_objective).toBe("implement the feature");
    expect(fields.active_plan_item_id).toBe(active.id);
    expect(fields.active_plan_item_title).toBe(active.title);
    expect(fields.active_plan_item_status).toBe("active");
    expect(fields.repair_cycle_count).toBe(1);
    // repair cycle implies reviewer-mediated chain is active
    expect(fields.grading_mode).toBe("reviewer_mediated");
  });

  test("low-complexity active item defaults to conductor_direct_diff grading", () => {
    const contract = createTaskRun({
      taskRunId: "task_simple",
      sessionId: "sess_c",
      objective: "add a README note",
      requirement: "full_execution",
      estimatedComplexity: "low",
      planItems: [{ title: "edit README" }],
    });
    const fields = taskPlanHealthFields(contract);
    expect(fields.grading_mode).toBe("conductor_direct_diff");
    expect(fields.repair_cycle_count).toBe(0);
  });

  test("medium complexity defaults to reviewer_mediated grading", () => {
    const contract = createTaskRun({
      taskRunId: "task_complex",
      sessionId: "sess_d",
      objective: "refactor the orchestrator",
      requirement: "full_execution",
      estimatedComplexity: "high",
      planItems: [{ title: "refactor pipeline" }],
    });
    expect(taskPlanHealthFields(contract).grading_mode).toBe("reviewer_mediated");
  });
});

describe("resolveActiveGradingMode", () => {
  test("prefers explicit gradingMode", () => {
    expect(
      resolveActiveGradingMode({ gradingMode: "conductor_direct_diff", repairCycleCount: 3 }),
    ).toBe("conductor_direct_diff");
  });

  test("repair cycle implies reviewer_mediated", () => {
    expect(resolveActiveGradingMode({ repairCycleCount: 1 })).toBe("reviewer_mediated");
  });

  test("reviewer_pass acceptance check implies reviewer_mediated", () => {
    expect(
      resolveActiveGradingMode({
        repairCycleCount: 0,
        acceptanceChecks: [{ kind: "reviewer_pass" }],
      }),
    ).toBe("reviewer_mediated");
  });
});

describe("delegateBackendHealthFields", () => {
  test("proxy + OpenAI-format OpenCode Go model stays proxy", () => {
    const cfg = defaultConfig();
    cfg.claude_cli.auth_mode = "proxy";
    // deepseek-v4-pro is OpenAI-format on OpenCode Go → local proxy path
    cfg.claude_cli.delegate.model = "deepseek-v4-pro";
    const fields = delegateBackendHealthFields(cfg);
    expect(fields.delegate_backend).toBe("proxy");
    expect(fields.delegate_auth_mode).toBe("proxy");
    expect(fields.delegate_model).toBe("deepseek-v4-pro");
  });

  test("subscription mode reports subscription backend", () => {
    const cfg = defaultConfig();
    cfg.claude_cli.auth_mode = "subscription";
    cfg.claude_cli.delegate.model = "claude-sonnet-4-20250514";
    const fields = delegateBackendHealthFields(cfg);
    expect(fields.delegate_backend).toBe("subscription");
    expect(fields.delegate_auth_mode).toBe("subscription");
  });

  test("proxy + Anthropic-native OpenCode Go model projects to opencode_go", () => {
    const cfg = defaultConfig();
    cfg.claude_cli.auth_mode = "proxy";
    // minimax-m* is Anthropic-native → point-to-point OpenCode Go, not the proxy
    cfg.claude_cli.delegate.model = "minimax-m3";
    cfg.opencode_go.api_key = "sk-test-go";
    const fields = delegateBackendHealthFields(cfg);
    expect(fields.delegate_backend).toBe("opencode_go");
    expect(fields.delegate_auth_mode).toBe("proxy");
  });
});

describe("policyStagingHealthFields", () => {
  test("returns nulls when no policy is staged", () => {
    const fields = policyStagingHealthFields();
    expect(fields.policy_version).toBeNull();
    expect(fields.policy_version_id).toBeNull();
    expect(fields.policy_stage).toBeNull();
    expect(fields.policy_canary_id).toBeNull();
    expect(fields.policy_lkg_id).toBeNull();
    expect(fields.policy_candidate_id).toBeNull();
  });

  test("exposes candidate after proposePolicy", () => {
    const result = proposePolicy(
      { domain: "routing", modelRoutingScoreDeltas: { "openrouter:m": 0.1 } },
      "test candidate",
    );
    expect(result.action).toBe("proposed");
    const fields = policyStagingHealthFields();
    expect(fields.policy_candidate_id).toBe(result.version?.id ?? null);
    expect(fields.policy_candidate_id).toBeTruthy();
    // production still empty until promote
    expect(fields.policy_version).toBeNull();
  });
});

describe("PersistentConductor.describeHealth telemetry extension", () => {
  test("includes null ledger + delegate + policy fields with no active task", async () => {
    (globalThis as any).fetch = async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "gemma4:e2b" }] });
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const cfg = makeConfig({ model: "gemma4:e2b", fallback_model: "gemma4:e2b" });
    cfg.claude_cli.auth_mode = "proxy";
    cfg.claude_cli.delegate.model = "deepseek-v4-pro";
    const conductor = new PersistentConductor(() => cfg);
    const health = await conductor.describeHealth();

    expect(health.enabled).toBe(true);
    expect(health.model).toBe("gemma4:e2b");
    expect(health.fallback_model).toBe("gemma4:e2b");
    expect(health.active_task_run_id).toBeNull();
    expect(health.active_plan_item_id).toBeNull();
    expect(health.grading_mode).toBeNull();
    expect(health.repair_cycle_count).toBeNull();
    expect(health.delegate_backend).toBe("proxy");
    expect(health.delegate_auth_mode).toBe("proxy");
    expect(health.delegate_model).toBe("deepseek-v4-pro");
    expect(health.policy_version).toBeNull();
  });

  test("wires active TaskPlan item into describeHealth options", async () => {
    (globalThis as any).fetch = async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "gemma4:e2b" }] });
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const cfg = makeConfig({ model: "gemma4:e2b" });
    const conductor = new PersistentConductor(() => cfg);
    const contract = createTaskRun({
      taskRunId: "task_health",
      sessionId: "sess_health",
      objective: "ship Task 8 health surface",
      requirement: "full_execution",
      estimatedComplexity: "low",
      planItems: [{ title: "extend describeHealth" }],
    });
    let withRepair = incrementPlanItemRepairCycle(contract, getActivePlanItem(contract)!.id);

    const health = await conductor.describeHealth({
      taskRun: withRepair,
      sessionId: "sess_health",
    });

    expect(health.active_task_run_id).toBe("task_health");
    expect(health.active_task_session_id).toBe("sess_health");
    expect(health.active_task_objective).toContain("Task 8");
    expect(health.active_plan_item_title).toBe("extend describeHealth");
    expect(health.active_plan_item_status).toBe("active");
    expect(health.repair_cycle_count).toBe(1);
    expect(health.grading_mode).toBe("reviewer_mediated");
  });

  test("disabled conductor still reports telemetry extras", async () => {
    const cfg = makeConfig({ enabled: false });
    cfg.claude_cli.auth_mode = "subscription";
    const conductor = new PersistentConductor(() => cfg);
    const health = await conductor.describeHealth();
    expect(health.enabled).toBe(false);
    expect(health.available).toBe(false);
    expect(health.reason).toBe("disabled");
    expect(health.delegate_backend).toBe("subscription");
    expect(health.active_task_run_id).toBeNull();
  });
});
