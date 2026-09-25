import { describe, expect, test } from "bun:test";
import {
  MAX_CRON_OUTPUT_LENGTH,
  createCronTerminalAccumulator,
  drainCronStreamJarvisResponse,
  handleCronRunRequest,
  runCronInference,
  type CronInferenceDependencies,
} from "./cron-inference";

const encoder = new TextEncoder();

function frame(type: string, fields: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ type, ...fields })}\n\n`;
}

function responseFromWire(wire: string, chunkSize = wire.length): Response {
  const chunks: string[] = [];
  for (let index = 0; index < wire.length; index += chunkSize) {
    chunks.push(wire.slice(index, index + chunkSize));
  }
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }));
}

function responseFromFrames(frames: string[], trailingNewline = true): Response {
  const wire = frames.join("").trimEnd() + (trailingNewline ? "\n\n" : "");
  return responseFromWire(wire, Math.max(1, Math.ceil(wire.length / 5)));
}

function makeDependencies(
  response: Response,
  overrides: Partial<CronInferenceDependencies> = {},
): CronInferenceDependencies {
  return {
    stream: async () => response,
    validateProjection: () => ({ ok: true, entry: { instructions: "canonical instructions" } }),
    refreshInferenceFeedback: async () => ({ success: true, output: "", applied: 0 }),
    now: () => "2026-09-24T00:00:00.000Z",
    uuid: () => "run-cron-test",
    feedbackJobId: "jarvis-system-inference-feedback",
    ...overrides,
  };
}

describe("Cron terminal accumulator", () => {
  test("accepts an authoritative successful result", () => {
    const accumulator = createCronTerminalAccumulator();
    accumulator.observe({ type: "stream_event", delta: { text: "working" } });
    accumulator.observe({ type: "result", subtype: "success", is_error: false, result: "done" });

    expect(accumulator.settle()).toMatchObject({
      success: true,
      status: "success",
      output: "done",
    });
    expect(accumulator.settle().error).toBeUndefined();
  });

  test("treats partial results as failure regardless of positive prose", () => {
    const accumulator = createCronTerminalAccumulator();
    accumulator.observe({
      type: "result",
      subtype: "partial",
      is_error: false,
      code: "partial_code",
      result: "all checks passed",
    });

    expect(accumulator.settle()).toMatchObject({
      success: false,
      status: "failed",
      error_code: "partial_code",
      output: "all checks passed",
    });
  });

  test("lets is_error win over a success subtype and preserves its code", () => {
    const accumulator = createCronTerminalAccumulator();
    accumulator.observe({
      type: "result",
      subtype: "success",
      is_error: true,
      code: "upstream_failure",
      result: "failure details",
    });

    expect(accumulator.settle()).toMatchObject({
      success: false,
      status: "failed",
      error_code: "upstream_failure",
    });
  });

  test("maps error and cancelled frames to explicit terminal outcomes", () => {
    const errorAccumulator = createCronTerminalAccumulator();
    errorAccumulator.observe({ type: "stream_event", delta: { text: "partial" } });
    errorAccumulator.observe({ type: "error", error: "upstream failed", code: "upstream_error" });
    expect(errorAccumulator.settle()).toMatchObject({
      success: false,
      status: "failed",
      output: "partial",
      error: "upstream failed",
      error_code: "upstream_error",
    });

    const cancelledAccumulator = createCronTerminalAccumulator();
    cancelledAccumulator.observe({ type: "stream_event", delta: { text: "partial" } });
    cancelledAccumulator.observe({ type: "cancelled" });
    expect(cancelledAccumulator.settle()).toMatchObject({
      success: false,
      status: "cancelled",
      output: "partial",
      error: "cancelled",
      error_code: "cancelled",
    });
  });

  test("fails closed at EOF when only transport markers were received", () => {
    const accumulator = createCronTerminalAccumulator();
    accumulator.observe({ type: "message_stop" });
    accumulator.observe("[DONE]");

    expect(accumulator.settle()).toMatchObject({
      success: false,
      status: "failed",
      error_code: "stream_ended_without_outcome",
    });
  });

  test("keeps the first terminal outcome when later outcomes arrive", () => {
    const accumulator = createCronTerminalAccumulator();
    accumulator.observe({ type: "result", subtype: "partial", code: "first", result: "partial" });
    accumulator.observe({ type: "result", subtype: "success", result: "late success" });
    accumulator.observe({ type: "error", error: "late error", code: "late_error" });

    expect(accumulator.settle()).toMatchObject({
      success: false,
      status: "failed",
      error_code: "first",
      output: "partial",
    });
  });

  test("fails closed for an unknown explicit result subtype", () => {
    const accumulator = createCronTerminalAccumulator();
    accumulator.observe({ type: "result", subtype: "mystery", result: "looks fine" });

    expect(accumulator.settle()).toMatchObject({
      success: false,
      status: "failed",
      error_code: "inference_failed",
    });
  });
});

describe("Cron stream draining", () => {
  test("parses frames split across arbitrary chunks without a trailing newline", async () => {
    const response = responseFromFrames([
      frame("stream_event", { delta: { text: "hel" } }),
      frame("stream_event", { delta: { text: "lo" } }),
      frame("result", { subtype: "success", is_error: false, result: "hello" }),
    ], false);

    const outcome = await drainCronStreamJarvisResponse(response);

    expect(outcome).toMatchObject({ success: true, output: "hello" });
  });

  test("does not treat message_stop or DONE as an outcome", async () => {
    const response = responseFromFrames([
      frame("message_stop"),
      "data: [DONE]\n\n",
      frame("stream_event", { delta: { text: "partial" } }),
    ]);

    const outcome = await drainCronStreamJarvisResponse(response);

    expect(outcome).toMatchObject({
      success: false,
      status: "failed",
      error_code: "stream_ended_without_outcome",
      output: "partial",
    });
  });

  test("cancels the response reader and settles an aborted Cron stream", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const response = delayedResponse(100, () => { cancelled = true; });
    const resultPromise = drainCronStreamJarvisResponse(response, undefined, { signal: controller.signal });

    controller.abort("request aborted");

    const outcome = await resultPromise;
    expect(cancelled).toBe(true);
    expect(outcome).toMatchObject({
      success: false,
      status: "cancelled",
      error_code: "cancelled",
      output: "partial",
    });
  });
});

function delayedResponse(
  delayMs: number,
  onCancel: () => void = () => {},
  onLateResult: () => void = () => {},
): Response {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frame("stream_event", { delta: { text: "partial" } })));
      timer = setTimeout(() => {
        if (cancelled) return;
        onLateResult();
        controller.enqueue(encoder.encode(frame("result", { subtype: "success", is_error: false, result: "late success" })));
        controller.close();
      }, delayMs);
    },
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      onCancel();
    },
  }));
}

describe("Cron inference route", () => {
  test("returns successful evidence for an authoritative result", async () => {
    let observed: { prompt: string; sessionId: string; options: unknown } | undefined;
    const response = responseFromFrames([
      frame("result", { subtype: "success", is_error: false, result: "done" }),
    ]);
    const result = await runCronInference({ prompt: "do work", projection_snapshot: { slug: "agent" } }, makeDependencies(response, {
      stream: async (prompt, sessionId, options) => {
        observed = { prompt, sessionId, options };
        return response;
      },
    }));

    expect(observed).toMatchObject({ prompt: "do work", sessionId: "cron_run-cron-test" });
    expect(observed?.options).toMatchObject({ surface: "cron", systemPromptOverride: "canonical instructions" });
    expect(result).toMatchObject({
      success: true,
      output: "done",
      execution_evidence: {
        run_id: "run-cron-test",
        status: "success",
        acceptance_result: "done",
        started_at: "2026-09-24T00:00:00.000Z",
        finished_at: "2026-09-24T00:00:00.000Z",
      },
    });
  });

  test("returns bounded partial output and a non-success evidence status", async () => {
    const response = responseFromFrames([
      frame("stream_event", { delta: { text: "x".repeat(MAX_CRON_OUTPUT_LENGTH + 200) } }),
      frame("result", { subtype: "partial", code: "partial_code", result: "all checks passed" }),
    ]);
    const result = await runCronInference({ prompt: "do work" }, makeDependencies(response));

    expect(result.success).toBe(false);
    expect(result.error).toBe("Inference returned a partial result");
    expect(result.output).toBe("all checks passed");
    expect(result.execution_evidence).toMatchObject({
      status: "failed",
      error_code: "partial_code",
      acceptance_result: "Inference returned a partial result",
    });
  });

  test("preserves stable error codes and bounds streamed error output", async () => {
    const response = responseFromFrames([
      frame("stream_event", { delta: { text: "x".repeat(MAX_CRON_OUTPUT_LENGTH + 200) } }),
      frame("error", { error: "upstream failed", code: "upstream_error" }),
    ]);
    const result = await runCronInference({ prompt: "do work" }, makeDependencies(response));

    expect(result.success).toBe(false);
    expect(result.output).toHaveLength(MAX_CRON_OUTPUT_LENGTH);
    expect(result.execution_evidence).toMatchObject({
      status: "failed",
      error_code: "upstream_error",
      acceptance_result: "upstream failed",
    });
  });

  test("returns HTTP 200 for a logical stream failure", async () => {
    const response = responseFromFrames([
      frame("result", { subtype: "partial", result: "partial" }),
    ]);
    const result = await handleCronRunRequest({ prompt: "do work" }, makeDependencies(response));

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      success: false,
      error: "Inference returned a partial result",
      execution_evidence: { status: "failed", error_code: "inference_partial" },
    });
  });

  test("preserves projection validation failures before starting inference", async () => {
    let streamCalls = 0;
    const result = await runCronInference(
      { prompt: "do work", projection_snapshot: { slug: "agent" } },
      makeDependencies(new Response(null), {
        stream: async () => {
          streamCalls += 1;
          return new Response(null);
        },
        validateProjection: () => ({ ok: false, code: "projection_stale", message: "stale projection" }),
      }),
    );

    expect(result).toMatchObject({
      success: false,
      error: "stale projection",
      execution_evidence: { status: "failed", error_code: "projection_stale" },
    });
    expect(streamCalls).toBe(0);
  });

  test("states the deadline of an applied inference-feedback policy when the producer is silent", async () => {
    const withDeadline = await runCronInference(
      { job_id: "jarvis-system-inference-feedback" },
      makeDependencies(new Response(null), {
        refreshInferenceFeedback: async () => ({
          success: true,
          output: "",
          applied: 2,
          expiresAt: "2026-07-12T00:00:00.000Z",
        }),
      }),
    );
    expect(withDeadline).toMatchObject({
      success: true,
      output: "Applied 2 inference feedback adjustment(s) until 2026-07-12T00:00:00.000Z.",
    });

    // A refresh that reported no deadline keeps the original wording rather
    // than claiming a policy lifetime it cannot name.
    const withoutDeadline = await runCronInference(
      { job_id: "jarvis-system-inference-feedback" },
      makeDependencies(new Response(null), {
        refreshInferenceFeedback: async () => ({ success: true, output: "", applied: 0 }),
      }),
    );
    expect(withoutDeadline).toMatchObject({
      success: true,
      output: "Applied 0 inference feedback adjustment(s).",
    });
  });

  test("keeps inference feedback and prompt/projection short circuits independent", async () => {
    let streamCalls = 0;
    const feedbackResult = await runCronInference(
      { job_id: "jarvis-system-inference-feedback" },
      makeDependencies(new Response(null), {
        stream: async () => {
          streamCalls += 1;
          return new Response(null);
        },
        refreshInferenceFeedback: async () => ({ success: true, output: "feedback applied", applied: 2 }),
      }),
    );
    expect(feedbackResult).toMatchObject({ success: true, output: "feedback applied" });
    expect(streamCalls).toBe(0);

    const promptResult = await runCronInference({ prompt: " " }, makeDependencies(new Response(null), {
      stream: async () => {
        streamCalls += 1;
        return new Response(null);
      },
    }));
    expect(promptResult).toMatchObject({
      success: false,
      error: "prompt required",
      execution_evidence: { error_code: "missing_prompt" },
    });

    const projectionResult = await runCronInference(
      { prompt: "do work", projection_snapshot: { slug: 42 } },
      makeDependencies(new Response(null), {
        stream: async () => {
          streamCalls += 1;
          return new Response(null);
        },
      }),
    );
    expect(projectionResult).toMatchObject({
      success: false,
      error: "invalid projection snapshot",
      execution_evidence: { error_code: "projection_invalid" },
    });
    expect(streamCalls).toBe(0);
  });

  test("passes request cancellation to the exact stream and suppresses late results", async () => {
    const request = new AbortController();
    let streamSignal: AbortSignal | undefined;
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    let cancelled = false;
    let lateResult = false;
    const response = delayedResponse(100, () => { cancelled = true; }, () => { lateResult = true; });
    const resultPromise = runCronInference(
      { prompt: "do work" },
      makeDependencies(new Response(null), {
        stream: async (_prompt, _sessionId, options) => {
          streamSignal = options.signal;
          startedResolve();
          return response;
        },
      }),
      { signal: request.signal },
    );

    await started;
    request.abort("request aborted");
    const result = await resultPromise;
    await Bun.sleep(120);

    expect(streamSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
    expect(lateResult).toBe(false);
    expect(result).toMatchObject({
      success: false,
      output: "partial",
      execution_evidence: {
        status: "cancelled",
        error_code: "cancelled",
      },
    });
  });

  test("waits for the active stream producer to finish after cancellation", async () => {
    const request = new AbortController();
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    let releaseCompletion!: () => void;
    let producerCompleted = false;
    const response = delayedResponse(100);
    const completion = new Promise<void>((resolve) => {
      releaseCompletion = () => {
        producerCompleted = true;
        resolve();
      };
    });
    const resultPromise = runCronInference(
      { prompt: "do work" },
      makeDependencies(new Response(null), {
        stream: async () => {
          startedResolve();
          return { response, completion };
        },
      }),
      { signal: request.signal },
    );

    await started;
    request.abort("request aborted");
    let settled = false;
    void resultPromise.then(() => { settled = true; });
    await Bun.sleep(20);
    expect(settled).toBe(false);
    releaseCompletion();

    const result = await resultPromise;
    expect(producerCompleted).toBe(true);
    expect(result.execution_evidence?.status).toBe("cancelled");
  });

  test("returns a stable timeout outcome when the production deadline expires", async () => {
    let streamSignal: AbortSignal | undefined;
    let lateResult = false;
    const response = delayedResponse(100, () => {}, () => { lateResult = true; });
    const result = await runCronInference(
      { prompt: "do work" },
      makeDependencies(new Response(null), {
        stream: async (_prompt, _sessionId, options) => {
          streamSignal = options.signal;
          return response;
        },
      }),
      { deadlineMs: 15 },
    );
    await Bun.sleep(120);

    expect(streamSignal?.aborted).toBe(true);
    expect(lateResult).toBe(false);
    expect(result).toMatchObject({
      success: false,
      output: "partial",
      execution_evidence: {
        status: "timeout",
        error_code: "cron_deadline_exceeded",
      },
    });
  });
});
