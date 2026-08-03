/**
 * Per-model observation-learned tool-call format (W3.3).
 *
 * Replaces a provider-level boolean with a process-local record of how each
 * model actually emits tool calls: `native` (OpenAI/Anthropic tool_calls),
 * `text_xml` (`<tool_call>` / bare XML), `dsml` (DeepSeek-style `|DSML|`
 * markup), or `unknown` until observed.
 *
 * Seeds cover models we already know; live turns update the map when
 * `resolveToolCallsFromTurn` (or callers) report a successful format.
 * Persistence is intentionally deferred — process-local is enough for the
 * first cut and for prompt-selection experiments.
 *
 * TODO(W3.4): route by observed no-tool rate using this capability record.
 */

export type ModelToolFormat = "native" | "text_xml" | "dsml" | "unknown";

const formatByModel = new Map<string, ModelToolFormat>();

/** Historical / probe seeds applied when a model has no live observation yet. */
const MODEL_TOOL_FORMAT_SEEDS: ReadonlyArray<{ model: string; format: ModelToolFormat }> = [
  // Anthropic-native OpenCode Go lane (messages API tool_use).
  { model: "minimax-m3", format: "native" },
  { model: "minimax-m2.7", format: "native" },
  // OpenAI-compatible Go flash models.
  { model: "deepseek-v4-flash", format: "native" },
  { model: "mimo-v2.5", format: "native" },
  // Free-pool models historically required text protocols.
  { model: "cohere/north-mini-code:free", format: "text_xml" },
  { model: "google/gemma-4-31b-it:free", format: "text_xml" },
];

function normalizeModelKey(model: string): string {
  return model.trim();
}

/** Apply seeds for any model not already present (merge-only). */
export function seedModelToolFormats(
  seeds: ReadonlyArray<{ model: string; format: ModelToolFormat }> = MODEL_TOOL_FORMAT_SEEDS,
): void {
  for (const seed of seeds) {
    const key = normalizeModelKey(seed.model);
    if (!key || formatByModel.has(key)) continue;
    formatByModel.set(key, seed.format);
  }
}

// Hydrate seeds on first import so getters are useful before any live turn.
seedModelToolFormats();

/**
 * Detect DSML vs `<tool_call>` text dialects from raw model content.
 * Returns null when the text does not clearly match a known text dialect.
 */
export function detectTextToolFormat(text: string): "dsml" | "text_xml" | null {
  if (!text) return null;
  // Fullwidth ｜ (U+FF5C) is used live; normalize so one matcher covers both.
  const normalized = text.replaceAll("\uFF5C", "|");
  if (/<\/?\|DSML\|/i.test(normalized) || /\|DSML\|:/i.test(normalized)) {
    return "dsml";
  }
  if (/<tool_call[\s>]/i.test(text) || /<\/tool_call>/i.test(text)) {
    return "text_xml";
  }
  return null;
}

/** Record (or overwrite) the learned format for a model. Ignores empty / unknown. */
export function recordModelToolFormat(model: string, format: ModelToolFormat): void {
  const key = normalizeModelKey(model);
  if (!key || format === "unknown") return;
  formatByModel.set(key, format);
}

/** Getter for prompt selection and diagnostics. Defaults to `unknown`. */
export function getModelToolFormat(model: string): ModelToolFormat {
  const key = normalizeModelKey(model);
  if (!key) return "unknown";
  return formatByModel.get(key) ?? "unknown";
}

/** Snapshot of every known model → format (seeds + observations). */
export function listModelToolFormats(): ReadonlyArray<{ model: string; format: ModelToolFormat }> {
  return [...formatByModel.entries()]
    .map(([model, format]) => ({ model, format }))
    .sort((a, b) => a.model.localeCompare(b.model));
}

/**
 * Observe a completed turn and update the process-local record when a tool
 * format successfully produced calls.
 *
 * Priority:
 *   1. native tool_calls present → `native`
 *   2. text parse found calls → `dsml` or `text_xml` from content (default text_xml)
 *   3. otherwise leave prior seed / observation unchanged
 */
export function observeModelToolFormatFromTurn(input: {
  model?: string | null;
  nativeCallCount: number;
  fullText?: string;
  textParseFoundCalls: boolean;
}): ModelToolFormat {
  const model = input.model?.trim();
  if (!model) return "unknown";

  if (input.nativeCallCount > 0) {
    recordModelToolFormat(model, "native");
    return "native";
  }

  if (input.textParseFoundCalls) {
    const detected = detectTextToolFormat(input.fullText ?? "");
    const format: ModelToolFormat = detected ?? "text_xml";
    recordModelToolFormat(model, format);
    return format;
  }

  return getModelToolFormat(model);
}

/** Test helper: clear observations and re-apply seeds. */
export function __resetModelToolFormatsForTests(): void {
  formatByModel.clear();
  seedModelToolFormats();
}

/** Test helper: empty map with no seeds (pure observation tests). */
export function __clearModelToolFormatsForTests(): void {
  formatByModel.clear();
}
