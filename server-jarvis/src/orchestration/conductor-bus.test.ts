import { describe, test, expect } from "bun:test";
import { ConductorBus } from "./conductor-bus";

describe("ConductorBus", () => {
  test("subscribe/publish: events arrive in order", () => {
    const bus = new ConductorBus();
    const received: string[] = [];
    bus.subscribe((e) => received.push(e.type));
    bus.subscribe((e) => received.push(e.type + "2"));
    bus.publish({ type: "stage_started", stage: "planner", model: "m", runId: "r" });
    expect(received).toEqual(["stage_started", "stage_started2"]);
  });

  test("subscribe returns working unsubscribe", () => {
    const bus = new ConductorBus();
    const received: string[] = [];
    const unsub = bus.subscribe((e) => received.push(e.type));
    bus.publish({ type: "stage_started", stage: "planner", model: "m", runId: "r" });
    unsub();
    bus.publish({ type: "stage_started", stage: "executor", model: "m", runId: "r" });
    expect(received).toHaveLength(1);
  });

  test("handler errors are caught and do not propagate to publisher", () => {
    const bus = new ConductorBus();
    bus.subscribe(() => { throw new Error("bad handler"); });
    // Should not throw
    expect(() => bus.publish({ type: "stage_started", stage: "planner", model: "m", runId: "r" })).not.toThrow();
  });

  test("registerAbortHandle + resolveAbort fires the controller", () => {
    const bus = new ConductorBus();
    const ctrl = new AbortController();
    bus.registerAbortHandle("executor", ctrl);
    expect(ctrl.signal.aborted).toBe(false);
    bus.resolveAbort("executor");
    expect(ctrl.signal.aborted).toBe(true);
  });

  test("resolveAbort on unregistered stage does not throw", () => {
    const bus = new ConductorBus();
    expect(() => bus.resolveAbort("executor")).not.toThrow();
  });

  test("clear() removes subscribers and abort handles", () => {
    const bus = new ConductorBus();
    const received: string[] = [];
    bus.subscribe((e) => received.push(e.type));
    const ctrl = new AbortController();
    bus.registerAbortHandle("planner", ctrl);
    bus.clear();
    bus.publish({ type: "stage_started", stage: "planner", model: "m", runId: "r" });
    expect(received).toHaveLength(0); // no handlers after clear
    bus.resolveAbort("planner"); // no-op after clear (should not throw)
    expect(ctrl.signal.aborted).toBe(false); // controller not fired (cleared)
  });

  // Test publishThrottled coalescing (async, needs small delay)
  test("publishThrottled coalesces rapid stage_token events", async () => {
    const bus = new ConductorBus();
    const received: Array<{textDelta: string}> = [];
    bus.subscribe((e) => {
      if (e.type === "stage_token") received.push({ textDelta: e.textDelta });
    });
    // Fire 5 rapid events
    for (let i = 0; i < 5; i++) {
      bus.publishThrottled({ type: "stage_token", stage: "executor", textDelta: `chunk${i}`, cumulativeLen: i });
    }
    // Wait for throttle window to flush
    await new Promise(r => setTimeout(r, 350));
    // Should receive 1 coalesced event, not 5
    expect(received).toHaveLength(1);
    expect(received[0].textDelta).toContain("chunk0");
    bus.clear();
  });
});
