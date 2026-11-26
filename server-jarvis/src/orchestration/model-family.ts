/**
 * Model families shared across pool ids and providers. The harness independence
 * rule is about the model the checker reasons with, not the id it was given:
 * `go-deepseek-v4-flash` and `or-deepseek-v4-flash` are the same reviewer.
 *
 * Lives in the orchestration layer (not the harness) because the fallback
 * cascade must apply the same family rule when a caller excludes families.
 */
const MODEL_FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/deepseek/i, "deepseek"],
  [/nemotron/i, "nemotron"],
  [/minimax/i, "minimax"],
  [/mimo/i, "mimo"],
  [/north/i, "north"],
  [/qwen/i, "qwen"],
  [/llama/i, "llama"],
  [/gemma/i, "gemma"],
  [/laguna/i, "laguna"],
  [/inkling/i, "inkling"],
  [/ling/i, "ling"],
  [/mistral|mixtral/i, "mistral"],
  [/claude/i, "claude"],
  [/gemini/i, "gemini"],
  [/gpt|o[1-9](?:-|$)/i, "openai"],
];

/**
 * Resolve a model id to its family. Provider namespaces and free/version
 * decorations are stripped first so the same underlying model shares one
 * family even when it is served by different providers.
 */
export function modelFamily(modelId: string): string {
  const id = modelId.trim().toLowerCase();
  if (!id) return "";
  for (const [pattern, family] of MODEL_FAMILIES) {
    if (pattern.test(id)) return family;
  }
  const bare = id.split(":")[0]!.replace(/^[^/]+\//, "").replace(/[-_]?free$/i, "");
  return bare.split(/[\/\-_.\s]+/).filter(Boolean)[0] ?? bare;
}
