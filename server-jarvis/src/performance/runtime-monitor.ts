import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export interface DelayHistogramLike {
  min: number;
  max: number;
  mean: number;
  percentile(percentile: number): number;
  enable(): void;
  disable(): void;
  reset(): void;
}

interface CpuUsageLike {
  user: number;
  system: number;
}

interface EluLike {
  idle: number;
  active: number;
  utilization: number;
}

export interface RuntimePerformanceSnapshot {
  window_started_at: string;
  window_ms: number;
  event_loop_delay_ms: {
    min: number;
    mean: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  event_loop_utilization: number;
  process_cpu_ms: { user: number; system: number };
  rss_bytes: number;
}

export interface RuntimeMonitor {
  start(): void;
  stop(): void;
  snapshot(options?: { reset?: boolean }): RuntimePerformanceSnapshot;
}

export interface RuntimeMonitorDependencies {
  histogram?: DelayHistogramLike;
  now?: () => number;
  cpuUsage?: (previous?: CpuUsageLike) => CpuUsageLike;
  memoryUsage?: () => { rss: number };
  eventLoopUtilization?: (previous?: EluLike) => EluLike;
}

export function shouldLogRuntimePerformance(value: string | undefined): boolean {
  return value === "1";
}

function finiteRounded(value: number, digits = 3): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function nanosecondsToMilliseconds(value: number): number {
  const milliseconds = value / 1_000_000;
  // perf_hooks uses a very large sentinel for `min` before the histogram has
  // any observations. Treat values above one day as "no sample" rather than
  // emitting a misleading multi-century event-loop delay.
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 86_400_000) return 0;
  return finiteRounded(milliseconds);
}

export function readDelayHistogram(histogram: DelayHistogramLike): RuntimePerformanceSnapshot["event_loop_delay_ms"] {
  return {
    min: nanosecondsToMilliseconds(histogram.min),
    mean: nanosecondsToMilliseconds(histogram.mean),
    p50: nanosecondsToMilliseconds(histogram.percentile(50)),
    p95: nanosecondsToMilliseconds(histogram.percentile(95)),
    p99: nanosecondsToMilliseconds(histogram.percentile(99)),
    max: nanosecondsToMilliseconds(histogram.max),
  };
}

export function createRuntimeMonitor(dependencies: RuntimeMonitorDependencies = {}): RuntimeMonitor {
  const histogram = dependencies.histogram ?? monitorEventLoopDelay({ resolution: 10 });
  const now = dependencies.now ?? Date.now;
  const cpuUsage = dependencies.cpuUsage ?? process.cpuUsage.bind(process);
  const memoryUsage = dependencies.memoryUsage ?? process.memoryUsage.bind(process);
  const eventLoopUtilization = dependencies.eventLoopUtilization
    ?? performance.eventLoopUtilization.bind(performance);

  let started = false;
  let windowStartedAt = now();
  let cpuBaseline: CpuUsageLike = { user: 0, system: 0 };
  let eluBaseline: EluLike = { idle: 0, active: 0, utilization: 0 };

  const resetBaselines = () => {
    windowStartedAt = now();
    cpuBaseline = cpuUsage();
    eluBaseline = eventLoopUtilization();
  };

  return {
    start() {
      if (started) return;
      started = true;
      resetBaselines();
      histogram.enable();
    },
    stop() {
      if (!started) return;
      histogram.disable();
      started = false;
    },
    snapshot(options = {}) {
      const capturedAt = now();
      const cpu = cpuUsage(cpuBaseline);
      const elu = eventLoopUtilization(eluBaseline);
      const snapshot: RuntimePerformanceSnapshot = {
        window_started_at: new Date(windowStartedAt).toISOString(),
        window_ms: Math.max(0, capturedAt - windowStartedAt),
        event_loop_delay_ms: readDelayHistogram(histogram),
        event_loop_utilization: finiteRounded(elu.utilization, 4),
        process_cpu_ms: {
          user: finiteRounded(cpu.user / 1_000),
          system: finiteRounded(cpu.system / 1_000),
        },
        rss_bytes: Math.max(0, Number(memoryUsage().rss) || 0),
      };
      if (options.reset) {
        histogram.reset();
        resetBaselines();
      }
      return snapshot;
    },
  };
}
