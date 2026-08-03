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
  //
  // The executor's *normal* exit is a no-tool turn (tools ran earlier; model
  // writes a closing summary). That accepted terminal empty must not count as
  // waste — otherwise short stages floor the metric at 25–50%. Real waste is
  // mid-stage empties and terminal empties typed as failures (stop_reason /
  // partial_error_code / was_successful=0).

  test("flags a run whose executor turns mostly did nothing", () => {
    // Eight mid-segment empties + two productive turns. Last turn has tools,
    // so every empty is mid-stage waste.
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

  test("accepted terminal no-tool turn does not count toward noop_executor_turns", () => {
    // Two mid-stage empties + one natural closing empty. Without excluding the
    // terminal summary: 3/5 = 60% flags. With exclusion: 2/5 = 40% stays green.
    const run = replayRun({
      stageRuns: [
        stage({ turn_number: 1 }),
        stage({ turn_number: 2 }),
        stage({ turn_number: 3, tool_calls_json: "[]" }),
        stage({ turn_number: 4, tool_calls_json: "[]" }),
        stage({
          turn_number: 5,
          tool_calls_json: "[]",
          was_successful: 1,
          // Natural close — no typed no_tool failure.
          stop_reason: "stop",
          partial_error_code: null,
        }),
      ],
    });
    expect(checkReplayInvariants(run).filter((v) => v.rule === "noop_executor_turns")).toHaveLength(0);
  });

  test("mid-stage no-tool turns still count as waste", () => {
    // Segment never ends on empty: empties sit before a final tool turn.
    const run = replayRun({
      stageRuns: [
        ...Array.from({ length: 6 }, (_, i) =>
          stage({ turn_number: i + 1, tool_calls_json: "[]" }),
        ),
        stage({ turn_number: 7 }),
        stage({ turn_number: 8 }),
      ],
    });
    const found = checkReplayInvariants(run).filter((v) => v.rule === "noop_executor_turns");
    expect(found).toHaveLength(1);
    expect(found[0]?.count).toBe(6);
  });

  test("terminal no-tool failure (stop_reason no_tool) still counts as waste", () => {
    // Mid-stage empties + a typed terminal no_tool failure — all waste.
    const run = replayRun({
      stageRuns: [
        stage({ turn_number: 1 }),
        stage({ turn_number: 2, tool_calls_json: "[]" }),
        stage({ turn_number: 3, tool_calls_json: "[]" }),
        stage({ turn_number: 4, tool_calls_json: "[]" }),
        stage({
          turn_number: 5,
          tool_calls_json: "[]",
          was_successful: 0,
          stop_reason: "no_tool",
          partial_error_code: "executor_no_tool",
        }),
      ],
    });
    const found = checkReplayInvariants(run).filter((v) => v.rule === "noop_executor_turns");
    expect(found).toHaveLength(1);
    expect(found[0]?.count).toBe(4);
  });

  test("terminal empty with was_successful=0 counts even without stop_reason", () => {
    const run = replayRun({
      stageRuns: [
        stage({ turn_number: 1 }),
        stage({ turn_number: 2, tool_calls_json: "[]" }),
        stage({ turn_number: 3, tool_calls_json: "[]" }),
        stage({ turn_number: 4, tool_calls_json: "[]" }),
        stage({
          turn_number: 5,
          tool_calls_json: "[]",
          was_successful: 0,
          stop_reason: null,
          partial_error_code: null,
        }),
      ],
    });
    const found = checkReplayInvariants(run).filter((v) => v.rule === "noop_executor_turns");
    expect(found).toHaveLength(1);
    expect(found[0]?.count).toBe(4);
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

describe("conductor replay — delegate wrote nothing invariant", () => {
  // 2026-08-01: `claude_cli_proxy` stopped on 07-21 and nothing restarted it.
  // The delegate — the PRIMARY write path (policy: delegate_first) — launches
  // the `claude` CLI with ANTHROPIC_BASE_URL=127.0.0.1:19878, got connection
  // refused, and terminated instantly on every run for eleven days. Writes
  // silently fell back to a free-tier text-protocol executor that rarely emits
  // write calls, which is what "struggling very hard with writes" looked like.
  //
  // The evidence was in turn 1 of every affected run the whole time. The
  // harness had no rule for it — this closes that gap. `delegate_cleanup` only
  // appears on write-intent turns (delegateEligibility requires
  // writeEffectRequired), so its presence alone establishes that a write was
  // expected.
  const delegateTurn = (over: Partial<StageRun> = {}) =>
    stage({
      tool_calls_json: JSON.stringify([
        { name: "delegate_cleanup", arguments: { status: "signal_error" }, is_error: true },
        {
          name: "git_metadata",
          arguments: {},
          is_error: true,
          output: "Post-run ground-truth verification unavailable; no diffstat is verified.",
        },
      ]),
      ...over,
    });

  test("flags a run where the delegate ran and nothing was ever written", () => {
    const run = replayRun({ stageRuns: [delegateTurn(), stage({ turn_number: 2 })] });
    const found = checkReplayInvariants(run).filter((v) => v.rule === "delegate_never_wrote");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("high");
  });

  test("later native write does not hide a failed delegate row", () => {
    // A successful write in a later native fallback row must not suppress
    // delegate_failed_before_fallback. Total-failure delegate_never_wrote is
    // correctly absent because a write did land somewhere in the turn.
    const run = replayRun({
      stageRuns: [
        delegateTurn(),
        stage({
          turn_number: 2,
          tool_calls_json: JSON.stringify([{ name: "write_file", arguments: {} }]),
        }),
      ],
    });
    const violations = checkReplayInvariants(run);
    expect(violations.filter((v) => v.rule === "delegate_never_wrote")).toHaveLength(0);
    expect(violations.filter((v) => v.rule === "delegate_failed_before_fallback")).toHaveLength(1);
  });

  test("a verified write inside the same delegate row is green", () => {
    const run = replayRun({
      stageRuns: [
        stage({
          tool_calls_json: JSON.stringify([
            { name: "write_file", arguments: { path: "claimed.ts" } },
            { name: "delegate_cleanup", arguments: { status: "exited" } },
          ]),
        }),
      ],
    });
    expect(
      checkReplayInvariants(run).filter((v) =>
        v.rule === "delegate_never_wrote" || v.rule === "delegate_failed_before_fallback",
      ),
    ).toHaveLength(0);
  });

  test("a failed write attempt does not count as a write", () => {
    const run = replayRun({
      stageRuns: [
        delegateTurn(),
        stage({
          turn_number: 2,
          tool_calls_json: JSON.stringify([
            { name: "edit_file", arguments: {}, is_error: true, output: "old_string not found" },
          ]),
        }),
      ],
    });
    expect(
      checkReplayInvariants(run).filter((v) => v.rule === "delegate_never_wrote"),
    ).toHaveLength(1);
  });

  test("a run where the delegate never launched is not flagged", () => {
    // Read-only turns never invoke the delegate; absence of writes is normal.
    const run = replayRun({ stageRuns: [stage(), stage({ turn_number: 2 })] });
    expect(
      checkReplayInvariants(run).filter((v) => v.rule === "delegate_never_wrote"),
    ).toHaveLength(0);
  });
});

describe("conductor replay — success verification invariants", () => {
  test("flags successful write-intent runs without a runtime check tier", () => {
    const run = replayRun({
      outcome: "success",
      checkTier: null,
      stageRuns: [
        stage({
          tool_calls_json: JSON.stringify([{ name: "write_file", arguments: {} }]),
        }),
      ],
    });
    const found = checkReplayInvariants(run).filter((v) => v.rule === "success_without_runtime_check");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("high");
  });

  test("accepts success with check_tier=builtin", () => {
    const run = replayRun({
      outcome: "success",
      checkTier: "builtin",
      verifiedVia: "runtime_check",
      stageRuns: [
        stage({
          tool_calls_json: JSON.stringify([{ name: "write_file", arguments: {} }]),
        }),
      ],
    });
    expect(
      checkReplayInvariants(run).filter((v) => v.rule === "success_without_runtime_check"),
    ).toHaveLength(0);
  });

  test("flags success whose final output declares incomplete progress", () => {
    const run = replayRun({
      outcome: "success",
      checkTier: "builtin",
      verifiedVia: "runtime_check",
      finalOutput: "Group A has not yet been completed.",
      stageRuns: [stage()],
    });
    const found = checkReplayInvariants(run).filter((v) => v.rule === "success_declares_incomplete");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("high");
  });
});

describe("conductor replay — delegate benched model selected (W1.4)", () => {
  // Selector pins (W1.4.1) live in delegate-model-select.test.ts. This invariant
  // is the offline half: a stored claude_cli attribution to a benched or
  // tool-incapable model must fail replay even without a live scoreboard.

  function claudeAttr(modelId: string): import("../self-tuning/store").ModelAttribution {
    return {
      id: `attr_${Math.random().toString(36).slice(2)}`,
      agent_run_id: "run_x",
      stage_id: "executor",
      agent_id: "claude_delegate",
      provider: "claude_cli",
      model_id: modelId,
      was_successful: 0,
      had_error: 1,
      fallback_used: 0,
    };
  }

  test("flags claude_cli attribution to a fixture-benched model", () => {
    const run = replayRun({
      stageRuns: [
        stage({
          tool_calls_json: JSON.stringify([
            { name: "delegate_cleanup", arguments: { status: "exited" } },
          ]),
        }),
      ],
      modelAttributions: [claudeAttr("cohere/north-mini-code:free")],
      benchedModels: ["cohere/north-mini-code:free"],
    });
    const found = checkReplayInvariants(run).filter(
      (v) => v.rule === "delegate_benched_model_selected",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("high");
    expect(found[0]?.detail).toContain("cohere/north-mini-code:free");
  });

  test("flags claude_cli attribution to a known tool-incapable free model", () => {
    const run = replayRun({
      modelAttributions: [
        claudeAttr("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"),
      ],
      // No benchedModels list — static DELEGATE_TOOL_INCAPABLE_MODELS alone.
    });
    const found = checkReplayInvariants(run).filter(
      (v) => v.rule === "delegate_benched_model_selected",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("tool-incapable");
  });

  test("does not flag a healthy minimax-m3 attribution", () => {
    const run = replayRun({
      modelAttributions: [claudeAttr("minimax-m3")],
      benchedModels: ["cohere/north-mini-code:free", "vendor/failing:free"],
    });
    expect(
      checkReplayInvariants(run).filter((v) => v.rule === "delegate_benched_model_selected"),
    ).toHaveLength(0);
  });

  test("ignores non-claude_cli attributions even when model is benched", () => {
    const run = replayRun({
      modelAttributions: [
        {
          ...claudeAttr("vendor/failing:free"),
          provider: "openrouter",
        },
      ],
      benchedModels: ["vendor/failing:free"],
    });
    expect(
      checkReplayInvariants(run).filter((v) => v.rule === "delegate_benched_model_selected"),
    ).toHaveLength(0);
  });

  test("does not flag when attributions are absent", () => {
    const run = replayRun({
      benchedModels: ["minimax-m3"],
      stageRuns: [stage()],
    });
    expect(
      checkReplayInvariants(run).filter((v) => v.rule === "delegate_benched_model_selected"),
    ).toHaveLength(0);
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
