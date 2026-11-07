import type { ExecutionContext, ToolTraceObservation } from "../tool-runtime";

export type ToolTraceFrame =
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      session_id: string;
    }
  | {
      type: "tool_result";
      call_id: string;
      name: string;
      output: string;
      is_error: boolean;
      session_id: string;
    };

/** The writer may return the boolean result of `streamWrite`; it is ignored. */
export type ToolTraceFrameWriter = (frame: ToolTraceFrame) => unknown;

/**
 * Adapt orchestration tool observations to the canonical chat SSE frame shape.
 * Tool calls are observed in both the batch and shared runToolCall paths, so
 * this boundary deduplicates each use/result pair by the canonical call ID.
 * Writer failures are diagnostics-only and never affect a tool outcome.
 */
export function createToolTraceObserver(
  sessionId: string,
  writeFrame: ToolTraceFrameWriter,
): NonNullable<ExecutionContext["onToolTrace"]> {
  const usedCallIds = new Set<string>();
  const resultCallIds = new Set<string>();

  const safeWrite = (frame: ToolTraceFrame): void => {
    try {
      const pending = writeFrame(frame);
      if (pending && typeof (pending as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(pending).catch(() => {});
      }
    } catch {
      // The trace is an optional diagnostic and cannot affect execution.
    }
  };

  const writeUse = (call: ToolTraceObservation["call"]): void => {
    if (usedCallIds.has(call.id)) return;
    usedCallIds.add(call.id);
    safeWrite({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: { ...call.arguments },
      session_id: sessionId,
    });
  };

  return (observation) => {
    if (observation.kind === "use") {
      writeUse(observation.call);
      return;
    }

    writeUse(observation.call);
    if (resultCallIds.has(observation.call.id)) return;
    resultCallIds.add(observation.call.id);
    safeWrite({
      type: "tool_result",
      call_id: observation.call.id,
      name: observation.call.name,
      output: observation.result.output,
      is_error: observation.result.is_error,
      session_id: sessionId,
    });
  };
}
