// ═══════════════════════════════════════════════════════════════
// Ollama local transport for Phase-D rollouts
// ═══════════════════════════════════════════════════════════════
// Native `/api/chat` only. Production's `/v1/chat/completions` path silently
// discards the entire `options` block (num_ctx, num_gpu, …) and hard-caps at
// the daemon default (4096 when OLLAMA_CONTEXT_LENGTH is unset). Rollouts pin
// num_ctx per request, so they must use the endpoint where that works.
//
// Precedent for body shape (think:false, keep_alive, /api/chat):
// PersistentConductor.callOllamaMessage.

import type { JarvisConfig } from "../../config";
import {
  ollamaBaseUrlCandidates,
  resolveDesiredOllamaModel,
} from "../../ollama";
import {
  normalizeStreamedToolCalls,
  type RawStreamedToolCall,
  type ToolCallWarning,
} from "../../streaming-tool-calls";
import { toApiTools } from "../../tool-runtime";
import type { ToolCall, ToolDefinition } from "../../tool-types";
import type { ChatMessage } from "../../orchestration/coordinator";

/**
 * Same probe as `checkOllamaModelSupportsTools`, but uses the injectable fetch
 * so unit tests never need a live daemon.
 */
async function probeSupportsNativeTools(
  fetchFn: typeof fetch,
  baseUrl: string,
  modelName: string,
): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetchFn(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName }),
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return false;
    const json = (await res.json()) as { capabilities?: string[] };
    return Array.isArray(json.capabilities) && json.capabilities.includes("tools");
  } catch {
    return false;
  }
}

const TARGET_CACHE_TTL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_NUM_CTX = 16_384;
const DEFAULT_KEEP_ALIVE = "30m";

export interface LocalOllamaTarget {
  baseUrl: string;
  model: string;
  supportsNativeTools: boolean;
  installedModels: string[];
}

export interface CallOllamaChatOptions {
  temperature?: number;
  top_p?: number;
  num_ctx?: number;
  num_predict?: number;
  /**
   * Ollama sampler seed (`options.seed`). Same (model, prompt, seed) should
   * yield the same sample path when the daemon honors it — used for CRN
   * fitness evaluation and paired held-out verdicts.
   */
  seed?: number;
  /** Keep the model resident across thousands of rollouts. Default "30m". */
  keep_alive?: string;
  tools?: ToolDefinition[];
  /** When true and tools are provided, include the OpenAI tools block. */
  useNativeTools?: boolean;
  timeoutMs?: number;
  /** Stage-local cancellation — must abort the HTTP request. */
  stageAbort?: AbortSignal;
}

