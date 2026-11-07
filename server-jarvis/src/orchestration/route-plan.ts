// ═══════════════════════════════════════════════════════════════
// ── Per-turn route plan: who actually answered, and why ──
// ═══════════════════════════════════════════════════════════════
// One record per model attempt, written where every attempt settles (success,
// failure, timeout or stop), so a fallback hop can never be invisible. The
// live `route_attempt` SSE frame and the terminal `result.route` summary are
// both built from it, so the UI's "answered by" line, the per-stage trace and
// the persisted turn all name the same model.
//
// Before this (2026-10-29 audit, finding 1) the only signal was `stage_route`,
// published after an HTTP response with no cause, outcome or timing, and never
// for connection failures, so a local selection could silently fall back to a
// cloud model and the UI kept naming the configured local model.
import { isCloudProvider } from "../provider-availability";

/** How this attempt's model was chosen. */
export type RouteChoice =
  /** The user's selected Inference backend and model. */
  | "configured"
  /** The agent pool picked it for this stage (pin, tier, trial or score). */
  | "pool"
  /** The cheap/strong cascade tier for a simple or scoped route. */
  | "cascade"
  /** A later candidate after an earlier one for the same stage failed. */
  | "fallback";

export interface RouteAttempt {
  stage: string;
  provider: string;
  model: string;
  choice: RouteChoice;
  /** The attempt outcome as the inference metrics record it (success, truncated, timeout, empty, http_error, …). */
  outcome: string;
  /** The attempt delivered a usable answer (success or truncated). */
  answered: boolean;
  /** True when the provider is a third-party cloud service. */
  cloud: boolean;
  duration_ms: number;
  first_token_ms?: number;
  /** Why the previous candidate was abandoned, when this is a fallback. */
  fallback_reason?: string;
  /** Short reason this attempt failed, when it did. */
  error?: string;
}

export interface RoutePlanSummary {
  /** The attempt whose answer the user received, if any. */
  answered_by?: Pick<RouteAttempt, "stage" | "provider" | "model" | "cloud">;
  /** True when any attempt in this turn went to a cloud provider. */
  left_machine: boolean;
  attempts: RouteAttempt[];
}

const ANSWER_STAGES = ["synthesizer", "rewriter", "executor", "agent", "agent_loop"];
const MAX_ATTEMPTS = 64;
const MAX_ERROR_CHARS = 240;

export class RoutePlan {
  private readonly items: RouteAttempt[] = [];

  /** Record one settled attempt. Bounded, and never throws. */
  add(input: Omit<RouteAttempt, "cloud" | "answered"> & { answered?: boolean }): RouteAttempt | undefined {
    if (!input.stage || !input.provider || !input.model) return undefined;
    if (this.items.length >= MAX_ATTEMPTS) return undefined;
    const attempt: RouteAttempt = {
      stage: input.stage,
      provider: input.provider,
      model: input.model,
      choice: input.choice,
      outcome: input.outcome,
      answered: input.answered ?? (input.outcome === "success" || input.outcome === "truncated"),
      cloud: isCloudProvider(input.provider),
      duration_ms: Math.max(0, Math.round(input.duration_ms)),
      ...(Number.isFinite(input.first_token_ms) ? { first_token_ms: Math.max(0, Math.round(input.first_token_ms!)) } : {}),
      ...(input.fallback_reason ? { fallback_reason: input.fallback_reason.slice(0, MAX_ERROR_CHARS) } : {}),
      ...(input.error ? { error: input.error.slice(0, MAX_ERROR_CHARS) } : {}),
    };
    this.items.push(attempt);
    return attempt;
  }

  get attempts(): readonly RouteAttempt[] {
    return this.items;
  }

  /**
   * The model whose words the user read: the last answered attempt of the
   * latest answer-producing stage, else the last answered attempt at all.
   */
  answeredBy(): RouteAttempt | undefined {
    const answered = this.items.filter((attempt) => attempt.answered);
    if (answered.length === 0) return undefined;
    for (let i = answered.length - 1; i >= 0; i--) {
      if (ANSWER_STAGES.includes(answered[i].stage)) return answered[i];
    }
    return answered[answered.length - 1];
  }

  summary(): RoutePlanSummary {
    const answered = this.answeredBy();
    return {
      ...(answered
        ? { answered_by: { stage: answered.stage, provider: answered.provider, model: answered.model, cloud: answered.cloud } }
        : {}),
      left_machine: this.items.some((attempt) => attempt.cloud),
      attempts: [...this.items],
    };
  }
}

/** Live SSE frame for one settled attempt. */
export function routeAttemptSseFrame(sessionId: string, attempt: RouteAttempt): string {
  return `data: ${JSON.stringify({ type: "route_attempt", ...attempt, session_id: sessionId })}\n\n`;
}
