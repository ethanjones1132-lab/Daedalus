// ═══════════════════════════════════════════════════════════════
// ── P1-06: Jarvis Tool Runtime Contract ──
// ═══════════════════════════════════════════════════════════════
// One canonical server-side runtime for tool registration, input validation,
// execution, and normalized result envelopes.
//
// All entry surfaces (chat, agent, cron, MCP) execute tools through this
// single contract. Surface variance is carried in ExecutionContext, not
// through separate tool implementations.

import type { JarvisConfig } from "./config";
import { WorkspaceSandboxDeniedError } from "./fs-scope";
import { ToolExecutionError } from "./tool-types";
import type { ToolDefinition, ToolCall, ToolResult, ToolErrorCode } from "./tool-types";
import type { WriteEffectObservation } from "./orchestration/content-fingerprint";

// ── Re-export tool types so callers import from one place ─────────────────────
export type { ToolDefinition, ToolCall, ToolResult };
export { ToolExecutionError };

export const TOOL_TIMEOUT_REASON = "tool_timeout";
const MAX_TOOL_ERROR_CHARS = 12_000;

function boundedToolText(value: string): string {
  if (value.length <= MAX_TOOL_ERROR_CHARS) return value;
  return `${value.slice(0, MAX_TOOL_ERROR_CHARS)}… [truncated]`;
}

function stoppedToolResult(
  call: ToolCall,
  start: number,
  reason: "cancelled" | "timeout",
  timeoutMs?: number,
): ToolResult {
  const message = reason === "timeout"
    ? `Tool execution timed out${timeoutMs !== undefined ? ` after ${timeoutMs}ms` : ""}`
    : "Tool execution cancelled";
  return {
    call_id: call.id,
    name: call.name,
    output: message,
    is_error: true,
    error: message,
    error_code: reason,
    duration_ms: Date.now() - start,
  };
}

interface ExecutionControl {
  signal: AbortSignal;
  reason: () => "cancelled" | "timeout" | undefined;
  cleanup: () => void;
}

