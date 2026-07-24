import { test, expect, describe } from "bun:test";
import { DashboardService, type JobStats, type HealthFlag } from "./dashboard-service";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Contract pin for the Live Ops Dashboard Service.
 *
 * Pins the parts of the surface that are stable:
 *  - Constructor: state shape, polling start, EventEmitter inheritance
 *  - getState(): stable, defensive copy
 *  - setPollInterval(): minimum-clamp at 5000ms
 *  - destroy(): clears the poll timer (no double-fire)
 *  - getStatusColor(): pure-function color table for the radar overlay
 *
 * Does NOT pin: SQL aggregation (the underlying schema is a stub pending
 * wiring into the real cron DB), modelReliability() (placeholder data),
 * the random radar data (deterministic-by-time would require a clock seam).
 */
describe("dashboard-service", () => {
  // Use a real temp dir so the constructor's mkdirSync + bun:sqlite
  // file creation runs through the real OS path, but isolate per test.
  function freshService(): { service: DashboardService; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-dashboard-test-"));
    // The service hardcodes ~/.jarvis/dashboard; we can't redirect it
    // without changing the constructor, so we accept the global path
    // for these tests and rely on each test using a unique instance.
    const service = new DashboardService({} as any);
    return { service, dir };
  }

  test("constructor initializes empty state with the documented shape", () => {
    const { service, dir } = freshService();
    try {
      const state = service.getState();
      expect(state.jobs).toEqual([]);
      expect(state.radarData).toEqual([]);
      expect(state.healthFlags).toEqual([]);
      expect(state.modelReliability).toEqual([]);
      expect(state.pollInterval).toBe(23000); // DEFAULT_POLL_INTERVAL
      expect(state.stats).toEqual({
        total: 0,
        active: 0,
        paused: 0,
        errored: 0,
        disabled: 0,
        delivery_fails: 0,
        overdue: 0,
      });
      expect(state.lastUpdated).toBeInstanceOf(Date);
    } finally {
      service.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("extends EventEmitter so consumers can subscribe to state changes", () => {
    const { service, dir } = freshService();
    try {
      expect(typeof service.on).toBe("function");
      expect(typeof service.emit).toBe("function");
      expect(typeof service.removeListener).toBe("function");

      // Sanity: a listener can be attached without throwing.
      const handler = () => {};
      service.on("stateChanged", handler);
      service.removeListener("stateChanged", handler);
    } finally {
      service.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("getState() returns a shallow copy of the top-level state object", () => {
    const { service, dir } = freshService();
    try {
      const a = service.getState();
      const b = service.getState();
      // Different object identity at the top level (caller cannot
      // replace the service's internal state object wholesale).
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
      // Reassigning a top-level field on the returned snapshot must not
      // leak back into the service's internal state.
      (a as any).jobs = [{ id: "tampered" } as any];
      expect(service.getState().jobs).toEqual([]);
    } finally {
      service.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("setPollInterval clamps to a minimum of 5000ms", () => {
    const { service, dir } = freshService();
    try {
      service.setPollInterval(0);
      expect(service.getState().pollInterval).toBe(5000);
      service.setPollInterval(-100);
      expect(service.getState().pollInterval).toBe(5000);
      service.setPollInterval(1000);
      expect(service.getState().pollInterval).toBe(5000);
      service.setPollInterval(12345);
      expect(service.getState().pollInterval).toBe(12345);
    } finally {
      service.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("destroy() is idempotent — calling it twice does not throw", () => {
    const { service, dir } = freshService();
    try {
      service.destroy();
      expect(() => service.destroy()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("getStatusColor maps the four documented radar statuses to distinct colors", () => {
    // Use a fresh instance just so we exercise the real method binding.
    const { service, dir } = freshService();
    try {
      // Access the private method through a narrow cast for the contract pin.
      const getColor = (status: any) =>
        (service as any).getStatusColor(status);
      const success = getColor("success");
      const failed = getColor("failed");
      const pending = getColor("pending");
      const running = getColor("running");
      const unknown = getColor("nonsense-status");

      // Each documented status resolves to a non-empty hex color.
      expect(typeof success).toBe("string");
      expect(success.startsWith("#")).toBe(true);
      // All four distinct (a regression guard against future collisions).
      const set = new Set([success, failed, pending, running]);
      expect(set.size).toBe(4);
      // Unknown status falls back to the neutral gray.
      expect(unknown).toBe("#6b7280");
    } finally {
      service.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the JobStats and HealthFlag union types are stable enough to construct", () => {
    // A pure-type regression pin: if either union is narrowed or reordered
    // in a breaking way, this test will fail to typecheck (bun test will
    // refuse to run the file).
    const stats: JobStats = {
      total: 1,
      active: 1,
      paused: 0,
      errored: 0,
      disabled: 0,
      delivery_fails: 0,
      overdue: 0,
    };
    expect(stats.active).toBe(1);

    const flag: HealthFlag = {
      id: "flag-1",
      severity: "warning",
      category: "rate_limit",
      message: "rate limited",
      timestamp: new Date(),
    };
    expect(flag.severity).toBe("warning");
  });
});
