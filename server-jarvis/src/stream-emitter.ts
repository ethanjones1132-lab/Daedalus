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
import { VisibleAnswerStreamSanitizer } from "./text-tools";

export const EFFECT_GATE_NO_WRITE_ERROR_CODE = "effect_gate_no_write_effect";

export function isTerminalPipelineErrorCode(code: string | undefined): boolean {
  return code === EFFECT_GATE_NO_WRITE_ERROR_CODE;
}

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
  // VisibleTextPipe is the single source of truth for user-visible text in
  // the direct chat path. It must strip both tagged tool calls (via
  // TextToolCallStreamSanitizer, which VisibleAnswerStreamSanitizer wraps)
  // AND bare-JSON tool lines (via VisibleAnswerStreamSanitizer) so that a
  // model which hallucinates either form of tool markup does not leak it
  // into the visible chat bubble. Defense-in-depth: the post-turn
  // extractTextToolCalls extractor (server-jarvis/src/text-tools.ts) catches
  // anything that survives streaming.
  private readonly sanitizer = new VisibleAnswerStreamSanitizer();
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
 * Per-request stream coordinator. It independently tracks the transport
 * `message_stop` and the user-visible terminal outcome (`result`, `error`, or
 * `cancelled`) so one cannot accidentally suppress the other.
 */
export class StreamSession {
  private readonly sessionId: string;
  private readonly write: StreamWriteFn;
  private readonly isAborted: () => boolean;
  private terminalSent = false;
  private outcomeSent = false;

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

  hasOutcome(): boolean {
    return this.outcomeSent;
  }

  /** Record a transport-level `message_stop` emitted by another path. */
  noteTerminal(): void {
    this.terminalSent = true;
  }

  /** Record an externally-emitted result, error, or cancelled outcome.
   * Returns false when another outcome already won the race. */
  noteOutcome(): boolean {
    if (this.outcomeSent) return false;
    this.outcomeSent = true;
    return true;
  }

  async init(model: string | null | undefined): Promise<void> {
    await this.write(sseFrame({ type: "init", session_id: this.sessionId, model: model ?? null }));
  }

  /** Emit the terminal error outcome. The transport terminator is sent separately. */
  async error(message: string, code?: string): Promise<void> {
    if (!this.noteOutcome()) return;
    await this.write(sseFrame({
      type: "error",
      error: message,
      ...(code ? { code } : {}),
      session_id: this.sessionId,
    }));
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
  async finish(result: string, opts?: { isError?: boolean; subtype?: "success" | "error" | "partial"; code?: string }): Promise<void> {
    // A terminal effect-gate fence may still carry planner/synthesizer prose
    // in `result`. That text predates the verified no-write outcome and must
    // never cross the public stream boundary as an answer.
    if (isTerminalPipelineErrorCode(opts?.code)) {
      await this.error(
        "The requested write could not be completed because no write effect was produced.",
        opts?.code,
      );
      return;
    }
    if (!this.noteOutcome()) return;
    if (!this.terminalSent) {
      this.terminalSent = true;
      await this.write(sseFrame({ type: "message_stop", session_id: this.sessionId }));
    }
    const isError = opts?.isError ?? false;
    const subtype = opts?.subtype ?? (isError ? "error" : "success");
    await this.write(sseFrame({
      type: "result",
      subtype,
      is_error: isError,
      ...(opts?.code ? { code: opts.code } : {}),
      result,
      session_id: this.sessionId,
    }));
  }

  /**
   * Guarantee a clean terminator. Call from the request's `finally`.
   * No-op if a terminal event was already sent, or if the client is gone
   * (an aborted stream can't be written to and the client has moved on).
   */
  async ensureTerminal(): Promise<void> {
    if (this.isAborted()) {
      this.terminalSent = true;
      return;
    }
    if (!this.outcomeSent) {
      await this.error(
        "The Jarvis stream ended without a terminal outcome.",
        "stream_ended_without_outcome",
      );
    }
    if (this.terminalSent) return;
    this.terminalSent = true;
    await this.write(sseFrame({ type: "message_stop", session_id: this.sessionId }));
  }
}
