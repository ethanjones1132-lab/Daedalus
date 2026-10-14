// ═══════════════════════════════════════════════════════════════
// ── channel-liveness — a stored login flag separated from a probe
// ═══════════════════════════════════════════════════════════════
//
// `login_channel` writes `config.connected: true` together with
// `config.last_connected: <now>` and bumps `updated_at` (src-tauri/src/commands/channels.rs:119-150);
// `logout_channel` clears only the flag and leaves `last_connected` behind (:154-181).
// Nothing in `src-tauri/` probes a channel, and `list_channels` returns the top-level
// `connected` field as a literal `false` (:37-63), so a channel row's flag records one
// moment: the login that set it. `isConnected` stays the reader of that recorded state —
// this module never rewrites it — but a stored flag is not an observation, so it cannot
// be the liveness claim a row makes.
//
// The one observation a channel surface can make is the delivery probe the Channels
// route already runs (`verifyDelivery`, which POSTs to the Bun send route and requires
// a `delivered` receipt). That probe is point-in-time evidence, so a confirmation it
// produced is reported with its basis, kept when a later probe fails (marked stale),
// and withdrawn while a probe is in flight — an unsettled probe is not a reading.

import { isConnected } from './channel-state';

export interface ChannelLivenessRecord {
  connected?: unknown;
  config?: unknown;
}

/** What the stored record's login flag says, including when it says nothing readable. */
export type ChannelFlag = 'on' | 'off' | 'unreadable';

/** Where the row's own delivery probe stands. */
export type ChannelProbePhase = 'none' | 'probing' | 'failed';

export type ChannelClaim =
  | 'confirmed'
  | 'probing'
  | 'stored'
  | 'not-connected'
  | 'flag-unreadable';

export type ChannelTone = 'success' | 'warn' | 'default';

export interface ChannelProbeEvidence {
  /** A probe in this session reported a `delivered` receipt for this channel. */
  verified: boolean;
  probe: ChannelProbePhase;
}

export interface ChannelLiveness {
  claim: ChannelClaim;
  /** The words an operator reads, so no state depends on colour. */
  claimLabel: string;
  /** One fixed sentence naming the claim and its basis; no stored value reaches it. */
  basis: string;
  /** The whole row as one sentence, used as its accessible name. */
  announcement: string;
  tone: ChannelTone;
  /** True only when a delivery probe stands behind the claim. */
  confirmed: boolean;
  /** True when the last confirmation was not re-confirmed by the latest probe. */
  stale: boolean;
  flag: ChannelFlag;
  /** `isConnected`'s reading, reported unchanged so the row's affordances still agree. */
  recordedConnected: boolean;
  storedAt: number | null;
  storedAge: string;
}

/**
 * A login time further ahead than this cannot have been written by the machine reading
 * it, so it is clock skew rather than evidence of a login.
 */
export const SKEW_TOLERANCE_MS = 60_000;

const CLAIM_LABELS: Record<ChannelClaim, string> = {
  confirmed: 'Connected',
  probing: 'Probing',
  stored: 'Stored as connected',
  'not-connected': 'Not connected',
  'flag-unreadable': 'Flag not readable',
};

export function formatChannelAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'unknown';
  const clamped = Math.max(0, ms);
  if (clamped < 60_000) return `${Math.round(clamped / 1000)}s`;
  if (clamped < 3_600_000) return `${Math.round(clamped / 60_000)}m`;
  if (clamped < 86_400_000) return `${Math.round(clamped / 3_600_000)}h`;
  return `${Math.round(clamped / 86_400_000)}d`;
}

function configOf(record: ChannelLivenessRecord): Record<string, unknown> | null {
  const config = record.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  return config as Record<string, unknown>;
}

export function decodeChannelFlag(record: ChannelLivenessRecord): ChannelFlag {
  if (record.connected === true) return 'on';
  const config = configOf(record);
  if (config === null) return 'unreadable';
  if (!('connected' in config)) return 'off';
  return typeof config.connected === 'boolean' ? (config.connected ? 'on' : 'off') : 'unreadable';
}

