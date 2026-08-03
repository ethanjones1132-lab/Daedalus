import { describe, expect, test } from "bun:test";
import {
  RELEASE_THRESHOLDS,
  meetsReleaseGate,
  summarizeConductorPerformance,
  type ConductorPerformanceFixture,
  type ConductorPerformanceThresholds,
} from "./conductor-performance";
import type { ConductorDirectiveRow, ModelAttribution, StageRun } from "../self-tuning/store";

// ---------------------------------------------------------------------------
// Fixtures shaped like self-tuning.db rows used by the pure metrics module.
// ---------------------------------------------------------------------------

function stage(over: Partial<StageRun> = {}): StageRun {
  return {
    id: `stage_${Math.random().toString(36).slice(2)}`,
    agent_run_id: "run_x",
    mode_id: "executor",
    turn_number: 1,
    was_successful: 1,
    had_error: 0,
    tool_calls_json: JSON.stringify([{ name: "read_file", arguments: {} }]),
    ...over,
  };
}

function directive(over: Partial<ConductorDirectiveRow> = {}): ConductorDirectiveRow {
  return {
    id: `dir_${Math.random().toString(36).slice(2)}`,
    agent_run_id: "run_x",
    stage: "executor",
    directive_type: "mid_loop_inject",
    ...over,
  };
}

/** Minimal model_attributions row — pipeline records provider "claude_cli" for delegates. */
function claudeCliAttribution(
  agentRunId: string,
  over: Partial<ModelAttribution> = {},
): ModelAttribution {
  return {
    id: `attr_${Math.random().toString(36).slice(2)}`,
    agent_run_id: agentRunId,
    stage_id: "executor",
    agent_id: "claude_delegate",
    provider: "claude_cli",
    model_id: "sonnet",
    was_successful: 1,
    had_error: 0,
    fallback_used: 0,
    ...over,
  };
}

const WRITE_PRESSURE_NOTE =
  "This turn is a CHANGE request. You have write tools available " +
  "(write_file, edit_file, multi_edit, apply_patch). Apply the requested " +
  "change by CALLING one of them now.";

/** Healthy delegate-verified write: claude_cli attribution + cleanup + write (legacy + modern signals). */
function delegateVerifiedWrite(
  agentRunId: string,
  over: Partial<ConductorPerformanceFixture> = {},
): ConductorPerformanceFixture {
  return {
    agentRunId,
    outcome: "success",
    checkTier: "builtin",
    verifiedVia: "runtime_check",
    finalOutput: "All requested files written and verified.",
    stageRuns: [
      stage({
        agent_run_id: agentRunId,
        tool_calls_json: JSON.stringify([
          { name: "write_file", arguments: { path: "out.txt" } },
          { name: "delegate_cleanup", arguments: { status: "exited" } },
        ]),
      }),
    ],
    directives: [],
    modelAttributions: [claudeCliAttribution(agentRunId)],
    ...over,
  };
}

/** Delegate launched but wrote nothing in its row (and nowhere else). */
function delegateFailedWrite(agentRunId: string): ConductorPerformanceFixture {
  return {
    agentRunId,
    outcome: "partial",
    checkTier: "none",
    stageRuns: [
      stage({
        agent_run_id: agentRunId,
        tool_calls_json: JSON.stringify([
          { name: "delegate_cleanup", arguments: { status: "signal_error" }, is_error: true },
          {
            name: "git_metadata",
            arguments: {},
            is_error: true,
            output: "Post-run ground-truth verification unavailable; no diffstat is verified.",
          },
        ]),
      }),
    ],
    directives: [],
    modelAttributions: [
      claudeCliAttribution(agentRunId, { was_successful: 0, had_error: 1 }),
    ],
  };
}

function nativeVerifiedWrite(agentRunId: string): ConductorPerformanceFixture {
  return {
    agentRunId,
    outcome: "success",
    checkTier: "builtin",
    verifiedVia: "runtime_check",
    finalOutput: "Native write applied.",
    stageRuns: [
      stage({
        agent_run_id: agentRunId,
        tool_calls_json: JSON.stringify([{ name: "write_file", arguments: { path: "native.txt" } }]),
      }),
    ],
    directives: [],
    // Native executor — no claude_cli attribution.
    modelAttributions: [],
  };
}

/**
 * Good-era (07-25) style: claude_cli attribution + successful write tools,
 * but no delegate_cleanup marker (that marker only appeared in 4/112 minimax runs).
 */
function attributionOnlyDelegateVerifiedWrite(
  agentRunId: string,
): ConductorPerformanceFixture {
  return {
    agentRunId,
    outcome: "success",
    checkTier: "builtin",
    verifiedVia: "runtime_check",
    finalOutput: "Delegated write applied (no cleanup tool in transcript).",
    stageRuns: [
      stage({
        agent_run_id: agentRunId,
        mode_id: "executor",
        tool_calls_json: JSON.stringify([
          { name: "write_file", arguments: { path: "out.txt" } },
          { name: "edit_file", arguments: { path: "out.txt" } },
        ]),
      }),
    ],
    directives: [],
    modelAttributions: [claudeCliAttribution(agentRunId)],
  };
}

