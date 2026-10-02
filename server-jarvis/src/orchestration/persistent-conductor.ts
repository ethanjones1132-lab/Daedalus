import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { estimateTokens, recordConductorCache } from "./conductor-metrics";
import { loadPrompt } from "./prompt-loader";
import type { ChatMessage, SharedContextHints } from "./coordinator";
import type { ConductorConfig, JarvisConfig } from "../config";
import { SESSIONS_DIR } from "../config";
import {
  resolveClaudeCliLaunchOptions,
  type ClaudeCliAuthMode,
} from "../claude-cli";
import { checkOllamaHealth, ollamaBaseUrlCandidates } from "../ollama";
import { resolveSkillsForConductor } from "../intelligence/skill-resolver";
import { SelfTuningStore, type ConductorOutcomeSummary } from "../self-tuning/store";
import { getPolicyVersionStore } from "../self-tuning/policy-staging";
import {
  getActivePlanItem,
  type TaskPlanGradingMode,
  type TaskPlanItemStatus,
  type TaskRunContract,
  type TaskRunStatus,
} from "./task-run";
import {
  CONDUCTOR_DIRECTIVE_JSON_SCHEMA,
  COORDINATOR_ROUTE_JSON_SCHEMA,
  extractConductorRoutingJson,
  stripGemmaThinkingArtifacts,
  type OllamaChatMessage,
} from "./conductor-routing";
import { parseConductorSessionState, writeJsonAtomic } from "./session-runtime-persistence";

export interface ConductorMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ConductorSessionState {
  sessionId: string;
  turns: number;
  lastOutcome?: string;
  messages: ConductorMessage[];
  lastActiveAt: number;
  /** Increments each routing turn — KV generation counter (Track A). */
  kvGeneration?: number;
  /** Stable hash of the system prompt prefix for cache hit detection. */
  systemPromptHash?: string;
  /** Estimated tokens in the reusable prefix (system + prior turns). */
  cachedPrefixTokens?: number;
  /** Last model used for this session's conductor turns. */
  lastModel?: string;
  /** Set when API fallback was used — next local turn rebuilds prefix safely. */
  apiFallbackUsed?: boolean;
}

export interface ConductorRouteTurnInput {
  sessionId: string;
  request: string;
  turnNumber: number;
  lastOutcome?: string;
  recentHistory?: ChatMessage[];
  sessionMemoryHints?: SharedContextHints;
  signal?: AbortSignal;
}

export interface ConductorRouteTurnResult {
  content: string;
  model: string;
  latencyMs: number;
  usedLocal: true;
  cacheHit: boolean;
  prefixTokensEstimated: number;
  deltaTokensEstimated: number;
  prefixTokensRecomputed: number;
  kvGeneration: number;
}

export interface ConductorSupervisionResult {
  content: string;
  model: string;
  latencyMs: number;
  fallbackUsed: boolean;
}

export interface PersistentConductorErrorOptions {
  status?: number;
  retryable?: boolean;
  code?: string;
}

/**
 * Optional context for {@link PersistentConductor.describeHealth}.
 * Task-plan fields come from SessionMemory (or a bound plan contract);
 * when omitted, ledger fields are null.
 */
export interface DescribeHealthOptions {
  taskRun?: TaskRunContract | null;
  sessionId?: string | null;
}

/**
 * Structured conductor / orchestration health for `/health`, logs, and SSE.
 * Extends the original T1.7 shape with TaskPlan ledger, Claude-CLI delegate
 * backend, and policy-staging version — all snake_case.
 */
export interface ConductorHealthSnapshot {
  /** Slice A: true when the configured resident model is loaded in Ollama. */
  warm?: boolean;
  enabled: boolean;
  available: boolean;
  fallback_to_api: boolean;
  model: string;
  fallback_model: string;
  reason?: string;
  supervision_warning?: string;

  /** Active TaskRun id, or null when no non-terminal task is in view. */
  active_task_run_id: string | null;
  active_task_session_id: string | null;
  active_task_status: TaskRunStatus | null;
  active_task_objective: string | null;
  /** Currently active TaskPlan item (Task 6 ledger). */
  active_plan_item_id: string | null;
  active_plan_item_title: string | null;
  active_plan_item_status: TaskPlanItemStatus | null;
  /**
   * Grading path for the active item:
   * conductor_direct_diff vs reviewer_mediated (null when no active item).
   */
  grading_mode: TaskPlanGradingMode | null;
  /**
   * Repair-cycle count on the active item (Reviewer→Rewriter→Executor chain).
   * null when no active item.
   */
  repair_cycle_count: number | null;

  /**
   * Effective Claude CLI delegate backend in use:
   * proxy | subscription | opencode_go (Anthropic-native OpenCode Go).
   */
  delegate_backend: ClaudeCliAuthMode;
  /** Configured claude_cli.auth_mode before model-based opencode_go projection. */
  delegate_auth_mode: "proxy" | "subscription";
  delegate_model: string | null;

  /** Production policy version number (Task 7), null when none staged. */
  policy_version: number | null;
  policy_version_id: string | null;
  policy_stage: string | null;
  policy_canary_id: string | null;
  policy_canary_version: number | null;
  policy_lkg_id: string | null;
  policy_candidate_id: string | null;
}

export type ConductorReadinessState = "pending" | "warming" | "ready" | "degraded" | "disabled";

/** Cached startup state; reading it never probes Ollama or loads a model. */
export interface ConductorReadinessSnapshot {
  enabled: boolean;
  state: ConductorReadinessState;
  model: string;
  started_at: number | null;
  completed_at: number | null;
  latency_ms: number | null;
  error: string | null;
}

/** Null ledger fields used when no active task is available. */
export function emptyTaskPlanHealthFields(): Pick<
  ConductorHealthSnapshot,
  | "active_task_run_id"
  | "active_task_session_id"
  | "active_task_status"
  | "active_task_objective"
  | "active_plan_item_id"
  | "active_plan_item_title"
  | "active_plan_item_status"
  | "grading_mode"
  | "repair_cycle_count"
> {
  return {
    active_task_run_id: null,
    active_task_session_id: null,
    active_task_status: null,
    active_task_objective: null,
    active_plan_item_id: null,
    active_plan_item_title: null,
    active_plan_item_status: null,
    grading_mode: null,
    repair_cycle_count: null,
  };
}

