import { describe, expect, it } from "bun:test";
import {
  createStreamFinishTracker,
  serverCancelFromReadStop,
} from "./stream-finish";

describe("createStreamFinishTracker", () => {
  it("settles clean stop as non-truncated", () => {
    const t = createStreamFinishTracker();
    t.observe({ finish_reason: null }); // intermediate delta
    t.observe({ finish_reason: "stop" });
    const s = t.settle();
    expect(s.finish_reason).toBe("stop");
    expect(s.truncated).toBe(false);
    expect(s.stop_reason).toBe("stop");
  });

  it("settles length as truncated token-cap", () => {
    const t = createStreamFinishTracker();
    t.observe({ finish_reason: "length" });
    const s = t.settle();
    expect(s.finish_reason).toBe("length");
    expect(s.truncated).toBe(true);
    expect(s.stop_reason).toBe("length");
  });

  it("settles tool_calls as clean (tool-bearing stages)", () => {
    const t = createStreamFinishTracker();
    t.observe({ finish_reason: "tool_calls" });
    const s = t.settle({ treatMissingAsTruncated: true });
    expect(s.truncated).toBe(false);
    expect(s.stop_reason).toBe("tool_calls");
  });

  it("provider_cut when stream ends done with no finish_reason", () => {
    const t = createStreamFinishTracker();
    // only intermediate nulls
    t.observe({ finish_reason: null });
    t.observe({});
    const s = t.settle({ treatMissingAsTruncated: true });
    expect(s.finish_reason).toBeNull();
    expect(s.truncated).toBe(true);
    expect(s.stop_reason).toBe("provider_cut");
  });

  it("missing finish_reason is NOT truncated when treatMissingAsTruncated=false", () => {
    const t = createStreamFinishTracker();
    const s = t.settle({ treatMissingAsTruncated: false });
    expect(s.truncated).toBe(false);
    expect(s.stop_reason).toBe("unknown");
  });

  it("turn_deadline cancel overrides clean finish_reason", () => {
    const t = createStreamFinishTracker();
    t.observe({ finish_reason: "stop" });
    const s = t.settle({ serverCancel: { kind: "turn_deadline" } });
    expect(s.truncated).toBe(true);
    expect(s.stop_reason).toBe("turn_deadline");
    expect(s.finish_reason).toBe("stop"); // last observed still recorded
  });

  it("stage_deadline cancel marks truncated", () => {
    const t = createStreamFinishTracker();
    const s = t.settle({ serverCancel: { kind: "stage_deadline" } });
    expect(s.truncated).toBe(true);
    expect(s.stop_reason).toBe("stage_deadline");
  });

  it("watchdog cancel marks truncated", () => {
    const t = createStreamFinishTracker();
    t.observe({ finish_reason: "stop" });
    const s = t.settle({ serverCancel: { kind: "watchdog" } });
    expect(s.stop_reason).toBe("watchdog");
    expect(s.truncated).toBe(true);
  });

  it("cancelled (user stop) marks truncated", () => {
    const t = createStreamFinishTracker();
    const s = t.settle({ serverCancel: { kind: "cancelled" } });
    expect(s.stop_reason).toBe("cancelled");
    expect(s.truncated).toBe(true);
  });

  it("keeps the last non-empty finish_reason across chunks", () => {
    const t = createStreamFinishTracker();
    t.observe({ finish_reason: null });
    t.observe({ finish_reason: "length" });
    t.observe({ finish_reason: null });
    expect(t.lastFinishReason()).toBe("length");
  });

  it("content_filter is truncated", () => {
    const t = createStreamFinishTracker();
    t.observe({ finish_reason: "content_filter" });
    const s = t.settle();
    expect(s.truncated).toBe(true);
    expect(s.stop_reason).toBe("content_filter");
  });
});

describe("serverCancelFromReadStop", () => {
  it("maps read-loop stop reasons to server cancel kinds", () => {
    expect(serverCancelFromReadStop("turn_deadline_exceeded")).toEqual({ kind: "turn_deadline" });
    expect(serverCancelFromReadStop("stage_deadline_exceeded")).toEqual({ kind: "stage_deadline" });
    expect(serverCancelFromReadStop("turn_cancelled")).toEqual({ kind: "cancelled" });
    expect(serverCancelFromReadStop("first_token_timeout")).toEqual({ kind: "watchdog" });
    expect(serverCancelFromReadStop("stream_idle_timeout")).toEqual({ kind: "watchdog" });
    expect(serverCancelFromReadStop("visible_progress_timeout")).toEqual({ kind: "watchdog" });
    expect(serverCancelFromReadStop("degenerate_stream")).toEqual({ kind: "degenerate_stream" });
    expect(serverCancelFromReadStop(null)).toBeNull();
  });
});
