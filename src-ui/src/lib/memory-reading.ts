// Memory use is one of the two resource readings the surfaces show, and it is
// the one Native reports in two different "unreadable" conventions. The disk
// probe in the same command answers an unreadable probe with the string `"?"`;
// the memory probe answers with a zeroed record — `total_mb: 0, available_mb: 0,
// used_mb: 0, used_percent: 0` — after a `cat /proc/meminfo` that cannot run on
// any host where `wsl_openclaw` is not a WSL call. That zero is a sentinel for
// *not measured*, and both mounted readers took it as a real reading: the
// Overview printed `0.0%` in the same muted tone as a real number, and the top
// bar printed an emerald `MEM 0%` chip — the reading that most strongly says
// nothing is wrong here.
//
// This module is where that verdict is derived, so the two surfaces cannot
// disagree about the same field. `total_mb` is the discriminator the record
// already carries and the decoder no longer throws away: a real machine never
// reports a zero total, so a zero separates "the probe did not report" from a
// genuine `used_percent: 0`. A real reading keeps its percentage, exactly as
// before. Anything this build cannot vouch for reads as `Not measured` with one
// fixed sentence naming what could not be read, and never as a number.
//
// Pure: no React, no Tauri, no clock. The record is read as `unknown` on
// purpose — a drifted or half-written health record arrives at the surface
// exactly as Native serialised it, and this is where that is decided.

/** Printed in place of a percentage whenever memory use cannot be measured. */
export const MEMORY_UNMEASURED_LABEL = 'Not measured';

export type MemoryUnavailableReason =
  /** The health record carries no memory object at all. */
  | 'no-record'
  /** Native's zeroed record: the probe ran and reported nothing. */
  | 'unprobed'
  | 'unreadable-total'
  | 'unreadable-percent';

export type MemoryReading =
  | {
      kind: 'measured';
      reason: null;
      /** The real percentage, for the surfaces' own 80/90 thresholds to read. */
      percent: number;
      label: string;
      /** A measurement carries no correction; the percentage is the whole claim. */
      basis: null;
    }
  | {
      kind: 'unavailable';
      reason: MemoryUnavailableReason;
      /** Null, so no surface can print a number it does not have. */
      percent: null;
      label: string;
      basis: string;
    };

const BASIS: Record<MemoryUnavailableReason, string> = {
  'no-record':
    'This system health record carries no memory reading, so memory use cannot be measured.',
  unprobed: 'The memory probe reported no total, so memory use cannot be measured.',
  'unreadable-total':
    'The memory total in this system health record is not a readable count, so memory use cannot be measured.',
  'unreadable-percent':
    'The memory percentage in this system health record is not a readable measurement, so memory use cannot be measured.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unavailable(reason: MemoryUnavailableReason): MemoryReading {
  return { kind: 'unavailable', reason, percent: null, label: MEMORY_UNMEASURED_LABEL, basis: BASIS[reason] };
}

export function decodeMemoryReading(value: unknown): MemoryReading {
  if (!isRecord(value)) return unavailable('no-record');

  const total = value.total_mb;
  // A zero total is the sentinel, checked before readability so the zeroed
  // record reports as unprobed rather than as an unreadable field. It wins over
  // any percentage: without a total there is no basis for one.
  if (total === 0) return unavailable('unprobed');
  if (typeof total !== 'number' || !Number.isFinite(total) || !Number.isInteger(total) || total < 0) {
    return unavailable('unreadable-total');
  }

  const percent = value.used_percent;
  // Native computes the percentage by integer division, so a fractional value is
  // a record this build cannot vouch for rather than a reading to round. The
  // range check matches the shared `parsePercent` this decoder replaces for the
  // memory field, so neither row invents a different window.
  if (typeof percent !== 'number' || !Number.isFinite(percent) || !Number.isInteger(percent) || percent < 0 || percent > 100) {
    return unavailable('unreadable-percent');
  }

  return { kind: 'measured', reason: null, percent, label: `${percent.toFixed(1)}%`, basis: null };
}