/**
 * Ten write-intent fixtures that hit the release targets exactly:
 * - 1/10 executor turns no-tool → ratio 0.1
 * - 4/5 delegate runs verified → rate 0.8
 * - zero unverified successes, false-completes, or duplicate write pressure
 *
 * Layout:
 * - 4 verified delegate (1 tool turn each)
 * - 1 failed delegate (1 tool turn)
 * - 4 native verified writes (1 tool turn each)
 * - 1 native no-tool partial (1 empty turn)
 * → executor turns = 10, no-tool = 1 → 0.1
 * → delegate runs = 5, verified = 4 → 0.8
 */
function tenHealthyWriteFixtures(): ConductorPerformanceFixture[] {
  return [
    ...Array.from({ length: 4 }, (_, i) => delegateVerifiedWrite(`run_delegate_ok_${i}`)),
    delegateFailedWrite("run_delegate_fail"),
    ...Array.from({ length: 4 }, (_, i) => nativeVerifiedWrite(`run_native_ok_${i}`)),
    {
      agentRunId: "run_native_noop",
      outcome: "partial",
      checkTier: "none",
      finalOutput: "No write was applied this turn.",
      stageRuns: [stage({ agent_run_id: "run_native_noop", tool_calls_json: "[]" })],
      directives: [],
    },
  ];
}

