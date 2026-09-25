import type { JarvisConfig, SurfaceType } from "./config";

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

  return dependencies.stream(body.message as string, sessionId, {
    config: body.config as Partial<JarvisConfig> | undefined,
    history: Array.isArray(body.history) ? body.history as ChatHistoryMessage[] : [],
    systemPromptOverride: typeof body.system_prompt_override === "string"
      ? body.system_prompt_override
      : undefined,
    surface: body.surface as SurfaceType | undefined,
    requestSignal: req.signal,
  });
}
