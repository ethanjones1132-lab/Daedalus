import type { JarvisConfig, SurfaceType } from "./config";
import type { MemoryRecallStatus } from "./memory-contract";

export interface ChatHistoryMessage {
  role: "user" | "assistant" | "system" | "tool" | string;
  content: string;
}

export interface ChatStreamOptions {
  config?: Partial<JarvisConfig>;
  history?: ChatHistoryMessage[];
  systemPromptOverride?: string;
  surface?: SurfaceType;
  signal?: AbortSignal;
  requestSignal?: AbortSignal;
  onComplete?: () => void;
  /** Stable turn identity for native memory diagnostics. Never contains memory text. */
  turnId?: string;
  /** Opaque native-prepared reference; resolved against the owned registry only. */
  memoryPreparationId?: string;
  /**
   * Client-reported initial memory status. Informational only: it can never
   * manufacture readiness or application absent a trusted registry envelope.
   */
  memoryStatus?: MemoryRecallStatus;
}

const MEMORY_RECALL_STATUSES: ReadonlySet<string> = new Set<MemoryRecallStatus>([
  "ready",
  "empty",
  "unavailable",
  "retrieval_failed",
  "registration_failed",
  "expired",
  "invalidated",
  "scope_mismatch",
  "already_consumed",
  "budget_omitted",
  "applied",
]);

function parseMemoryRecallStatus(value: unknown): MemoryRecallStatus | undefined {
  return typeof value === "string" && MEMORY_RECALL_STATUSES.has(value)
    ? value as MemoryRecallStatus
    : undefined;
}

export interface ChatStreamDependencies {
  stream(message: string, sessionId: string, options: ChatStreamOptions): Promise<Response>;
  createSessionId?: () => string;
}

export async function handleChatStreamRequest(
  req: Request,
  dependencies: ChatStreamDependencies,
): Promise<Response | null> {
  const url = new URL(req.url, "http://local");
  if (url.pathname !== "/chat/stream" || req.method !== "POST") return null;

  const body = await req.json() as Record<string, unknown>;
  const createSessionId = dependencies.createSessionId ?? (() => crypto.randomUUID());
  const sessionId = typeof body.session_id === "string" && body.session_id
    ? body.session_id
    : createSessionId();

  // Only whitelisted reference fields reach inference. Legacy/forged fields
  // (`memory`, `scope`, `agent_id`, `effective_workspace`, memory text) are
  // never read or forwarded: scope, authority, and content come only from the
  // authenticated native envelope resolved inside the owned Bun process.
  // Memory reference keys are added only when present so ordinary callers keep
  // their exact existing options shape.
  const options: ChatStreamOptions = {
    config: body.config as Partial<JarvisConfig> | undefined,
    history: Array.isArray(body.history) ? body.history as ChatHistoryMessage[] : [],
    systemPromptOverride: typeof body.system_prompt_override === "string"
      ? body.system_prompt_override
      : undefined,
    surface: body.surface as SurfaceType | undefined,
    requestSignal: req.signal,
  };
  if (typeof body.turn_id === "string" && body.turn_id.length > 0) {
    options.turnId = body.turn_id;
  }
  if (typeof body.memory_preparation_id === "string" && body.memory_preparation_id.length > 0) {
    options.memoryPreparationId = body.memory_preparation_id;
  }
  const memoryStatus = parseMemoryRecallStatus(body.memory_status);
  if (memoryStatus !== undefined) {
    options.memoryStatus = memoryStatus;
  }
  return dependencies.stream(body.message as string, sessionId, options);
}
