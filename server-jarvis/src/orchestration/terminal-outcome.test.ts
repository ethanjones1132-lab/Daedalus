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
