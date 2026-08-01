import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REPLAY_THRESHOLDS,
  checkReplayInvariants,
  summarizeViolations,
  type ReplayRun,
} from "./conductor-replay";
import type { ConductorDirectiveRow, StageRun } from "../self-tuning/store";

// ---------------------------------------------------------------------------
// Fixtures — shaped exactly like the rows self-tuning.db actually stores.
// ---------------------------------------------------------------------------

function directive(over: Partial<ConductorDirectiveRow> = {}): ConductorDirectiveRow {
  return {
    id: `dir_${Math.random().toString(36).slice(2)}`,
    agent_run_id: "run_x",
    stage: "executor",
    directive_type: "mid_loop_inject",
    ...over,
  };
}

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

function replayRun(over: Partial<ReplayRun> = {}): ReplayRun {
  return {
    agentRunId: "run_x",
    taskType: "general",
    outcome: "success",
    stageRuns: [],
    directives: [],
    ...over,
  };
}

describe("conductor replay — repeated nudge invariant", () => {
  // The 2026-07-31 incident (run_2c46d082): the same plan-remainder note was
  // injected 56x byte-identical, plus 10x of a sibling variant. 28 of 37
  // executor turns then produced no tool call. The note text is stored
  // verbatim in conductor_directives.inject_note, so this was visible in the
  // database the entire time — nothing was reading it.
  test("flags a note injected more times than the threshold", () => {
    const run = replayRun({
      directives: Array.from({ length: 8 }, () =>
        directive({ inject_note: "4 plan item(s) are still unverified — this turn is not done." }),
      ),
    });
    const violations = checkReplayInvariants(run);
    const repeated = violations.filter((v) => v.rule === "repeated_nudge");
    expect(repeated).toHaveLength(1);
    expect(repeated[0]?.count).toBe(8);
    expect(repeated[0]?.severity).toBe("high");
  });

  test("does not flag a note repeated within the allowed budget", () => {
    const run = replayRun({
      directives: [
        directive({ inject_note: "Apply the change now." }),
        directive({ inject_note: "Apply the change now." }),
      ],
    });
    expect(checkReplayInvariants(run).filter((v) => v.rule === "repeated_nudge")).toHaveLength(0);
  });

  test("counts distinct note texts independently", () => {
    const run = replayRun({
      directives: [
        ...Array.from({ length: 5 }, () => directive({ inject_note: "note A" })),
        ...Array.from({ length: 5 }, () => directive({ inject_note: "note B" })),
      ],
    });
    const repeated = checkReplayInvariants(run).filter((v) => v.rule === "repeated_nudge");
    expect(repeated).toHaveLength(2);
  });

  test("ignores directives that carry no note", () => {
    const run = replayRun({
      directives: Array.from({ length: 20 }, () => directive({ directive_type: "continue" })),
    });
    expect(checkReplayInvariants(run).filter((v) => v.rule === "repeated_nudge")).toHaveLength(0);
  });
});

describe("conductor replay — placeholder note invariant", () => {
  // Same incident: `activePlanItem` rendered to the stage-output placeholder
  // and was formatted into a model-facing instruction, telling the executor
  // its active work item was the string "No planning stage executed."
  test("flags a stage-summary placeholder inside a model-facing note", () => {
    const run = replayRun({
      directives: [
        directive({
          inject_note:
            "4 plan item(s) are still unverified. The active item is: No planning stage executed.",
        }),
      ],
    });
    const found = checkReplayInvariants(run).filter((v) => v.rule === "placeholder_in_note");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("high");
  });

  test("accepts a note naming a real plan item", () => {
    const run = replayRun({
      directives: [directive({ inject_note: "The active item is: Task 2: add the enum." })],
    });
    expect(checkReplayInvariants(run).filter((v) => v.rule === "placeholder_in_note")).toHaveLength(0);
  });
});

describe("conductor replay — stage deadline invariant", () => {
  // The B3 reviewer regression: qwythos on the reviewer stage exceeded the
  // 60s stage_ms cap on 100% of real turns, burning 60s for zero output.
  test("flags a stage that died on its own deadline", () => {
    const run = replayRun({
      stageRuns: [
        stage({
          mode_id: "reviewer",
          was_successful: 0,
          had_error: 1,
          duration_ms: 60_026,
          error_message: "Stage deadline exceeded (60000ms) on stage=reviewer",
        }),
      ],
    });
    const found = checkReplayInvariants(run).filter((v) => v.rule === "stage_deadline_exceeded");
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("reviewer");
    expect(found[0]?.severity).toBe("high");
  });

  test("does not flag a stage that failed for an unrelated reason", () => {
    const run = replayRun({
      stageRuns: [
        stage({ mode_id: "executor", was_successful: 0, had_error: 1, error_message: "upstream 500" }),
      ],
    });
    expect(
      checkReplayInvariants(run).filter((v) => v.rule === "stage_deadline_exceeded"),
    ).toHaveLength(0);
  });
});

