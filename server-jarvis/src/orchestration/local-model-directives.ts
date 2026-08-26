/**
 * Per-model corrective directives for local Ollama models.
 *
 * Hand-authored from confirmed failure modes (file misattribution, confidence
 * without re-test, no-op edit_file). Wired through OrchestratorAgent.system_prompt
 * via localStageAgent and the rollout path (local-call-model).
 *
 * Keep entries short (soft target ≤600 chars; hard cap 4000 at splice).
 */

/** Normalize model id the same way ollama/local-call-model matching does. */
export function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/:latest$/, "");
}

/**
 * Known local-model corrective prompts, keyed by normalized model id
 * (lowercase, no trailing `:latest`).
 */
export const LOCAL_MODEL_DIRECTIVES: Readonly<Record<string, string>> = {
  "qwen3.5-9b-heretic":
    "Before editing a symbol, confirm by reading which file textually contains " +
    "its definition (grep/read the definition site). An import line names a " +
    "module; that is not proof the definition lives in the imported path. " +
    "Do not attribute a symbol to a file from imports alone. " +
    "After editing, run the adjacent test and read its real output. Do not " +
    "report success from reasoning or confidence alone.",

  "qwythos9b-conductor":
    "Before editing a symbol, confirm by reading which file textually contains " +
    "its definition — imports name modules, not necessarily the edit target. " +
    "After editing, run the adjacent test and read its real output. Do not " +
    "report success from reasoning or confidence alone.",

  "ornith-1.0-9b":
    "Before issuing edit_file, verify old_string and new_string actually differ. " +
    "An edit where old_string === new_string reports success and changes nothing. " +
    "Encode the fix you described; never submit a no-op edit.",
};

/** Look up a corrective directive for a local model id, if any. */
export function directiveForModel(modelId: string): string | undefined {
  if (!modelId || typeof modelId !== "string") return undefined;
  const key = normalizeModelId(modelId);
  if (!key) return undefined;
  return LOCAL_MODEL_DIRECTIVES[key];
}
