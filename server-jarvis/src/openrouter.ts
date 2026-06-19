  // Some providers send "data: data: {…}" — strip double prefix
  if (payload.startsWith("data: ")) {
    return parseSSELine(`data: ${payload.slice(6)}`);
  }

  if (!payload) return null;

  try {
    const parsed = JSON.parse(payload);
    return parsed as SSEChunk;
  } catch {
    // Not valid JSON — likely a provider error or half-line
    return null;
  }
}

/**
 * Read an SSE stream and accumulate chunks.
 * Handles partial lines across buffer boundaries and malformed providers.
 */
export async function* streamOpenRouterSSE(
  response: Response,
): AsyncGenerator<SSEChunk, { cost: OpenRouterCostInfo | null; error: OpenRouterError | null }, unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { cost: null, error: { status: 500, code: "no_body", message: "Response body missing" } };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let accumulatedCost: OpenRouterCostInfo | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = parseSSELine(line);
        if (chunk) {
          // Accumulate cost from final usage block
          if (chunk.usage) {
            accumulatedCost = {
              prompt_tokens: chunk.usage.prompt_tokens,
              completion_tokens: chunk.usage.completion_tokens,
              total_tokens: chunk.usage.total_tokens,
              total_cost_usd: chunk.or_cost ?? 0,
              generation_id: chunk.or_id ?? "",
              model: chunk.model ?? "",
            };
          }
          yield chunk;
        }
      }
    }

    // Flush any remaining buffer content
    if (buffer.trim()) {
      const lines = buffer.split("\n").filter(Boolean);
      for (const line of lines) {
        const chunk = parseSSELine(line);
        if (chunk) {
          if (chunk.usage) {
            accumulatedCost = {
              prompt_tokens: chunk.usage.prompt_tokens,
              completion_tokens: chunk.usage.completion_tokens,
              total_tokens: chunk.usage.total_tokens,
              total_cost_usd: chunk.or_cost ?? 0,
              generation_id: chunk.or_id ?? "",
              model: chunk.model ?? "",
            };
          }
          yield chunk;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { cost: accumulatedCost, error: null };
}

// ═══════════════════════════════════════════════════════════════
// Retry / Fallback Logic
// ═══════════════════════════════════════════════════════════════

const RETRY_DELAYS = [1000, 2000, 4000]; // ms exponential backoff
const PREFERRED_FREE_FALLBACKS = [
  "openrouter/free",
  "openrouter/owl-alpha",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "qwen/qwen3-coder:free",
  "openai/gpt-oss-120b:free",
  "meta-llama/llama-3.3-70b-instruct:free",
];

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine if an HTTP status is retryable
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 502 || status === 504;
}

async function resolveFallbackModels(cfg: JarvisConfig): Promise<string[]> {
  const requested = cfg.openrouter.model || "openrouter/free";
  try {
    const catalog = await listOpenRouterModels(cfg);
    const byId = new Map(catalog.map((model) => [model.id, model]));
    const freeCatalogIds = catalog
      .filter((model) => model.is_free && model.id !== requested)