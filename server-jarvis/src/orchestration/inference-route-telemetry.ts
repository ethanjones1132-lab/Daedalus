export interface ActualInferenceRouteTelemetryInput {
  stage?: string;
  provider?: string;
  model?: string;
  firstVisibleTokenMs?: number;
}

export interface ObservedStageRouteSseFrameInput extends ActualInferenceRouteTelemetryInput {
  /** A fetch Response proves that the provider endpoint returned an HTTP response. */
  response: Response;
  sessionId: string;
}

/**
 * Build public route-attribution fields for a live stage-route or terminal
 * metrics frame. Configured defaults are intentionally not substituted here.
 */
export function actualInferenceRouteTelemetry(
  input: ActualInferenceRouteTelemetryInput,
): Record<string, string | number> {
  const telemetry: Record<string, string | number> = {};
  if (input.stage?.trim()) telemetry.stage = input.stage.trim();
  if (input.provider) telemetry.actual_provider = input.provider;
  if (input.model) telemetry.actual_model = input.model;
  if (Number.isFinite(input.firstVisibleTokenMs)) {
    telemetry.first_visible_token_ms = Math.max(0, input.firstVisibleTokenMs!);
  }
  return telemetry;
}

/**
 * Build a live SSE event only after a provider response has been observed and
 * the stage, provider, and model are known. Non-OK responses still count as
 * observations; connection failures never reach this helper.
 */
export function observedStageRouteSseFrame(
  input: ObservedStageRouteSseFrameInput,
): string | null {
  const stage = input.stage?.trim();
  const provider = input.provider?.trim();
  const model = input.model?.trim();
  const sessionId = input.sessionId.trim();
  if (!input.response || !stage || !provider || !model || !sessionId) return null;

  return `data: ${JSON.stringify({
    type: "stage_route",
    ...actualInferenceRouteTelemetry({ stage, provider, model }),
    session_id: sessionId,
  })}\n\n`;
}