function loginTime(config: Record<string, unknown> | null, now: number): number | null {
  const value = config?.last_connected;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed - now > SKEW_TOLERANCE_MS) return null;
  return parsed;
}

export interface ChannelOperationLike {
  action: string;
  phase: string;
}

/**
 * Only a `connect` write sends anything, so only a `connect` write can be a probe —
 * a rejected write proves the probe succeeded, and the later phases are Native writes.
 */
export function channelProbePhase(operation: ChannelOperationLike | undefined): ChannelProbePhase {
  if (!operation || operation.action !== 'connect') return 'none';
  if (operation.phase === 'writing') return 'probing';
  if (operation.phase === 'verification-failed') return 'failed';
  return 'none';
}

interface Stored {
  storedAt: number | null;
  storedAge: string;
}

function stored(config: Record<string, unknown> | null, now: number): Stored {
  const at = loginTime(config, now);
  if (at === null) return { storedAt: null, storedAge: 'unknown' };
  return { storedAt: at, storedAge: formatChannelAge(Math.max(0, now - at)) };
}

function liveness(
  record: ChannelLivenessRecord,
  claim: ChannelClaim,
  basis: string,
  flag: ChannelFlag,
  storedState: Stored,
  confirmed: boolean,
  stale: boolean,
): ChannelLiveness {
  const claimLabel = CLAIM_LABELS[claim];
  return {
    claim,
    claimLabel,
    basis,
    announcement: `${claimLabel}. ${basis}`,
    tone: claim === 'confirmed' ? (stale ? 'warn' : 'success') : claim === 'not-connected' ? 'default' : claim === 'probing' ? 'default' : 'warn',
    confirmed,
    stale,
    flag,
    recordedConnected: isConnected(record as unknown as Parameters<typeof isConnected>[0]),
    storedAt: storedState.storedAt,
    storedAge: storedState.storedAge,
  };
}

/**
 * Reads one channel row and reports the connection claim its evidence can carry, with
 * the basis printed as text. A stored flag is reported as a stored flag, a probe that
 * confirmed delivery is reported as a confirmed claim, and an unsettled probe makes no
 * claim at all.
 */
export function projectChannelLiveness(
  record: ChannelLivenessRecord,
  evidence: ChannelProbeEvidence,
  now: number = Date.now(),
): ChannelLiveness {
  const config = configOf(record);
  const flag = decodeChannelFlag(record);
  const storedState = stored(config, now);

  if (evidence.probe === 'probing') {
    return liveness(record, 'probing', 'A probe is in flight, so no connection is claimed until it settles.', flag, storedState, false, false);
  }
  if (evidence.verified) {
    return liveness(
      record,
      'confirmed',
      evidence.probe === 'failed'
        ? 'An earlier probe confirmed a message reached this channel, but the latest probe did not, so this may be stale.'
        : 'A probe confirmed a message reached this channel, so the claim rests on that check.',
      flag,
      storedState,
      true,
      evidence.probe === 'failed',
    );
  }
  if (flag === 'on') {
    return liveness(
      record,
      'stored',
      storedState.storedAt === null
        ? 'The stored login flag is set with no login time Daedalus can read. Daedalus only checks a channel when you ask it to.'
        : `The stored login flag was last set ${storedState.storedAge} ago. Daedalus only checks a channel when you ask it to.`,
      flag,
      storedState,
      false,
      false,
    );
  }
  if (flag === 'unreadable') {
    return liveness(record, 'flag-unreadable', 'The stored record carries no login flag Daedalus can read, so no connection is claimed.', flag, storedState, false, false);
  }
  return liveness(
    record,
    'not-connected',
    storedState.storedAt === null
      ? 'No stored login flag is set for this channel. Daedalus only checks a channel when you ask it to.'
      : `No stored login flag is set for this channel; the last recorded login was ${storedState.storedAge} ago.`,
    flag,
    storedState,
    false,
    false,
  );
}
