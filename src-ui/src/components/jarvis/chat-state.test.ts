import { describe, expect, it, vi } from 'vitest';
import {
  SendGate,
  finalizeStreamingMessages,
  mergeToolResult,
  recoverComposerAfterFailure,
  sanitizeAssistantDisplay,
  shouldSubmitComposerKey,
  type ToolCallState,
} from './chat-state';

describe('SendGate', () => {
  it('admits one send and prevents a stale completion from unlocking a newer send', () => {
    const gate = new SendGate();
    const first = gate.tryAcquire();
    expect(first).not.toBeNull();
    expect(gate.tryAcquire()).toBeNull();

    gate.invalidate();
    const second = gate.tryAcquire();
    expect(second).not.toBeNull();
    expect(gate.release(first!)).toBe(false);
    expect(gate.tryAcquire()).toBeNull();
    expect(gate.release(second!)).toBe(true);
  });
});

it('restores a failed message only when the composer is still empty', () => {
  expect(recoverComposerAfterFailure('', 'please retry')).toBe('please retry');
  expect(recoverComposerAfterFailure('new draft', 'please retry')).toBe('new draft');
});

it('removes complete and unterminated think blocks from assistant display', () => {
  expect(sanitizeAssistantDisplay('<think>private</think>Visible answer')).toBe('Visible answer');
  expect(sanitizeAssistantDisplay('Visible\n<think>unfinished private text')).toBe('Visible');
  expect(sanitizeAssistantDisplay('</think>Visible answer')).toBe('Visible answer');
});

it('drops an empty or think-only streaming assistant when finalizing', () => {
  expect(finalizeStreamingMessages([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: '<think>private</think>', isStreaming: true },
  ])).toEqual([{ role: 'user', content: 'hello' }]);

  expect(finalizeStreamingMessages([
    { role: 'assistant', content: 'Visible', isStreaming: true },
  ])).toEqual([{ role: 'assistant', content: 'Visible', isStreaming: false }]);
});

it('does not submit Enter while an IME composition is active', () => {
  expect(shouldSubmitComposerKey({ key: 'Enter', isComposing: true })).toBe(false);
  expect(shouldSubmitComposerKey({ key: 'Enter', isComposing: false })).toBe(true);
  expect(shouldSubmitComposerKey({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false);
});

describe('mergeToolResult', () => {
  const calls: ToolCallState[] = [
    { call_id: 'one', name: 'read_file', arguments: { path: 'a' } },
    { call_id: 'two', name: 'read_file', arguments: { path: 'b' } },
  ];

  it('matches a result by call_id even when names repeat', () => {
    const warn = vi.fn();
    const merged = mergeToolResult(calls, {
      callId: 'two', name: 'read_file', output: 'B', isError: false,
    }, warn);

    expect(merged[0].result).toBeUndefined();
    expect(merged[1].result).toBe('B');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns before compatibility matching a result that has no call_id', () => {
    const warn = vi.fn();
    const merged = mergeToolResult(calls, {
      name: 'read_file', output: 'fallback', isError: false,
    }, warn);

    expect(merged[1].result).toBe('fallback');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('does not name-match a mismatched call_id', () => {
    const warn = vi.fn();
    const merged = mergeToolResult(calls, {
      callId: 'missing', name: 'read_file', output: 'orphan', isError: true,
    }, warn);

    expect(merged.slice(0, 2).every((call) => call.result === undefined)).toBe(true);
    expect(merged[2]).toMatchObject({ call_id: 'missing', result: 'orphan', is_error: true });
    expect(warn).toHaveBeenCalledOnce();
  });
});
