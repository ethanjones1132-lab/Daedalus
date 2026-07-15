import type { ModelAttribution } from "../self-tuning/store";

export interface ScorecardAttempt {
  ok: boolean;
  firstTokenMs?: number;
}

const WINDOW_SIZE = 20;
const MIN_SAMPLES = 6;
const UNFIT_ERROR_RATE = 0.5;

/** In-process rolling stage/model telemetry used to add selection pressure. */
export class ModelScorecard {
  private readonly attempts = new Map<string, ScorecardAttempt[]>();

  private slot(stage: string, providerModelKey: string): ScorecardAttempt[] {
    const key = `${stage}|${providerModelKey}`;
    let list = this.attempts.get(key);
    if (!list) {
      list = [];
      this.attempts.set(key, list);
    }
    return list;
  }

  record(stage: string, providerModelKey: string, attempt: ScorecardAttempt): void {
    const list = this.slot(stage, providerModelKey);
    list.push(attempt);
    if (list.length > WINDOW_SIZE) list.splice(0, list.length - WINDOW_SIZE);
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

  errorRate(stage: string, providerModelKey: string): number | undefined {
    const list = this.slot(stage, providerModelKey);
    if (list.length < MIN_SAMPLES) return undefined;
    return list.filter((attempt) => !attempt.ok).length / list.length;
  }

  unfitKeys(stage: string): Set<string> {
    const result = new Set<string>();
    const prefix = `${stage}|`;
    for (const key of this.attempts.keys()) {
      if (!key.startsWith(prefix)) continue;
      const providerModelKey = key.slice(prefix.length);
      const rate = this.errorRate(stage, providerModelKey);
      if (rate !== undefined && rate >= UNFIT_ERROR_RATE) result.add(providerModelKey);
    }
    return result;
  }

  p50FirstToken(stage: string, providerModelKey: string): number | undefined {
    const latencies = this.slot(stage, providerModelKey)
      .map((attempt) => attempt.firstTokenMs)
      .filter((ms): ms is number => typeof ms === "number")
      .sort((a, b) => a - b);
    if (latencies.length === 0) return undefined;
    return latencies[Math.floor((latencies.length - 1) / 2)];
  }
}
