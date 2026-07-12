import { beforeEach, describe, expect, test } from "bun:test";
import { AgentPool, firstTokenTimeoutFor, type OrchestratorAgent } from "../orchestration/agent-pool";
import { applyInferenceFeedback } from "./inference-feedback";
import {
  buildInferenceFeedbackCommand,
  refreshInferenceFeedback,
} from "./inference-feedback-refresh";
import { resetLearnedPoolStateForTests } from "./learned-pool-state";

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
});
