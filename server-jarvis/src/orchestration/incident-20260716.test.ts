/**
 * Incident fixtures for 2026-07-16 supervision-starvation forensics.
 *
 * Source: docs/DIAGNOSIS_ORCHESTRATION_SUPERVISION_2026-07-16.md
 * Plan:   docs/superpowers/plans/2026-07-16-supervision-starvation-remediation.md (Phase 0)
 *
 * Target run: run_5283dd64 (session a074271b) — Versutus gap-analysis, failed ~142s.
 *
 * Structure:
 *   - "bug pin" tests document today's broken behavior so the diagnosis stays falsifiable.
 *   - "fix contract" tests (test.todo) pin the post-remediation invariants.
 *     Flip them green in Phase 1 (F1 reroute guard) and Phase 2 (usage-based budgets).
 */
import { describe, expect, test } from "bun:test";
import { LiveConductor } from "./conductor";
import { ConductorBus } from "./conductor-bus";
import { AgentPool, DEFAULT_ORCHESTRATOR_AGENTS } from "./agent-pool";
import { createTurnBudget } from "./turn-budget";

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

describe("incident 2026-07-16 run_5283dd64 — F2 stage-window starvation (Phase 0.1)", () => {
  test("bug pin: wall-clock stage window refuses planner re-entry at T0+88s", () => {
    // Live: planner first began ~14s into the turn; by ~88s elapsed the stage
    // window was dead even though only ~50s of planner inference had run.
    // T1.1 anti-re-arm: first beginStage wins; remaining = 60s − wall elapsed.
    const budget = createTurnBudget("full_execution", "high", T0);
    budget.beginStage("planner", T0 + 14_000);

    const atReplan = T0 + 88_000;
    expect(budget.stageRemainingMs("planner", atReplan)).toBe(0);
    expect(budget.canStart("planner", atReplan)).toBe(false);
    // Turn itself still has budget — the mislabeled "Total turn deadline" path.
    expect(budget.remainingMs(atReplan)).toBeGreaterThan(90_000);
  });

  test("bug pin: wall-clock stage window starves reviewer re-entry at T0+109s", () => {
    // Live: reviewer first entry ~58s; re-entry at ~109s died after ~8.86s
    // because remaining was 60_000 − ~51_000 wall-clock, not usage.
    const budget = createTurnBudget("full_execution", "high", T0);
    budget.beginStage("reviewer", T0 + 58_000);

    const atReentry = T0 + 109_000;
    expect(budget.stageRemainingMs("reviewer", atReentry)).toBe(9_000);
  });

  // Phase 2 target: usage-based accounting + endStage so idle/replan time is free.
  // Planner used only ~50s of its 60s budget across the run; at T0+88s it must
  // still be startable. Flip green after Phase 2 lands.
  test.todo(
    "F2 fix: canStart(planner) at T0+88s is true when only ~50s of stage budget was used",
  );

  // Reviewer used ~8.86s before the kill; after idle gap to T0+109s remaining
  // must be 60_000 − usedMs (~51_138), not 60_000 − 51_000 wall (~9_000).
  test.todo(
    "F2 fix: stageRemainingMs(reviewer) meters usage (60_000 − usedMs), not wall-clock since first begin",
  );
});

describe("incident 2026-07-16 run_5283dd64 — F1 planner evidence reroute (Phase 0.2)", () => {
  test("bug pin: supervisor re-enter:planner after clean planner completion is currently admitted", async () => {
    // Live: 8 planner-completed→reroute directives; reason class was
    // "failed to gather workspace evidence" on a toolless stage.
    const conductor = makeSupervisingConductor(
      JSON.stringify({
        directive: "reroute",
        newRemaining: ["re-enter:planner"],
        reason:
          "Planner completed but failed to gather any workspace evidence; must re-run planner",
      }),
    );

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

    expect(directive.type).toBe("reroute");
    if (directive.type === "reroute") {
      expect(directive.newRemaining).toEqual(["re-enter:planner"]);
    }
  });

  // Phase 1 target: rejectReroute / pipeline admission wins over the model.
  // AfterStage (or its admission wrapper) must return continue for a cleanly
  // completed planner that the supervisor wants to re-enter on evidence grounds.
  test.todo(
    "F1 fix: deterministic guard forces continue when supervisor re-enters a cleanly completed planner",
  );
});