/**
 * Infer which grading path is currently active for a plan item.
 * Prefer an explicit gradingMode (set on verify); otherwise repair cycles and
 * acceptance checks imply reviewer mediation; low complexity defaults to
 * conductor-direct.
 */
export function resolveActiveGradingMode(
  item: {
    gradingMode?: TaskPlanGradingMode;
    repairCycleCount?: number;
    acceptanceChecks?: Array<{ kind?: string }>;
  },
  estimatedComplexity?: "low" | "medium" | "high",
): TaskPlanGradingMode {
  if (item.gradingMode) return item.gradingMode;
  if ((item.repairCycleCount ?? 0) > 0) return "reviewer_mediated";
  if (item.acceptanceChecks?.some((c) => c.kind === "reviewer_pass")) {
    return "reviewer_mediated";
  }
  if (estimatedComplexity === "medium" || estimatedComplexity === "high") {
    return "reviewer_mediated";
  }
  return "conductor_direct_diff";
}

/**
 * Pure TaskPlan ledger slice for the health surface.
 * Graceful nulls when no active / non-terminal task is provided.
 */
export function taskPlanHealthFields(
  taskRun?: TaskRunContract | null,
  sessionId?: string | null,
): ReturnType<typeof emptyTaskPlanHealthFields> {
  if (!taskRun) return emptyTaskPlanHealthFields();
  if (["completed", "failed", "cancelled"].includes(taskRun.status)) {
    return emptyTaskPlanHealthFields();
  }

  const active = getActivePlanItem(taskRun);
  return {
    active_task_run_id: taskRun.taskRunId,
    active_task_session_id: sessionId ?? taskRun.sessionId ?? null,
    active_task_status: taskRun.status,
    active_task_objective: taskRun.objective || null,
    active_plan_item_id: active?.id ?? taskRun.plan?.activeItemId ?? null,
    active_plan_item_title: active?.title ?? null,
    active_plan_item_status: active?.status ?? null,
    grading_mode: active
      ? resolveActiveGradingMode(active, taskRun.estimatedComplexity)
      : null,
    repair_cycle_count: active ? (active.repairCycleCount ?? 0) : null,
  };
}

/** Policy staging (Task 7) fields for the health surface. */
export function policyStagingHealthFields(): Pick<
  ConductorHealthSnapshot,
  | "policy_version"
  | "policy_version_id"
  | "policy_stage"
  | "policy_canary_id"
  | "policy_canary_version"
  | "policy_lkg_id"
  | "policy_candidate_id"
> {
  const store = getPolicyVersionStore();
  const production = store.production;
  return {
    policy_version: production?.version ?? null,
    policy_version_id: production?.id ?? null,
    policy_stage: production?.stage ?? null,
    policy_canary_id: store.canary?.id ?? null,
    policy_canary_version: store.canary?.version ?? null,
    policy_lkg_id: store.lastKnownGood?.id ?? null,
    policy_candidate_id: store.candidate?.id ?? null,
  };
}

/** Claude CLI delegate backend fields (Task 1 launch modes). */
export function delegateBackendHealthFields(cfg: JarvisConfig): Pick<
  ConductorHealthSnapshot,
  "delegate_backend" | "delegate_auth_mode" | "delegate_model"
> {
  const authMode = cfg.claude_cli?.auth_mode === "subscription" ? "subscription" : "proxy";
  const model = cfg.claude_cli?.delegate?.model?.trim() || "";
  const launch = resolveClaudeCliLaunchOptions({
    authMode,
    modelId: model,
    opencodeGoApiKey: cfg.opencode_go?.api_key,
    opencodeGoBaseUrl: cfg.opencode_go?.base_url,
  });
  return {
    delegate_backend: launch.authMode,
    delegate_auth_mode: authMode,
    delegate_model: model || null,
  };
}

export class PersistentConductorError extends Error {
  readonly status?: number;
  readonly retryable?: boolean;
  readonly code?: string;

  constructor(message: string, options: PersistentConductorErrorOptions = {}) {
    super(message);
    this.name = "PersistentConductorError";
    this.status = options.status;
    this.retryable = options.retryable;
    this.code = options.code;
  }
}

interface ResolvedConductorTarget {
  baseUrl: string;
  model: string;
  backend: "ollama" | "llama_cpp";
}

/**
 * Resident-model listing returned by the local runtime: Ollama `/api/ps`
 * reports `models[].name|model`; llama.cpp's OpenAI-compatible `/v1/models`
 * reports `data[].id`.
 */
interface LoadedModelsResponse {
  models?: Array<{ name?: string; model?: string }>;
  data?: Array<{ id?: string }>;
}

export interface ConductorTimerApi {
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
}

let cachedTarget: ResolvedConductorTarget | null = null;
let cachedTargetKey = "";
let cachedTargetAt = 0;
const TARGET_CACHE_TTL_MS = 10_000;
const TARGET_RUNTIME_FAILURE_TTL_MS = 5 * 60_000;
const RUNTIME_HEALTH_FAILURE_TTL_MS = 30_000;
const runtimeFailedTargets = new Map<string, number>();

/** F7: warm routing must fail fast before API fallback takes over. */
export const ROUTING_TIMEOUT_MS = 20_000;

export function __resetPersistentConductorCachesForTests(): void {
  cachedTarget = null;
  cachedTargetKey = "";
  cachedTargetAt = 0;
  runtimeFailedTargets.clear();
}

function cleanOllamaBaseUrl(url: string): string {
  return url.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

function sessionFilePath(sessionId: string, sessionsRoot = SESSIONS_DIR): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(sessionsRoot, "conductor", `${safe}.json`);
}

function modelAvailable(models: string[], requested: string): boolean {
  if (models.includes(requested)) return true;
  const [base, tag = "latest"] = requested.split(":");
  if (tag !== "latest") {
    return models.includes(`${base}:latest`) || models.includes(base);
  }
  return models.includes(base) || models.includes(`${base}:latest`);
}

function conductorModelCandidates(conductor: ConductorConfig): string[] {
  return Array.from(new Set([conductor.model, conductor.fallback_model].filter(Boolean)));
}

