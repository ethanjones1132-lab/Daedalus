import { describe, expect, it, vi } from 'vitest';
import {
  SendGate,
  SendInFlightGuard,
  dedupeMessages,
  finalizeStreamingMessages,
  isToolCallEchoOnly,
  mergeToolResult,
  recoverComposerAfterFailure,
  sanitizeAssistantDisplay,
  shouldSubmitComposerKey,
  type ToolCallState,
} from './chat-state';
import type { JarvisMessage } from './types';

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

describe('dedupeMessages', () => {
  it('collapses the same message instance appearing twice via optimistic+reload overlap', () => {
    const messages: JarvisMessage[] = [
      { id: 'a1', role: 'user', content: 'hello' },
      { id: 'a1', role: 'user', content: 'hello' },
    ];
    expect(dedupeMessages(messages)).toEqual([{ id: 'a1', role: 'user', content: 'hello' }]);
  });

  it('does not collapse distinct identical texts sent as separate instances (different ids)', () => {
    const messages: JarvisMessage[] = [
      { id: 'a1', role: 'user', content: 'ping' },
      { role: 'assistant', content: 'pong' },
      { id: 'a2', role: 'user', content: 'ping' },
    ];
    expect(dedupeMessages(messages)).toHaveLength(3);
  });

  it('collapses legacy id-less consecutive duplicates (same role+content+timestamp)', () => {
    const messages: JarvisMessage[] = [
      { role: 'user', content: 'hi', timestamp: 't1' },
      { role: 'user', content: 'hi', timestamp: 't1' },
    ];
    expect(dedupeMessages(messages)).toEqual([{ role: 'user', content: 'hi', timestamp: 't1' }]);
  });

  it('does not collapse id-less messages once separated by another message', () => {
    const messages: JarvisMessage[] = [
      { role: 'user', content: 'hi', timestamp: 't1' },
      { role: 'assistant', content: 'hello!', timestamp: 't2' },
      { role: 'user', content: 'hi', timestamp: 't1' },
    ];
    expect(dedupeMessages(messages)).toHaveLength(3);
  });

  it('does not collapse an id-bearing message against an id-less one even if content matches', () => {
    const messages: JarvisMessage[] = [
      { role: 'user', content: 'hi', timestamp: 't1' },
      { id: 'a1', role: 'user', content: 'hi', timestamp: 't1' },
    ];
    expect(dedupeMessages(messages)).toHaveLength(2);
  });
});

describe('isToolCallEchoOnly', () => {
  it('is true for a single-line bare tool-call JSON object', () => {
    expect(isToolCallEchoOnly('{"name":"read_file","arguments":{"path":"a.ts"}}')).toBe(true);
  });

  it('is true for the legacy {tool,arguments} echo shape', () => {
    expect(isToolCallEchoOnly('{"tool":"list_directory","arguments":{"path":"."}}')).toBe(true);
  });

  it('is false for a {tool} object without arguments', () => {
    expect(isToolCallEchoOnly('{"tool":"list_directory"}')).toBe(false);
  });

  it('is true for multi-line bare tool-call JSON (one call per line)', () => {
    const content = [
      '{"name":"read_file","arguments":{"path":"a.ts"}}',
      '{"name":"write_file","arguments":{"path":"b.ts","content":"x"}}',
    ].join('\n');
    expect(isToolCallEchoOnly(content)).toBe(true);
  });

  it('is true for <tool_call>-wrapped JSON', () => {
    expect(isToolCallEchoOnly('<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>')).toBe(true);
  });

  it('tolerates blank lines between bare tool-call JSON lines', () => {
    const content = '{"name":"read_file","arguments":{}}\n\n{"name":"write_file","arguments":{}}';
    expect(isToolCallEchoOnly(content)).toBe(true);
  });

  it('is false for plain prose', () => {
    expect(isToolCallEchoOnly('Here is the answer you asked for.')).toBe(false);
  });

  it('is false for prose mixed with tool-call JSON', () => {
    const content = 'Let me check that.\n{"name":"read_file","arguments":{"path":"a.ts"}}';
    expect(isToolCallEchoOnly(content)).toBe(false);
  });

  it('is false for a fenced JSON code block', () => {
    const content = '```json\n{"name":"read_file","arguments":{"path":"a.ts"}}\n```';
    expect(isToolCallEchoOnly(content)).toBe(false);
  });

  it('is false for JSON that is not tool-call shaped', () => {
    expect(isToolCallEchoOnly('{"foo":"bar","baz":123}')).toBe(false);
  });

  it('is false for JSON with a name but non-object arguments', () => {
    expect(isToolCallEchoOnly('{"name":"read_file","arguments":"a.ts"}')).toBe(false);
  });

  it('is false for empty or whitespace-only content', () => {
    expect(isToolCallEchoOnly('')).toBe(false);
    expect(isToolCallEchoOnly('   \n  ')).toBe(false);
  });
});

describe('SendInFlightGuard', () => {
  // 2026-07-13 live incident (session 7254c3ae): a rapid second Enter-press
  // bypassed the React `isStreaming` state guard because setState is async
  // and batched. The SendInFlightGuard is a synchronous ref-backed mirror
  // that closes the race.
  it('admits one send, rejects a concurrent second send in the same tick', () => {
    const guard = new SendInFlightGuard();
    expect(guard.isInFlight()).toBe(false);
    expect(guard.begin()).toBe(true);
    expect(guard.isInFlight()).toBe(true);
    // Second begin() in the same synchronous tick — exactly the case that
    // raced past the React state guard in the live incident.
    expect(guard.begin()).toBe(false);
    expect(guard.isInFlight()).toBe(true);
  });

  it('counts the rejected sends so the daily report can surface the resend rate', () => {
    const guard = new SendInFlightGuard();
    expect(guard.begin()).toBe(true);
    expect(guard.begin()).toBe(false);
    expect(guard.begin()).toBe(false);
    expect(guard.blocksRecorded()).toBe(2);
    guard.finish();
    // A new begin() after finish() succeeds and does not affect the prior
    // block count.
    expect(guard.begin()).toBe(true);
    expect(guard.blocksRecorded()).toBe(2);
  });

  it('finish() releases the in-flight slot and a subsequent begin() succeeds', () => {
    const guard = new SendInFlightGuard();
    expect(guard.begin()).toBe(true);
    guard.finish();
    expect(guard.isInFlight()).toBe(false);
    expect(guard.begin()).toBe(true);
  });

  it('finish() is idempotent so a try/finally that always fires cannot corrupt state', () => {
    const guard = new SendInFlightGuard();
    guard.finish(); // nothing in flight
    guard.finish(); // still nothing
    expect(guard.isInFlight()).toBe(false);
    expect(guard.blocksRecorded()).toBe(0);
  });

  it('resetBlockCount() zeroes the counter without affecting in-flight state', () => {
    const guard = new SendInFlightGuard();
    expect(guard.begin()).toBe(true);
    expect(guard.begin()).toBe(false);
    expect(guard.blocksRecorded()).toBe(1);
    guard.resetBlockCount();
    expect(guard.blocksRecorded()).toBe(0);
    expect(guard.isInFlight()).toBe(true);
  });
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
