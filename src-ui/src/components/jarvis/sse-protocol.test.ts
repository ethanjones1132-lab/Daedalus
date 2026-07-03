import { describe, expect, it, vi } from 'vitest';
import {
  createUnknownFrameReporter,
  InactivityWatchdog,
  isPassiveSseFrame,
  parseSseDataLine,
  readToolResultTruncation,
  SseProtocolError,
  type TimeoutScheduler,
} from './sse-protocol';

class FakeTimeoutScheduler implements TimeoutScheduler {
  private nextId = 1;
  private tasks = new Map<number, () => void>();

  setTimeout(callback: () => void): unknown {
    const id = this.nextId++;
    this.tasks.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(Number(handle));
  }

  runNext(): void {
    const entry = this.tasks.entries().next().value as [number, () => void] | undefined;
    if (!entry) return;
    this.tasks.delete(entry[0]);
    entry[1]();
  }
}

describe('Jarvis SSE protocol', () => {
  it('parses data frames and ignores comments, empty data, and DONE', () => {
    expect(parseSseDataLine('data: {"type":"init","session_id":"s1"}')).toEqual({
      type: 'init',
      session_id: 's1',
    });
    expect(parseSseDataLine(': ping')).toBeNull();
    expect(parseSseDataLine('data:')).toBeNull();
    expect(parseSseDataLine('data: [DONE]')).toBeNull();
  });

  it('turns malformed JSON into an actionable protocol error', () => {
    expect(() => parseSseDataLine('data: {not-json}')).toThrowError(SseProtocolError);
    expect(() => parseSseDataLine('data: {not-json}')).toThrow(
      'Jarvis returned a malformed SSE frame',
    );
  });

  it('recognizes passive protocol frames that require no UI mutation', () => {
    expect(isPassiveSseFrame('init')).toBe(true);
    expect(isPassiveSseFrame('message_stop')).toBe(true);
    expect(isPassiveSseFrame('agent_run_id')).toBe(true);
    expect(isPassiveSseFrame('heartbeat')).toBe(true);
    expect(isPassiveSseFrame('something_new')).toBe(false);
  });

  it('reports each unknown frame type once per stream', () => {
    const warn = vi.fn();
    const reportUnknown = createUnknownFrameReporter(warn);

    reportUnknown('something_new');
    reportUnknown('something_new');
    reportUnknown('another_new_type');

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, '[Jarvis] unknown SSE frame type: something_new');
    expect(warn).toHaveBeenNthCalledWith(2, '[Jarvis] unknown SSE frame type: another_new_type');
  });

  it('reads tool-result context truncation metadata for the tool card', () => {
    expect(readToolResultTruncation({
      type: 'tool_result',
      context_truncation: {
        truncated: true,
        original_chars: 3_000,
        retained_chars: 1_880,
        removed_chars: 1_120,
        limit_chars: 2_000,
      },
    })).toEqual({
      truncated: true,
      original_chars: 3_000,
      retained_chars: 1_880,
      removed_chars: 1_120,
      limit_chars: 2_000,
    });

    expect(readToolResultTruncation({ type: 'tool_result', context_truncation: { truncated: true } })).toBeNull();
  });

  it('resets and stops the inactivity deadline', () => {
    const scheduler = new FakeTimeoutScheduler();
    const onTimeout = vi.fn();
    const watchdog = new InactivityWatchdog(90_000, onTimeout, scheduler);

    watchdog.start();
    watchdog.touch();
    scheduler.runNext();
    scheduler.runNext();
    expect(onTimeout).toHaveBeenCalledTimes(1);

    watchdog.start();
    watchdog.stop();
    scheduler.runNext();
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
