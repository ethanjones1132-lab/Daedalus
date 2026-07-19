export interface ActualInferenceRouteTelemetryInput {
  provider?: string;
  model?: string;
  firstVisibleTokenMs?: number;
}

/**
 * Build the public route-attribution fields for the terminal run metrics frame.
 * These values describe the provider call that actually served the final model
 * stage; configured defaults are intentionally not substituted here.
 */
export function actualInferenceRouteTelemetry(
  input: ActualInferenceRouteTelemetryInput,
): Record<string, string | number> {
  const telemetry: Record<string, string | number> = {};
  if (input.provider) telemetry.actual_provider = input.provider;
  if (input.model) telemetry.actual_model = input.model;
  if (Number.isFinite(input.firstVisibleTokenMs)) {
    telemetry.first_visible_token_ms = Math.max(0, input.firstVisibleTokenMs!);
  }
  return telemetry;
}
