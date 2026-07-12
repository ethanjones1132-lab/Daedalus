import { describe, expect, test } from "bun:test";
import { OrchestrationAdmissionController } from "./admission-controller";

describe("OrchestrationAdmissionController", () => {
  test("queues background work while interactive capacity is active", async () => {
    const controller = new OrchestrationAdmissionController({ interactive: 2, background: 1 });
    const chat = await controller.acquire({ workClass: "interactive" });
    let cronStarted = false;
    const cronPromise = controller.acquire({ workClass: "background" }).then((lease) => {
      cronStarted = true;
      return lease;
    });

    await Promise.resolve();
    expect(cronStarted).toBe(false);
    chat.release();
    const cron = await cronPromise;
    expect(cronStarted).toBe(true);
    cron.release();
  });

  test("interactive work preempts queued background work", async () => {
    const controller = new OrchestrationAdmissionController({ interactive: 1, background: 1 });
    const first = await controller.acquire({ workClass: "interactive" });
    let backgroundStarted = false;
    const backgroundPromise = controller.acquire({ workClass: "background" }).then((lease) => {
      backgroundStarted = true;
      return lease;
    });
    const interactivePromise = controller.acquire({ workClass: "interactive" });
    first.release();
    const second = await interactivePromise;
    expect(backgroundStarted).toBe(false);
    second.release();
    const background = await backgroundPromise;
    background.release();
  });

  test("aborted waiters are removed without consuming capacity", async () => {
    const controller = new OrchestrationAdmissionController({ interactive: 1, background: 1 });
    const first = await controller.acquire({ workClass: "interactive" });
    const abort = new AbortController();
    const waiting = controller.acquire({ workClass: "interactive", signal: abort.signal });
    abort.abort();
    await expect(waiting).rejects.toThrow("aborted");
    expect(controller.snapshot().queued_interactive).toBe(0);
    first.release();
  });
});
