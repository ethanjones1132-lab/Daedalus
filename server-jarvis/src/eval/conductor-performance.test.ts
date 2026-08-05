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

  test("meetsReleaseGate is false at 79% delegate write-land rate (Stage 0a.2)", () => {
    // 79 with a landed write + 21 with zero writes = 100 delegate fixtures → 0.79
    // Gate uses write-land rate, not strict row-level verified.
    const fixtures: ConductorPerformanceFixture[] = [
      ...Array.from({ length: 79 }, (_, i) => delegateVerifiedWrite(`run_v_${i}`)),
      ...Array.from({ length: 21 }, (_, i) => delegateFailedWrite(`run_f_${i}`)),
    ];
    const summary = summarizeConductorPerformance(fixtures);
    expect(summary.delegateWriteLandRate).toBeCloseTo(0.79, 5);
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

  // Task 4 — unchecked-write coverage: success + wrote code + no runtime check
  // is a hard release-gate failure (maxUncheckedWriteRatio default 0).
  describe("unchecked-write coverage gate", () => {
    test("successes that wrote code without a check fail the gate", () => {
      const fixtures: ConductorPerformanceFixture[] = [
        {
          agentRunId: "run_unchecked_write",
          outcome: "success",
          checkTier: "none",
          finalOutput: "Wrote without a runtime check.",
          stageRuns: [
            stage({
              agent_run_id: "run_unchecked_write",
              tool_calls_json: JSON.stringify([
                { name: "write_file", arguments: { path: "out.txt" } },
              ]),
            }),
          ],
          directives: [],
        },
        nativeVerifiedWrite("run_checked_write"),
      ];
      const summary = summarizeConductorPerformance(fixtures, {
        ...RELEASE_THRESHOLDS,
        maxUncheckedWriteRatio: 0,
      });
      expect(summary.uncheckedWriteRuns).toBe(1);
      expect(summary.gateFailures).toContain("unchecked_write_ratio");
    });

    test("read-only successes are not counted as unchecked", () => {
      const fixtures: ConductorPerformanceFixture[] = [
        {
          agentRunId: "run_readonly_success",
          outcome: "success",
          checkTier: "none",
          finalOutput: "Read-only answer; no files changed.",
          stageRuns: [
            stage({
              agent_run_id: "run_readonly_success",
              tool_calls_json: JSON.stringify([
                { name: "read_file", arguments: { path: "src/a.ts" } },
              ]),
            }),
          ],
          directives: [],
        },
      ];
      const summary = summarizeConductorPerformance(fixtures, {
        ...RELEASE_THRESHOLDS,
        maxUncheckedWriteRatio: 0,
      });
      expect(summary.uncheckedWriteRuns).toBe(0);
      expect(summary.gateFailures).not.toContain("unchecked_write_ratio");
    });

    test("check_tier=existing is not an unchecked write", () => {
      const fixtures: ConductorPerformanceFixture[] = [
        {
          agentRunId: "run_existing_tier",
          outcome: "success",
          checkTier: "existing",
          verifiedVia: "runtime_check",
          finalOutput: "Verified via existing project check.",
          stageRuns: [
            stage({
              agent_run_id: "run_existing_tier",
              tool_calls_json: JSON.stringify([
                { name: "write_file", arguments: { path: "out.txt" } },
              ]),
            }),
          ],
          directives: [],
        },
      ];
      const summary = summarizeConductorPerformance(fixtures, {
        ...RELEASE_THRESHOLDS,
        maxUncheckedWriteRatio: 0,
      });
      expect(summary.uncheckedWriteRuns).toBe(0);
      expect(summary.gateFailures).not.toContain("unchecked_write_ratio");
    });
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

  test("RELEASE_THRESHOLDS match the plan contract (Stage 0a.2 write-land dials)", () => {
    const expected: ConductorPerformanceThresholds = {
      maxExecutorNoToolRatio: 0.1,
      minDelegateVerifiedWriteRate: 0.8,
      minWritesLandedPerRun: 0.5,
      maxUnverifiedSuccesses: 0,
      maxFalseCompleteRuns: 0,
      maxDuplicateWritePressureRuns: 0,
      maxUncheckedWriteRatio: 0,
    };
    expect(RELEASE_THRESHOLDS).toEqual(expected);
  });

  test("Stage 0a.2: low writesLandedPerRun fails the release gate", () => {
    // 5 native no-write partials → 0 writes/run, sample ≥ MIN_DELEGATE_SAMPLE
    const fixtures: ConductorPerformanceFixture[] = Array.from({ length: 5 }, (_, i) => ({
      agentRunId: `run_empty_${i}`,
      outcome: "partial",
      checkTier: "none",
      stageRuns: [stage({ agent_run_id: `run_empty_${i}`, tool_calls_json: "[]" })],
      directives: [],
    }));
    const summary = summarizeConductorPerformance(fixtures);
    expect(summary.writesLandedPerRun).toBe(0);
    expect(summary.gateFailures).toContain("writes_landed_per_run");
    expect(meetsReleaseGate(summary)).toBe(false);
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

  // W2.2 — first-class write volume metrics
  test("writesLandedPerRun averages successful write tools across runs", () => {
    // 2 runs: first has 2 successful writes, second has 0 → avg 1.0
    const fixtures: ConductorPerformanceFixture[] = [
      {
        agentRunId: "run_two_writes",
        outcome: "success",
        checkTier: "builtin",
        stageRuns: [
          stage({
            agent_run_id: "run_two_writes",
            tool_calls_json: JSON.stringify([
              { name: "write_file", arguments: { path: "a.ts" } },
              { name: "edit_file", arguments: { path: "b.ts" } },
              { name: "read_file", arguments: { path: "a.ts" } },
            ]),
          }),
        ],
        directives: [],
      },
      {
        agentRunId: "run_no_writes",
        outcome: "partial",
        stageRuns: [
          stage({
            agent_run_id: "run_no_writes",
            tool_calls_json: JSON.stringify([{ name: "read_file", arguments: {} }]),
          }),
        ],
        directives: [],
      },
    ];
    const summary = summarizeConductorPerformance(fixtures);
    expect(summary.writesLandedPerRun).toBe(1);
    expect(summary.taskTargetWrites).toBe(2);
  });

  test("taskTargetWrites excludes status/log docs and honors fixture targets", () => {
    const fixtures: ConductorPerformanceFixture[] = [
      {
        agentRunId: "run_mixed_paths",
        outcome: "success",
        checkTier: "builtin",
        taskTargets: ["src/app.ts"],
        stageRuns: [
          stage({
            agent_run_id: "run_mixed_paths",
            tool_calls_json: JSON.stringify([
              { name: "write_file", arguments: { path: "src/app.ts" } },
              { name: "write_file", arguments: { path: "IMPLEMENTATION_STATUS_CURRENT.md" } },
              { name: "edit_file", arguments: { path: "docs/other.ts" } },
              { name: "write_file", arguments: { path: "src/app.ts" }, is_error: true },
            ]),
          }),
        ],
        directives: [],
      },
    ];
    const summary = summarizeConductorPerformance(fixtures);
    // All successful write tools (including status + off-target): 3
    expect(summary.writesLandedPerRun).toBe(3);
    // Only non-status + on-target: src/app.ts once
    expect(summary.taskTargetWrites).toBe(1);
  });

  test("taskTargetWrites without targets counts all non-status successful writes", () => {
    const fixtures: ConductorPerformanceFixture[] = [
      {
        agentRunId: "run_no_targets",
        outcome: "success",
        checkTier: "builtin",
        stageRuns: [
          stage({
            agent_run_id: "run_no_targets",
            tool_calls_json: JSON.stringify([
              { name: "write_file", arguments: { path: "src/app.ts" } },
              { name: "write_file", arguments: { path: "EXECUTION_LOG.md" } },
            ]),
          }),
        ],
        directives: [],
      },
    ];
    const summary = summarizeConductorPerformance(fixtures);
    expect(summary.writesLandedPerRun).toBe(2);
    expect(summary.taskTargetWrites).toBe(1);
  });

  test("native fallback write after failed delegate stage does not count as verified", () => {
    // Delegate launched (claude_cli attr) but wrote nothing; later native
    // executor stage wrote. Must not credit the native write to the delegate.
    const fixtures: ConductorPerformanceFixture[] = [
      {
        agentRunId: "run_native_fallback_after_delegate",
        outcome: "success",
        checkTier: "builtin",
        verifiedVia: "runtime_check",
        finalOutput: "Native fallback applied the write.",
        stageRuns: [
          stage({
            id: "stage_delegate_first",
            agent_run_id: "run_native_fallback_after_delegate",
            mode_id: "executor",
            turn_number: 1,
            was_successful: 0,
            had_error: 1,
            tool_calls_json: JSON.stringify([{ name: "read_file", arguments: {} }]),
            diagnostic_json: JSON.stringify({
              delegate_request_id: "req_delegate_1",
              exit_code: 1,
            }),
          }),
          stage({
            id: "stage_native_second",
            agent_run_id: "run_native_fallback_after_delegate",
            mode_id: "executor",
            turn_number: 2,
            was_successful: 1,
            had_error: 0,
            tool_calls_json: JSON.stringify([
              { name: "write_file", arguments: { path: "native-fallback.txt" } },
            ]),
          }),
        ],
        directives: [],
        modelAttributions: [
          claudeCliAttribution("run_native_fallback_after_delegate", {
            was_successful: 0,
            had_error: 1,
            fallback_used: 1,
          }),
        ],
      },
    ];
    const summary = summarizeConductorPerformance(fixtures);
    expect(summary.delegateRuns).toBe(1);
    expect(summary.delegateVerifiedWrites).toBe(0);
    expect(summary.delegateVerifiedWriteRate).toBe(0);
  });

  test("diagnostic-marked delegate stage with write counts even if not first executor", () => {
    // Unusual ordering: a non-first executor row carries the delegate diagnostic
    // and the write — still the delegate stage, not native fallback.
    const fixtures: ConductorPerformanceFixture[] = [
      {
        agentRunId: "run_diagnostic_delegate_write",
        outcome: "success",
        checkTier: "builtin",
        verifiedVia: "runtime_check",
        finalOutput: "Delegate wrote on diagnostic-marked row.",
        stageRuns: [
          stage({
            id: "stage_early_read",
            agent_run_id: "run_diagnostic_delegate_write",
            mode_id: "executor",
            turn_number: 1,
            tool_calls_json: JSON.stringify([{ name: "read_file", arguments: {} }]),
          }),
          stage({
            id: "stage_delegate_write",
            agent_run_id: "run_diagnostic_delegate_write",
            mode_id: "executor",
            turn_number: 2,
            tool_calls_json: JSON.stringify([
              { name: "write_file", arguments: { path: "delegated.txt" } },
            ]),
            diagnostic_json: JSON.stringify({
              delegate_request_id: "req_delegate_2",
              exit_code: 0,
            }),
          }),
        ],
        directives: [],
        modelAttributions: [claudeCliAttribution("run_diagnostic_delegate_write")],
      },
    ];
    const summary = summarizeConductorPerformance(fixtures);
    expect(summary.delegateRuns).toBe(1);
    expect(summary.delegateVerifiedWrites).toBe(1);
  });
});
