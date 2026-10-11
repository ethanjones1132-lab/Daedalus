import { useCallback, useRef, useState } from 'react';
import {
  decodeDirectives,
  decodeInferenceMetrics,
  decodeReadiness,
  decodeRuntimeHealth,
  type ConductorDirectiveSummary,
  type InferenceMetrics,
  type ReadinessHealth,
  type RuntimeHealth,
} from './health-format';

const BUN_URL = 'http://127.0.0.1:19877';

export interface RuntimeTelemetry {
  inference: InferenceMetrics | null;
  directives: ConductorDirectiveSummary | null;
  runtime: RuntimeHealth | null;
  readiness: ReadinessHealth | null;
}

export interface RuntimeTelemetryState extends RuntimeTelemetry {
  /** A read has completed at least once (so "unavailable" can be said honestly). */
  settled: boolean;
  /** The newest read came back empty everywhere (any values held are from an earlier read). */
  failed: boolean;
  loading: boolean;
}

const EMPTY: RuntimeTelemetryState = {
  inference: null,
  directives: null,
  runtime: null,
  readiness: null,
  settled: false,
  failed: false,
  loading: false,
};

async function getJson<T>(path: string, decode: (value: unknown) => T | null): Promise<T | null> {
  try {
    if (typeof globalThis.fetch !== 'function') return null;
    const response = await globalThis.fetch(`${BUN_URL}${path}`);
    if (!response.ok) return null;
    return decode(await response.json());
  } catch {
    return null;
  }
}

/**
 * The four Bun-server health endpoints (`/health/inference`,
 * `/health/conductor-directives`, `/health`, `/health/readiness`). Each is
 * independent and optional: one that fails reads as `null` (not an empty
 * observation), and the newest request wins. A re-read that fails everywhere
 * keeps the previous values.
 */
export function useRuntimeTelemetry() {
  const [state, setState] = useState<RuntimeTelemetryState>(EMPTY);
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    setState((prev) => ({ ...prev, loading: true }));
    const [inference, directives, runtime, readiness] = await Promise.all([
      getJson('/health/inference', decodeInferenceMetrics),
      getJson('/health/conductor-directives', decodeDirectives),
      getJson('/health', decodeRuntimeHealth),
      getJson('/health/readiness', decodeReadiness),
    ]);
    if (request.current !== id) return;
    setState((prev) => {
      const none = !inference && !directives && !runtime && !readiness;
      return none
        ? { ...prev, settled: true, failed: true, loading: false }
        : { inference, directives, runtime, readiness, settled: true, failed: false, loading: false };
    });
  }, []);

  return { ...state, load };
}
