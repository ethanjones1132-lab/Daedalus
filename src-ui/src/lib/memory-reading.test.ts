import { describe, expect, it } from 'vitest';
import { decodeMemoryReading, MEMORY_UNMEASURED_LABEL } from './memory-reading';

// A key the record never returned, so a fixture can express absence that
// object spread cannot: `{ ...base, total_mb: 0 }` carries the key.
const ABSENT = Symbol('absent');

function record(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { total_mb: 16384, available_mb: 8192, used_mb: 8192, used_percent: 50, ...fields };
}

function without(key: string): Record<string, unknown> {
  const value = record();
  delete value[key];
  return value;
}

describe('memory reading sentinel', () => {
  // Native reports a probe that did not run as a zeroed record rather than the
  // "?" string its disk probe uses, so the zero is a sentinel, not a reading.
  it('reads Native’s zeroed memory record as unprobed rather than as a measurement', () => {
    const reading = decodeMemoryReading({ total_mb: 0, available_mb: 0, used_mb: 0, used_percent: 0 });
    expect(reading.kind).toBe('unavailable');
    expect(reading.kind === 'unavailable' && reading.reason).toBe('unprobed');
    expect(reading.percent).toBeNull();
    expect(reading.label).toBe(MEMORY_UNMEASURED_LABEL);
  });

  it('never prints a number beside an unprobed record, whatever percentage it carries', () => {
    // A contradictory record still has no measurement basis: the total is the
    // discriminator, so the percentage cannot rescue it.
    for (const used_percent of [0, 25, 100, -1, 250]) {
      const reading = decodeMemoryReading(record({ total_mb: 0, used_percent }));
      expect(reading.percent).toBeNull();
      expect(reading.label).toBe(MEMORY_UNMEASURED_LABEL);
      expect(reading.label).not.toContain('%');
    }
  });

  it('prints one fixed basis sentence naming that the probe did not report', () => {
    const reading = decodeMemoryReading({ total_mb: 0, available_mb: 0, used_mb: 0, used_percent: 0 });
    expect(reading.basis).toBe(
      'The memory probe reported no total, so memory use cannot be measured.',
    );
  });

  it('reads a record with no readable total as unprobed when the key is zero, not when it is absent', () => {
    expect(decodeMemoryReading(without('total_mb')).kind).toBe('unavailable');
    expect(decodeMemoryReading(without('total_mb')).reason).toBe('unreadable-total');
    expect(decodeMemoryReading(record({ total_mb: ABSENT })).reason).toBe('unreadable-total');
  });
});

describe('memory reading measurement', () => {
  it('keeps a real reading and its percentage', () => {
    const reading = decodeMemoryReading({ total_mb: 16384, available_mb: 12288, used_mb: 4096, used_percent: 25 });
    expect(reading.kind).toBe('measured');
    expect(reading.percent).toBe(25);
    expect(reading.label).toBe('25.0%');
    expect(reading.basis).toBeNull();
  });

  it('keeps a genuine zero as a zero when the record carries a real total', () => {
    // The non-vacuity case: a machine whose memory probe succeeded and found
    // nothing in use must not become indistinguishable from a probe that never
    // ran, or the honest path stops being a working meter.
    const reading = decodeMemoryReading({ total_mb: 16384, available_mb: 16384, used_mb: 0, used_percent: 0 });
    expect(reading.kind).toBe('measured');
    expect(reading.percent).toBe(0);
    expect(reading.label).toBe('0.0%');
    expect(reading.basis).toBeNull();
  });

  it('rounds a real reading to the one decimal place the Overview already printed', () => {
    // Native computes the percentage by integer division, so 25 is the finest
    // reading the record can carry and `25.0%` is the existing rendering.
    const reading = decodeMemoryReading(record({ used_percent: 100 }));
    expect(reading.label).toBe('100.0%');
    const low = decodeMemoryReading(record({ used_percent: 7 }));
    expect(low.label).toBe('7.0%');
  });

  it('ignores the used and available counts, which are zeroed by the same sentinel', () => {
    // Only `total_mb` discriminates; `used_mb` and `available_mb` are zero on the
    // same record and must not be mistaken for the basis of the reading.
    const reading = decodeMemoryReading({ total_mb: 16384, available_mb: 0, used_mb: 0, used_percent: 0 });
    expect(reading.kind).toBe('measured');
    expect(reading.percent).toBe(0);
  });
});

describe('memory reading unreadable records', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true],
    ['a number', 42],
    ['a string', '25%'],
    ['an array', [16384, 50]],
  ])('reads %s in place of a memory record as carrying no reading at all', (_label, value) => {
    const reading = decodeMemoryReading(value);
    expect(reading.kind).toBe('unavailable');
    expect(reading.kind === 'unavailable' && reading.reason).toBe('no-record');
    expect(reading.percent).toBeNull();
    expect(reading.basis).toBe(
      'This system health record carries no memory reading, so memory use cannot be measured.',
    );
  });

  it.each([
    ['null', null],
    ['a numeric string', '16384'],
    ['a negative count', -1],
    ['a non-finite count', Number.POSITIVE_INFINITY],
    ['a fractional count', 16384.5],
  ])('reads a total that is %s as unreadable', (_label, total_mb) => {
    const reading = decodeMemoryReading(record({ total_mb }));
    expect(reading.kind === 'unavailable' && reading.reason).toBe('unreadable-total');
    expect(reading.basis).toBe(
      'The memory total in this system health record is not a readable count, so memory use cannot be measured.',
    );
  });

  it.each([
    ['null', null],
    ['a numeric string', '50'],
    ['a negative percentage', -1],
    ['a percentage above the window', 101],
    ['a non-finite percentage', Number.NaN],
    ['a fractional percentage', 25.4],
  ])('reads a percentage that is %s as unreadable', (_label, used_percent) => {
    const reading = decodeMemoryReading(record({ used_percent }));
    expect(reading.kind === 'unavailable' && reading.reason).toBe('unreadable-percent');
    expect(reading.percent).toBeNull();
    expect(reading.label).toBe(MEMORY_UNMEASURED_LABEL);
    expect(reading.basis).toBe(
      'The memory percentage in this system health record is not a readable measurement, so memory use cannot be measured.',
    );
  });

  it('reads a missing percentage key as unreadable rather than as zero', () => {
    const reading = decodeMemoryReading(without('used_percent'));
    expect(reading.kind === 'unavailable' && reading.reason).toBe('unreadable-percent');
    expect(reading.percent).toBeNull();
  });

  it('checks the total before the percentage, because a missing total is the measured fact', () => {
    // A record that failed both ways reports the one that explains the record:
    // without a total there is no basis for a percentage at all.
    const reading = decodeMemoryReading(without('total_mb'));
    expect(reading.kind === 'unavailable' && reading.reason).toBe('unreadable-total');
  });

  it('keeps the two mounted surfaces on one verdict for the same record', () => {
    // The Overview and the top bar read the same field; one decoder means the
    // same record cannot produce a number in one and a sentence in the other.
    const sentinel = { total_mb: 0, available_mb: 0, used_mb: 0, used_percent: 0 };
    expect(decodeMemoryReading(sentinel)).toEqual(decodeMemoryReading({ ...sentinel }));
    const measured = record({ used_percent: 42 });
    expect(decodeMemoryReading(measured).percent).toBe(42);
  });
});
