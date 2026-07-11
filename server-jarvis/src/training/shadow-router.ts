/** Bounded, non-user-visible shadow evaluation.
 *
 * The candidate receives only redacted text and an explicit no-tools request.
 * Its result is comparison metadata; the primary completion is always the user
 * visible answer and candidate failures never fail the live request.
 */

export interface ShadowRequest {
  message: string;
  history?: readonly { role: string; content: string }[];
}

export interface ShadowModelRequest extends ShadowRequest {
  mode: "shadow";
  max_tokens: number;
  tools: readonly [];
}

export interface ShadowCompletion {
  answer: string;
  model?: string;
  latency_ms?: number;
}

export type ShadowRunner = (request: ShadowModelRequest) => Promise<ShadowCompletion>;

export interface ShadowComparison {
  request_id: string;
  candidate_answer?: string;
  candidate_model?: string;
  candidate_error?: string;
  candidate_latency_ms?: number;
  redacted: true;
  tools_executed: 0;
}

export interface ShadowRouteResult {
  user_visible: string;
  comparison: ShadowComparison;
}

export interface ShadowRouteOptions {
  request_id?: string;
  timeout_ms?: number;
  max_tokens?: number;
  onComparison?: (comparison: ShadowComparison) => void | Promise<void>;
}

/** Redact common credentials and contact identifiers before shadow evaluation. */
export function redactShadowText(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]")
    .replace(/\b(?:\+?\d[\d ().-]{8,}\d)\b/g, "[REDACTED_PHONE]");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("shadow_timeout")), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export async function runShadowRoute(
  primary: Promise<ShadowCompletion> | ShadowCompletion,
  candidate: ShadowRunner,
  request: ShadowRequest,
  options: ShadowRouteOptions = {},
): Promise<ShadowRouteResult> {
  const primaryResult = await primary;
  const shadowRequest: ShadowModelRequest = {
    message: redactShadowText(request.message),
    history: request.history?.map((m) => ({ ...m, content: redactShadowText(m.content) })),
    mode: "shadow",
    max_tokens: Math.max(1, Math.min(2048, options.max_tokens ?? 512)),
    tools: [],
  };
  const comparison: ShadowComparison = {
    request_id: options.request_id ?? crypto.randomUUID(),
    redacted: true,
    tools_executed: 0,
  };
  try {
    const candidateResult = await withTimeout(candidate(shadowRequest), options.timeout_ms ?? 3000);
    comparison.candidate_answer = candidateResult.answer;
    comparison.candidate_model = candidateResult.model;
    comparison.candidate_latency_ms = candidateResult.latency_ms;
  } catch (error) {
    comparison.candidate_error = error instanceof Error ? error.message : String(error);
  }
  await options.onComparison?.(comparison);
  return { user_visible: primaryResult.answer, comparison };
}
