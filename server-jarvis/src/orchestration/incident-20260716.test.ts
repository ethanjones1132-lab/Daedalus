/**
 * Incident fixtures for 2026-07-16 supervision-starvation forensics.
 *
 * Source: docs/DIAGNOSIS_ORCHESTRATION_SUPERVISION_2026-07-16.md
 * Plan:   docs/superpowers/plans/2026-07-16-supervision-starvation-remediation.md (Phase 0)
 *
 * Target run: run_5283dd64 (session a074271b) — Versutus gap-analysis, failed ~142s.
 */
import { describe, expect, test } from "bun:test";
import { LiveConductor } from "./conductor";
import { ConductorBus } from "./conductor-bus";
import { AgentPool, DEFAULT_ORCHESTRATOR_AGENTS } from "./agent-pool";
import { createTurnBudget } from "./turn-budget";
import { rejectReroute } from "./reroute-policy";
import type { ConductorDirective } from "./conductor-bus";

/** Approximate plan body from the incident (planner produced ~750 output tokens). */
const INCIDENT_PLAN_TEXT = [
  "Architecture audit plan for the Versutus repository.",
  "1. Inventory app entry points under src/app and lib/gateway.",
  "2. Read dashboard.ts, client.ts, and layout sources for routing seams.",
  "3. Map gateway request handling and auth boundaries.",
  "4. Identify remaining gaps versus a production-ready Expo/RN shell.",
  "5. Summarize findings with concrete file-level recommendations.",
  "Worker should list src/app, then deep-read the named source files before synthesizing.",
].join(" ").repeat(8);

const INCIDENT_REQUEST =
  "Identify all remaining gaps in the repo for a comprehensive architecture audit.";
const INCIDENT_WORKSPACE = "C:\\Projects\\Versutus";

/** Wall-clock origin for run_5283dd64 timing math (relative offsets only). */
const T0 = 0;

function makeSupervisingConductor(
  supervisorContent: string,
): LiveConductor {
  const bus = new ConductorBus();
  const pool = new AgentPool(DEFAULT_ORCHESTRATOR_AGENTS);
  const callModel = async () => ({ content: supervisorContent });
  const conductor = new LiveConductor(callModel, bus, pool, {
    supervision_timeout_ms: 5_000,
    max_tool_errors_before_reroute: 2,
    supervise_low_complexity: false,
  });
  conductor.setContext("research", "high", "run_5283dd64");
  return conductor;
}

/** Same admission gate pipeline.afterConductorStage applies (F1). */
function admitReroute(
  stage: string,
  outcome: "completed" | "failed",
  directive: ConductorDirective,
): ConductorDirective {
  if (directive.type !== "reroute") return directive;
  const rejection = rejectReroute({
    triggerStage: stage,
    triggerOutcome: outcome,
    newRemaining: directive.newRemaining,
    reason: directive.reason ?? "",
  });
  return rejection ? { type: "continue" } : directive;
}

describe("incident 2026-07-16 run_5283dd64 — F2 stage-window starvation (Phase 0.1 / Phase 2)", () => {
  test("F2: canStart(planner) at T0+88s is true when only ~50s of stage budget was used", () => {
    // Live bug: wall-clock from first begin (T0+14) to T0+88 = 74s killed the
    // 60s stage window even though only ~50s of planner inference ran.
    // Usage-based accounting: end after 50s of work; idle until T0+88 is free.
    const budget = createTurnBudget("full_execution", "high", T0);
    budget.beginStage("planner", T0 + 14_000);
    budget.endStage("planner", T0 + 14_000 + 50_000);

    const atReplan = T0 + 88_000;
    expect(budget.stageUsedMs("planner", atReplan)).toBe(50_000);
    expect(budget.stageRemainingMs("planner", atReplan)).toBe(10_000);
    expect(budget.canStart("planner", atReplan)).toBe(true);
    // Turn itself still has budget (the mislabeled "Total turn deadline" path).
    expect(budget.remainingMs(atReplan)).toBeGreaterThan(90_000);
  });

  test("F2: stageRemainingMs(reviewer) meters usage (60_000 − usedMs), not wall-clock", () => {
    // Live: reviewer first entry ~58s; re-entry at ~109s died after ~8.86s
    // because remaining was 60_000 − ~51_000 wall-clock. Usage accounting:
    // first segment used 8_862ms then ended; idle gap free.
    const budget = createTurnBudget("full_execution", "high", T0);
    const usedMs = 8_862;
    budget.beginStage("reviewer", T0 + 58_000);
    budget.endStage("reviewer", T0 + 58_000 + usedMs);

    const atReentry = T0 + 109_000;
    expect(budget.stageRemainingMs("reviewer", atReentry)).toBe(60_000 - usedMs);
  });
});

describe("incident 2026-07-16 run_5283dd64 — F1 planner evidence reroute (Phase 0.2 / Phase 1)", () => {
  test("F1: deterministic guard forces continue when supervisor re-enters a cleanly completed planner", async () => {
    const conductor = makeSupervisingConductor(
      JSON.stringify({
        directive: "reroute",
        newRemaining: ["re-enter:planner"],
        reason:
          "Planner completed but failed to gather any workspace evidence; must re-run planner",
      }),
    );

    const raw = await conductor.afterStage(
      "planner",
      "completed",
      INCIDENT_PLAN_TEXT,
      ["executor", "reviewer", "synthesizer"],
      {
        request: INCIDENT_REQUEST,
        workspaceRoot: INCIDENT_WORKSPACE,
      },
    );

    const admitted = admitReroute("planner", "completed", raw);
    expect(admitted.type).toBe("continue");
    if (raw.type === "reroute") {
      expect(
        rejectReroute({
          triggerStage: "planner",
          triggerOutcome: "completed",
          newRemaining: raw.newRemaining,
          reason: raw.reason ?? "",
        }),
      ).toBe("self_reroute_after_clean_completion");
    }
  });

  test("F1+F7: clean planner completion never calls supervisor (no sufficient:false path)", async () => {
    // After F7 diet, clean planner completions are free — the F1 category
    // error cannot fire because the supervisor is never invoked.
    const supervisorMessages: any[][] = [];
    const bus = new ConductorBus();
    const pool = new AgentPool(DEFAULT_ORCHESTRATOR_AGENTS);
    const conductor = new LiveConductor(
      async (messages) => {
        supervisorMessages.push(messages);
        return {
          content: JSON.stringify({
            directive: "reroute",
            newRemaining: ["re-enter:planner"],
            reason: "no workspace evidence",
          }),
        };
      },
      bus,
      pool,
      {
        supervision_timeout_ms: 5_000,
        max_tool_errors_before_reroute: 2,
        supervise_low_complexity: false,
      },
    );
    conductor.setContext("research", "high", "run_5283dd64");

    const directive = await conductor.afterStage(
      "planner",
      "completed",
      INCIDENT_PLAN_TEXT,
      ["executor", "reviewer", "synthesizer"],
      {
        request: INCIDENT_REQUEST,
        workspaceRoot: INCIDENT_WORKSPACE,
      },
    );

    expect(directive).toEqual({ type: "continue" });
    expect(supervisorMessages).toHaveLength(0);
  });
});
