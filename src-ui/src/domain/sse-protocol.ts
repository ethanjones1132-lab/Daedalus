export interface JarvisSseFrame {
  type: string;
  [key: string]: unknown;
}

export type StageTerminalStatus = 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'partial';

export function isTerminalStageStatus(status: unknown): status is StageTerminalStatus {
  return status === 'completed'
    || status === 'done'
    || status === 'failed'
    || status === 'timed_out'
    || status === 'cancelled'
    || status === 'partial';
}

export interface ToolResultTruncationMetadata {
  truncated: true;
  original_chars: number;
  retained_chars: number;
  removed_chars: number;
  limit_chars: number;
}

export class SseProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SseProtocolError';
  }
}

const PASSIVE_FRAME_TYPES = new Set(['init', 'message_stop', 'agent_run_id', 'heartbeat']);

export interface TimeoutScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimeoutScheduler: TimeoutScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class InactivityWatchdog {
  private handle: unknown = null;
  private active = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout: () => void,
    private readonly scheduler: TimeoutScheduler = defaultTimeoutScheduler,
  ) {}

  start(): void {
    this.active = true;
    this.schedule();
  }

  touch(): void {
    if (!this.active) return;
    this.schedule();
  }

  stop(): void {
    this.active = false;
    if (this.handle !== null) {
      this.scheduler.clearTimeout(this.handle);
      this.handle = null;
    }
  }

  private schedule(): void {
    if (this.handle !== null) this.scheduler.clearTimeout(this.handle);
    this.handle = this.scheduler.setTimeout(() => {
      this.handle = null;
      if (!this.active) return;
      this.active = false;
      this.onTimeout();
    }, this.timeoutMs);
  }
}

export function isPassiveSseFrame(type: unknown): boolean {
  return typeof type === 'string' && PASSIVE_FRAME_TYPES.has(type);
}

export function parseSseDataLine(line: string): JarvisSseFrame | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;

  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (cause) {
    throw new SseProtocolError('Jarvis returned a malformed SSE frame.', { cause });
  }

  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
    throw new SseProtocolError('Jarvis returned an SSE frame without a string type.');
  }
  return parsed as JarvisSseFrame;
}

export function readToolResultTruncation(frame: JarvisSseFrame): ToolResultTruncationMetadata | null {
  const value = frame.context_truncation;
  if (!value || typeof value !== 'object') return null;
  const metadata = value as Record<string, unknown>;
  if (metadata.truncated !== true) return null;
  for (const key of ['original_chars', 'retained_chars', 'removed_chars', 'limit_chars']) {
    if (typeof metadata[key] !== 'number' || !Number.isFinite(metadata[key])) return null;
  }
  return metadata as unknown as ToolResultTruncationMetadata;
}

export function createUnknownFrameReporter(
  warn: (message: string) => void = (message) => console.warn(message),
): (type: string) => void {
  const seen = new Set<string>();
  return (type: string) => {
    if (seen.has(type)) return;
    seen.add(type);
    warn(`[Jarvis] unknown SSE frame type: ${type}`);
  };
}
