import { describe, expect, test } from "bun:test";
import {
  createRuntimeMonitor,
  readDelayHistogram,
  shouldLogRuntimePerformance,
  type DelayHistogramLike,
} from "./runtime-monitor";

function fakeHistogram(): DelayHistogramLike & { resetCount: number } {
  return {
    min: 1_000_000,
    max: 12_000_000,
    mean: 4_500_000,
    percentile: (p: number) => ({ 50: 2_000_000, 95: 8_000_000, 99: 11_000_000 }[p] ?? 0),
    enable: () => undefined,
    disable: () => undefined,
    resetCount: 0,
    reset() { this.resetCount += 1; },
  };
}

describe("runtime performance monitor", () => {
  test("keeps periodic logging opt-in while measurement remains available", () => {
    expect(shouldLogRuntimePerformance("1")).toBe(true);
    expect(shouldLogRuntimePerformance("0")).toBe(false);
    expect(shouldLogRuntimePerformance(undefined)).toBe(false);
  });

  test("converts perf_hooks nanoseconds to bounded millisecond percentiles", () => {
    expect(readDelayHistogram(fakeHistogram())).toEqual({
      min: 1,
      mean: 4.5,
      p50: 2,
      p95: 8,
      p99: 11,
      max: 12,
    });
  });

  test("snapshot reports interval CPU/ELU and resets only when requested", () => {
    const histogram = fakeHistogram();
    let now = 1_000;
    let cpu = { user: 10_000, system: 5_000 };
    let elu = { idle: 90, active: 10, utilization: 0.1 };
    const monitor = createRuntimeMonitor({
      histogram,
      now: () => now,
      cpuUsage: (previous) => ({
        user: cpu.user - (previous?.user ?? 0),
        system: cpu.system - (previous?.system ?? 0),
      }),
      memoryUsage: () => ({ rss: 123_456 }),
      eventLoopUtilization: (previous) => previous ? {
        idle: elu.idle - previous.idle,
        active: elu.active - previous.active,
        utilization: elu.utilization,
      } : elu,
    });

    monitor.start();
    now = 2_000;
    cpu = { user: 25_000, system: 9_000 };
    elu = { idle: 180, active: 20, utilization: 0.1 };
    const first = monitor.snapshot({ reset: false });
    expect(first.window_ms).toBe(1_000);
    expect(first.process_cpu_ms).toEqual({ user: 15, system: 4 });
    expect(first.event_loop_utilization).toBe(0.1);
    expect(first.rss_bytes).toBe(123_456);
    expect(histogram.resetCount).toBe(0);

    monitor.snapshot({ reset: true });
    expect(histogram.resetCount).toBe(1);
    monitor.stop();
  });
});
