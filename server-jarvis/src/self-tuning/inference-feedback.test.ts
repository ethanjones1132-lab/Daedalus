import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AgentPool, firstTokenTimeoutFor, type OrchestratorAgent } from "../orchestration/agent-pool";
import { applyInferenceFeedback } from "./inference-feedback";
import {
  buildInferenceFeedbackCommand,
  findInferenceMetricsScript,
  refreshInferenceFeedback,
} from "./inference-feedback-refresh";
import {
  applyPolicySnapshotToPool,
  clearInferenceFeedbackState,
  getLearnedPoolState,
  resetLearnedPoolStateForTests,
} from "./learned-pool-state";
import {
  getPolicyVersionStore,
  reapplyProductionPolicySnapshot,
  resetPolicyStagingForTests,
  type PolicyVersion,
} from "./policy-staging";

const slowDefault: OrchestratorAgent = {
  id: "slow-default",
  provider: "openrouter",
  model_id: "slow-model",
  capabilities: { code: 0.9, reasoning: 0.95, speed: 0.8, cost: 1, json_reliability: 0.9 },
  default_for: ["synthesizer"],
  enabled: true,
};

const fastAlternative: OrchestratorAgent = {
  id: "fast-alternative",
  provider: "openrouter",
  model_id: "fast-model",
  capabilities: { code: 0.8, reasoning: 0.82, speed: 0.9, cost: 1, json_reliability: 0.85 },
  default_for: [],
  enabled: true,
};

function policy(expiresAt: string) {
  return {
    schema_version: 1,
    generated_at: "2026-07-10T00:00:00.000Z",
    expires_at: expiresAt,
    routing_policy: {
      min_samples: 5,
      model_adjustments: {
        "openrouter:slow-model": {
          sample_count: 12,
          routing_score_delta: -0.25,
          speed_capability_delta: -0.15,
          reliability_capability_delta: -0.1,
          first_token_timeout_ms: 42_000,
        },
        "openrouter:fast-model": {
          sample_count: 10,
          routing_score_delta: 0.15,
          speed_capability_delta: 0.05,
          reliability_capability_delta: 0.05,
          first_token_timeout_ms: 18_000,
        },
      },
    },
  };
}

describe("inference feedback policy", () => {
  beforeEach(() => resetLearnedPoolStateForTests());

  test("valid empirical policy can demote a failing default and tune first-token budget", () => {
    expect(applyInferenceFeedback(policy("2026-07-12T00:00:00.000Z"), {
      now: new Date("2026-07-10T12:00:00.000Z"),
    })).toEqual({ applied: 2, ignored: 0, reason: undefined });

    const pool = new AgentPool([slowDefault, fastAlternative]);
    expect(pool.pickFor("synthesizer", "general")?.id).toBe("fast-alternative");
    expect(firstTokenTimeoutFor(pool, "slow-model", 30_000, 60_000, "openrouter")).toBe(42_000);
  });

  test("expired policy is ignored and cannot change routing", () => {
    expect(applyInferenceFeedback(policy("2026-07-09T00:00:00.000Z"), {
      now: new Date("2026-07-10T12:00:00.000Z"),
    }).reason).toBe("expired");
    const pool = new AgentPool([slowDefault, fastAlternative]);
    expect(pool.pickFor("synthesizer", "general")?.id).toBe("slow-default");
    expect(firstTokenTimeoutFor(pool, "slow-model", 30_000, 60_000, "openrouter")).toBe(30_000);
  });

  test("ignores stage adjustments with non-numeric sample counts", () => {
    const result = applyInferenceFeedback({
      ...policy("2026-07-12T00:00:00.000Z"),
      routing_policy: {
        min_samples: 5,
        model_adjustments: {},
        stage_adjustments: {
          "openrouter:slow-model:synthesizer": {
            sample_count: "not-a-number",
            routing_score_delta: -0.2,
          },
        },
      },
    }, { now: new Date("2026-07-10T12:00:00.000Z") });

    expect(result).toEqual({ applied: 0, ignored: 1, reason: undefined });
  });
});

