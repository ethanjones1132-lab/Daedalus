import { describe, expect, test } from "bun:test";
import {
  OrchestrationAdmissionAbortedError,
  OrchestrationAdmissionDeadlineExceededError,
} from "./admission-controller";
import { acquireAdmissionForStream } from "./admission-boundary";
import { StreamSession } from "../stream-emitter";

function recorder() {
  const frames: string[] = [];
  return {
    write: async (frame: string): Promise<boolean> => {
      frames.push(frame);
      return true;
    },
    events: () => frames
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice("data: ".length)) as Record<string, unknown>),
  };
}

describe("acquireAdmissionForStream", () => {
  test("settles a queued deadline as a typed stream error", async () => {
    const rec = recorder();
    const session = new StreamSession({
      sessionId: "admission-deadline",
      write: rec.write,
      isAborted: () => false,
    });
    const lease = await acquireAdmissionForStream({
      acquire: async () => {
        throw new OrchestrationAdmissionDeadlineExceededError(10);
      },
      onDeadline: async () => {
        await session.error("The turn deadline expired while waiting for capacity.", "turn_deadline_exceeded");
      },
      onCancelled: async () => {
        throw new Error("unexpected cancellation");
      },
    });
    await session.ensureTerminal();

    expect(lease).toBeUndefined();
    expect(rec.events().filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({ code: "turn_deadline_exceeded" }),
    ]);
    expect(rec.events().filter((event) => event.type === "cancelled")).toHaveLength(0);
    expect(rec.events().filter((event) => event.type === "message_stop")).toHaveLength(1);
  });

  test("settles an aborted waiter through the cancellation callback", async () => {
    let cancelled = false;
    await expect(
      acquireAdmissionForStream({
        acquire: async () => {
          throw new OrchestrationAdmissionAbortedError();
        },
        onDeadline: async () => {
          throw new Error("unexpected deadline");
        },
        onCancelled: async () => {
          cancelled = true;
          throw new Error("cancelled");
        },
      }),
    ).rejects.toThrow("cancelled");
    expect(cancelled).toBe(true);
  });

  test("rethrows unrelated admission failures", async () => {
    const failure = new Error("controller failure");
    await expect(
      acquireAdmissionForStream({
        acquire: async () => {
          throw failure;
        },
        onDeadline: async () => {},
        onCancelled: async () => {},
      }),
    ).rejects.toBe(failure);
  });
});
