/**
 * M2 — cache-stable prompt assembly and provider cache measurement.
 *
 * Prompt prefix order (keep the first three blocks as stable as possible
 * across turns within a stage):
 *
 *   [runtime facts]
 *     → [tool definitions / text tool instructions]
 *     → [stage system prompt]
 *     → [history]
 *     → [turn]
 *
 * `normalizeMessagesForLLM` later merges consecutive leading system messages
 * into one contiguous system block, so this order becomes a single cacheable
 * token prefix. History/turn grow and may be compacted (tail only) without
 * rewriting the stable head.
 */

export type CacheStableChatMessage = {
  role: string;
  content?: string;
  [key: string]: unknown;
};

export interface AssembleCacheStableMessagesInput {
  /** Stable runtime facts (backend/model identity). */
  runtimeFacts: string;
  /**
   * Text-protocol tool instructions when native tools are unavailable.
   * Native tool schemas travel on `requestBody.tools` and are not part of
   * the message prefix.
   */
  textToolInstructions?: string | null;
  /**
   * Stage-built messages. The first leading `system` message (if any) is the
   * stage system prompt and is lifted into the stable prefix; remaining
   * messages form history + turn.
   */
  stageMessages: readonly CacheStableChatMessage[];
  /**
   * Optional agent-specific directives (T3.2). Appended to the stage system
   * block so they stay after runtime facts + tools.
   */
  agentSystemPromptBlock?: string | null;
}

/**
 * Assemble messages in cache-stable prefix order.
 * Does not mutate the input array or its message objects.
 */
export function assembleCacheStableMessages(
  input: AssembleCacheStableMessagesInput,
): CacheStableChatMessage[] {
  const runtimeFacts = (input.runtimeFacts ?? "").trim();
  const textTools = (input.textToolInstructions ?? "").trim();
  const agentBlock = (input.agentSystemPromptBlock ?? "").trim();

  let stageSystem = "";
  const historyAndTurn: CacheStableChatMessage[] = [];
  let liftedStageSystem = false;

  for (const message of input.stageMessages) {
    if (!liftedStageSystem && message?.role === "system") {
      stageSystem = typeof message.content === "string" ? message.content : "";
      liftedStageSystem = true;
      continue;
    }
    historyAndTurn.push({ ...message });
  }

  if (agentBlock) {
    stageSystem = stageSystem
      ? `${stageSystem}\n\n${agentBlock}`
      : agentBlock;
  }

  const out: CacheStableChatMessage[] = [];
  if (runtimeFacts) {
    out.push({ role: "system", content: runtimeFacts });
  }
  if (textTools) {
    out.push({ role: "system", content: textTools });
  }
  if (stageSystem.trim()) {
    out.push({ role: "system", content: stageSystem });
  }
  out.push(...historyAndTurn);
  return out;
}

/**
 * Best-effort extraction of provider-reported prompt-cache hit tokens.
 * Returns undefined when the provider did not report a cache signal.
 * Never throws — measurement only.
 */
export function extractCachedTokensFromUsage(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;

  const direct = positiveInt(u.cached_tokens)
    ?? positiveInt(u.cache_read_input_tokens)
    ?? positiveInt(u.prompt_cache_hit_tokens)
    ?? positiveInt(u.cache_read_tokens);
  if (direct !== undefined) return direct;

  const details = u.prompt_tokens_details;
  if (details && typeof details === "object") {
    const d = details as Record<string, unknown>;
    const nested = positiveInt(d.cached_tokens)
      ?? positiveInt(d.cache_read_tokens)
      ?? positiveInt(d.cached);
    if (nested !== undefined) return nested;
  }

  const inputDetails = u.input_tokens_details;
  if (inputDetails && typeof inputDetails === "object") {
    const d = inputDetails as Record<string, unknown>;
    const nested = positiveInt(d.cached_tokens) ?? positiveInt(d.cache_read);
    if (nested !== undefined) return nested;
  }

  return undefined;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return undefined;
}

/**
 * Log provider cache signal when present. Non-blocking measurement probe.
 */
export function logCachedTokensProbe(opts: {
  usage: unknown;
  stage?: string;
  model?: string;
  provider?: string;
}): number | undefined {
  const cached = extractCachedTokensFromUsage(opts.usage);
  if (cached === undefined) return undefined;
  const stage = opts.stage ?? "unknown";
  const model = opts.model ?? "unknown";
  const provider = opts.provider ?? "unknown";
  console.log(
    `[prompt-cache] cached_tokens=${cached} stage=${stage} model=${model} provider=${provider}`,
  );
  return cached;
}
