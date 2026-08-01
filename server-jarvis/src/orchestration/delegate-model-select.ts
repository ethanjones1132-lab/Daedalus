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

/**
 * Free-first is the goal, but a lane that cannot emit a tool call is not a
 * cheap lane — it is a wasted turn plus a fallback.
 *
 * The delegate is the primary write path, so tool-call fidelity is the entire
 * job. Reasoning models emit `<think>` and leave `content` empty, so there is
 * nothing to parse as a tool call (the trap already recorded for MiniMax M3).
 * Live 2026-08-01 (run_d84a937f, run_275068a5): with the reasoning model in
 * this pool, one executor turn produced 7825 output tokens and ZERO tool
 * calls, the delegate's only edit was a no-op (`old_string` === `new_string`),
 * and both delegate stages recorded ok=0 err=1.
 *
 * Listed by EXPLICIT id rather than matched on a substring like "reasoning":
 * a wrong exclusion silently costs a free lane, and re-enabling a model once
 * it supports tools must be deleting one line here — nothing else. Entries
 * stay in DELEGATE_FREE_FIRST_MODELS above so the pool still documents what
 * exists and ordering is unchanged for every capable model.
 */
export const DELEGATE_TOOL_INCAPABLE_MODELS = [
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
] as const;

/** False only for models known to be unable to emit a usable tool call. */
export function isToolCallCapableDelegate(
  model: string,
  incapable: readonly string[] = DELEGATE_TOOL_INCAPABLE_MODELS,
): boolean {
  return !incapable.includes(model.trim());
}

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
/** Default session thrash counter TTL (30 minutes). */
export const DEFAULT_THRASH_TTL_MS = 30 * 60_000;

export type DelegateModelPool = "free" | "go_capable";

export interface DelegateModelSelection {
  model: string;
  pool: DelegateModelPool;
  reason: string;
  thrashCount: number;
}

/** Session-scoped thrash state with expiry for free→Go promotion. */
export interface DelegateThrashState {
  count: number;
  updatedAt: number;
}

/** Process-local thrash counters keyed by session (survives agent-run boundaries). */
const thrashByKey = new Map<string, DelegateThrashState>();

/** Stable thrash key for a session; blank/missing → unknown-session. */
export function delegateThrashKey(sessionId: string): string {
  return sessionId.trim() || "unknown-session";
}

export function __resetDelegateThrashForTests(): void {
  thrashByKey.clear();
}

function thrashStateAt(
  key: string,
  ttlMs: number,
  now: number,
): DelegateThrashState | undefined {
  const state = thrashByKey.get(key);
  if (!state) return undefined;
  if (now - state.updatedAt > ttlMs) {
    thrashByKey.delete(key);
    return undefined;
  }
  return state;
}

export function getDelegateThrashCount(
  key: string,
  ttlMs: number = DEFAULT_THRASH_TTL_MS,
  now: number = Date.now(),
): number {
  return thrashStateAt(key, ttlMs, now)?.count ?? 0;
}

export function recordDelegateThrash(
  key: string,
  ttlMs: number = DEFAULT_THRASH_TTL_MS,
  now: number = Date.now(),
): number {
  const prev = thrashStateAt(key, ttlMs, now);
  const next = (prev?.count ?? 0) + 1;
  thrashByKey.set(key, { count: next, updatedAt: now });
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
    code.includes("handoff") ||
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
  const goOpenai = input.goOpenaiModels ?? DELEGATE_GO_OPENAI_MODELS;
  const goAnthropic = input.goAnthropicModels ?? DELEGATE_GO_ANTHROPIC_MODELS;
  const installed = input.installedOllamaModels ?? [];
  // Two independent reasons a free lane is not actually usable: the proxy
  // cannot route it, or the model cannot emit a tool call. Both cost a whole
  // turn plus a fallback, so both are filtered before free-first ordering.
  const resolvableFree = free.filter((model) =>
    isProxyResolvable(model, installed, goOpenai) && isToolCallCapableDelegate(model));
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
