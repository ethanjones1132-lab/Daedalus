import type { ModelAttribution } from "../self-tuning/store";
import type { ReliabilityLatencyEntry } from "./reliability-latency-rank";
import { activePolicyArmContext, policy } from "./orchestration-policy";

export interface ScorecardAttempt {
  ok: boolean;
  firstTokenMs?: number;
}

const MIN_SAMPLES = 6;

/** Exported so ranking / trial policy can share the same floor. */
export const SCORECARD_MIN_SAMPLES = MIN_SAMPLES;

/** In-process rolling stage/model telemetry used to add selection pressure. */
export class ModelScorecard {
  private readonly attemptsByScope = new Map<string, Map<string, ScorecardAttempt[]>>();

  private scope(scopeId = activePolicyArmContext().scopeId): Map<string, ScorecardAttempt[]> {
    let attempts = this.attemptsByScope.get(scopeId);
    if (!attempts) {
      attempts = new Map();
      this.attemptsByScope.set(scopeId, attempts);
    }
    return attempts;
  }

  private slot(
    stage: string,
    providerModelKey: string,
    scopeId = activePolicyArmContext().scopeId,
  ): ScorecardAttempt[] {
    const key = `${stage}|${providerModelKey}`;
    const attempts = this.scope(scopeId);
    let list = attempts.get(key);
    if (!list) {
      list = [];
      attempts.set(key, list);
    }
    return list;
  }

  private visibleAttempts(stage: string, providerModelKey: string): ScorecardAttempt[] {
    const context = activePolicyArmContext();
    const production = this.slot(stage, providerModelKey, "production");
    const raw = context.arm === "canary"
      ? [...production, ...this.slot(stage, providerModelKey, context.scopeId)]
      : production;
    const windowSize = Math.max(1, Math.floor(policy().model_scorecard_window_size));
    return raw.slice(-windowSize);
  }

  record(stage: string, providerModelKey: string, attempt: ScorecardAttempt): ScorecardAttempt {
    const list = this.slot(stage, providerModelKey);
    const trackedAttempt = { ...attempt };
    list.push(trackedAttempt);
    return trackedAttempt;
  }

  revise(attempt: ScorecardAttempt, patch: Partial<ScorecardAttempt>): void {
    Object.assign(attempt, patch);
  }

  seedFromHistory(stage: string, rows: ModelAttribution[]): void {
    if (rows.length === 0) return;
    const byProviderModel = new Map<string, ModelAttribution[]>();
    for (const row of rows) {
      const providerModelKey = `${row.provider}:${row.model_id}`;
      const bucket = byProviderModel.get(providerModelKey) ?? [];
      if (bucket.length < 12) {
        bucket.push(row);
        byProviderModel.set(providerModelKey, bucket);
      }
    }

    for (const [providerModelKey, bucket] of byProviderModel.entries()) {
      for (const row of [...bucket].reverse()) {
        this.record(stage, providerModelKey, {
          ok: row.was_successful === 1 && row.had_error === 0,
          firstTokenMs: row.first_token_ms,
        });
      }
    }
  }

  /**
   * Observations recorded for this stage/model. Drives the new-release trial
   * policy: below `TRIAL_SAMPLE_TARGET` there is not yet enough data to grade
   * a model fairly, which is the same floor `errorRate` uses before it will
   * return a verdict at all.
   */
  sampleCount(stage: string, providerModelKey: string): number {
    return this.visibleAttempts(stage, providerModelKey).length;
  }

  errorRate(stage: string, providerModelKey: string): number | undefined {
    const list = this.visibleAttempts(stage, providerModelKey);
    if (list.length < SCORECARD_MIN_SAMPLES) return undefined;
    return list.filter((attempt) => !attempt.ok).length / list.length;
  }

  /**
   * Observed success fraction for this stage/model. Defined for any non-empty
   * window (unlike errorRate, which waits for MIN_SAMPLES). Used by M5
   * reliability/latency ranking so thin samples still participate softly.
   */
  successRate(stage: string, providerModelKey: string): number | undefined {
    const list = this.visibleAttempts(stage, providerModelKey);
    if (list.length === 0) return undefined;
    return list.filter((attempt) => attempt.ok).length / list.length;
  }

  unfitKeys(stage: string): Set<string> {
    const result = new Set<string>();
    const prefix = `${stage}|`;
    const context = activePolicyArmContext();
    const keys = new Set(this.scope("production").keys());
    if (context.arm === "canary") {
      for (const key of this.scope(context.scopeId).keys()) keys.add(key);
    }
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      const providerModelKey = key.slice(prefix.length);
      const rate = this.errorRate(stage, providerModelKey);
      if (rate !== undefined && rate >= policy().model_scorecard_unfit_error_rate) result.add(providerModelKey);
    }
    return result;
  }

  p50FirstToken(stage: string, providerModelKey: string): number | undefined {
    const latencies = this.visibleAttempts(stage, providerModelKey)
      .map((attempt) => attempt.firstTokenMs)
      .filter((ms): ms is number => typeof ms === "number")
      .sort((a, b) => a - b);
    if (latencies.length === 0) return undefined;
    return latencies[Math.floor((latencies.length - 1) / 2)];
  }

  /**
   * M5 input row for one stage/model. Undefined when the scorecard has never
   * observed this key for the stage.
   */
  reliabilityEntry(
    stage: string,
    providerModelKey: string,
  ): ReliabilityLatencyEntry | undefined {
    const samples = this.sampleCount(stage, providerModelKey);
    if (samples === 0) return undefined;
    const successRate = this.successRate(stage, providerModelKey);
    if (successRate === undefined) return undefined;
    return {
      key: providerModelKey,
      sampleCount: samples,
      successRate,
      p50FirstTokenMs: this.p50FirstToken(stage, providerModelKey),
    };
  }
}
