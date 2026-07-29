/**
 * Slice B — free-first executor model selection for the Claude CLI tool surface.
 *
 * Preference order:
 *   1. Free-capable models (proxy path) when the local proxy is up
 *   2. After thrash / no proxy: cheapest capable OpenCode Go models
 *      - OpenAI-format Go (deepseek-v4-flash) when proxy is up
 *      - Anthropic-native Go (minimax-m3) when proxy is down but Go key exists
 *
 * Operator pin: non-empty non-"auto" model is used until thrash forces promotion.
 */

/** OpenAI-format Go models (need proxy for Claude CLI). */
export const DELEGATE_GO_OPENAI_MODELS = [
  "deepseek-v4-flash",
  "mimo-v2.5",
] as const;

/**
 * Mirror of the claude_cli proxy's own model routing
 * (claude_cli_proxy.py::resolve_upstream, verified 2026-07-29):
 *
 *   1. Bare id in get_opencode_go_openai_models() + Go key -> opencode_go (direct)
 *   2. Namespaced "vendor/model[:tag]" + OpenRouter key     -> openrouter
 *   3. Bare Ollama ids / claude-* placeholders              -> ollama
 *
 * Rule 1 matters: DELEGATE_GO_OPENAI_MODELS ("deepseek-v4-flash", "mimo-v2.5")
 * are bare ids that resolve WITHOUT being installed in Ollama, via a
 * different mechanism than rule 3. A bare id that matches neither rule 1 nor
 * an installed Ollama model is unreachable: the proxy sends it to :11434 and
 * gets `{"error":{"message":"model '<id>' not found"}}`, the delegate exits
 * nonzero, and the turn opens with a failed git_metadata call. Through
 * 2026-07-29 every id in DELEGATE_FREE_FIRST_MODELS was a bare OpenCode ZEN
 * id (a different catalog than OpenCode Go) matching neither rule 1 nor any
 * installed Ollama model, so the whole free-first pool 404'd on every write run.
 */
export function isProxyResolvable(
  model: string,
  installedOllamaModels: readonly string[],
  goOpenaiModels: readonly string[] = DELEGATE_GO_OPENAI_MODELS,
): boolean {
  const id = model.trim();
  if (id.length === 0) return false;
  if (goOpenaiModels.includes(id)) return true; // rule 1 — OpenCode Go direct
  if (id.includes("/")) return true;            // rule 2 — OpenRouter
  if (id.startsWith("claude-")) return true;    // rule 3 — proxy default model
  return installedOllamaModels.includes(id);    // rule 3 — must be installed
}

/**
 * Free-tier delegate models, healthiest first.
 *
 * These MUST be namespaced (`vendor/model`) so the proxy routes them to
 * OpenRouter. Bare OpenCode Zen ids are unreachable — see isProxyResolvable.
 */
export const DELEGATE_FREE_FIRST_MODELS = [
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "google/gemma-4-31b-it:free",
] as const;

/** Anthropic-native Go models (skip proxy; need opencode_go key). */
export const DELEGATE_GO_ANTHROPIC_MODELS = [
  "minimax-m3",
  "minimax-m2.7",
] as const;

export const DELEGATE_GO_CHEAP_CAPABLE_MODELS = [
  ...DELEGATE_GO_OPENAI_MODELS,
  ...DELEGATE_GO_ANTHROPIC_MODELS,
] as const;

export const DEFAULT_FREE_THRASH_THRESHOLD = 2;

export type DelegateModelPool = "free" | "go_capable";

export interface DelegateModelSelection {
  model: string;
  pool: DelegateModelPool;
  reason: string;
  thrashCount: number;
}

/** Process-local thrash counters keyed by agent run id (or session). */
const thrashByKey = new Map<string, number>();

export function __resetDelegateThrashForTests(): void {
  thrashByKey.clear();
}

export function getDelegateThrashCount(key: string): number {
  return thrashByKey.get(key) ?? 0;
}

export function recordDelegateThrash(key: string): number {
  const next = (thrashByKey.get(key) ?? 0) + 1;
  thrashByKey.set(key, next);
  return next;
}

export function clearDelegateThrash(key: string): void {
  thrashByKey.delete(key);
}

/**
 * Whether a delegate outcome should count as thrash for free→Go promotion.
 */
export function isDelegateThrashOutcome(input: {
  ok: boolean;
  hasVerifiedWrite: boolean;
  errorCode?: string;
}): boolean {
  if (input.hasVerifiedWrite) return false;
  if (input.ok && !input.hasVerifiedWrite) return true;
  const code = (input.errorCode || "").toLowerCase();
  if (!code) return !input.ok;
  return (
    code.includes("no_write") ||
    code.includes("stream") ||
    code.includes("timeout") ||
    code.includes("rate") ||
    code.includes("spawn") ||
    code.includes("exit") ||
    code.includes("unverified") ||
    code.includes("aborted") ||
    code.includes("integration") ||
    code.includes("unavailable")
  );
}

