import { applyLearningEvalDecision, loadSkillCandidate, saveSkillCandidate } from "../intelligence/skill-store";
import type { SkillCandidate } from "../intelligence/skill-types";
import type { SkillPromotionProof } from "../intelligence/skill-promotion";
import { computeBodyDigest, computeCandidateArtifactDigest, computeDigest, LEARNING_EVAL_ARMS } from "../self-tuning/rollout/learning-eval-types";
import { computeLearningEvalAcceptanceReportHash, LEARNING_EVAL_ACCEPTANCE_CRITERION_IDS, type LearningEvalAcceptanceReportV1 } from "../self-tuning/rollout/learning-eval-report";
import { createLearningEvalDecisionRecord, writeLearningEvalDecision } from "../self-tuning/rollout/learning-eval-decision-store";

/** Synthetic accepted transfer evidence; never writes outside the supplied temp store. */
export function stagePromotionFixture(candidate: SkillCandidate, root: string): SkillPromotionProof {
  saveSkillCandidate(candidate);
  candidate = loadSkillCandidate(candidate.id)!;
  const digest = computeDigest(`synthetic-transfer:${candidate.id}`);
  const bootstrap = (delta: number) => ({
    method: "task_cluster_percentile_bootstrap" as const, version: 1,
    seed: digest, seedDerivation: "synthetic fixture", draws: 10_000,
    confidence: 0.95, lowerPercentile: 0.025, upperPercentile: 0.975,
    clusterCount: 8, observationsPerCluster: 3, pointEstimate: delta, lower: delta, upper: delta,
  });
  const report: LearningEvalAcceptanceReportV1 = {
    schemaVersion: 1, acceptanceGovernanceVersion: 1,
    campaignId: `synthetic-${candidate.id}`, manifestHash: digest,
    baseSourceSha: "a".repeat(40), fixtureSourceDigest: digest, rubricDigest: digest,
    acceptanceCodeDigest: digest, verifierSourceDigest: digest, inputOutcomesDigest: digest,
    generatedAt: "2026-10-14T00:00:00.000Z",
    candidate: { id: candidate.id, contentDigest: computeBodyDigest(candidate.body), artifactDigest: computeCandidateArtifactDigest(candidate) },
    neutralArtifactDigest: digest,
    model: { name: "synthetic-model", digest, baseUrl: "http://127.0.0.1:11434", supportsNativeTools: true, version: "fixture" },
    coverage: { plannedTaskCount: 8, seedsPerTask: 3, armsPerBlock: 3, plannedBlockCount: 24, plannedOutcomeCount: 72, observedOutcomeCount: 72, missingOutcomeCount: 0, missingOutcomeKeys: [], complete: true },
    arms: LEARNING_EVAL_ARMS.map((arm) => ({
      arm, scheduled: 24, observed: 24, primaryAccepted: arm === "candidate" ? 24 : 0,
      primaryRejected: arm === "candidate" ? 0 : 24, primaryUnknown: 0,
      primaryAcceptedRate: arm === "candidate" ? 1 : 0, meanReward: arm === "candidate" ? 1 : 0,
      toolFailures: 0, toolFailureRate: 0, toolFailureKnown: true, treatmentDeliveryFailures: 0,
      runFailures: 0, timeouts: 0, cancellations: 0, capturedErrors: 0, missingTelemetry: 0,
    })),
    pairedDeltas: Array.from({ length: 24 }, (_, index) => ({
      task: `synthetic-task-${Math.floor(index / 3)}`, seed: index % 3,
      baseline: false, candidate: true, neutral: false, candidateMinusBaseline: 1, neutralMinusBaseline: 0,
    })),
    candidateBootstrap: bootstrap(1), neutralBootstrap: bootstrap(0),
    toolFailure: { definition: "arm tool failures over 24 scheduled rows", baselineRate: 0, candidateRate: 0, neutralRate: 0, candidateMinusBaseline: 0, maximumAllowedDelta: 0.05, known: true },
    safety: { evidenceStatus: "available", highSeverityEventCount: 0, events: [], impacted: [] },
    criteria: LEARNING_EVAL_ACCEPTANCE_CRITERION_IDS.map((id) => ({ id, description: `Synthetic ${id}`, threshold: "fixture", observed: "pass", status: "pass", reason: "Synthetic passing evidence" })),
    decision: "accepted", reasons: ["Synthetic passing evidence"], reportHash: "",
  };
  report.reportHash = computeLearningEvalAcceptanceReportHash(report);
  const decision = createLearningEvalDecisionRecord({ report, candidate, observedCandidateStatus: "candidate", observedCandidateLifecycleVersion: candidate.lifecycle_version ?? 0, createdAt: report.generatedAt });
  if (!decision.ok) throw new Error(`Promotion fixture decision: ${decision.error}`);
  const saved = writeLearningEvalDecision(decision.value, { root });
  if (!saved.ok) throw new Error(`Promotion fixture persistence: ${saved.error}`);
  const staged = applyLearningEvalDecision(decision.value, { action: "stage_candidate", expectedLifecycleVersion: candidate.lifecycle_version ?? 0 }, { root });
  if (!staged.ok) throw new Error(`Promotion fixture stage: ${staged.error} ${staged.detail ?? ""}`);
  return { reportHash: decision.value.reportHash, decisionRecordHash: decision.value.recordHash, expectedLifecycleVersion: staged.candidate.lifecycle_version! };
}
