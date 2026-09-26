// ═══════════════════════════════════════════════════════════════
// ── device-presence — a recorded status separated from a check-in
// ═══════════════════════════════════════════════════════════════
//
// `add_device` writes `status: "online"` together with `last_seen: now_iso()`
// (src-tauri/src/commands/system.rs:679-692) and `get_devices` returns the
// stored vector unchanged (:673-677); the only other mutation of that vector
// anywhere in the repo is the `retain` in `remove_device` (:694-704). So a
// record this build created claims liveness on the strength of the moment it was
// paired, and nothing ever probes a device to replace that claim.
//
// A `last_seen` this close to the read therefore cannot be a heartbeat — it is
// the pairing stamp — and a device carrying one must not read as online. A stamp
// older than the pairing window was written by something this build does not own,
// so it is the only evidence that a check-in exists, and it is printed next to
// the claim. `add_node` stores `status: "unknown"` for the same never-observed
// case (:714-729) and the Nodes surface already treats that as a warning, so the
// two mounted surfaces no longer disagree about what a fresh record means.

export interface DeviceRecord {
  status?: unknown;
  last_seen?: unknown;
}

export type DeviceCheckIn = 'check-in' | 'pairing-stamp' | 'unreadable-stamp' | 'unstamped';

export type DeviceClaim =
  | 'checked-in'
  | 'not-checked-in'
  | 'not-verified'
  | 'offline'
  | 'unknown'
  | 'unrecognised';

export type DeviceTone = 'success' | 'warn' | 'default';

export interface DevicePresence {
  /** The stored status exactly as Native holds it; never rewritten here. */
  recorded: string;
  claim: DeviceClaim;
  /** The words an operator reads, so no state depends on colour. */
  claimLabel: string;
  /** One fixed sentence naming the claim and its basis; never stored text beyond the status. */
  basis: string;
  /** The whole row as one sentence, used as its accessible name. */
  announcement: string;
  tone: DeviceTone;
  /** True only when a check-in stands behind the stored claim. */
  checkedIn: boolean;
  checkIn: DeviceCheckIn;
  lastSeenAt: number | null;
  lastSeenAgeMs: number | null;
  lastSeenAge: string;
}

/** The only statuses Daedalus stores or speaks about for a paired device. */
export const DEVICE_STATUSES = ['online', 'offline', 'unknown'] as const;

/**
 * A stored stamp this recent cannot be a check-in: this build writes the field
 * exactly once, at `add_device`, with the current time. Anything older than this
 * window predates the read by more than a minute, so it cannot be the moment of
 * the read's own pairing.
 */
export const PAIRING_WINDOW_MS = 60_000;

const STATUS_TEXT_LIMIT = 40;

const CLAIM_LABELS: Record<DeviceClaim, string> = {
  'checked-in': 'Checked in',
  'not-checked-in': 'Not checked in',
  'not-verified': 'Not verified',
  offline: 'Offline',
  unknown: 'Unknown',
  unrecognised: 'Unrecognised',
};

export function formatDeviceAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'unknown';
  const clamped = Math.max(0, ms);
  if (clamped < 60_000) return `${Math.round(clamped / 1000)}s`;
  if (clamped < 3_600_000) return `${Math.round(clamped / 60_000)}m`;
  if (clamped < 86_400_000) return `${Math.round(clamped / 3_600_000)}h`;
  return `${Math.round(clamped / 86_400_000)}d`;
}

function readableStatus(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function boundedStatus(status: string): string {
  return status.length > STATUS_TEXT_LIMIT ? `${status.slice(0, STATUS_TEXT_LIMIT)}…` : status;
}

function stampOf(value: unknown, now: number): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  // A stamp beyond the pairing window in the future is not a check-in from this
  // record's own machine either, so it is unreadable rather than fresh.
  if (parsed - now > PAIRING_WINDOW_MS) return null;
  return parsed;
}

interface Stamped {
  lastSeenAt: number | null;
  lastSeenAgeMs: number | null;
  lastSeenAge: string;
  checkIn: DeviceCheckIn;
}

function stamp(value: unknown, now: number): Stamped {
  const at = stampOf(value, now);
  if (at === null) {
    // An absent field and a field holding something Daedalus cannot read are
    // different defects, so they are reported differently even though neither
    // can back a check-in.
    const blank = value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
    return {
      lastSeenAt: null,
      lastSeenAgeMs: null,
      lastSeenAge: 'unknown',
      checkIn: blank ? 'unstamped' : 'unreadable-stamp',
    };
  }
  const ageMs = Math.max(0, now - at);
  return {
    lastSeenAt: at,
    lastSeenAgeMs: ageMs,
    lastSeenAge: formatDeviceAge(ageMs),
    checkIn: ageMs < PAIRING_WINDOW_MS ? 'pairing-stamp' : 'check-in',
  };
}

function stampClause(stamped: Stamped): string {
  if (stamped.lastSeenAt === null) return 'no readable last-seen value is stored.';
  return `last stamped ${stamped.lastSeenAge} ago.`;
}

function presence(
  recorded: string,
  claim: DeviceClaim,
  basis: string,
  stamped: Stamped,
): DevicePresence {
  const claimLabel = CLAIM_LABELS[claim];
  return {
    recorded,
    claim,
    claimLabel,
    basis,
    announcement: `${claimLabel}. ${basis}`,
    tone: claim === 'checked-in' ? 'success' : claim === 'offline' || claim === 'unrecognised' ? 'default' : 'warn',
    checkedIn: claim === 'checked-in',
    ...stamped,
  };
}

/**
 * Reads one stored device row and reports the liveness claim it can actually
 * back, with the basis printed as text. The stored status is reported verbatim;
 * only the reading is derived, and a record that cannot back an online claim
 * never gets one.
 */
export function projectDevicePresence(device: DeviceRecord, now: number = Date.now()): DevicePresence {
  const stamped = stamp(device.last_seen, now);
  const raw = readableStatus(device.status);
  if (raw === null) {
    return presence('', 'not-verified', 'The stored record carries no readable status, so no liveness claim is made.', stamped);
  }

  const recorded = raw;
  switch (raw.trim().toLowerCase()) {
    case 'online':
      if (stamped.checkIn === 'check-in') {
        return presence(
          recorded,
          'checked-in',
          `Last stamped ${stamped.lastSeenAge} ago. This is a stored timestamp — Daedalus does not probe devices.`,
          stamped,
        );
      }
      if (stamped.checkIn === 'pairing-stamp') {
        return presence(
          recorded,
          'not-checked-in',
          `Stamped ${stamped.lastSeenAge} ago, and Daedalus only writes that field when a device is paired, so no check-in is recorded.`,
          stamped,
        );
      }
      return presence(
        recorded,
        'not-verified',
        'Stored status "online" with a last-seen value Daedalus cannot read, so no check-in can be shown.',
        stamped,
      );
    case 'offline':
      return presence(recorded, 'offline', `Stored status "offline"; ${stampClause(stamped)}`, stamped);
    case 'unknown':
      return presence(recorded, 'unknown', 'Stored status "unknown"; no check-in has been recorded for this device.', stamped);
    default:
      return presence(
        recorded,
        'unrecognised',
        `Stored status "${boundedStatus(recorded)}" is not a status Daedalus defines, so no liveness claim is made.`,
        stamped,
      );
  }
}
