import type { OrchestratorAgent } from "./agent-pool";

export type RecoverableFailureKind =
  | "first_token_timeout"
  | "stream_idle_timeout"
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
}

const COOLDOWN_MS = 5 * 60_000;

function modelKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

function failureKey(provider: string, modelId: string, stage: string): string {
  return `${stage}:${provider}:${modelId}`;
}

function thresholdFor(kind: RecoverableFailureKind): number {
  return kind === "empty_completion" ? 2 : 1;
}

/** Process-lifetime health memory for recoverable stage failures. */
export class StageHealthRegistry {
  private readonly failures = new Map<string, FailureRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  recordFailure(failure: StageModelFailure): void {
    const key = failureKey(failure.provider, failure.modelId, failure.stage);
    const prior = this.failures.get(key);
    const strikes = (prior?.strikes ?? 0) + 1;
    const threshold = thresholdFor(failure.kind);
    const cooldownStartedAt = strikes >= threshold
      ? (prior && prior.strikes >= threshold ? prior.cooldownStartedAt : this.now())
      : 0;
    this.failures.set(key, { strikes, cooldownStartedAt });
  }

  recordSuccess(input: Pick<StageModelFailure, "provider" | "modelId" | "stage">): void {
    this.failures.delete(failureKey(input.provider, input.modelId, input.stage));
  }

  excludedModelKeys(stage: string): Set<string> {
    const result = new Set<string>();
    const now = this.now();
    for (const [key, record] of this.failures) {
      if (!key.startsWith(`${stage}:`) || record.cooldownStartedAt <= 0) continue;
      if (now - record.cooldownStartedAt >= COOLDOWN_MS) {
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
