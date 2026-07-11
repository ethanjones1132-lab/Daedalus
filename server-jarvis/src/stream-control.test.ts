import { describe, expect, mock, test } from "bun:test";
import {
  ActiveStreamRegistry,
  collectTerminalEvents,
  createIdempotentReaderCancel,
  registerAbortHandler,
  resolveReadStopReason,
} from "./stream-control";

test("terminal smoke records exactly one terminal outcome", () => {
  const events = collectTerminalEvents([
    { type: "message_stop" },
    { type: "result", subtype: "success", result: "ok" },
  ]);

  expect(events).toEqual([{ type: "result", subtype: "success", result: "ok" }]);
});

test("terminal smoke ignores late duplicate outcomes", () => {
  const events = collectTerminalEvents([
    { type: "result", subtype: "success", result: "first" },
    { type: "error", code: "late_error" },
    { type: "cancelled", reason: "late_cancel" },
  ]);

  expect(events).toEqual([{ type: "result", subtype: "success", result: "first" }]);
});

describe("ActiveStreamRegistry", () => {
  test("an older stream cannot release a newer stream for the same session", () => {
    const registry = new ActiveStreamRegistry();
    const first = registry.begin("session-1");
    const second = registry.begin("session-1");

    expect(first.controller.signal.aborted).toBe(true);
    expect(first.release()).toBe(false);
    expect(registry.size).toBe(1);

    expect(registry.cancel("session-1")).toBe(true);
    expect(second.controller.signal.aborted).toBe(true);
    expect(second.release()).toBe(true);
    expect(registry.size).toBe(0);
  });

  test("repeated cancellation has one side effect and cleanup remains lease-owned", () => {
    const registry = new ActiveStreamRegistry();
    const lease = registry.begin("session-1");
    const onAbort = mock(() => {});
    lease.controller.signal.addEventListener("abort", onAbort);

    expect(registry.cancel("session-1")).toBe(true);
    expect(registry.cancel("session-1")).toBe(false);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(1);

    expect(lease.release()).toBe(true);
    expect(registry.size).toBe(0);
  });
});

test("registerAbortHandler handles an already-aborted signal and cleanup is idempotent", () => {
  const controller = new AbortController();
  controller.abort("already stopped");
  const onAbort = mock(() => {});

  const cleanup = registerAbortHandler(controller.signal, onAbort);
  cleanup();
  cleanup();

  expect(onAbort).toHaveBeenCalledTimes(1);
});

test("reader cancellation is idempotent across competing timeout and user abort paths", async () => {
  const cancel = mock(async (_reason?: unknown) => {});
  const cancelReader = createIdempotentReaderCancel({ cancel });

  await Promise.all([
    cancelReader("First-token timeout"),
    cancelReader("Inter-token timeout"),
    cancelReader("User cancelled"),
  ]);

  expect(cancel).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledWith("First-token timeout");
});

test("reader cancellation stays idempotent when the reader throws synchronously", async () => {
  const failure = new Error("reader already released");
  const cancel = mock(() => {
    throw failure;
  });
  const cancelReader = createIdempotentReaderCancel({ cancel });

  const first = cancelReader("timeout");
  const second = cancelReader("user abort");

  await expect(first).rejects.toBe(failure);
  await expect(second).rejects.toBe(failure);
  expect(cancel).toHaveBeenCalledTimes(1);
});

test("read completion resolves timeout and user-cancel races to one reason", () => {
  const controller = new AbortController();
  controller.abort("user stopped");

  expect(resolveReadStopReason({ firstTokenTimedOut: true, streamIdleTimedOut: false, signal: controller.signal }))
    .toBe("first_token_timeout");
  expect(resolveReadStopReason({ firstTokenTimedOut: false, streamIdleTimedOut: true, signal: controller.signal }))
    .toBe("stream_idle_timeout");
  expect(resolveReadStopReason({ firstTokenTimedOut: false, streamIdleTimedOut: false, signal: controller.signal }))
    .toBe("turn_cancelled");
  expect(resolveReadStopReason({
    firstTokenTimedOut: false,
    streamIdleTimedOut: false,
    signal: new AbortController().signal,
  })).toBeNull();
});

test("new deadline stop reasons preserve user-cancel and deadline precedence", () => {
  const cancelled = new AbortController();
  cancelled.abort("user stopped");
  expect(resolveReadStopReason({
    firstTokenTimedOut: false,
    streamIdleTimedOut: false,
    visibleProgressTimedOut: true,
    turnDeadlineExceeded: true,
    signal: cancelled.signal,
  })).toBe("turn_cancelled");

  expect(resolveReadStopReason({
    firstTokenTimedOut: false,
    streamIdleTimedOut: false,
    visibleProgressTimedOut: true,
    turnDeadlineExceeded: true,
    signal: new AbortController().signal,
  })).toBe("turn_deadline_exceeded");

  expect(resolveReadStopReason({
    firstTokenTimedOut: false,
    streamIdleTimedOut: false,
    visibleProgressTimedOut: true,
    turnDeadlineExceeded: false,
    signal: new AbortController().signal,
  })).toBe("visible_progress_timeout");
});