describe("cron feedback refresh", () => {
  test("builds the deterministic metrics command with live DB and policy paths", () => {
    expect(buildInferenceFeedbackCommand({
      python: "python",
      scriptPath: "C:/Jarvis/automate_inference_metrics.py",
      dbPath: "C:/Users/test/.openclaw/jarvis/self-tuning.db",
      reportsPath: "C:/Users/test/.openclaw/jarvis/reports",
      policyPath: "C:/Users/test/.openclaw/jarvis/inference-feedback.json",
    })).toEqual([
      "python",
      "C:/Jarvis/automate_inference_metrics.py",
      "--db", "C:/Users/test/.openclaw/jarvis/self-tuning.db",
      "--output-dir", "C:/Users/test/.openclaw/jarvis/reports",
      "--policy-out", "C:/Users/test/.openclaw/jarvis/inference-feedback.json",
      "--format", "json",
    ]);
  });

  test("successful cron refresh loads the newly generated policy", async () => {
    const seen: string[][] = [];
    const result = await refreshInferenceFeedback({
      scriptPath: "C:/Jarvis/automate_inference_metrics.py",
      runCommand: async (command) => {
        seen.push(command);
        return { exitCode: 0, stdout: "Policy written", stderr: "" };
      },
      loadPolicy: () => ({ applied: 2, ignored: 0, reason: undefined }),
      paths: {
        python: "python",
        dbPath: "db",
        reportsPath: "reports",
        policyPath: "policy",
      },
    });
    expect(seen).toHaveLength(1);
    expect(result).toEqual({ success: true, output: "Policy written", applied: 2, ignored: 0 });
  });

  test("non-zero exit code captures trimmed stderr as the error", async () => {
    const result = await refreshInferenceFeedback({
      scriptPath: "C:/Jarvis/automate_inference_metrics.py",
      runCommand: async () => ({
        exitCode: 1,
        stdout: "   \n",
        stderr: "Traceback (most recent call last):\n  File ...\n",
      }),
      loadPolicy: () => ({ applied: 0, ignored: 0, reason: undefined }),
      paths: {
        python: "python",
        dbPath: "db",
        reportsPath: "reports",
        policyPath: "policy",
      },
    });
    // stdout is whitespace-only so trim() yields "" — error comes from stderr.
    expect(result.success).toBe(false);
    expect(result.output).toBe("");
    expect(result.error).toBe("Traceback (most recent call last):\n  File ...");
  });

  test("non-zero exit code without stderr falls back to the exit-code summary", async () => {
    const result = await refreshInferenceFeedback({
      scriptPath: "C:/Jarvis/automate_inference_metrics.py",
      runCommand: async () => ({ exitCode: 2, stdout: "", stderr: "" }),
      loadPolicy: () => ({ applied: 0, ignored: 0, reason: undefined }),
      paths: {
        python: "python",
        dbPath: "db",
        reportsPath: "reports",
        policyPath: "policy",
      },
    });
    expect(result.success).toBe(false);
    // The fallback message reflects the actual exit code.
    expect(result.error).toBe("metrics process exited 2");
  });

  test("error message is sliced to 2000 chars to bound operator-visible error logs", async () => {
    const result = await refreshInferenceFeedback({
      scriptPath: "C:/Jarvis/automate_inference_metrics.py",
      runCommand: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "x".repeat(5_000),
      }),
      loadPolicy: () => ({ applied: 0, ignored: 0, reason: undefined }),
      paths: {
        python: "python",
        dbPath: "db",
        reportsPath: "reports",
        policyPath: "policy",
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.length).toBe(2_000);
  });

  test("stdout is trimmed before being returned as output on the success path", async () => {
    const result = await refreshInferenceFeedback({
      scriptPath: "C:/Jarvis/automate_inference_metrics.py",
      runCommand: async () => ({
        exitCode: 0,
        stdout: "Policy written\n\n",
        stderr: "",
      }),
      loadPolicy: () => ({ applied: 3, ignored: 1, reason: undefined }),
      paths: {
        python: "python",
        dbPath: "db",
        reportsPath: "reports",
        policyPath: "policy",
      },
    });
    expect(result).toEqual({ success: true, output: "Policy written", applied: 3, ignored: 1 });
  });

  test("loadPolicy returning a reason short-circuits with a not-applied error and no applied count", async () => {
    const result = await refreshInferenceFeedback({
      scriptPath: "C:/Jarvis/automate_inference_metrics.py",
      runCommand: async () => ({ exitCode: 0, stdout: "Policy written\n", stderr: "" }),
      loadPolicy: () => ({ applied: 0, ignored: 0, reason: "missing" }),
      paths: {
        python: "python",
        dbPath: "db",
        reportsPath: "reports",
        policyPath: "policy",
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("generated inference policy was not applied: missing");
    // The reason short-circuit must NOT surface `applied`/`ignored` — they're
    // not the success path.
    expect(result.applied).toBeUndefined();
    expect(result.ignored).toBeUndefined();
  });

  test("loadPolicy reason preserves the trimmed stdout in the output field", async () => {
    const result = await refreshInferenceFeedback({
      scriptPath: "C:/Jarvis/automate_inference_metrics.py",
      runCommand: async () => ({
        exitCode: 0,
        stdout: "Policy written\n",
        stderr: "",
      }),
      loadPolicy: () => ({ applied: 0, ignored: 0, reason: "expired" }),
      paths: {
        python: "python",
        dbPath: "db",
        reportsPath: "reports",
        policyPath: "policy",
      },
    });
    expect(result.success).toBe(false);
    expect(result.output).toBe("Policy written");
    expect(result.error).toBe("generated inference policy was not applied: expired");
  });

  test("a thrown exception from runCommand is caught and surfaced as a failed result", async () => {
    const result = await refreshInferenceFeedback({
      scriptPath: "C:/Jarvis/automate_inference_metrics.py",
      runCommand: async () => {
        throw new Error("spawn failed");
      },
      loadPolicy: () => ({ applied: 0, ignored: 0, reason: undefined }),
      paths: {
        python: "python",
        dbPath: "db",
        reportsPath: "reports",
        policyPath: "policy",
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("spawn failed");
    expect(result.output).toBe("");
  });
});

describe("production policy durability across inference-feedback clear/apply", () => {
  const productionKey = "opencode_go:promoted-model";

  function seedProductionSnapshot(): void {
    const snapshot = {
      modelRoutingScoreDeltas: { [productionKey]: 0.12 },
      stageModelRoutingScoreDeltas: {},
      fallbackBoosts: {},
      modelFirstTokenTimeouts: { [productionKey]: 40_000 },
      recovery: { prefer_fallback_on_timeout: true },
    };
    applyPolicySnapshotToPool(snapshot);
    const production: PolicyVersion = {
      id: "pv-durability-test",
      version: 1,
      stage: "production",
      domain: "routing",
      snapshot,
      patch: {
        domain: "routing",
        modelRoutingScoreDeltas: { [productionKey]: 0.12 },
      },
      rationale: "seeded for durability test",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
      eligibleOutcomes: 0,
      eligibleSuccessCount: 0,
      eligibleFailureCount: 0,
      history: [],
    };
    getPolicyVersionStore().production = production;
  }

  beforeEach(() => {
    resetPolicyStagingForTests();
    resetLearnedPoolStateForTests();
  });

  test("reapplyProductionPolicySnapshot restores keys wiped by clearInferenceFeedbackState", () => {
    seedProductionSnapshot();
    const state = getLearnedPoolState();
    expect(state.modelRoutingScoreDeltas.get(productionKey)).toBe(0.12);

    clearInferenceFeedbackState();
    expect(state.modelRoutingScoreDeltas.get(productionKey)).toBeUndefined();
    expect(state.modelFirstTokenTimeouts.get(productionKey)).toBeUndefined();
    // recovery is not cleared by clearInferenceFeedbackState
    expect(state.recoveryPolicy.get("prefer_fallback_on_timeout")).toBe(true);

    expect(reapplyProductionPolicySnapshot()).toBe(true);
    expect(state.modelRoutingScoreDeltas.get(productionKey)).toBe(0.12);
    expect(state.modelFirstTokenTimeouts.get(productionKey)).toBe(40_000);
  });

  test("applyInferenceFeedback re-merges production so promote is not undone in-process", () => {
    seedProductionSnapshot();
    const state = getLearnedPoolState();
    expect(state.modelRoutingScoreDeltas.get(productionKey)).toBe(0.12);

    // This path clears the four cron-managed maps then reloads feedback — the
    // durability hole before reapply would drop productionKey until restart.
    const result = applyInferenceFeedback(policy("2026-07-12T00:00:00.000Z"), {
      now: new Date("2026-07-10T12:00:00.000Z"),
    });
    expect(result).toEqual({ applied: 2, ignored: 0, reason: undefined });

    // Production key survives clear + operational reload.
    expect(state.modelRoutingScoreDeltas.get(productionKey)).toBe(0.12);
    expect(state.modelFirstTokenTimeouts.get(productionKey)).toBe(40_000);
    // Operational feedback coexists.
    expect(state.modelRoutingScoreDeltas.get("openrouter:slow-model")).toBe(-0.25);
    expect(state.modelRoutingScoreDeltas.get("openrouter:fast-model")).toBe(0.15);
    expect(state.modelFirstTokenTimeouts.get("openrouter:slow-model")).toBe(42_000);
  });

  test("expired feedback still re-applies production after clear", () => {
    seedProductionSnapshot();
    const result = applyInferenceFeedback(policy("2026-07-09T00:00:00.000Z"), {
      now: new Date("2026-07-10T12:00:00.000Z"),
    });
    expect(result.reason).toBe("expired");
    expect(getLearnedPoolState().modelRoutingScoreDeltas.get(productionKey)).toBe(0.12);
  });
});

describe("findInferenceMetricsScript (env override precedence)", () => {
  let tempRoot = "";
  let savedEnv: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "jarvis-inference-metrics-"));
    // Save and clear the env var so a leaked value from a previous test (or
    // the user's shell) cannot hijack these assertions.
    savedEnv = process.env.JARVIS_INFERENCE_METRICS_SCRIPT;
    delete process.env.JARVIS_INFERENCE_METRICS_SCRIPT;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.JARVIS_INFERENCE_METRICS_SCRIPT;
    } else {
      process.env.JARVIS_INFERENCE_METRICS_SCRIPT = savedEnv;
    }
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  test("JARVIS_INFERENCE_METRICS_SCRIPT takes priority when the configured file exists", () => {
    const overridePath = join(tempRoot, "my-custom-metrics.py");
    writeFileSync(overridePath, "# custom metrics", "utf-8");
    process.env.JARVIS_INFERENCE_METRICS_SCRIPT = overridePath;
    expect(findInferenceMetricsScript()).toBe(overridePath);
  });

  test("JARVIS_INFERENCE_METRICS_SCRIPT is silently ignored when the configured path does not exist", () => {
    process.env.JARVIS_INFERENCE_METRICS_SCRIPT = join(tempRoot, "does-not-exist.py");
    // The repo-root candidate <repo>/automate_inference_metrics.py is always
    // present in this workspace, so the function falls through to it. The
    // contract under test is: a misconfigured env var must not silently pick
    // an empty / wrong path; the existsSync guard skips it and the walk
    // continues.
    const result = findInferenceMetricsScript();
    expect(result).toBeDefined();
    expect(result).not.toContain("does-not-exist.py");
  });
});