function formatRecentHistory(history: ChatMessage[] | undefined): string {
  if (!history || history.length === 0) return "Recent session history: none";
  const lines = history
    .slice(-8)
    .map((m) => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 1200)}${m.content.length > 1200 ? "..." : ""}`)
    .join("\n");
  return `Recent session history:\n${lines}`;
}

function truncateContextText(text: string, maxTokens: number): string {
  const maxChars = Math.max(1_000, Math.floor(maxTokens * 4));
  if (text.length <= maxChars) return text;
  const marker = "\n[shared context truncated by runtime]\n";
  return `${text.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

function formatSessionMemoryHints(hints?: SharedContextHints, maxTokens = 2_048): string {
  if (!hints) return "Session shared memory: none";
  const blocks: string[] = ["Session shared memory:"];

  if (hints.relevant_memories?.length) {
    blocks.push(
      "Relevant memories:\n" +
      hints.relevant_memories.map((m) => `- ${m}`).join("\n"),
    );
  }
  if (hints.failure_patterns?.length) {
    blocks.push(
      "Known failure patterns:\n" +
      hints.failure_patterns.map((p) => `- ${p}`).join("\n"),
    );
  }
  const cached = hints.prior_tool_results ?? {};
  // Keep the most recent bounded set. The full cache is still available to
  // the executor; the local conductor only needs enough context to choose the
  // next stage without silently exceeding Ollama's context window.
  const entries = Object.entries(cached).slice(-24);
  if (entries.length > 0) {
    blocks.push(
      "Cached tool results:\n" +
      entries.map(([key, value]) => `### ${key}\n${value}`).join("\n\n"),
    );
  }

  return blocks.length > 1
    ? truncateContextText(blocks.join("\n\n"), maxTokens)
    : "Session shared memory: none";
}

function hashText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function estimateMessageTokens(messages: ConductorMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name} ${error.message}` : String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const message = typeof signal.reason === "string" ? signal.reason : "Turn aborted";
  const error = new Error(message);
  error.name = "AbortError";
  throw error;
}

function isAbortOrTimeoutError(error: unknown): boolean {
  const text = errorText(error);
  return /\bAbortError\b|\bTimeoutError\b|aborted|timed?\s*out|timeout|first-token timeout|stream idle timeout|visible-progress timeout/i.test(text);
}

function isRetryableRuntimeFailure(error: unknown): boolean {
  if (isAbortOrTimeoutError(error)) return false;
  if (error instanceof PersistentConductorError && typeof error.retryable === "boolean") {
    return error.retryable;
  }
  const text = errorText(error);
  return /HTTP 5\d\d|runner|failed to load|load failed|unavailable|ECONNRESET|ECONNREFUSED/i.test(text);
}

/**
 * D4 (organism loop v1): compact hint of promoted skills relevant to this
 * turn, resolved WITHOUT knowing task_type (routing hasn't happened yet —
 * see `resolveSkillsForConductor`). Returns "" when nothing matches, which
 * `buildTurnUserContent`'s `.filter(Boolean)` drops entirely — an unmatched
 * turn is byte-identical to the pre-D4 output. Rides the per-turn user
 * delta, never the KV-cache-guarded system prompt (A-02).
 */
function formatSkillHint(request: string): string {
  const hint = resolveSkillsForConductor(request);
  if (!hint.trim()) return "";
  return `Promoted skills relevant to this turn:\n${hint}`;
}

function formatPipelineShape(shape: string): string {
  try {
    const parsed = JSON.parse(shape);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((stage): stage is string => typeof stage === "string" && stage.length > 0)
        .map((stage) => stage.replace(/^re-enter:/, ""))
        .join(" > ") || "empty";
    }
  } catch {
    // Keep a malformed historical row bounded and visible rather than hiding
    // the fact that the stored shape could not be parsed.
  }
  return shape.slice(0, 120) || "unknown";
}

function formatRecentOutcomeHint(summaries: ConductorOutcomeSummary[]): string {
  if (summaries.length === 0) return "";
  const lines = summaries.slice(0, 3).map((summary) => {
    const rate = Math.round(Math.max(0, Math.min(1, Number(summary.success_rate) || 0)) * 100);
    return `- ${summary.task_type} | ${formatPipelineShape(summary.pipeline_shape)} | ${rate}% success (${summary.sample_count} runs)`;
  });
  return `Recent conductor outcomes by task and pipeline (last 7 days):\n${lines.join("\n")}`;
}

function buildTurnUserContent(
  input: ConductorRouteTurnInput,
  memoryBudgetTokens = 2_048,
  recentOutcomeHint = "",
): string {
  return [
    `Session ID: ${input.sessionId}`,
    `Coordinator turn: ${input.turnNumber}`,
    `Last outcome: ${input.lastOutcome ?? "none"}`,
    formatSessionMemoryHints(input.sessionMemoryHints, memoryBudgetTokens),
    formatRecentHistory(input.recentHistory),
    formatSkillHint(input.request),
    recentOutcomeHint,
    `Current request:\n${input.request}`,
  ].filter(Boolean).join("\n\n");
}

export class PersistentConductor {
  private static readonly MAX_SESSIONS = 256;
  private sessions = new Map<string, ConductorSessionState>();
  private keepWarmTimer: ReturnType<typeof setInterval> | null = null;
  private keepWarmInFlight: Promise<void> | null = null;
  private lastWarmRenewedAt = 0;
  private readinessState: ConductorReadinessState = "pending";
  private readinessStartedAt: number | null = null;
  private readinessCompletedAt: number | null = null;
  private readinessLatencyMs: number | null = null;
  private readinessError: string | null = null;
  private lastRuntimeFailureAt = 0;
  private lastRuntimeFailureMessage = "";
  private lastSupervisionFailureAt = 0;
  private lastSupervisionFailureMessage = "";

  constructor(
    private getConfig: () => JarvisConfig,
    private sessionsRoot: string = SESSIONS_DIR,
    private readonly outcomeStore: SelfTuningStore = new SelfTuningStore(),
    private readonly timers: ConductorTimerApi = globalThis,
  ) {}

  private config(): ConductorConfig {
    return this.getConfig().orchestrator.conductor;
  }

  readinessSnapshot(): ConductorReadinessSnapshot {
    const conductor = this.config();
    return {
      enabled: conductor.enabled,
      state: conductor.enabled ? this.readinessState : "disabled",
      model: conductor.model,
      started_at: this.readinessStartedAt,
      completed_at: this.readinessCompletedAt,
      latency_ms: this.readinessLatencyMs,
      error: conductor.enabled ? this.readinessError : null,
    };
  }

  private ollamaConfig() {
    const cfg = this.getConfig();
    const conductor = this.config();
    return {
      ...cfg.ollama,
      base_url: conductor.base_url?.trim() || cfg.ollama.base_url,
      model: conductor.model,
    };
  }

  private llamaCppBaseUrl(): string {
    const cfg = this.getConfig();
    return (this.config().base_url?.trim() || cfg.llama_cpp.base_url).replace(/\/+$/, "");
  }

  async isAvailable(): Promise<boolean> {
    if (!this.config().enabled) return false;
    if (this.hasRecentRuntimeFailure()) return false;
    const conductor = this.config();
    if (conductor.kv_backend === "llama_cpp") {
      try {
        const response = await fetch(`${this.llamaCppBaseUrl()}/models`, { signal: AbortSignal.timeout(3_000) });
        if (!response.ok) return false;
        const body = await response.json() as { data?: Array<{ id?: string }> };
        const models = (body.data ?? []).map((item) => item.id ?? "").filter(Boolean);
        return models.length > 0 && modelAvailable(models, conductor.model);
      } catch {
        return false;
      }
    }
    for (const model of conductorModelCandidates(conductor)) {
      const health = await checkOllamaHealth({ ...this.ollamaConfig(), model });
      if (health.running && health.modelAvailable) return true;
    }
    return false;
  }

  shouldFallbackToApi(): boolean {
    return this.config().fallback_to_api;
  }

  startKeepWarm(): void {
    const conductor = this.config();
    if (!conductor.enabled || !conductor.keep_warm) return;
    if (this.keepWarmTimer) return;

    const intervalMs = this.keepWarmIntervalMs();
    this.keepWarmTimer = setInterval(() => {
      void this.keepWarmIfDue(intervalMs);
    }, intervalMs);
    const timerWithUnref = this.keepWarmTimer as ReturnType<typeof setInterval> & { unref?: () => void };
    timerWithUnref.unref?.();
  }

  stopKeepWarm(): void {
    if (!this.keepWarmTimer) return;
    clearInterval(this.keepWarmTimer);
    this.keepWarmTimer = null;
  }

  async isWarm(timeoutMs = 2_500): Promise<boolean> {
    if (!this.config().enabled) return true;
    const target = await this.resolveTarget().catch(() => null);
    if (!target) return true;
    return this.isTargetWarm(target, timeoutMs);
  }

  /**
   * T1.7 + Task 8: structured health for logs, /health JSON, and per-turn
   * conductor_health SSE frames when config says enabled but we fell back.
   *
   * Core conductor fields (model / fallback_model / reason) keep their
   * existing snake_case names. New fields: active TaskPlan item, grading
   * mode, repair-cycle count, Claude-CLI delegate backend, policy version.
   * Ledger fields are null when no active task is supplied.
   */
  async describeHealth(options: DescribeHealthOptions = {}): Promise<ConductorHealthSnapshot> {
    const jarvisCfg = this.getConfig();
    const conductor = this.config();
    const extras = {
      ...taskPlanHealthFields(options.taskRun, options.sessionId),
      ...delegateBackendHealthFields(jarvisCfg),
      ...policyStagingHealthFields(),
    };

    if (!conductor.enabled) {
      return {
        enabled: false,
        available: false,
        warm: false,
        fallback_to_api: conductor.fallback_to_api,
        model: conductor.model,
        fallback_model: conductor.fallback_model,
        reason: "disabled",
        ...extras,
      };
    }
    try {
      const available = await this.isAvailable();
      const warm = available ? await this.isWarm(2_500) : false;
      return {
        enabled: true,
        available,
        warm,
        fallback_to_api: conductor.fallback_to_api,
        model: conductor.model,
        fallback_model: conductor.fallback_model,
        reason: available
          ? undefined
          : this.hasRecentRuntimeFailure()
            ? `recent_runtime_failure: ${this.lastRuntimeFailureMessage}`
          : conductor.kv_backend === "llama_cpp" ? "llama_cpp_unavailable_or_model_missing" : "ollama_unavailable_or_model_missing",
        supervision_warning: this.recentSupervisionWarning(),
        ...extras,
      };
    } catch (e) {
      return {
        enabled: true,
        available: false,
        warm: false,
        fallback_to_api: conductor.fallback_to_api,
        model: conductor.model,
        fallback_model: conductor.fallback_model,
        reason: e instanceof Error ? e.message : String(e),
        supervision_warning: this.recentSupervisionWarning(),
        ...extras,
      };
    }
  }

  async routeTurn(input: ConductorRouteTurnInput): Promise<ConductorRouteTurnResult> {
    throwIfAborted(input.signal);
    if (!this.config().enabled) {
      throw new PersistentConductorError("Persistent conductor is disabled");
    }

    const primary = await this.resolveTarget();
    let target = await this.resolveWarmInferenceTarget(primary);
    if (!target) {
      // Slice A: first-route waits for a bounded warm instead of immediately
      // aborting to deterministic routing (live canary: ~50s cold load).
      try {
        await this.warmUp(90_000);
        target = (await this.resolveWarmInferenceTarget(primary)) ?? primary;
      } catch (error) {
        void this.warmUp().catch((warmError) => {
          console.warn(
            `[PersistentConductor] background warm after cold_start_warming failed: ${
              warmError instanceof Error ? warmError.message : String(warmError)
            }`,
          );
        });
        throw new PersistentConductorError(
          error instanceof Error ? error.message : "cold_start_warming",
          { code: "cold_start_warming", retryable: true },
        );
      }
    }
    throwIfAborted(input.signal);

    const session = this.getSession(input.sessionId);
    const recentOutcomeHint = formatRecentOutcomeHint(
      this.outcomeStore.getRecentConductorOutcomeSummaries(7, 3),
    );
    const userContent = buildTurnUserContent(
      input,
      Math.floor(this.config().num_ctx * 0.25),
      recentOutcomeHint,
    );
    const systemPrompt = loadPrompt("coordinator.md");
    const systemHash = hashText(systemPrompt);
    const candidateMessages = session.messages.map((message) => ({ ...message }));

    const hadSystem = candidateMessages.some((m) => m.role === "system");
    const rebuiltPrefix = !hadSystem || session.apiFallbackUsed || session.systemPromptHash !== systemHash;
    if (rebuiltPrefix) {
      const existingSystemIdx = candidateMessages.findIndex((m) => m.role === "system");
      if (existingSystemIdx >= 0) {
        candidateMessages[existingSystemIdx] = { role: "system", content: systemPrompt };
      } else {
        candidateMessages.unshift({ role: "system", content: systemPrompt });
      }
    }

    const prefixTokensBefore = estimateMessageTokens(candidateMessages);
    const cacheHit = hadSystem && !rebuiltPrefix && session.kvGeneration !== undefined && session.kvGeneration > 0
      && session.systemPromptHash === systemHash;
    const nextKvGeneration = (session.kvGeneration ?? 0) + 1;
    candidateMessages.push({ role: "user", content: userContent });
    const deltaTokens = estimateTokens(userContent);

    const start = Date.now();
    let content: string;
    let ok = true;
    try {
      const routed = await this.withRuntimeFallback(target, (candidate) =>
        this.callOllamaChat(candidate, candidateMessages, input.signal));
      target = routed.target;
      content = routed.value;
      throwIfAborted(input.signal);
      this.lastWarmRenewedAt = Date.now();
      this.readinessState = "ready";
      this.readinessCompletedAt = Date.now();
      this.readinessError = null;
      this.clearRuntimeFailure();
    } catch (e) {
      ok = false;
      if (input.signal?.aborted) throwIfAborted(input.signal);
      this.recordRuntimeFailure(e);
      throw e;
    }
    const latencyMs = Date.now() - start;

    candidateMessages.push({ role: "assistant", content });
    const nextSession: ConductorSessionState = {
      ...session,
      messages: candidateMessages,
      turns: input.turnNumber,
      lastOutcome: input.lastOutcome,
      lastActiveAt: Date.now(),
      lastModel: target.model,
      cachedPrefixTokens: prefixTokensBefore,
      kvGeneration: nextKvGeneration,
      ...(rebuiltPrefix ? { systemPromptHash: systemHash, apiFallbackUsed: false } : {}),
    };

    const prefixRecomputed = cacheHit ? 0 : prefixTokensBefore;
    recordConductorCache({
      ts: Date.now(),
      session_id: input.sessionId,
      turn_number: input.turnNumber,
      model: target.model,
      latency_ms: latencyMs,
      ok,
      conductor_cache_hit: cacheHit,
      prefix_tokens_estimated: prefixTokensBefore,
      delta_tokens_estimated: deltaTokens + estimateTokens(content),
      prefix_tokens_recomputed: prefixRecomputed,
      kv_generation: nextKvGeneration,
    });

    this.pruneSessionMessages(nextSession);
    if (!input.signal?.aborted) {
      Object.assign(session, nextSession);
      this.persistSession(session);
      this.touchSession(input.sessionId, session);
    }

    return {
      content,
      model: target.model,
      latencyMs,
      usedLocal: true,
      cacheHit,
      prefixTokensEstimated: prefixTokensBefore,
      deltaTokensEstimated: deltaTokens + estimateTokens(content),
      prefixTokensRecomputed: prefixRecomputed,
      kvGeneration: nextKvGeneration,
    };
  }

  /** Run a compact post-stage directive on the same local model as routing. */
  async supervise(messages: ConductorMessage[], timeoutMs = 5_000): Promise<ConductorSupervisionResult> {
    if (!this.config().enabled) {
      throw new PersistentConductorError("Persistent conductor is disabled");
    }
    // Prefer the resident conductor candidate. During a delegate write turn the
    // fallback_model is already loaded; supervising through it avoids forcing a
    // reload of the evicted primary (which would in turn evict the delegate).
    const primary = await this.resolveTarget();
    let target = (await this.resolveWarmInferenceTarget(primary)) ?? primary;
    const startedAt = Date.now();
    let supervised: { target: ResolvedConductorTarget; value: OllamaChatMessage };
    try {
      supervised = await this.withRuntimeFallback(target, (candidate) =>
        this.callOllamaMessage(candidate, messages, {
          format: CONDUCTOR_DIRECTIVE_JSON_SCHEMA,
          numPredict: 160,
          timeoutMs,
          temperature: 0.1,
        }));
    } catch (error) {
      // Supervision is advisory. A slow/aborted post-stage check must not
      // poison the route-health circuit breaker for the next user turn.
      this.recordSupervisionFailure(error);
      throw error;
    }
    target = supervised.target;
    const message = supervised.value;
    const content = stripGemmaThinkingArtifacts(message.content ?? "");
    if (!content) throw new PersistentConductorError("Local conductor returned empty supervision output");
    this.clearSupervisionFailure();
    return {
      content,
      model: target.model,
      latencyMs: Date.now() - startedAt,
      fallbackUsed: target.model !== this.config().model,
    };
  }

  /** Load and retain the configured conductor model before the first user turn. */
  async warmUp(timeoutMs = 90_000): Promise<{ model: string; latencyMs: number }> {
    if (!this.config().enabled) {
      this.readinessState = "disabled";
      this.readinessCompletedAt = Date.now();
      this.readinessError = null;
      throw new PersistentConductorError("Persistent conductor is disabled");
    }
    const startedAt = Date.now();
    this.readinessState = "warming";
    this.readinessStartedAt = startedAt;
    this.readinessCompletedAt = null;
    this.readinessLatencyMs = null;
    this.readinessError = null;

    let target: ResolvedConductorTarget | undefined;
    let timeout: ReturnType<ConductorTimerApi["setTimeout"]> | undefined;
    try {
      target = await this.resolveTarget();
      const controller = new AbortController();
      timeout = this.timers.setTimeout(() => controller.abort(), timeoutMs);
      const warmupResponse = target.backend === "llama_cpp"
        ? await fetch(`${target.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: target.model,
              messages: [
                { role: "system", content: loadPrompt("coordinator.md") },
                { role: "user", content: "Return a single short readiness response." },
              ],
              stream: false,
              max_tokens: Math.max(4_096, this.config().max_tokens),
              temperature: 0,
              cache_prompt: true,
            }),
            signal: controller.signal,
          })
        : await fetch(`${target.baseUrl}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: target.model,
              prompt: "",
              stream: false,
              keep_alive: "30m",
              options: {
                num_predict: 1,
                num_ctx: this.config().num_ctx,
              },
            }),
            signal: controller.signal,
          });
      const res = warmupResponse;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new PersistentConductorError(
          `Local conductor warm-up failed: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`,
        );
      }
      await res.json().catch(() => ({}));
      const latencyMs = Date.now() - startedAt;
      this.lastWarmRenewedAt = Date.now();
      this.readinessState = "ready";
      this.readinessCompletedAt = Date.now();
      this.readinessLatencyMs = latencyMs;
      this.readinessError = null;
      this.clearRuntimeFailure();
      return { model: target.model, latencyMs };
    } catch (error) {
      this.readinessState = "degraded";
      this.readinessCompletedAt = Date.now();
      this.readinessLatencyMs = Date.now() - startedAt;
      this.readinessError = errorText(error).slice(0, 240);
      this.recordRuntimeFailure(error);
      if (target) this.quarantineTarget(target);
      if (error instanceof PersistentConductorError) throw error;
      throw new PersistentConductorError(error instanceof Error ? error.message : String(error));
    } finally {
      if (timeout !== undefined) this.timers.clearTimeout(timeout);
    }
  }

  /** Mark session after API coordinator fallback so next local turn rebuilds prefix. */
  markApiFallback(sessionId: string, signal?: AbortSignal): void {
    throwIfAborted(signal);
    const session = this.sessions.get(sessionId);
    if (session) {
      session.apiFallbackUsed = true;
      this.persistSession(session);
    }
  }

  pruneExpiredDiskSessions(): number {
    if (!this.config().kv_persist && !this.config().persist_sessions) return 0;
    const dir = join(this.sessionsRoot, "conductor");
    if (!existsSync(dir)) return 0;
    const ttl = this.config().session_ttl_ms;
    const now = Date.now();
    let removed = 0;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const path = join(dir, file);
      try {
        const mtime = statSync(path).mtimeMs;
        if (now - mtime > ttl) {
          unlinkSync(path);
          removed += 1;
        }
      } catch {
        // Best effort.
      }
    }
    return removed;
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (!this.config().persist_sessions && !this.config().kv_persist) return;
    const path = sessionFilePath(sessionId, this.sessionsRoot);
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  getSessionState(sessionId: string): ConductorSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  private async resolveTarget(): Promise<ResolvedConductorTarget> {
    const conductor = this.config();
    if (conductor.kv_backend === "llama_cpp") {
      const baseUrl = this.llamaCppBaseUrl();
      const cacheKey = `llama_cpp|${baseUrl}|${conductor.model}`;
      const now = Date.now();
      if (cachedTarget && cachedTargetKey === cacheKey && now - cachedTargetAt < TARGET_CACHE_TTL_MS) return cachedTarget;
      try {
        const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(3_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json() as { data?: Array<{ id?: string }> };
        const models = (body.data ?? []).map((item) => item.id ?? "").filter(Boolean);
        if (!modelAvailable(models, conductor.model)) {
          throw new Error(`configured model '${conductor.model}' is not served`);
        }
        const target: ResolvedConductorTarget = { baseUrl, model: conductor.model, backend: "llama_cpp" };
        cachedTarget = target;
        cachedTargetKey = cacheKey;
        cachedTargetAt = now;
        return target;
      } catch (error) {
        throw new PersistentConductorError(`Local conductor unreachable. Tried llama.cpp at ${baseUrl}: ${errorText(error)}`);
      }
    }

    const ollamaCfg = this.ollamaConfig();
    const cacheKey = `ollama|${ollamaCfg.base_url}|${conductor.model}|${conductor.fallback_model}`;
    const now = Date.now();
    if (cachedTarget && cachedTargetKey === cacheKey && (now - cachedTargetAt) < TARGET_CACHE_TTL_MS) {
      return cachedTarget;
    }

    for (const cleanUrl of ollamaBaseUrlCandidates(ollamaCfg)) {
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 3000);
        const tagsResp = await fetch(`${cleanUrl}/api/tags`, { signal: ctrl.signal });
        clearTimeout(timeout);
        if (!tagsResp.ok) continue;

        const tagsJson = await tagsResp.json();
        const models: string[] = (tagsJson.models || [])
          .map((m: { name?: string; model?: string }) => m.name || m.model || "")
          .filter(Boolean);

        if (models.length === 0) continue;

        const installedCandidates = conductorModelCandidates(this.config())
          .filter((candidate) => modelAvailable(models, candidate));
        const installed = installedCandidates.find((candidate) =>
          !this.targetIsQuarantined({ baseUrl: cleanUrl, model: candidate, backend: "ollama" }))
          ?? installedCandidates[0];
        if (!installed) continue;

        const target: ResolvedConductorTarget = {
          baseUrl: cleanUrl,
          model: installed,
          backend: "ollama",
        };

        cachedTarget = target;
        cachedTargetKey = cacheKey;
        cachedTargetAt = now;
        return target;
      } catch {
        // Try the next candidate URL.
      }
    }

    const fallbackUrl = cleanOllamaBaseUrl(ollamaCfg.base_url) || "http://localhost:11434";
    const modelsWanted = conductorModelCandidates(conductor).join(" or ");
    throw new PersistentConductorError(
      `Local conductor unreachable. Tried Ollama at ${fallbackUrl} for ${modelsWanted}`,
    );
  }

  private keepWarmIntervalMs(): number {
    const configured = Number(this.config().keep_warm_interval_ms);
    return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 600_000;
  }

  private async keepWarmIfDue(intervalMs = this.keepWarmIntervalMs()): Promise<void> {
    const conductor = this.config();
    if (!conductor.enabled || !conductor.keep_warm) return;
    if (Date.now() - this.lastWarmRenewedAt < intervalMs) return;
    if (this.keepWarmInFlight) return;

    this.keepWarmInFlight = this.warmUp()
      .then(() => undefined)
      .catch((error) => {
        console.warn(
          `[PersistentConductor] keep-warm skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.keepWarmInFlight = null;
      });

    await this.keepWarmInFlight;
  }

  /**
   * The models Ollama currently has RESIDENT (`/api/ps`). Returns `null` when
   * warmth cannot be determined (unreachable / malformed) so callers can
   * fail-open, and `[]` when the runtime confidently reports nothing loaded.
   */
  private async loadedModels(baseUrl: string, timeoutMs = 2_500): Promise<string[] | null> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const useLlamaCpp = this.config().kv_backend === "llama_cpp";
      const res = await fetch(useLlamaCpp ? `${baseUrl}/models` : `${baseUrl}/api/ps`, { signal: ctrl.signal });
      if (!res.ok) return null;
      const json = await res.json().catch(() => null) as LoadedModelsResponse | null;
      if (!json) return null;
      if (useLlamaCpp) {
        if (!Array.isArray(json.data)) return null;
        return json.data
          .map((model) => model?.id ?? "")
          .filter(Boolean);
      }
      if (!Array.isArray(json.models)) return null;
      return json.models
        .map((model) => model?.name || model?.model || "")
        .filter(Boolean);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async isTargetWarm(target: ResolvedConductorTarget, timeoutMs = 2_500): Promise<boolean> {
    const loaded = await this.loadedModels(target.baseUrl, timeoutMs);
    if (loaded === null) return true; // indeterminate → fail open (don't mark a working conductor cold)
    if (loaded.length === 0) return false;
    return modelAvailable(loaded, target.model);
  }

  /**
   * Prefer whichever conductor candidate is ACTUALLY resident, not merely the
   * installed primary. On a VRAM-constrained host the delegate's model — which
   * is also the configured `fallback_model` — evicts the primary conductor
   * mid-turn; following the resident model keeps supervision/routing LOCAL
   * instead of forcing a slow reload (which would evict the delegate) or a
   * remote coordinator that blows the stage deadline. Returns the primary when
   * warmth is indeterminate (fail-open), or `null` when nothing is loaded.
   */
  private async resolveWarmInferenceTarget(
    primary: ResolvedConductorTarget,
  ): Promise<ResolvedConductorTarget | null> {
    const loaded = await this.loadedModels(primary.baseUrl);
    if (loaded === null) return primary;
    if (loaded.length === 0) return null;
    // Candidate order is [model, fallback_model]: prefer the fast primary when
    // it is resident, otherwise the resident fallback.
    for (const model of conductorModelCandidates(this.config())) {
      if (modelAvailable(loaded, model)) {
        return { baseUrl: primary.baseUrl, model, backend: primary.backend };
      }
    }
    return null;
  }

  /**
   * Installed does not necessarily mean runnable: Ollama can discover a model
   * whose runner then fails during load. Quarantine that target briefly and
   * retry the configured fallback before escalating the turn to the API.
   */
  private async withRuntimeFallback<T>(
    initial: ResolvedConductorTarget,
    operation: (target: ResolvedConductorTarget) => Promise<T>,
  ): Promise<{ target: ResolvedConductorTarget; value: T }> {
    try {
      return { target: initial, value: await operation(initial) };
    } catch (primaryError) {
      if (!isRetryableRuntimeFailure(primaryError)) throw primaryError;
      this.quarantineTarget(initial);
      const alternate = await this.resolveTarget().catch(() => null);
      if (!alternate || alternate.model === initial.model) throw primaryError;

      console.warn(
        `[PersistentConductor] Model ${initial.model} failed at runtime; retrying with ${alternate.model}`,
      );
      try {
        return { target: alternate, value: await operation(alternate) };
      } catch (fallbackError) {
        if (!isRetryableRuntimeFailure(fallbackError)) throw fallbackError;
        this.quarantineTarget(alternate);
        const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new PersistentConductorError(
          `Primary conductor ${initial.model} failed (${primaryMessage}); ` +
          `fallback ${alternate.model} failed (${fallbackMessage})`,
          { retryable: true },
        );
      }
    }
  }

  private targetIsQuarantined(target: ResolvedConductorTarget): boolean {
    const key = `${target.baseUrl}|${target.model}`;
    const until = runtimeFailedTargets.get(key) ?? 0;
    if (until <= Date.now()) {
      runtimeFailedTargets.delete(key);
      return false;
    }
    return true;
  }

  private quarantineTarget(target: ResolvedConductorTarget): void {
    runtimeFailedTargets.set(
      `${target.baseUrl}|${target.model}`,
      Date.now() + TARGET_RUNTIME_FAILURE_TTL_MS,
    );
    if (cachedTarget?.baseUrl === target.baseUrl && cachedTarget.model === target.model) {
      cachedTarget = null;
      cachedTargetKey = "";
      cachedTargetAt = 0;
    }
  }

  private hasRecentRuntimeFailure(): boolean {
    return this.lastRuntimeFailureAt > 0
      && Date.now() - this.lastRuntimeFailureAt < RUNTIME_HEALTH_FAILURE_TTL_MS;
  }

  private recordRuntimeFailure(error: unknown): void {
    // Eviction/cold aborts and routing timeouts are expected under GPU pressure
    // (write turns unload the conductor). They must not flip isAvailable() false
    // for later turns — that sustained API degradation is F2 (2026-07-21).
    if (isAbortOrTimeoutError(error)) return;
    if (error instanceof PersistentConductorError && error.code === "cold_start_warming") return;
    if (!isRetryableRuntimeFailure(error)) return;
    this.lastRuntimeFailureAt = Date.now();
    this.lastRuntimeFailureMessage = errorText(error).slice(0, 240);
    this.readinessState = "degraded";
    this.readinessCompletedAt = this.lastRuntimeFailureAt;
    this.readinessError = this.lastRuntimeFailureMessage;
  }

  private clearRuntimeFailure(): void {
    this.lastRuntimeFailureAt = 0;
    this.lastRuntimeFailureMessage = "";
  }

  private recordSupervisionFailure(error: unknown): void {
    this.lastSupervisionFailureAt = Date.now();
    this.lastSupervisionFailureMessage = errorText(error).slice(0, 240);
  }

  private clearSupervisionFailure(): void {
    this.lastSupervisionFailureAt = 0;
    this.lastSupervisionFailureMessage = "";
  }

  private recentSupervisionWarning(): string | undefined {
    if (!this.lastSupervisionFailureAt || Date.now() - this.lastSupervisionFailureAt >= RUNTIME_HEALTH_FAILURE_TTL_MS) {
      return undefined;
    }
    return this.lastSupervisionFailureMessage;
  }

  private async callOllamaMessage(
    target: ResolvedConductorTarget,
    messages: ConductorMessage[],
    options: {
      format: Record<string, unknown>;
      numPredict: number;
      timeoutMs: number;
      temperature?: number;
      signal?: AbortSignal;
    },
  ): Promise<OllamaChatMessage> {
    const conductor = this.config();
    const ctrl = new AbortController();
    const timeout = this.timers.setTimeout(() => ctrl.abort(), options.timeoutMs);
    const abortFromCaller = () => ctrl.abort(options.signal?.reason);
    if (options.signal?.aborted) abortFromCaller();
    else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const cleanupSignal = () => options.signal?.removeEventListener("abort", abortFromCaller);

    const body: Record<string, unknown> = target.backend === "llama_cpp"
      ? {
          model: target.model,
          messages,
          stream: false,
          max_tokens: Math.max(4_096, conductor.max_tokens),
          temperature: options.temperature ?? conductor.temperature,
          top_p: conductor.top_p,
          cache_prompt: true,
          response_format: {
            type: "json_schema",
            json_schema: { name: "conductor_response", strict: true, schema: options.format },
          },
        }
      : {
          model: target.model,
          messages,
          stream: false,
          keep_alive: "30m",
          think: false,
          options: {
            temperature: options.temperature ?? conductor.temperature,
            top_p: conductor.top_p,
            top_k: conductor.top_k,
            num_ctx: conductor.num_ctx,
            num_predict: Math.min(options.numPredict, Math.max(64, conductor.max_tokens)),
          },
          format: options.format,
        };

    try {
      const res = await fetch(target.backend === "llama_cpp" ? `${target.baseUrl}/chat/completions` : `${target.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        const retryable = res.status >= 500 || /runner|failed to load|load failed|unavailable/i.test(errBody);
        throw new PersistentConductorError(
          `Local conductor chat failed: HTTP ${res.status}${errBody ? ` — ${errBody.slice(0, 200)}` : ""}`,
          { status: res.status, retryable },
        );
      }

      const json = await res.json() as { message?: OllamaChatMessage; choices?: Array<{ message?: OllamaChatMessage }> };
      const message = target.backend === "llama_cpp" ? json.choices?.[0]?.message : json.message;
      if (!message) throw new PersistentConductorError("Local conductor returned no message");
      return message;
    } catch (e) {
      if (isAbortOrTimeoutError(e)) throw e;
      if (e instanceof PersistentConductorError) throw e;
      throw new PersistentConductorError(e instanceof Error ? e.message : String(e));
    } finally {
      this.timers.clearTimeout(timeout);
      cleanupSignal();
    }
  }

  private async callOllamaChat(
    target: ResolvedConductorTarget,
    messages: ConductorMessage[],
    signal?: AbortSignal,
  ): Promise<string> {
    // Route selection is deliberately schema-only. The conductor should emit
    // a compact decision, not author worker prompts or replay session memory;
    // those details are assembled by Jarvis-owned code after routing.
    const message = await this.callOllamaMessage(target, messages, {
      format: COORDINATOR_ROUTE_JSON_SCHEMA,
      numPredict: 320,
      timeoutMs: this.config().kv_backend === "llama_cpp" ? 90_000 : ROUTING_TIMEOUT_MS,
      signal,
    });
    return extractConductorRoutingJson(message);
  }

  private getSession(sessionId: string): ConductorSessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.touchSession(sessionId, existing);
      return existing;
    }

    const loaded = this.loadSessionFromDisk(sessionId);
    if (loaded) {
      this.touchSession(sessionId, loaded);
      return loaded;
    }

    const created: ConductorSessionState = {
      sessionId,
      turns: 0,
      messages: [],
      lastActiveAt: Date.now(),
      kvGeneration: 0,
    };
    this.touchSession(sessionId, created);
    return created;
  }

  private touchSession(sessionId: string, session: ConductorSessionState): void {
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, session);
    this.pruneInactiveSessions();
    while (this.sessions.size > PersistentConductor.MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
  }

  private pruneInactiveSessions(): void {
    const ttl = this.config().session_ttl_ms;
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastActiveAt > ttl) {
        this.sessions.delete(sessionId);
      }
    }
  }

  private pruneSessionMessages(session: ConductorSessionState): void {
    const config = this.config();
    const maxTurns = Math.max(1, config.max_turns_in_cache);
    const system = session.messages.find((m) => m.role === "system");
    const nonSystem = session.messages.filter((m) => m.role !== "system");

    // Each turn is a user + assistant pair.
    const maxMessages = maxTurns * 2;
    let kept = nonSystem.length > maxMessages
      ? nonSystem.slice(nonSystem.length - maxMessages)
      : nonSystem;

    // Keep the reusable non-system prefix within half of the conductor context
    // window. Drop whole oldest turn pairs so role ordering stays valid.
    const tokenBudget = Math.floor(config.num_ctx * 0.5);
    while (kept.length > 0 && estimateMessageTokens(kept) > tokenBudget) {
      kept = kept.slice(Math.min(2, kept.length));
    }

    session.messages = system ? [system, ...kept] : kept;
  }

  private persistSession(session: ConductorSessionState): void {
    if (!this.config().persist_sessions && !this.config().kv_persist) return;
    try {
      writeJsonAtomic(sessionFilePath(session.sessionId, this.sessionsRoot), session);
    } catch {
      console.warn("[PersistentConductor] Failed to persist state: write_failed");
    }
  }

  private loadSessionFromDisk(sessionId: string): ConductorSessionState | null {
    if (!this.config().persist_sessions) return null;
    const path = sessionFilePath(sessionId, this.sessionsRoot);
    if (!existsSync(path)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      console.warn("[PersistentConductor] Ignoring persisted state: invalid_json");
      return null;
    }
    const parsed = parseConductorSessionState(raw, sessionId);
    if (!parsed.ok) {
      console.warn("[PersistentConductor] Ignoring persisted state: invalid_state");
      return null;
    }
    return parsed.state;
  }
}
