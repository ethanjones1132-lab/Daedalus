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