describe("conductor replay — no-op executor turn invariant", () => {
  // 28 of 37 executor turns produced no tool call, each still costing a full
  // model round-trip plus a re-upload of the growing transcript.
  test("flags a run whose executor turns mostly did nothing", () => {
    const run = replayRun({
      stageRuns: [
        ...Array.from({ length: 8 }, (_, i) =>
          stage({ turn_number: i + 1, tool_calls_json: "[]" }),
        ),
        stage({ turn_number: 9 }),
        stage({ turn_number: 10 }),
      ],
    });
    const found = checkReplayInvariants(run).filter((v) => v.rule === "noop_executor_turns");
    expect(found).toHaveLength(1);
    expect(found[0]?.count).toBe(8);
  });

  test("does not flag a productive executor stage", () => {
    const run = replayRun({
      stageRuns: Array.from({ length: 10 }, (_, i) => stage({ turn_number: i + 1 })),
    });
    expect(checkReplayInvariants(run).filter((v) => v.rule === "noop_executor_turns")).toHaveLength(0);
  });

  test("ignores non-executor stages when computing the ratio", () => {
    const run = replayRun({
      stageRuns: [
        stage({ mode_id: "planner", tool_calls_json: "[]" }),
        stage({ mode_id: "synthesizer", tool_calls_json: "[]" }),
        stage({ mode_id: "executor" }),
      ],
    });
    expect(checkReplayInvariants(run).filter((v) => v.rule === "noop_executor_turns")).toHaveLength(0);
  });

  test("needs a minimum sample before judging a ratio", () => {
    // Two turns, both empty, is noise — not a spin.
    const run = replayRun({
      stageRuns: [stage({ turn_number: 1, tool_calls_json: "[]" }), stage({ turn_number: 2, tool_calls_json: "[]" })],
    });
    expect(checkReplayInvariants(run).filter((v) => v.rule === "noop_executor_turns")).toHaveLength(0);
  });
});

describe("conductor replay — turn cap saturation invariant", () => {
  // Every executor segment in run_2c46d082 ran to exactly turn 12 and stopped.
  // None exited naturally. Repeated saturation means the loop is being held
  // open rather than completing.
  test("flags repeated segments that all end exactly at the cap", () => {
    const segment = (n: number) =>
      Array.from({ length: n }, (_, i) => stage({ turn_number: i + 1 }));
    const run = replayRun({
      stageRuns: [...segment(12), ...segment(12), ...segment(12)],
    });
    const found = checkReplayInvariants(run).filter((v) => v.rule === "turn_cap_saturation");
    expect(found).toHaveLength(1);
    expect(found[0]?.count).toBe(3);
  });

  test("does not flag segments that exit before the cap", () => {
    const run = replayRun({
      stageRuns: [
        ...Array.from({ length: 4 }, (_, i) => stage({ turn_number: i + 1 })),
        ...Array.from({ length: 3 }, (_, i) => stage({ turn_number: i + 1 })),
      ],
    });
    expect(checkReplayInvariants(run).filter((v) => v.rule === "turn_cap_saturation")).toHaveLength(0);
  });
});

describe("conductor replay — reporting", () => {
  test("a clean run yields no violations", () => {
    const run = replayRun({
      stageRuns: [stage(), stage({ turn_number: 2 })],
      directives: [directive({ inject_note: "one note" })],
    });
    expect(checkReplayInvariants(run)).toEqual([]);
  });

  test("summarize groups violations by rule and orders by severity then count", () => {
    const runs: ReplayRun[] = [
      replayRun({
        agentRunId: "run_a",
        directives: Array.from({ length: 9 }, () => directive({ inject_note: "spin" })),
      }),
      replayRun({
        agentRunId: "run_b",
        stageRuns: [
          stage({
            mode_id: "reviewer",
            was_successful: 0,
            had_error: 1,
            error_message: "Stage deadline exceeded (60000ms) on stage=reviewer",
          }),
        ],
      }),
    ];
    const summary = summarizeViolations(runs.flatMap((r) => checkReplayInvariants(r)));
    expect(summary.totalViolations).toBe(2);
    expect(summary.byRule.map((r) => r.rule).sort()).toEqual([
      "repeated_nudge",
      "stage_deadline_exceeded",
    ]);
    expect(summary.byRule.every((r) => r.affectedRuns >= 1)).toBe(true);
  });

  test("thresholds are overridable so a stricter gate can be trialled offline", () => {
    const run = replayRun({
      directives: [
        directive({ inject_note: "twice" }),
        directive({ inject_note: "twice" }),
      ],
    });
    expect(checkReplayInvariants(run)).toEqual([]);
    const strict = checkReplayInvariants(run, {
      ...DEFAULT_REPLAY_THRESHOLDS,
      maxIdenticalNudges: 1,
    });
    expect(strict.filter((v) => v.rule === "repeated_nudge")).toHaveLength(1);
  });
});
