// ═══════════════════════════════════════════════════════════════
// ── Stream Emitter ──
// ═══════════════════════════════════════════════════════════════
// Single source of truth for everything streamJarvis sends to the client.
//
// Before this module the SSE emission logic was duplicated across four code
// paths (Claude CLI, orchestrator callModel, the main Ollama/OpenRouter loop,
// and the skill echo). Each handled reasoning, tool-call sanitisation and the
// terminal `message_stop` slightly differently, which is why two classes of
// bug kept recurring:
//
//   • Reasoning / tool-call markup leaking into the visible chat when the
//     paths disagreed on whether (or in what order) to strip it.
//   • "error decoding response body" on the Rust client, because a path could
//     finish (or throw) without emitting a terminal event, leaving the reqwest
//     byte-stream without a clean terminator.
//
// `VisibleTextPipe` owns the per-turn visible-text concern: it ALWAYS strips
// reasoning tags and tool-call markup from what the user sees, and only
// *forwards* the structured reasoning events when the caller opted in.
//
// `StreamSession` owns the per-request concern and guarantees that exactly one
// terminal `message_stop` is emitted, even on error or early return.

import { ReasoningParser, type ReasoningEvent } from "./reasoning";
import { TextToolCallStreamSanitizer } from "./text-tools";

/** Writes a single pre-formatted SSE frame. Returns false if the client is gone. */
export type StreamWriteFn = (frame: string) => Promise<boolean>;

function sseFrame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export interface VisibleTextPipeOptions {
  sessionId: string;
  /** When false, reasoning is still stripped from visible text but the
   *  reasoning_step / reasoning_chunk / reasoning_complete events are NOT sent. */
  reasoningEnabled: boolean;
  write: StreamWriteFn;
}

/**
 * Processes the visible-text channel for a single model turn.
 *
 * Create one per model invocation (its internal parser/sanitiser carry state
 * across the chunks of that turn). Feed raw model `content` deltas to
 * {@link push}; call {@link finish} once the turn's text is complete.
 */
export class VisibleTextPipe {
  private readonly sessionId: string;
  private readonly reasoningEnabled: boolean;
  private readonly write: StreamWriteFn;
  private readonly reasoning: ReasoningParser;
  private readonly sanitizer = new TextToolCallStreamSanitizer();
  private finished = false;

  constructor(opts: VisibleTextPipeOptions) {
    this.sessionId = opts.sessionId;
    this.reasoningEnabled = opts.reasoningEnabled;
    this.write = opts.write;
    this.reasoning = new ReasoningParser(opts.sessionId);
  }

  private async emitVisible(text: string): Promise<void> {
    const visible = this.sanitizer.push(text);
    if (visible) {
      await this.write(sseFrame({ type: "stream_event", delta: { text: visible }, session_id: this.sessionId }));
    }
  }

  private async handleEvents(events: ReasoningEvent[]): Promise<void> {
    for (const ev of events) {
      if (ev.type === "reasoning_step") {
        if (this.reasoningEnabled) {
          await this.write(sseFrame({ type: "reasoning_step", step: ev.step, session_id: this.sessionId }));
        }
      } else if (ev.type === "reasoning_chunk") {
        if (this.reasoningEnabled) {
          await this.write(sseFrame({ type: "reasoning_chunk", text: ev.text, session_id: this.sessionId }));
        }
      } else if (ev.type === "content") {
        await this.emitVisible(ev.text);
      }
      // "tool_call" / "complete" reasoning events are not produced by the
      // streaming parser path; ignore them defensively.
    }
  }

  /** Feed a raw model content delta. Reasoning + tool-call markup are stripped. */
  async push(raw: string): Promise<void> {
    if (!raw) return;
    await this.handleEvents(this.reasoning.processChunk(raw));
  }

  /**
   * Flush any buffered reasoning/sanitiser tail and emit `reasoning_complete`
   * (only when reasoning is enabled). Idempotent across multiple calls.
   */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.handleEvents(this.reasoning.flush());
    const tail = this.sanitizer.flush();
    if (tail) {
      await this.write(sseFrame({ type: "stream_event", delta: { text: tail }, session_id: this.sessionId }));
    }
    const trace = this.reasoning.finalize();
    if (this.reasoningEnabled) {
      await this.write(sseFrame({ type: "reasoning_complete", trace, session_id: this.sessionId }));
    }
  }
}

export interface StreamSessionOptions {
  sessionId: string;
  write: StreamWriteFn;
  /** True once the client has disconnected / the stream was aborted. */
  isAborted: () => boolean;
}

/**
 * Per-request stream coordinator. Its job is to guarantee that every stream
 * ends with exactly one terminal `message_stop`, so the Rust client never sees
 * a byte-stream that ends without a recognised terminator.
 */
export class StreamSession {
  private readonly sessionId: string;
  private readonly write: StreamWriteFn;
  private readonly isAborted: () => boolean;
  private terminalSent = false;

  constructor(opts: StreamSessionOptions) {
    this.sessionId = opts.sessionId;
    this.write = opts.write;
    this.isAborted = opts.isAborted;
  }

  /** Fresh visible-text pipe for one model turn. */
  newTextPipe(reasoningEnabled: boolean): VisibleTextPipe {
    return new VisibleTextPipe({ sessionId: this.sessionId, reasoningEnabled, write: this.write });
  }

  hasTerminated(): boolean {
    return this.terminalSent;
  }

  /** Record that a terminal event was emitted by other code (forwarded CLI
   *  `message_stop`, a `cancelled` frame, etc.) so we don't double-terminate. */
  noteTerminal(): void {
    this.terminalSent = true;
  }

  async init(model: string | null | undefined): Promise<void> {
    await this.write(sseFrame({ type: "init", session_id: this.sessionId, model: model ?? null }));
  }

  /** Emit a non-terminal error frame. The terminator is still sent afterwards. */
  async error(message: string): Promise<void> {
    await this.write(sseFrame({ type: "error", error: message, session_id: this.sessionId }));
  }

  /**
   * Emit the single terminal `message_stop` (plus an optional `result`).
   * Idempotent — subsequent calls are no-ops.
   *
   * Pass `{ isError: true }` when `result` carries a failure (e.g. the
   * orchestrator's synthesizer threw on a hard auth/network error). The
   * Rust relay surfaces an error-flagged `result` as `jarvis://error`
   * (a visible banner) instead of injecting the text into the chat bubble
   * as if it were a real answer — which previously made auth failures look
   * like a silent stall.
   */
  async finish(result?: string, opts?: { isError?: boolean }): Promise<void> {
    if (this.terminalSent) return;
    this.terminalSent = true;
    await this.write(sseFrame({ type: "message_stop", session_id: this.sessionId }));
    if (result !== undefined) {
      const isError = opts?.isError ?? false;
      await this.write(sseFrame({
        type: "result",
        subtype: isError ? "error" : "success",
        is_error: isError,
        result,
        session_id: this.sessionId,
      }));
    }
  }

  /**
   * Guarantee a clean terminator. Call from the request's `finally`.
   * No-op if a terminal event was already sent, or if the client is gone
   * (an aborted stream can't be written to and the client has moved on).
   */
  async ensureTerminal(): Promise<void> {
    if (this.terminalSent) return;
    this.terminalSent = true;
    if (this.isAborted()) return;
    await this.write(sseFrame({ type: "message_stop", session_id: this.sessionId }));
  }
}
