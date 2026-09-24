export const DEFAULT_MAX_TRAJECTORY_SNAPSHOTS = 500;

export function isValidTrajectoryRetention(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function normalizeTrajectoryRetention(value: unknown): number {
  return isValidTrajectoryRetention(value) ? value : DEFAULT_MAX_TRAJECTORY_SNAPSHOTS;
}

export function invalidTrajectoryRetentionMessage(value: unknown, source: string): string {
  return `[${source}] orchestrator.conductor_learning.max_trajectory_snapshots must be a finite positive integer; received ${String(value)}; using ${DEFAULT_MAX_TRAJECTORY_SNAPSHOTS}.`;
}