describe("summarizeConductorPerformance", () => {
  test("ten write fixtures hit release target metrics exactly", () => {
    const fixtures = tenHealthyWriteFixtures();
    expect(fixtures).toHaveLength(10);
    expect(summarizeConductorPerformance(fixtures)).toMatchObject({
      runs: 10,
      executorNoToolRatio: 0.1,
      delegateVerifiedWriteRate: 0.8,
      unverifiedSuccesses: 0,
      falseCompleteRuns: 0,
      duplicateWritePressureRuns: 0,
    });
  });

  test("healthy ten-run fixture meets the release gate", () => {
    const summary = summarizeConductorPerformance(tenHealthyWriteFixtures());
    expect(meetsReleaseGate(summary)).toBe(true);
    expect(summary.meetsReleaseGate).toBe(true);
  });

  test("meetsReleaseGate is false at 20% no-tool turns", () => {
    // 8 productive + 2 empty = 0.2
    const fixtures: ConductorPerformanceFixture[] = [
      ...Array.from({ length: 4 }, (_, i) => delegateVerifiedWrite(`run_d_${i}`)),
      ...Array.from({ length: 4 }, (_, i) => nativeVerifiedWrite(`run_n_${i}`)),
      {
        agentRunId: "run_empty_a",
        outcome: "partial",
        stageRuns: [stage({ agent_run_id: "run_empty_a", tool_calls_json: "[]" })],
        directives: [],
      },
      {
        agentRunId: "run_empty_b",
        outcome: "partial",
        stageRuns: [stage({ agent_run_id: "run_empty_b", tool_calls_json: "[]" })],
        directives: [],
      },
    ];
    const summary = summarizeConductorPerformance(fixtures);
    expect(summary.executorNoToolRatio).toBe(0.2);
    expect(meetsReleaseGate(summary)).toBe(false);
    expect(summary.meetsReleaseGate).toBe(false);
    expect(summary.gateFailures).toContain("executor_no_tool_ratio");
  });

  test("meetsReleaseGate is false at 79% delegate verified writes", () => {
    // 79 verified + 21 failed = 100 delegate fixtures → 0.79
    const fixtures: ConductorPerformanceFixture[] = [
      ...Array.from({ length: 79 }, (_, i) => delegateVerifiedWrite(`run_v_${i}`)),
      ...Array.from({ length: 21 }, (_, i) => delegateFailedWrite(`run_f_${i}`)),
    ];
    const summary = summarizeConductorPerformance(fixtures);
    expect(summary.delegateVerifiedWriteRate).toBeCloseTo(0.79, 5);
    expect(meetsReleaseGate(summary)).toBe(false);
    expect(summary.gateFailures).toContain("delegate_verified_write_rate");
  });

  test("meetsReleaseGate is false with one unverified success", () => {
    const fixtures = tenHealthyWriteFixtures();
    fixtures[0] = {
      ...fixtures[0]!,
      outcome: "success",
      checkTier: "none",
      verifiedVia: null,
      finalOutput: "Looks done.",
    };
    const summary = summarizeConductorPerformance(fixtures);
    expect(summary.unverifiedSuccesses).toBe(1);
    expect(meetsReleaseGate(summary)).toBe(false);
    expect(summary.gateFailures).toContain("unverified_successes");
  });

  test("meetsReleaseGate is false with one false-complete run", () => {
    const fixtures = tenHealthyWriteFixtures();
    fixtures[0] = {
      ...fixtures[0]!,
      outcome: "success",
      checkTier: "builtin",
      verifiedVia: "runtime_check",
      finalOutput: "Group A has not yet been completed.",
    };
    const summary = summarizeConductorPerformance(fixtures);
    expect(summary.falseCompleteRuns).toBe(1);
    expect(meetsReleaseGate(summary)).toBe(false);
    expect(summary.gateFailures).toContain("false_complete_runs");
  });

  test("counts a run with duplicate write-pressure notes", () => {
    const fixtures = tenHealthyWriteFixtures();
    fixtures[0] = {
      ...fixtures[0]!,
      directives: [
        directive({ agent_run_id: fixtures[0]!.agentRunId, inject_note: WRITE_PRESSURE_NOTE }),
        directive({ agent_run_id: fixtures[0]!.agentRunId, inject_note: WRITE_PRESSURE_NOTE }),
      ],
    };
    const summary = summarizeConductorPerformance(fixtures);
    expect(summary.duplicateWritePressureRuns).toBe(1);
    expect(meetsReleaseGate(summary)).toBe(false);
    expect(summary.gateFailures).toContain("duplicate_write_pressure_runs");
  });

  test("delegate_gate is insufficient_sample below five delegate fixtures", () => {
    const fixtures = [
      delegateVerifiedWrite("run_a"),
      delegateVerifiedWrite("run_b"),
      nativeVerifiedWrite("run_native"),
    ];
    const summary = summarizeConductorPerformance(fixtures);
    expect(summary.delegateRuns).toBe(2);
    expect(summary.delegateGate).toBe("insufficient_sample");
    // Below five, a low or high rate must not fail the release gate on the
    // delegate axis alone; other axes still apply.
    expect(summary.meetsReleaseGate).toBe(true);
  });

  test("RELEASE_THRESHOLDS match the plan contract", () => {
    const expected: ConductorPerformanceThresholds = {
      maxExecutorNoToolRatio: 0.1,
      minDelegateVerifiedWriteRate: 0.8,
      maxUnverifiedSuccesses: 0,
      maxFalseCompleteRuns: 0,
      maxDuplicateWritePressureRuns: 0,
    };
    expect(RELEASE_THRESHOLDS).toEqual(expected);
  });

  // W2.1 — identify delegate runs by claude_cli attribution, not only cleanup marker.
  test("claude_cli attribution + write tools (no cleanup) counts as delegate verified write", () => {
    const fixtures = [attributionOnlyDelegateVerifiedWrite("run_attr_only")];
    const summary = summarizeConductorPerformance(fixtures);
    expect(summary.delegateRuns).toBe(1);
    expect(summary.delegateVerifiedWrites).toBe(1);
    expect(summary.delegateVerifiedWriteRate).toBe(1);
  });

  test("native writes without claude_cli attribution do not count as delegate", () => {
    const fixtures = [nativeVerifiedWrite("run_native_only")];
    const summary = summarizeConductorPerformance(fixtures);
    expect(summary.delegateRuns).toBe(0);
    expect(summary.delegateVerifiedWrites).toBe(0);
    expect(summary.delegateVerifiedWriteRate).toBe(0);
    expect(summary.delegateGate).toBe("not_applicable");
  });

  test("delegate_cleanup remains a valid fallback signal without attributions", () => {
    // Historical fixture shape: cleanup marker only, no modelAttributions field.
    const fixtures: ConductorPerformanceFixture[] = [
      {
        agentRunId: "run_cleanup_only",
        outcome: "success",
        checkTier: "builtin",
        verifiedVia: "runtime_check",
        finalOutput: "Cleanup-marked delegate write.",
        stageRuns: [
          stage({
            agent_run_id: "run_cleanup_only",
            tool_calls_json: JSON.stringify([
              { name: "write_file", arguments: { path: "out.txt" } },
              { name: "delegate_cleanup", arguments: { status: "exited" } },
            ]),
          }),
        ],
        directives: [],
        // omit modelAttributions entirely
      },
    ];
    const summary = summarizeConductorPerformance(fixtures);
    expect(summary.delegateRuns).toBe(1);
    expect(summary.delegateVerifiedWrites).toBe(1);
  });

  test("claude_cli attribution without successful write is a failed delegate run", () => {
    const fixtures: ConductorPerformanceFixture[] = [
      {
        agentRunId: "run_attr_no_write",
        outcome: "partial",
        checkTier: "none",
        stageRuns: [
          stage({
            agent_run_id: "run_attr_no_write",
            tool_calls_json: JSON.stringify([{ name: "read_file", arguments: {} }]),
          }),
        ],
        directives: [],
        modelAttributions: [
          claudeCliAttribution("run_attr_no_write", { was_successful: 0, had_error: 1 }),
        ],
      },
    ];
    const summary = summarizeConductorPerformance(fixtures);
    expect(summary.delegateRuns).toBe(1);
    expect(summary.delegateVerifiedWrites).toBe(0);
    expect(summary.delegateVerifiedWriteRate).toBe(0);
  });
});
