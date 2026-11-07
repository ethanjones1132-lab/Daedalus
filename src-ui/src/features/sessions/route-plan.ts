// Session-turn route plan as the Bun server reports it: one `route_attempt`
// frame per settled model attempt while the turn runs, then `result.route`
// as the authoritative summary. This is the single source for the
// "answered by" line and the per-stage trace; nothing here substitutes the
// configured backend for an answer that came from somewhere else.
import { formatInferenceRoute } from '../../domain/chat-state';

export interface RouteAttemptView {
  stage: string;
  provider: string;
  model: string;
  choice: string;
  outcome: string;
  answered: boolean;
  cloud: boolean;
  durationMs: number;
  firstTokenMs?: number;
  fallbackReason?: string;
  error?: string;
}

export interface RoutePlanView {
  answeredBy?: { stage: string; provider: string; model: string; cloud: boolean };
  leftMachine: boolean;
  attempts: RouteAttemptView[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const num = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

/** Decode one attempt from a `route_attempt` frame or a `result.route.attempts` entry. */
export function parseRouteAttempt(raw: unknown): RouteAttemptView | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const stage = text(value.stage);
  const provider = text(value.provider);
  const model = text(value.model);
  if (!stage || !provider || !model) return null;
  return {
    stage,
    provider,
    model,
    choice: text(value.choice) || 'configured',
    outcome: text(value.outcome) || 'unknown',
    answered: value.answered === true,
    cloud: value.cloud === true,
    durationMs: num(value.duration_ms) ?? 0,
    ...(num(value.first_token_ms) !== undefined ? { firstTokenMs: num(value.first_token_ms) } : {}),
    ...(text(value.fallback_reason) ? { fallbackReason: text(value.fallback_reason) } : {}),
    ...(text(value.error) ? { error: text(value.error) } : {}),
  };
}

/** Decode the terminal `result.route` summary. */
export function parseRoutePlan(raw: unknown): RoutePlanView | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const attempts = Array.isArray(value.attempts)
    ? value.attempts.map(parseRouteAttempt).filter((attempt): attempt is RouteAttemptView => attempt !== null)
    : [];
  const answered = value.answered_by && typeof value.answered_by === 'object'
    ? value.answered_by as Record<string, unknown>
    : null;
  const answeredBy = answered && text(answered.stage) && text(answered.provider) && text(answered.model)
    ? { stage: text(answered.stage), provider: text(answered.provider), model: text(answered.model), cloud: answered.cloud === true }
    : undefined;
  return {
    ...(answeredBy ? { answeredBy } : {}),
    leftMachine: value.left_machine === true || attempts.some((attempt) => attempt.cloud),
    attempts,
  };
}

/** Live view before the terminal summary arrives: derived from the attempts so far. */
export function routePlanFromAttempts(attempts: readonly RouteAttemptView[]): RoutePlanView {
  const answered = [...attempts].reverse().find((attempt) => attempt.answered);
  return {
    ...(answered ? { answeredBy: { stage: answered.stage, provider: answered.provider, model: answered.model, cloud: answered.cloud } } : {}),
    leftMachine: attempts.some((attempt) => attempt.cloud),
    attempts: [...attempts],
  };
}

const seconds = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** The one-line route shown under the composer and as the Inspector's Route. */
export function formatAnsweredBy(plan: RoutePlanView): string {
  const where = plan.leftMachine ? 'used a cloud provider' : 'stayed on this PC';
  const fallbacks = plan.attempts.filter((attempt) => attempt.choice === 'fallback').length;
  const extra = fallbacks > 0 ? ` · ${fallbacks} fallback${fallbacks === 1 ? '' : 's'}` : '';
  if (!plan.answeredBy) {
    return plan.attempts.length > 0
      ? `No model answered · ${plan.attempts.length} attempt${plan.attempts.length === 1 ? '' : 's'} · ${where}${extra}`
      : 'No model attempt reported';
  }
  return `Answered by ${formatInferenceRoute(plan.answeredBy.provider, plan.answeredBy.model)} · ${plan.answeredBy.stage} · ${where}${extra}`;
}

/** One trace row per attempt, oldest first, for the Inspector. */
export function formatAttemptLine(attempt: RouteAttemptView): string {
  const parts = [
    `${attempt.stage} · ${formatInferenceRoute(attempt.provider, attempt.model)}${attempt.cloud ? ' (cloud)' : ''}`,
    attempt.answered ? 'answered' : attempt.outcome.replace(/_/g, ' '),
    seconds(attempt.durationMs),
  ];
  if (attempt.firstTokenMs !== undefined) parts.push(`first token ${seconds(attempt.firstTokenMs)}`);
  if (attempt.choice !== 'configured') parts.push(`chosen by ${attempt.choice}`);
  if (attempt.fallbackReason) parts.push(`after ${attempt.fallbackReason.replace(/_/g, ' ')}`);
  if (attempt.error && !attempt.answered) parts.push(attempt.error);
  return parts.join(' · ');
}

/** Plain words for the completion policy's reasons on a non-success turn. */
export function formatTurnReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const known: Record<string, string> = {
    task_plan_open: 'the task plan still has open steps',
    pipeline_partial: 'a stage stopped before it finished',
    pipeline_degraded: 'a stage fell back or degraded',
    pipeline_failed: 'the pipeline failed',
    repetition_detected: 'the answer repeated an earlier one without new evidence',
    verification_failed: 'verification failed',
    write_unverified: 'the write could not be verified',
  };
  return known[reason] ?? reason.replace(/_/g, ' ');
}
