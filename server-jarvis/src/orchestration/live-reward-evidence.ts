import type { CheckResult } from "./check-runner";
import type { WriteEffectObservation } from "./content-fingerprint";
import {
  buildStoredRunRewardSnapshot,
  type DeclaredRunOutcome,
  type RunRewardPlanEvidence,
  type StoredRunRewardSnapshot,
} from "./run-reward";

/**
 * Live persistence boundary for reward evidence. Tool-call fallback is only
 * for replaying historical rows and is intentionally not expressible here.
 */
export interface LiveRunRewardSnapshotInput {
  writeRequired: boolean;
  effects: readonly WriteEffectObservation[];
  targetPaths?: string[];
  check: Pick<CheckResult, "tier" | "ran" | "passed"> | null;
  plan?: RunRewardPlanEvidence | null;
  declaredOutcome?: DeclaredRunOutcome | null;
}

export function buildLiveRunRewardSnapshot(
  input: LiveRunRewardSnapshotInput,
): StoredRunRewardSnapshot {
  const snapshot = buildStoredRunRewardSnapshot(input);
  if (snapshot.writeEvidenceSource !== "fingerprints") {
    throw new Error("live reward snapshot requires fingerprint evidence");
  }
  return snapshot;
}
