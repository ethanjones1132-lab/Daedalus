import { createHash } from "crypto";
import {
  type OrchestrationTheta,
  type RolloutSpec,
  rolloutId,
  withRollout,
} from "../orchestration/orchestration-policy";
import { DeadToolTracker } from "../orchestration/dead-tool-suppression";
import { decideDelegateIntervention } from "../orchestration/delegate-intervention-policy";
import { decideExecutorProgress } from "../orchestration/executor-progress-policy";
import { canApplyConductorReroute } from "../orchestration/reroute-policy";
import { POLICY_STAGING_GOVERNANCE } from "../self-tuning/policy-staging";
import type { PolicyRolloutFixture, PolicyRolloutStep } from "./policy-rollout-fixtures";

export interface PolicyRolloutEvent {
  index: number;
  id: string;
  kind: PolicyRolloutStep["kind"];
  decision: string | boolean;
}

export interface PolicyRolloutResult {
  rolloutFingerprint: string;
  trajectoryDigest: string;
  theta: OrchestrationTheta;
  events: PolicyRolloutEvent[];
}

/** Execute only deterministic policy decisions against recorded fixture inputs. */
export function runPolicyRollout(
  spec: RolloutSpec,
  fixture: PolicyRolloutFixture,
): PolicyRolloutResult {
  if (spec.fixtureId !== fixture.id) {
    throw new Error(`fixture mismatch: spec=${spec.fixtureId} fixture=${fixture.id}`);
  }

  const execution = withRollout(spec, (rng) => fixture.steps.map((step, index) => {
    let decision: string | boolean;
    switch (step.kind) {
      case "canary_draw":
        decision = step.canaryActive
          ? rng() < POLICY_STAGING_GOVERNANCE.canaryTrafficFraction
          : false;
        break;
      case "executor_progress":
        decision = decideExecutorProgress(step.input);
        break;
      case "delegate_intervention":
        decision = decideDelegateIntervention(step.input);
        break;
      case "reroute_admission":
        decision = canApplyConductorReroute(step.applied);
        break;
      case "dead_tool": {
        const tracker = new DeadToolTracker();
        for (const failure of step.failures) tracker.record(step.tool, true, failure);
        decision = tracker.isSuppressed(step.tool);
        break;
      }
    }
    return { index, id: rolloutId("rollout_event"), kind: step.kind, decision };
  }));

  const events = execution.result;
  const trajectoryDigest = createHash("sha256")
    .update(JSON.stringify(events))
    .digest("hex");
  return {
    rolloutFingerprint: execution.fingerprint,
    trajectoryDigest,
    theta: execution.theta,
    events,
  };
}
