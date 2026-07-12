import type { OrchestratorAgent } from "./agent-pool";

export type RecoverableFailureKind =
  | "first_token_timeout"
  | "stream_idle_timeout"
  | "visible_progress_timeout"
  | "empty_completion";

export interface StageModelFailure {
  provider: string;
  modelId: string;
  stage: string;
  kind: RecoverableFailureKind;
}

interface FailureRecord {
  strikes: number;
  cooldownStartedAt: number;
  cooldownMs: number;
}

const COOLDOWN_MS: Record<RecoverableFailureKind, number> = {
  first_token_timeout: 5 * 60_000,
  stream_idle_timeout: 5 * 60_000,
  visible_progress_timeout: 5 * 60_000,
  empty_completion: 2 * 60_000,
};

function modelKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

function failureKey(provider: string, modelId: string, stage: string): string {
  return `${stage}:${provider}:${modelId}`;
}

/** Process-lifetime health memory for recoverable stage failures. */
export class StageHealthRegistry {
  private readonly failures = new Map<string, FailureRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  recordFailure(failure: StageModelFailure): void {
    const key = failureKey(failure.provider, failure.modelId, failure.stage);
    const prior = this.failures.get(key);
    const strikes = (prior?.strikes ?? 0) + 1;
    this.failures.set(key, {
      strikes,
      // A single transport stall or empty answer is enough to exclude the
      // candidate on the next turn. Repeated failures refresh the same active
      // cooldown instead of creating a retry storm.
      cooldownStartedAt: prior?.cooldownStartedAt && this.now() - prior.cooldownStartedAt < prior.cooldownMs
        ? prior.cooldownStartedAt
        : this.now(),
      cooldownMs: COOLDOWN_MS[failure.kind],
    });
  }

  recordSuccess(input: Pick<StageModelFailure, "provider" | "modelId" | "stage">): void {
    const key = failureKey(input.provider, input.modelId, input.stage);
    const prior = this.failures.get(key);
    if (prior && prior.cooldownStartedAt > 0 && this.now() - prior.cooldownStartedAt < prior.cooldownMs) {
      // An alternating success must not immediately re-admit a model that is
      // still inside a transport/empty-completion cooldown window.
      return;
    }
    this.failures.delete(key);
  }

  excludedModelKeys(stage: string): Set<string> {
    const result = new Set<string>();
    const now = this.now();
    for (const [key, record] of this.failures) {
      if (!key.startsWith(`${stage}:`) || record.cooldownStartedAt <= 0) continue;
      if (now - record.cooldownStartedAt >= record.cooldownMs) {
        this.failures.delete(key);
        continue;
      }
      const [, provider, ...modelParts] = key.split(":");
      result.add(modelKey(provider, modelParts.join(":")));
    }
    return result;
  }

  clear(): void {
    this.failures.clear();
  }
}

export function stageHealthKey(agent: Pick<OrchestratorAgent, "provider" | "model_id">, stage: string): string {
  return failureKey(agent.provider, agent.model_id, stage);
}
