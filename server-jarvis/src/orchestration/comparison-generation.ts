import type { JarvisConfig } from "../config";

export interface ComparisonGenerationSettings {
  max_tokens: number;
  temperature: number;
  top_p: number;
}

/** Return validation messages for a present comparison-only generation policy. */
export function validateComparisonGeneration(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["must be an object with max_tokens, temperature, and top_p"];
  }

  const settings = value as Record<string, unknown>;
  const expectedKeys = ["max_tokens", "temperature", "top_p"];
  const keys = Object.keys(settings);
  const errors: string[] = [];
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(settings, key)) ||
    keys.some((key) => !expectedKeys.includes(key))
  ) {
    errors.push("must contain only max_tokens, temperature, and top_p");
  }

  if (!Number.isFinite(settings.max_tokens) || !Number.isInteger(settings.max_tokens) || (settings.max_tokens as number) < 1 || (settings.max_tokens as number) > 32_768) {
    errors.push("max_tokens must be a finite integer from 1 to 32768");
  }
  if (!Number.isFinite(settings.temperature) || (settings.temperature as number) < 0 || (settings.temperature as number) > 2) {
    errors.push("temperature must be finite and from 0 to 2");
  }
  if (!Number.isFinite(settings.top_p) || (settings.top_p as number) <= 0 || (settings.top_p as number) > 1) {
    errors.push("top_p must be finite and greater than 0 through 1");
  }
  return errors;
}

/**
 * Apply the opt-in measurement policy to a completed generation request body.
 * An absent setting is a no-op; a present malformed setting throws before the
 * caller can send an unmatched request.
 */
export function applyComparisonGeneration(
  body: Record<string, unknown>,
  cfg: Pick<JarvisConfig, "comparison_generation">,
): void {
  if (!Object.prototype.hasOwnProperty.call(cfg, "comparison_generation")) return;

  const settings = cfg.comparison_generation as ComparisonGenerationSettings;
  const errors = validateComparisonGeneration(settings);
  if (errors.length > 0) {
    throw new Error(`Invalid comparison_generation: ${errors.join("; ")}`);
  }

  const options = body.options;
  if (options && typeof options === "object" && !Array.isArray(options)) {
    const ollamaOptions = options as Record<string, unknown>;
    ollamaOptions.num_predict = settings.max_tokens;
    ollamaOptions.temperature = settings.temperature;
    ollamaOptions.top_p = settings.top_p;
    return;
  }

  body.max_tokens = settings.max_tokens;
  body.temperature = settings.temperature;
  body.top_p = settings.top_p;
}