function createExecutionControl(ctx: ExecutionContext): ExecutionControl {
  const controller = new AbortController();
  let reason: "cancelled" | "timeout" | undefined;
  const timeoutMs = typeof ctx.timeout_ms === "number" && Number.isFinite(ctx.timeout_ms) && ctx.timeout_ms > 0
    ? Math.max(1, Math.floor(ctx.timeout_ms))
    : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onCallerAbort = (): void => {
    if (reason) return;
    reason = "cancelled";
    controller.abort(ctx.signal?.reason);
  };

  if (ctx.signal) {
    if (ctx.signal.aborted) onCallerAbort();
    else ctx.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      if (reason) return;
      reason = "timeout";
      controller.abort(TOOL_TIMEOUT_REASON);
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    reason: () => reason,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/** Text of a tool result as the model should see it (error text on failure). */
export function toolResultModelText(result: ToolResult): string {
  return result.is_error
    ? (result.error || result.output || "Tool failed with no error detail.")
    : result.output;
}

/**
 * Map full tool definitions to the OpenAI API shape (drops runtime-only flags).
 * Filters out tools marked `text_protocol_only` so they are never sent to
 * native-function-calling models — they remain callable via the text protocol.
 */
export function toApiTools(
  defs: ToolDefinition[],
): Array<Pick<ToolDefinition, "type" | "function">> {
  return defs
    .filter((d) => !d.text_protocol_only)
    .map(({ type, function: fn }) => ({ type, function: fn }));
}

// ── Execution Context ─────────────────────────────────────────────────────────

export interface ExecutionContext {
  /** Which surface is invoking the tool. */
  surface: "chat" | "agent" | "cron" | "mcp";
  /**
   * Whether the surface can prompt the user for approval or clarification.
   * Non-interactive surfaces (cron, agent) must not block on user input.
   */
  interactive: boolean;
  config: JarvisConfig;
  session_id?: string;
  /**
   * Maximum milliseconds this tool invocation may run before being considered
   * timed out. `undefined` means no enforced limit at the runtime layer.
   */
  timeout_ms?: number;
  /**
   * Resolved agents root for this invocation.
   * Absent → callers fall back to `config.agents_root`.
   */
  agents_root?: string;
  /**
   * Workspace boundary path for filesystem tools.
   * Absent → unrestricted (tool's own policy applies).
   */
  workspace_path?: string;
  /** Absolute roots explicitly granted by raw user messages for this Session. */
  session_grants?: string[];
  signal?: AbortSignal;
  /** Pre/post content hashes recorded by filesystem write handlers for effect gating. */
  write_effects?: WriteEffectObservation[];
  /**
   * Optional approval prompt for tools whose policy resolves to "ask".
   * When present, `execute()` awaits it on an "ask" decision and only runs the
   * handler if it resolves `true`. Absent → "ask" falls through (legacy
   * passthrough behavior, used by surfaces that cannot prompt).
   */
  requestApproval?: (req: {
    call_id: string;
    name: string;
    arguments: Record<string, unknown>;
    policy_source: string;
  }) => Promise<boolean>;
  /**
   * When true, bypass the approval gate entirely — all tools are allowed
   * regardless of `requires_approval` or `dangerous` flags. Intended for the
   * orchestrator pipeline which runs autonomously and cannot block on a modal.
   */
  skip_approval_gate?: boolean;
  /**
   * Trusted runtime observation of one completed tool execution. Receives the
   * raw, untruncated result envelope (before any caller context truncation)
   * and must never block or throw into the execution path. Used by the chat
   * stream to record bounded runtime evidence for the native memory receipt.
   */
  onToolResult?: (call: ToolCall, result: ToolResult) => void;
}

/**
 * Build an `ExecutionContext` with documented defaults.
 *
 * Defaults applied automatically:
 * - `interactive` is `true` only for the `"chat"` surface.
 * - `timeout_ms` is `undefined` (no enforced runtime limit).
 * - `agents_root` is `undefined` (consumers fall back to `config.agents_root`).
 * - `workspace_path` is `undefined` (unrestricted).
 *
 * Any field in `overrides` takes precedence over the defaults above.
 */
export function makeExecutionContext(
  surface: ExecutionContext["surface"],
  config: JarvisConfig,
  overrides?: Partial<Omit<ExecutionContext, "surface" | "config">>,
): ExecutionContext {
  return {
    surface,
    interactive: surface === "chat",
    config,
    write_effects: [],
    ...overrides,
  };
}

// ── Handler Type ──────────────────────────────────────────────────────────────

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ExecutionContext,
) => Promise<string>;

// ── Runtime Interface ─────────────────────────────────────────────────────────

export interface ToolRuntime {
  /**
   * Register a tool definition and its handler.
   * Throws if a tool with the same name is already registered.
   */
  register(def: ToolDefinition, handler: ToolHandler): void;

  /**
   * Execute a tool call and return a normalized ToolResult.
   * Never throws — all errors are captured in the result envelope.
   */
  execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResult>;

  /** Return all registered tool definitions. */
  listTools(): ToolDefinition[];
}

// ── Policy Types ──────────────────────────────────────────────────────────────

/**
 * Outcome of a permission policy evaluation.
 *
 * - `"allow"`: execute without restriction.
 * - `"ask"`: interactive surface must obtain user approval before proceeding.
 *   Only returned when `ctx.interactive` and `config.tools.interactive_approval`
 *   are both true.
 * - `"deny"`: execution blocked; a deterministic error is returned to the caller.
 */
export type PolicyDecision = "allow" | "ask" | "deny";

/** Stable machine-readable origin of the policy decision. */
export type PolicySource =
  | "tools_disabled"
  | "approval_non_interactive"
  | "tool_requires_approval"
  | "config_requires_approval"
  | "dangerous_non_interactive"
  | "dangerous_strict"
  | "interactive_approval_off"
  | "safe";

export interface PolicyResult {
  decision: PolicyDecision;
  /** Human-readable reason included in error messages for deny decisions. */
  reason: string;
  /** Machine-readable origin of the decision for audit records. */
  source: PolicySource;
}

// ── Policy Evaluator ──────────────────────────────────────────────────────────

/**
 * Evaluate the permission policy for a tool call before execution.
 *
 * Evaluation order (first matching rule wins):
 * 1. `config.tools.enabled = false` → deny all tools.
 * 2. `dangerous = true` AND `sandbox_mode = 'strict'` AND `!interactive` → deny.
 * 3. Approval required (def flag OR config list) AND `!interactive` → deny.
 * 4. Approval required AND `interactive` AND `interactive_approval = true` -> ask.
 * 5. Approval required AND `interactive` AND `interactive_approval = false` -> allow.
 * 6. `dangerous = true` AND `sandbox_mode = 'strict'` AND `interactive_approval = true` -> ask.
 * 7. Otherwise -> allow.
 */
export function evaluatePolicy(
  def: ToolDefinition,
  ctx: ExecutionContext,
): PolicyResult {
  const { config, interactive } = ctx;
  const toolCfg = config.tools;
  const name = def.function.name;

  if (!toolCfg.enabled) {
    return {
      decision: "deny",
      reason: `Tool execution is disabled in configuration`,
      source: "tools_disabled",
    };
  }

  // Orchestrator / agent surfaces set this to bypass approval modals entirely.
  if (ctx.skip_approval_gate) {
    return { decision: "allow", reason: "", source: "safe" };
  }

  const requiresApproval =
    def.requires_approval || toolCfg.require_approval.includes(name);

  // Dangerous + strict sandbox in non-interactive context: always deny
  if (def.dangerous && toolCfg.sandbox_mode === "strict" && !interactive) {
    return {
      decision: "deny",
      reason: `Tool "${name}" is dangerous and strict sandbox mode denies non-interactive dangerous tool execution`,
      source: "dangerous_non_interactive",
    };
  }

  // Approval-required in non-interactive context: deny (cannot prompt)
  if (requiresApproval && !interactive) {
    return {
      decision: "deny",
      reason: `Tool "${name}" requires approval but execution context is non-interactive`,
      source: "approval_non_interactive",
    };
  }

  // Approval-required in interactive context asks only when the chat surface
  // has explicitly enabled blocking approval. With interactive approval off,
  // Jarvis preserves the legacy passthrough path used by live chat writes.
  if (requiresApproval && interactive && toolCfg.interactive_approval) {
    return {
      decision: "ask",
      reason: `Tool "${name}" requires user approval`,
      source: def.requires_approval ? "tool_requires_approval" : "config_requires_approval",
    };
  }

  // Dangerous + strict + interactive: surface should ask user
  if (def.dangerous && toolCfg.sandbox_mode === "strict" && interactive && toolCfg.interactive_approval) {
    return {
      decision: "ask",
      reason: `Tool "${name}" is dangerous; strict sandbox mode requires user approval`,
      source: "dangerous_strict",
    };
  }

  return { decision: "allow", reason: "", source: "safe" };
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createToolRuntime(): ToolRuntime {
  const registry = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();

  function register(def: ToolDefinition, handler: ToolHandler): void {
    const name = def.function.name;
    if (registry.has(name)) {
      throw new Error(
        `ToolRuntime: tool "${name}" is already registered. Use a unique name.`,
      );
    }
    registry.set(name, { def, handler });
  }

  async function executeCore(call: ToolCall, ctx: ExecutionContext): Promise<ToolResult> {
    const start = Date.now();
    const entry = registry.get(call.name);

    // Unknown tool
    if (!entry) {
      return {
        call_id: call.id,
        name: call.name,
        output: `Unknown tool: ${call.name}`,
        is_error: true,
        error: `Unknown tool: ${call.name}`,
        error_code: "unknown_tool" satisfies ToolErrorCode,
        duration_ms: Date.now() - start,
      };
    }

    // Input validation — check required parameters before invoking handler
    const required: string[] = entry.def.function.parameters?.required ?? [];
    // Models occasionally use this descriptive schema alias for filesystem
    // tools. Canonicalize it before validation so policy, approval, and the
    // handler all see the same arguments. Empty aliases remain invalid.
    const callArguments = { ...call.arguments };
    if (
      required.includes("path") &&
      callArguments.path === undefined &&
      typeof callArguments.relative_workspace_path === "string" &&
      callArguments.relative_workspace_path.trim().length > 0
    ) {
      callArguments.path = callArguments.relative_workspace_path.trim();
    }
    const missingArgs = required.filter(
      (param) => !(param in callArguments) || callArguments[param] === undefined,
    );
    if (missingArgs.length > 0) {
      const msg = `Missing required argument(s) for "${call.name}": ${missingArgs.join(", ")}`;
      return {
        call_id: call.id,
        name: call.name,
        output: msg,
        is_error: true,
        error: msg,
        error_code: "missing_args" satisfies ToolErrorCode,
        duration_ms: Date.now() - start,
      };
    }

    // Permission policy — evaluated after input validation, before handler invocation
    const policy = evaluatePolicy(entry.def, ctx);
    if (policy.decision === "deny") {
      return {
        call_id: call.id,
        name: call.name,
        output: policy.reason,
        is_error: true,
        error: policy.reason,
        error_code: "policy_denied" satisfies ToolErrorCode,
        duration_ms: Date.now() - start,
      };
    }
    // "ask": an approval-required tool. If the caller wired an approval hook,
    // prompt and honor the decision. If NOT, deny — never silently fall through
    // to execution. The old fall-through let an approval-gated write/shell tool
    // run unapproved on any interactive surface that forgot to wire the hook
    // (defense-in-depth; the policy layer already denies these for
    // non-interactive surfaces).
    if (policy.decision === "ask") {
      if (!ctx.requestApproval) {
        const msg = `Tool "${call.name}" requires approval, but this surface cannot prompt for it — denying.`;
        return {
          call_id: call.id,
          name: call.name,
          output: msg,
          is_error: true,
          error: msg,
          error_code: "approval_required" satisfies ToolErrorCode,
          duration_ms: Date.now() - start,
        };
      }
      const approved = await ctx.requestApproval({
        call_id: call.id,
        name: call.name,
        arguments: callArguments,
        policy_source: policy.source,
      });
      if (!approved) {
        const msg = `Tool "${call.name}" was rejected by the user.`;
        return {
          call_id: call.id,
          name: call.name,
          output: msg,
          is_error: true,
          error: msg,
          error_code: "approval_rejected" satisfies ToolErrorCode,
          duration_ms: Date.now() - start,
        };
      }
    }
    if (ctx.signal?.aborted) {
      return stoppedToolResult(call, start, "cancelled");
    }

    const control = createExecutionControl(ctx);
    const executionCtx: ExecutionContext = { ...ctx, signal: control.signal };
    const timeoutMs = typeof ctx.timeout_ms === "number" && Number.isFinite(ctx.timeout_ms) && ctx.timeout_ms > 0
      ? Math.max(1, Math.floor(ctx.timeout_ms))
      : undefined;

    try {
      const initialReason = control.reason();
      if (initialReason) return stoppedToolResult(call, start, initialReason, timeoutMs);

      const output = await entry.handler(callArguments, executionCtx);
      const stopReason = control.reason();
      if (stopReason) return stoppedToolResult(call, start, stopReason, timeoutMs);
      return {
        call_id: call.id,
        name: call.name,
        output,
        is_error: false,
        duration_ms: Date.now() - start,
      };
    } catch (e: any) {
      const stopReason = control.reason();
      if (stopReason) return stoppedToolResult(call, start, stopReason, timeoutMs);
      if (e instanceof WorkspaceSandboxDeniedError) {
        const message = boundedToolText(e.message || "Tool execution failed");
        return {
          call_id: call.id,
          name: call.name,
          output: boundedToolText(`Error: ${message}`),
          is_error: true,
          error: message,
          error_code: (e.forWrite
            ? "non_fixture_write_denied"
            : "workspace_escape_denied") satisfies ToolErrorCode,
          duration_ms: Date.now() - start,
        };
      }
      if (e instanceof ToolExecutionError) {
        const message = boundedToolText(e.message || "Tool execution failed");
        return {
          call_id: call.id,
          name: call.name,
          output: boundedToolText(e.output || `Error: ${message}`),
          is_error: true,
          error: message,
          error_code: e.code,
          duration_ms: Date.now() - start,
        };
      }
      const msg = boundedToolText(e?.message ?? String(e));
      return {
        call_id: call.id,
        name: call.name,
        output: `Error: ${msg}`,
        is_error: true,
        error: msg,
        error_code: "handler_error" satisfies ToolErrorCode,
        duration_ms: Date.now() - start,
      };
    } finally {
      control.cleanup();
    }
  }

  /**
   * Execute through the canonical contract, then publish one trusted
   * observation of the raw result. The observer is deliberately isolated: an
   * observer failure must never change the tool outcome or throw to callers.
   */
  async function execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResult> {
    const result = await executeCore(call, ctx);
    if (ctx.onToolResult) {
      try {
        ctx.onToolResult(call, result);
      } catch {
        // Observation is diagnostics only; never affect execution.
      }
    }
    return result;
  }

  function listTools(): ToolDefinition[] {
    return Array.from(registry.values()).map((entry) => entry.def);
  }

  return { register, execute, listTools };
}
