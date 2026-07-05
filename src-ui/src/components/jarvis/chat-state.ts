import type { JarvisMessage } from './types';
import type { ToolResultTruncationMetadata } from './sse-protocol';

/** Synchronous send lock with generations so stale completions cannot unlock a replacement. */
export class SendGate {
  private locked = false;
  private generation = 0;

  tryAcquire(): number | null {
    if (this.locked) return null;
    this.locked = true;
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return this.locked && this.generation === generation;
  }

  release(generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    this.locked = false;
    return true;
  }

  invalidate(): void {
    this.generation += 1;
    this.locked = false;
  }
}

export function recoverComposerAfterFailure(currentInput: string, sentText: string): string {
  return currentInput.trim() ? currentInput : sentText;
}

export function sanitizeAssistantDisplay(content: string): string {
  let visible = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const unterminated = visible.search(/<think>/i);
  if (unterminated >= 0) visible = visible.slice(0, unterminated);
  return visible.replace(/<\/?think>/gi, '').trim();
}

export function finalizeStreamingMessages(messages: JarvisMessage[]): JarvisMessage[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || !last.isStreaming) return messages;
  const content = sanitizeAssistantDisplay(last.content);
  if (!content) return messages.slice(0, -1);
  return [...messages.slice(0, -1), { ...last, content, isStreaming: false }];
}

// ── Message identity + dedupe (Task 7 / 2026-07-03 incident 1d4727cf) ──
//
// Live incident: turn 1 failed on a synthesizer timeout, the user re-sent,
// and the optimistic user bubble + the history-reload from SQLite both
// rendered the same logical message — the UI had no message identity to
// tell "this is the same instance shown twice" apart from "the user typed
// the same text twice on purpose". This is about collapsing the FORMER,
// never the latter: a legitimate repeat send must survive dedupe.
//
// Two dedupe strategies, applied in order:
//   1. By `id` — an id that has already been seen (optimistic append,
//      followed by the history reload assigning the same DB row id) is
//      dropped. This is the precise, non-lossy path.
//   2. Fallback for id-less legacy rows — collapse CONSECUTIVE messages
//      that share role + content + timestamp. Consecutive-only so two
//      genuinely repeated user sends (different timestamps, or separated
//      by an assistant reply) are never merged.
export function dedupeMessages(messages: JarvisMessage[]): JarvisMessage[] {
  const seenIds = new Set<string>();
  const out: JarvisMessage[] = [];
  for (const msg of messages) {
    if (msg.id) {
      if (seenIds.has(msg.id)) continue;
      seenIds.add(msg.id);
      out.push(msg);
      continue;
    }
    const prev = out[out.length - 1];
    if (
      prev
      && !prev.id
      && prev.role === msg.role
      && prev.content === msg.content
      && prev.timestamp === msg.timestamp
    ) {
      continue;
    }
    out.push(msg);
  }
  return out;
}

// ── Tool-call-JSON-only assistant content (Task 7 Part B) ──
//
// Defense-in-depth: the server should never send raw tool-call JSON as the
// visible assistant text anymore (2026-07-03 incident — a synthesizer
// stage leaked `{"name":..., "arguments":...}` into the display content
// instead of routing it through the `tool_call` SSE frame / ToolCallCard).
// This is a conservative, line-wise detector: every non-blank line must
// either be `<tool_call>...</tool_call>`-wrapped JSON or parse as JSON with
// a `name: string` + `arguments: object` shape. Prose, prose+JSON mixes,
// fenced code blocks, and non-tool-shaped JSON all return false — when in
// doubt, render as normal markdown.
export function isToolCallEchoOnly(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/```/.test(trimmed)) return false;

  const lines = trimmed.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return false;

  return lines.every((line) => {
    let candidate = line;
    const wrapped = /^<tool_call>([\s\S]*)<\/tool_call>$/i.exec(line);
    if (wrapped) candidate = wrapped[1].trim();
    if (!candidate) return false;

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const obj = parsed as Record<string, unknown>;
    return (
      (typeof obj.name === 'string'
        || typeof obj.tool === 'string'
        || typeof obj.tool_name === 'string')
      && obj.arguments !== undefined
      && obj.arguments !== null
      && typeof obj.arguments === 'object'
      && !Array.isArray(obj.arguments)
    );
  });
}

export function shouldSubmitComposerKey(event: {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
}): boolean {
  return event.key === 'Enter'
    && !event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.isComposing;
}

export interface ToolCallState {
  call_id?: string;
  name: string;
  arguments: unknown;
  result?: string;
  is_error?: boolean;
  matched?: boolean;
  contextTruncation?: ToolResultTruncationMetadata;
}

export interface IncomingToolResult {
  callId?: string;
  name: string;
  output: string;
  isError: boolean;
  contextTruncation?: ToolResultTruncationMetadata;
}

export function mergeToolResult(
  calls: ToolCallState[],
  result: IncomingToolResult,
  warn: (message: string) => void = (message) => console.warn(message),
): ToolCallState[] {
  let index = -1;
  if (result.callId) {
    index = calls.findIndex((call) => call.call_id === result.callId && call.result === undefined);
    if (index < 0) warn(`[Jarvis] tool_result call_id did not match a pending call: ${result.callId}`);
  } else {
    const reverseIndex = [...calls].reverse().findIndex(
      (call) => call.name === result.name && call.result === undefined,
    );
    if (reverseIndex >= 0) index = calls.length - 1 - reverseIndex;
    warn(`[Jarvis] tool_result missing call_id; compatibility-matched by name=${result.name}`);
  }

  const patch = {
    result: result.output,
    is_error: result.isError,
    matched: index >= 0,
    contextTruncation: result.contextTruncation,
  };
  if (index >= 0) {
    const next = [...calls];
    next[index] = { ...next[index], ...patch };
    return next;
  }
  return [...calls, {
    call_id: result.callId,
    name: result.name,
    arguments: null,
    ...patch,
  }];
}
