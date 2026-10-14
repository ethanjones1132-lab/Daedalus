import { describe, expect, it } from 'vitest';
import {
  LOG_RAW_CONTENT_NOTICE,
  logLevelTone,
  logTailBound,
  parseDiagnosticsLogTail,
} from './diagnostics-log-state';

// The decoder's whole job is that an unknown payload from `fetch` cannot take the
// Diagnostics section down with it. `parseActionRegistryAlerts` throws for a
// malformed entry, which is right where a boot read has nothing to fall back on;
// a log tail is a panel an operator opened alongside two other reads, and one
// unreadable line in it must cost that line rather than the section.

const ISO = '2026-09-26T09:12:33.123Z';

function line(text: string, extra: Record<string, unknown> = {}) {
  return { text, timestamp: ISO, level: 'ERROR', ...extra };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    source: 'server-jarvis.self.log',
    format: 'self-log',
    limit: 200,
    truncated: false,
    lines: [line('first'), line('second')],
    ...overrides,
  };
}

describe('parseDiagnosticsLogTail', () => {
  it('accepts the payload the route sends', () => {
    const tail = parseDiagnosticsLogTail(payload());
    expect(tail).not.toBeNull();
    expect(tail!.source).toBe('server-jarvis.self.log');
    expect(tail!.format).toBe('self-log');
    expect(tail!.limit).toBe(200);
    expect(tail!.truncated).toBe(false);
    expect(tail!.lines).toHaveLength(2);
    expect(tail!.lines[0]).toEqual({ text: 'first', timestamp: ISO, level: 'ERROR' });
  });

  it('accepts a confirmed empty log as an empty tail, because that is a real read', () => {
    const tail = parseDiagnosticsLogTail(payload({ lines: [] }));
    expect(tail).not.toBeNull();
    expect(tail!.lines).toEqual([]);
    expect(tail!.truncated).toBe(false);
  });

  it('accepts a line the writer could not have written, with no invented level', () => {
    // Decision (c): a level is a property of the file. A partial write mid-line
    // is the common case and it still belongs on screen, with the two fields the
    // format did not supply left null.
    const tail = parseDiagnosticsLogTail(payload({ lines: [{ text: 'half a line', timestamp: null, level: null }] }));
    expect(tail!.lines[0]).toEqual({ text: 'half a line', timestamp: null, level: null });
  });

  it('drops a line it cannot make sense of and keeps the rest', () => {
    const tail = parseDiagnosticsLogTail(payload({
      lines: [line('kept'), null, 'a bare string', 42, {}, line('also kept')],
    }));
    expect(tail).not.toBeNull();
    expect(tail!.lines.map((l) => l.text)).toEqual(['kept', 'also kept']);
  });

  it('drops a line whose text is missing, or is not a string', () => {
    const tail = parseDiagnosticsLogTail(payload({
      lines: [{ timestamp: ISO, level: 'INFO' }, { text: 7, level: 'INFO' }, line('kept')],
    }));
    expect(tail!.lines.map((l) => l.text)).toEqual(['kept']);
  });

  it('drops a line whose level or timestamp is the wrong type rather than rendering it', () => {
    const tail = parseDiagnosticsLogTail(payload({
      lines: [{ text: 'a', timestamp: 1, level: 'INFO' }, { text: 'b', timestamp: ISO, level: {} }, line('kept')],
    }));
    expect(tail!.lines.map((l) => l.text)).toEqual(['kept']);
  });

  it('rejects a payload that is not a tail at all, so the section says the read failed', () => {
    // The difference from a bad line: there is nothing left to show, so the
    // honest reading is a failed read, not an empty log.
    for (const value of [null, undefined, 'ok', 7, [], { ok: true }, payload({ lines: 'two' }), payload({ limit: 0 }), payload({ truncated: 'yes' }), payload({ source: 12 })]) {
      expect(parseDiagnosticsLogTail(value), `should reject ${JSON.stringify(value)}`).toBeNull();
    }
  });

  it('rejects a limit that is not a positive integer, because it is this read’s own bound', () => {
    expect(parseDiagnosticsLogTail(payload({ limit: -1 }))).toBeNull();
    expect(parseDiagnosticsLogTail(payload({ limit: 1.5 }))).toBeNull();
    expect(parseDiagnosticsLogTail(payload({ limit: '200' }))).toBeNull();
  });
});

describe('logTailBound', () => {
  it('claims the whole file only when the read reached its first line', () => {
    const tail = parseDiagnosticsLogTail(payload({ truncated: false, lines: [line('only')] }))!;
    expect(logTailBound(tail)).toBe('Every line the file held when this was read.');
  });

  it('states the newest N and says the total is unknown when the read stopped short', () => {
    const tail = parseDiagnosticsLogTail(payload({ truncated: true, limit: 200, lines: [line('a'), line('b'), line('c')] }))!;
    expect(logTailBound(tail)).toBe(
      'The newest 3 lines, oldest first. The file held more, and this read does not say how many more.',
    );
  });

  it('does not claim a bound it cannot support for a truncated read of no lines', () => {
    // A zero-line tail that says `The newest 0 lines` is arithmetic talking. The
    // bound sentence stays a statement about the file.
    const tail = parseDiagnosticsLogTail(payload({ truncated: true, lines: [] }))!;
    expect(logTailBound(tail)).toBe('This read did not reach the start of the file, so it does not say how many lines the file holds.');
  });

  it('is a fixed sentence, not one assembled from anything the server chose', () => {
    // The only variable in either sentence is the number of lines this read
    // confirmed, which is the one number it is entitled to.
    const bounds = new Set<string>();
    for (const truncated of [true, false]) {
      for (const count of [0, 1, 7, 200]) {
        const lines = Array.from({ length: count }, (_unused, i) => line(`line ${i}`));
        const tail = parseDiagnosticsLogTail(payload({ truncated, lines }))!;
        bounds.add(logTailBound(tail).replace(/\b\d+\b/, 'N'));
      }
    }
    expect(bounds.size).toBe(3);
  });
});

describe('logLevelTone', () => {
  it('gives the writer’s own levels a tone and invents none for a line without one', () => {    expect(logLevelTone('ERROR')).toBe('error');
    expect(logLevelTone('WARN')).toBe('warn');
    expect(logLevelTone('INFO')).toBe('default');
    expect(logLevelTone(null)).toBeNull();
  });
});

describe('LOG_RAW_CONTENT_NOTICE', () => {
  it('says, in the surface’s own words, that a log line is not sanitised', () => {
    // Decision (a), made before the section rendered one line: this is the
    // read-error rule's one deliberate exception, and the exception is stated on
    // screen rather than assumed. A log line is raw server output and can carry
    // the store paths and session ids the rule otherwise withholds; an operator
    // opening the log is asking for them, and the cost of that is the operator's
    // to know about, not the app's to make silently.
    expect(LOG_RAW_CONTENT_NOTICE).toBe(
      'These lines are the raw output of the server process. They are not sanitised, and they can contain file paths and session ids.',
    );
  });
});
