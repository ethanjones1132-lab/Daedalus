import { describe, expect, test } from "bun:test";
import { ActiveStreamRegistry, classifyAbortReason } from "../stream-control";
import {
  STAGE_ABORTED_ABORT_REASON,
  StageAbortedError,
  classifyCallAbort,
  isStageAbortedError,
  linkStageAbortToTransport,
} from "./stage-abort-link";

describe("linkStageAbortToTransport", () => {
  test("a pre-aborted stage signal still reaches the request before it is sent", () => {
    const stageAbort = new AbortController();
    stageAbort.abort("Conductor ordered the executor to stop");

    const request = new AbortController();
    linkStageAbortToTransport({ stage: "executor", stageAbort: stageAbort.signal, request }).cleanup();

    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toBe(STAGE_ABORTED_ABORT_REASON);
  });

  test("a stage abort mid-flight cancels the request and the body reader together", () => {
    const stageAbort = new AbortController();
    const request = new AbortController();
    const cancels: unknown[] = [];
    const cancelReader = (reason?: unknown) => {
      cancels.push(reason);
      return Promise.resolve();
    };

    const cleanup = linkStageAbortToTransport({
      stage: "planner",
      stageAbort: stageAbort.signal,
      request,
      cancelReader,
    }).cleanup;
    expect(request.signal.aborted).toBe(false);

    stageAbort.abort("planner is unrecoverable");

    expect(request.signal.aborted).toBe(true);
    expect(cancels).toEqual([STAGE_ABORTED_ABORT_REASON]);
    cleanup();
  });

  test("a stage abort never touches the Session turn lease or unrelated stages", () => {
    const registry = new ActiveStreamRegistry();
    const lease = registry.begin("session-1");
    const otherStage = new AbortController();
    const otherRequest = new AbortController();
    const stageAbort = new AbortController();

    const cleanup = linkStageAbortToTransport({
      stage: "executor",
      stageAbort: stageAbort.signal,
      request: new AbortController(),
    }).cleanup;

    stageAbort.abort("stop the executor only");

    expect(lease.controller.signal.aborted).toBe(false);
    expect(otherStage.signal.aborted).toBe(false);
    expect(otherRequest.signal.aborted).toBe(false);
    expect(classifyAbortReason(lease.controller.signal.reason)).toBe("unknown");
    expect(registry.size).toBe(1);
    cleanup();
  });

  test("cleanup detaches the transport so a later stage abort cannot race a settled attempt", () => {
    const stageAbort = new AbortController();
    const request = new AbortController();
    const cancels: unknown[] = [];

    const cleanup = linkStageAbortToTransport({
      stage: "synthesizer",
      stageAbort: stageAbort.signal,
      request,
      cancelReader: (reason?: unknown) => {
        cancels.push(reason);
        return Promise.resolve();
      },
    }).cleanup;
    cleanup();
    cleanup(); // idempotent

    stageAbort.abort("late");

    expect(request.signal.aborted).toBe(false);
    expect(cancels).toEqual([]);
  });

  test("the reader is cancelled even when no request controller is available", () => {
    const stageAbort = new AbortController();
    const cancels: unknown[] = [];
    const link = linkStageAbortToTransport({
      stage: "rewriter",
      stageAbort: stageAbort.signal,
      cancelReader: (reason?: unknown) => {
        cancels.push(reason);
        return Promise.resolve();
      },
    });

    stageAbort.abort("rewriter is unrecoverable");

    expect(cancels).toEqual([STAGE_ABORTED_ABORT_REASON]);
    link.cleanup();
  });

  test("an absent stage signal registers nothing and is inert", () => {
    const request = new AbortController();
    const cancelReader = () => Promise.resolve();
    const cleanup = linkStageAbortToTransport({ stage: "planner", request, cancelReader }).cleanup;

    cleanup();

    expect(request.signal.aborted).toBe(false);
  });
});

describe("classifyCallAbort", () => {
  test("reports stage_aborted while the stage signal is the only thing that fired", () => {
    const stageAbort = new AbortController();
    const turnAbort = new AbortController();
    stageAbort.abort("executor stopped");

    expect(classifyCallAbort({ stageAbort: stageAbort.signal, turnAbort: turnAbort.signal, turnDeadlineReached: false }))
      .toBe("stage_aborted");
  });

  test("stage_aborted outranks a turn cancellation that raced it", () => {
    const stageAbort = new AbortController();
    const turnAbort = new AbortController();
    turnAbort.abort("User cancelled");
    stageAbort.abort("executor stopped");

    expect(classifyCallAbort({ stageAbort: stageAbort.signal, turnAbort: turnAbort.signal, turnDeadlineReached: false }))
      .toBe("stage_aborted");
  });

  test("stage_aborted outranks a reached turn deadline", () => {
    const stageAbort = new AbortController();
    const turnAbort = new AbortController();
    stageAbort.abort("executor stopped");

    expect(classifyCallAbort({ stageAbort: stageAbort.signal, turnAbort: turnAbort.signal, turnDeadlineReached: true }))
      .toBe("stage_aborted");
  });

  test("a turn cancellation without a stage abort stays a turn cancellation", () => {
    const stageAbort = new AbortController();
    const turnAbort = new AbortController();
    turnAbort.abort("Superseded by a newer Session turn");

    expect(classifyCallAbort({ stageAbort: stageAbort.signal, turnAbort: turnAbort.signal, turnDeadlineReached: false }))
      .toBe("turn_cancelled");
  });

  test("an exhausted turn deadline is named, and a live turn reports no abort cause", () => {
    const turnAbort = new AbortController();

    expect(classifyCallAbort({ turnAbort: turnAbort.signal, turnDeadlineReached: true })).toBe("turn_deadline");
    expect(classifyCallAbort({ turnAbort: turnAbort.signal, turnDeadlineReached: false })).toBeNull();
    expect(classifyCallAbort({ turnAbort: turnAbort.signal, turnDeadlineReached: false, stageAbort: new AbortController().signal }))
      .toBeNull();
  });

  test("a live stage and turn report no abort cause at all", () => {
    const stageAbort = new AbortController();
    const turnAbort = new AbortController();

    expect(classifyCallAbort({ stageAbort: stageAbort.signal, turnAbort: turnAbort.signal, turnDeadlineReached: false }))
      .toBeNull();
  });
});

describe("StageAbortedError", () => {
  test("carries a stable code and the stopped stage without provider detail", () => {
    const err = new StageAbortedError("executor");

    expect(isStageAbortedError(err)).toBe(true);
    expect(err.code).toBe("stage_aborted");
    expect(err.stage).toBe("executor");
    expect(err.message).toBe("Stage aborted: executor");
  });

  test("a plain timeout or cancellation is not a stage abort", () => {
    const abortError = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });

    expect(isStageAbortedError(abortError)).toBe(false);
    expect(isStageAbortedError(new Error("Request timed out after 30000ms"))).toBe(false);
    expect(isStageAbortedError("stage_aborted")).toBe(false);
    expect(isStageAbortedError(undefined)).toBe(false);
  });
});
