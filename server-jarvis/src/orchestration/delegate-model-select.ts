/**
 * Slice B — free-first executor model selection for the Claude CLI tool surface.
 *
 * Preference order:
 *   1. Free-capable models (any free provider id that the CLI proxy can host)
 *   2. After thrash (no write / stream error / rate limit × N), cheapest known
 *      capable OpenCode Go models (deepseek-v4-flash, minimax-m3, …)
 *
 * Operator pin: any non-empty, non-"auto" `claude_cli.delegate.model` is used
 * until thrash forces Go promotion (pin still loses after threshold so free
 * thrash cannot stick forever on a broken free id).
 */

export const DELEGATE_FREE_FIRST_MODELS = [
  "deepseek-v4-flash-free",
  "north-mini-code-free",
  "mimo-v2.5-free",
  "nemotron-3-ultra-free",
] as const;

export const DELEGATE_GO_CHEAP_CAPABLE_MODELS = [
  "deepseek-v4-flash",
  "minimax-m3",
  "mimo-v2.5",
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
  if (input.ok && !input.hasVerifiedWrite) return true; // completed without write
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
    code.includes("integration")
  );
}

export function selectDelegateModel(input: {
  configuredModel: string;
  thrashCount: number;
  thrashThreshold?: number;
  freeModels?: readonly string[];
  goModels?: readonly string[];
}): DelegateModelSelection {
  const threshold = input.thrashThreshold ?? DEFAULT_FREE_THRASH_THRESHOLD;
  const free = input.freeModels ?? DELEGATE_FREE_FIRST_MODELS;
  const go = input.goModels ?? DELEGATE_GO_CHEAP_CAPABLE_MODELS;
  const configured = input.configuredModel.trim();
  const auto = !configured || configured.toLowerCase() === "auto";

  if (input.thrashCount >= threshold) {
    const model = go[0] ?? "deepseek-v4-flash";
    return {
      model,
      pool: "go_capable",
      reason: `thrash_promoted_after_${input.thrashCount}`,
      thrashCount: input.thrashCount,
    };
  }

  if (!auto) {
    // Operator pin for the free-first window; thrash still promotes to Go above.
    const pinnedIsGo = go.some((m) => m === configured);
    return {
      model: configured,
      pool: pinnedIsGo ? "go_capable" : "free",
      reason: "operator_pin",
      thrashCount: input.thrashCount,
    };
  }

  // Free-first rotation: cycle free models by thrash count before Go promotion.
  const freeIdx = Math.min(input.thrashCount, Math.max(0, free.length - 1));
  const model = free[freeIdx] ?? free[0] ?? "deepseek-v4-flash-free";
  return {
    model,
    pool: "free",
    reason: input.thrashCount === 0 ? "free_first" : `free_rotate_${input.thrashCount}`,
    thrashCount: input.thrashCount,
  };
}