export interface CallOllamaChatResult {
  content: string;
  /** Raw thinking channel. NEVER substituted for empty content. */
  thinking: string;
  tool_calls: ToolCall[];
  warnings: ToolCallWarning[];
  model: string;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface OllamaTransportDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

interface CachedTarget {
  target: LocalOllamaTarget;
  timestamp: number;
}

const targetCache = new Map<string, CachedTarget>();

/** Test seam: clear the 10s target cache between cases. */
export function __resetLocalTargetCacheForTests(): void {
  targetCache.clear();
}

function cacheKey(cfg: JarvisConfig, desiredModel?: string): string {
  return `${cfg.ollama.base_url}|${desiredModel ?? cfg.ollama.model}`;
}

/**
 * Probe candidates → resolve model → capability check.
 * Module-level TTL cache keyed on desired model (mirrors Ollama health TTL).
 */
export async function resolveLocalTarget(
  cfg: JarvisConfig,
  desiredModel?: string,
  deps: OllamaTransportDeps = {},
): Promise<LocalOllamaTarget> {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now?.() ?? Date.now();
  const key = cacheKey(cfg, desiredModel);
  const cached = targetCache.get(key);
  if (cached && now - cached.timestamp < TARGET_CACHE_TTL_MS) {
    return cached.target;
  }

  const tried: string[] = [];
  let lastError: string | undefined;

  for (const baseUrl of ollamaBaseUrlCandidates(cfg.ollama)) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 3000);
      const tagsResp = await fetchFn(`${baseUrl}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timeout);

      if (!tagsResp.ok) {
        tried.push(`${baseUrl} -> HTTP ${tagsResp.status}`);
        continue;
      }

      const tagsJson = (await tagsResp.json()) as {
        models?: Array<{ name?: string; model?: string }>;
      };
      const installedModels = (tagsJson.models || [])
        .map((m) => m.name || m.model || "")
        .filter(Boolean);

      if (installedModels.length === 0) {
        tried.push(`${baseUrl} -> no models`);
        continue;
      }

      const model = resolveDesiredOllamaModel(desiredModel, cfg, installedModels);
      const supportsNativeTools = await probeSupportsNativeTools(fetchFn, baseUrl, model);

      const target: LocalOllamaTarget = {
        baseUrl,
        model,
        supportsNativeTools,
        installedModels,
      };
      targetCache.set(key, { target, timestamp: now });
      return target;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      tried.push(`${baseUrl} -> ${lastError}`);
    }
  }

  throw new Error(
    `Ollama unreachable for local transport` +
      (tried.length ? ` (tried: ${tried.join("; ")})` : "") +
      (lastError ? `: ${lastError}` : ""),
  );
}

function combineAbortSignals(
  timeoutMs: number,
  stageAbort?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  const onStageAbort = () => ctrl.abort();
  if (stageAbort) {
    if (stageAbort.aborted) {
      ctrl.abort();
    } else {
      stageAbort.addEventListener("abort", onStageAbort, { once: true });
    }
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      stageAbort?.removeEventListener("abort", onStageAbort);
    },
  };
}

/**
 * Convert Ollama `/api/chat` tool_calls (arguments may be object or string)
 * into the RawStreamedToolCall shape that normalizeStreamedToolCalls expects.
 */
function toRawStreamedToolCalls(
  raw: unknown,
): RawStreamedToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((tc: any) => {
    const name = tc?.function?.name ?? tc?.name;
    const id = tc?.id;
    const rawArgs = tc?.function?.arguments ?? tc?.arguments;
    let argumentsStr: string | undefined;
    if (typeof rawArgs === "string") {
      argumentsStr = rawArgs;
    } else if (rawArgs && typeof rawArgs === "object") {
      // Native /api/chat returns arguments as an object — stringify so the
      // shared normalizer's JSON.parse path accepts it.
      try {
        argumentsStr = JSON.stringify(rawArgs);
      } catch {
        argumentsStr = "{}";
      }
    } else if (rawArgs === undefined || rawArgs === null) {
      argumentsStr = "";
    } else {
      argumentsStr = String(rawArgs);
    }
    return { id, name, arguments: argumentsStr };
  });
}

/**
 * POST `${baseUrl}/api/chat`. Body mirrors PersistentConductor.callOllamaMessage:
 * stream:false, think:false, keep_alive, options.{num_ctx,num_predict,...}.
 *
 * Never substitutes `thinking` for empty `content` — that leak class was fixed
 * in jarvis-toolcall-leak-rootcause. Empty content stays empty.
 */
export async function callOllamaChat(
  target: LocalOllamaTarget,
  messages: ChatMessage[],
  opts: CallOllamaChatOptions = {},
  deps: OllamaTransportDeps = {},
): Promise<CallOllamaChatResult> {
  const fetchFn = deps.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { signal, cleanup } = combineAbortSignals(timeoutMs, opts.stageAbort);

  const useNative =
    opts.useNativeTools === true &&
    Array.isArray(opts.tools) &&
    opts.tools.length > 0;

  const body: Record<string, unknown> = {
    model: target.model,
    messages,
    stream: false,
    think: false,
    keep_alive: opts.keep_alive ?? DEFAULT_KEEP_ALIVE,
    options: {
      temperature: opts.temperature ?? 0.2,
      top_p: opts.top_p ?? 0.95,
      num_ctx: opts.num_ctx ?? DEFAULT_NUM_CTX,
      num_predict: opts.num_predict ?? 1024,
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    },
  };

  if (useNative) {
    body.tools = toApiTools(opts.tools!);
  }

  try {
    const res = await fetchFn(`${target.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(
        `Ollama /api/chat failed: HTTP ${res.status}` +
          (errBody ? ` — ${errBody.slice(0, 300)}` : ""),
      );
    }

    const json = (await res.json()) as {
      message?: {
        content?: string | null;
        thinking?: string | null;
        tool_calls?: unknown;
      };
      model?: string;
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const message = json.message ?? {};
    // Deliberate: never fill content from thinking.
    const content = typeof message.content === "string" ? message.content : "";
    const thinking = typeof message.thinking === "string" ? message.thinking : "";

    const rawSlots = toRawStreamedToolCalls(message.tool_calls);
    const { calls, warnings } = normalizeStreamedToolCalls(rawSlots);

    return {
      content,
      thinking,
      tool_calls: calls,
      warnings,
      model: json.model || target.model,
      done_reason: json.done_reason,
      prompt_eval_count:
        typeof json.prompt_eval_count === "number" ? json.prompt_eval_count : undefined,
      eval_count: typeof json.eval_count === "number" ? json.eval_count : undefined,
    };
  } finally {
    cleanup();
  }
}

/**
 * Read effective context_length from `/api/ps` (running models).
 * Returns the max context_length among loaded models, or null if none/unreachable.
 */
export async function readOllamaLoadedContextLength(
  baseUrl: string,
  deps: OllamaTransportDeps = {},
): Promise<number | null> {
  const fetchFn = deps.fetch ?? fetch;
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetchFn(`${baseUrl}/api/ps`, { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      models?: Array<{ context_length?: number; size_vram?: number; model?: string }>;
    };
    const lengths = (json.models || [])
      .map((m) => m.context_length)
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0);
    if (lengths.length === 0) return null;
    return Math.max(...lengths);
  } catch {
    return null;
  }
}

/** Probe Ollama version string from `/api/version`, if available. */
export async function readOllamaVersion(
  baseUrl: string,
  deps: OllamaTransportDeps = {},
): Promise<string | null> {
  const fetchFn = deps.fetch ?? fetch;
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetchFn(`${baseUrl}/api/version`, { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: string };
    return typeof json.version === "string" ? json.version : null;
  } catch {
    return null;
  }
}

export const LOCAL_CONTEXT_LENGTH_FLOOR = 16_384;