export function selectDelegateModel(input: {
  configuredModel: string;
  thrashCount: number;
  thrashThreshold?: number;
  /** Local claude_cli_proxy on :19878 (required for free + OpenAI-format Go). */
  proxyAvailable?: boolean;
  /** OpenCode Go API key present (required for Anthropic-native Go). */
  hasOpenCodeGoKey?: boolean;
  freeModels?: readonly string[];
  goOpenaiModels?: readonly string[];
  goAnthropicModels?: readonly string[];
  /** Ollama tags, for resolving bare model ids. Empty means "none installed". */
  installedOllamaModels?: readonly string[];
}): DelegateModelSelection {
  const threshold = input.thrashThreshold ?? DEFAULT_FREE_THRASH_THRESHOLD;
  const free = input.freeModels ?? DELEGATE_FREE_FIRST_MODELS;
  const installed = input.installedOllamaModels ?? [];
  const resolvableFree = free.filter((model) => isProxyResolvable(model, installed));
  const goOpenai = input.goOpenaiModels ?? DELEGATE_GO_OPENAI_MODELS;
  const goAnthropic = input.goAnthropicModels ?? DELEGATE_GO_ANTHROPIC_MODELS;
  const proxyOk = input.proxyAvailable !== false;
  const goKey = input.hasOpenCodeGoKey !== false;
  const configured = input.configuredModel.trim();
  const auto = !configured || configured.toLowerCase() === "auto";
  const thrash = input.thrashCount;

  const pickGo = (reason: string): DelegateModelSelection => {
    // Prefer proxy OpenAI Go when proxy is up; else Anthropic-native Go (no proxy).
    if (proxyOk && goOpenai.length > 0) {
      return {
        model: goOpenai[0],
        pool: "go_capable",
        reason,
        thrashCount: thrash,
      };
    }
    if (goKey && goAnthropic.length > 0) {
      return {
        model: goAnthropic[0],
        pool: "go_capable",
        reason: `${reason}_anthropic_no_proxy`,
        thrashCount: thrash,
      };
    }
    if (goOpenai.length > 0) {
      return { model: goOpenai[0], pool: "go_capable", reason, thrashCount: thrash };
    }
    return {
      model: goAnthropic[0] ?? "minimax-m3",
      pool: "go_capable",
      reason,
      thrashCount: thrash,
    };
  };

  if (thrash >= threshold) {
    return pickGo(`thrash_promoted_after_${thrash}`);
  }

  // No proxy → free/OpenAI Go cannot launch; jump to Anthropic Go if possible.
  if (!proxyOk) {
    if (!auto && configured) {
      // Pinned free/openai model cannot run without proxy → promote.
      return pickGo("no_proxy_promote_go");
    }
    return pickGo("no_proxy_go_first");
  }

  if (!auto) {
    const pinnedIsGo =
      goOpenai.includes(configured as typeof goOpenai[number]) ||
      goAnthropic.includes(configured as typeof goAnthropic[number]);
    return {
      model: configured,
      pool: pinnedIsGo ? "go_capable" : "free",
      reason: "operator_pin",
      thrashCount: thrash,
    };
  }

  // Free-first rotation while under thrash threshold and proxy is up.
  if (resolvableFree.length > 0) {
    const freeIdx = Math.min(thrash, Math.max(0, resolvableFree.length - 1));
    return {
      model: resolvableFree[freeIdx] ?? resolvableFree[0],
      pool: "free",
      reason: thrash === 0 ? "free_first" : `free_rotate_${thrash}`,
      thrashCount: thrash,
    };
  }

  return pickGo("no_free_candidates");
}

/**
 * Build ordered candidate models to try until CLI availability succeeds.
 * Starts at current thrash selection and walks free → Go.
 */
export function enumerateDelegateModelCandidates(input: {
  configuredModel: string;
  thrashCount: number;
  thrashThreshold?: number;
  proxyAvailable?: boolean;
  hasOpenCodeGoKey?: boolean;
}): DelegateModelSelection[] {
  const threshold = input.thrashThreshold ?? DEFAULT_FREE_THRASH_THRESHOLD;
  const maxThrash = Math.max(input.thrashCount, threshold) + 1;
  const seen = new Set<string>();
  const out: DelegateModelSelection[] = [];
  for (let t = input.thrashCount; t <= maxThrash; t++) {
    const sel = selectDelegateModel({ ...input, thrashCount: t });
    if (seen.has(sel.model)) continue;
    seen.add(sel.model);
    out.push(sel);
  }
  // Always ensure an Anthropic Go fallback is last when key exists (no-proxy launch).
  if (input.hasOpenCodeGoKey !== false) {
    for (const model of DELEGATE_GO_ANTHROPIC_MODELS) {
      if (seen.has(model)) continue;
      out.push({
        model,
        pool: "go_capable",
        reason: "anthropic_go_fallback",
        thrashCount: input.thrashCount,
      });
      seen.add(model);
    }
  }
  return out;
}
