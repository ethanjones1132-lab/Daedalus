import { describe, expect, test } from "bun:test";
import {
  finishWithRunOutcome,
  terminalResultFields,
  type TerminalFinishOptions,
} from "./terminal-outcome";

function captureFinish() {
  const calls: Array<{ result: string; options: TerminalFinishOptions | undefined }> = [];
  const session = {
    async finish(result: string, options?: TerminalFinishOptions): Promise<void> {
      calls.push({ result, options });
    },
  };
  return { calls, session };
}

describe("terminal run outcome reporting", () => {
  test("a degraded run keeps its real reason on the partial terminal frame", () => {
    // Regression (audit item 2): a degraded run's answer was emitted as
    // `partial` with NO code, so the UI invented `inference_partial`. The
    // run's own reason must survive to the client. (The original live run's
    // cause was not established; this pins the source-level defect only.)
    expect(terminalResultFields({
      outcome: "degraded",
      errorCode: "upstream_stage_failed",
      repeated: false,
    })).toEqual({ subtype: "partial", code: "upstream_stage_failed" });
  });

  test("a partial run keeps its typed stage code", () => {
    expect(terminalResultFields({
      outcome: "partial",
      errorCode: "stage_timeout",
      repeated: false,
    })).toEqual({ subtype: "partial", code: "stage_timeout" });
  });

  test("a failed run maps to error and keeps its reason", () => {
    expect(terminalResultFields({
      outcome: "failed",
      errorCode: "empty_completion",
      repeated: false,
    })).toEqual({ subtype: "error", code: "empty_completion" });
  });

  test("a successful run reports no code", () => {
    expect(terminalResultFields({
      outcome: "success",
      errorCode: "upstream_stage_failed",
      repeated: false,
    })).toEqual({ subtype: "success" });
  });

  test("repetition keeps its existing subtype and code", () => {
    // Existing behaviour: a repeated turn is persisted/labelled as degraded →
    // partial, tagged `no_progress_repetition`, and that tag wins over the
    // pipeline's own code.
    expect(terminalResultFields({
      outcome: "degraded",
      errorCode: "upstream_stage_failed",
      repeated: true,
    })).toEqual({ subtype: "partial", code: "no_progress_repetition" });
    expect(terminalResultFields({
      outcome: "partial",
      errorCode: "stage_timeout",
      repeated: true,
    })).toEqual({ subtype: "partial", code: "no_progress_repetition" });
  });

  test("a non-success outcome with no server reason reports no code", () => {
    // Do not invent a reason the server never produced.
    expect(terminalResultFields({
      outcome: "partial",
      errorCode: undefined,
      repeated: false,
    })).toEqual({ subtype: "partial" });
    expect(terminalResultFields({
      outcome: "degraded",
      errorCode: "   ",
      repeated: false,
    })).toEqual({ subtype: "partial" });
    expect(terminalResultFields({
      outcome: "failed",
      errorCode: null,
      repeated: false,
    })).toEqual({ subtype: "error" });
  });
});

describe("finishWithRunOutcome", () => {
  test("passes the preserved reason to the stream terminal", async () => {
    const { calls, session } = captureFinish();
    await finishWithRunOutcome(session, {
      result: "The answer.",
      outcome: "degraded",
      errorCode: "upstream_stage_failed",
      repeated: false,
    });
    expect(calls).toEqual([{
      result: "The answer.",
      options: { subtype: "partial", code: "upstream_stage_failed" },
    }]);
  });

  test("keeps the success frame unchanged", async () => {
    const { calls, session } = captureFinish();
    await finishWithRunOutcome(session, {
      result: "Done.",
      outcome: "success",
      errorCode: undefined,
      repeated: false,
    });
    expect(calls).toEqual([{ result: "Done.", options: { subtype: "success" } }]);
  });
});

describe("terminal reason (2026-11-07)", () => {
  test("a partial run with no error code still says why", () => {
    expect(terminalResultFields({ outcome: "partial", errorCode: undefined, repeated: false, reason: "task_plan_open" }))
      .toEqual({ subtype: "partial", reason: "task_plan_open" });
  });

  test("the reason travels beside the code, never replacing it", () => {
    expect(terminalResultFields({ outcome: "degraded", errorCode: "upstream_stage_failed", repeated: false, reason: "pipeline_degraded" }))
      .toEqual({ subtype: "partial", code: "upstream_stage_failed", reason: "pipeline_degraded" });
  });

  test("success carries no reason", () => {
    expect(terminalResultFields({ outcome: "success", repeated: false, reason: "verified_complete" })).toEqual({ subtype: "success" });
  });

  test("finishWithRunOutcome forwards the reason and the route plan", async () => {
    const calls: Array<{ result: string; options: unknown }> = [];
    const session = { finish: async (result: string, options?: unknown) => { calls.push({ result, options }); } };
    const route = { left_machine: false, attempts: [] };
    await finishWithRunOutcome(session as any, {
      result: "4", outcome: "partial", errorCode: null, repeated: false, reason: "task_plan_open", route,
    });
    expect(calls).toEqual([{ result: "4", options: { subtype: "partial", reason: "task_plan_open", route } }]);
  });

  test("a fatal finish keeps the error flag beside the reason and route", async () => {
    const calls: Array<{ result: string; options: unknown }> = [];
    const session = { finish: async (result: string, options?: unknown) => { calls.push({ result, options }); } };
    const route = { left_machine: false, attempts: [] };
    await finishWithRunOutcome(session as any, {
      result: "Synthesis failed", outcome: "failed", errorCode: "turn_deadline", repeated: false,
      reason: "pipeline_failed", route, isError: true,
    });
    expect(calls).toEqual([{
      result: "Synthesis failed",
      options: { subtype: "error", code: "turn_deadline", reason: "pipeline_failed", isError: true, route },
    }]);
  });
});
