import { describe, expect, it } from 'vitest';
import {
  SKEW_TOLERANCE_MS,
  channelProbePhase,
  decodeChannelFlag,
  formatChannelAge,
  projectChannelLiveness,
  type ChannelLivenessRecord,
} from './channel-liveness';
import { isConnected } from './channel-state';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const channel = (config: unknown = { channel_id: '123' }, connected = false): ChannelLivenessRecord => ({
  connected,
  config: config as ChannelLivenessRecord['config'],
});
const stored = channel({ channel_id: '123', connected: true, last_connected: ago(2 * DAY) });
const settled = { verified: false, probe: 'none' } as const;

describe('stored channel flag decoding', () => {
  it('reads a login flag Native wrote as on or off', () => {
    expect(decodeChannelFlag(stored)).toBe('on');
    expect(decodeChannelFlag(channel({ channel_id: '123', connected: true }))).toBe('on');
    expect(decodeChannelFlag(channel({ channel_id: '123', connected: false }))).toBe('off');
  });

  it('reads a record that never logged in as off rather than unreadable', () => {
    expect(decodeChannelFlag(channel())).toBe('off');
    expect(decodeChannelFlag(channel({}))).toBe('off');
  });

  it('reads the top-level flag the way the recorded-state reader does', () => {
    expect(decodeChannelFlag(channel(null, true))).toBe('on');
    expect(isConnected({ connected: true, config: null })).toBe(true);
  });

  it('refuses to read a flag that is absent, drifted, or not an object', () => {
    expect(decodeChannelFlag(channel(null))).toBe('unreadable');
    expect(decodeChannelFlag(channel('{"connected":true}'))).toBe('unreadable');
    expect(decodeChannelFlag(channel([{ connected: true }]))).toBe('unreadable');
    for (const value of ['true', 1, 0, null, undefined, {}, []]) {
      expect(decodeChannelFlag(channel({ channel_id: '123', connected: value }))).toBe('unreadable');
    }
  });

  it('never rewrites what the recorded-state reader concluded', () => {
    const shapes: ChannelLivenessRecord[] = [
      stored, channel(), channel(null), channel('nope'),
      channel({ connected: 'true' }), channel(null, true),
    ];
    for (const shape of shapes) {
      expect(projectChannelLiveness(shape, settled, NOW).recordedConnected)
        .toBe(isConnected(shape as unknown as Parameters<typeof isConnected>[0]));
    }
  });
});

describe('channel age formatting', () => {
  it('names an age in the largest unit that still reads as an age', () => {
    expect(formatChannelAge(0)).toBe('0s');
    expect(formatChannelAge(45_000)).toBe('45s');
    expect(formatChannelAge(59 * 60_000)).toBe('59m');
    expect(formatChannelAge(HOUR)).toBe('1h');
    expect(formatChannelAge(2 * HOUR + 200_000)).toBe('2h');
    expect(formatChannelAge(2 * DAY)).toBe('2d');
  });

  it('reads an unreadable age rather than printing a number', () => {
    expect(formatChannelAge(null)).toBe('unknown');
    expect(formatChannelAge(-5_000)).toBe('0s');
    expect(formatChannelAge(Number.NaN)).toBe('unknown');
    expect(formatChannelAge(Number.POSITIVE_INFINITY)).toBe('unknown');
  });
});

describe('channel liveness projection', () => {
  it('never lets a stored flag read as a live connection', () => {
    const liveness = projectChannelLiveness(stored, settled, NOW);
    expect(liveness.claim).toBe('stored');
    expect(liveness.claimLabel).toBe('Stored as connected');
    expect(liveness.tone).toBe('warn');
    expect(liveness.confirmed).toBe(false);
    expect(liveness.stale).toBe(false);
    expect(liveness.flag).toBe('on');
    expect(liveness.recordedConnected).toBe(true);
    expect(liveness.basis).toBe('The stored login flag was last set 2d ago. Daedalus only checks a channel when you ask it to.');
    expect(liveness.announcement).toBe(`Stored as connected. ${liveness.basis}`);
  });

  it('names the login time when the record carries a readable one', () => {
    const recent = channel({ channel_id: '123', connected: true, last_connected: ago(3 * HOUR) });
    const liveness = projectChannelLiveness(recent, settled, NOW);
    expect(liveness.storedAt).toBe(NOW - 3 * HOUR);
    expect(liveness.storedAge).toBe('3h');
    expect(liveness.basis).toContain('last set 3h ago');
  });

  it('falls back to a nameless flag rather than printing an unreadable stamp', () => {
    for (const value of ['yesterday', 1_756_000_000_000, {}, [], '', '   ']) {
      const liveness = projectChannelLiveness(channel({ channel_id: '123', connected: true, last_connected: value }), settled, NOW);
      expect(liveness.storedAt).toBeNull();
      expect(liveness.storedAge).toBe('unknown');
      expect(liveness.claim).toBe('stored');
      expect(liveness.basis).toBe('The stored login flag is set with no login time Daedalus can read. Daedalus only checks a channel when you ask it to.');
    }
  });

  it('refuses a login time this machine could not have written', () => {
    const skewed = channel({ channel_id: '123', connected: true, last_connected: new Date(NOW + 4 * HOUR).toISOString() });
    const inside = channel({ channel_id: '123', connected: true, last_connected: new Date(NOW + SKEW_TOLERANCE_MS - 1).toISOString() });
    expect(projectChannelLiveness(skewed, settled, NOW).storedAt).toBeNull();
    expect(projectChannelLiveness(inside, settled, NOW).storedAt).toBe(NOW + SKEW_TOLERANCE_MS - 1);
  });

  it('reads a confirmed probe as connected and rests the claim on the probe', () => {
    const liveness = projectChannelLiveness(stored, { verified: true, probe: 'none' }, NOW);
    expect(liveness.claim).toBe('confirmed');
    expect(liveness.claimLabel).toBe('Connected');
    expect(liveness.tone).toBe('success');
    expect(liveness.confirmed).toBe(true);
    expect(liveness.stale).toBe(false);
    expect(liveness.basis).toBe('A probe confirmed a message reached this channel, so the claim rests on that check.');
  });

  it('keeps the last confirmation after a probe fails, marked stale', () => {
    const liveness = projectChannelLiveness(stored, { verified: true, probe: 'failed' }, NOW);
    expect(liveness.claim).toBe('confirmed');
    expect(liveness.claimLabel).toBe('Connected');
    expect(liveness.confirmed).toBe(true);
    expect(liveness.stale).toBe(true);
    expect(liveness.tone).toBe('warn');
    expect(liveness.basis).toContain('may be stale');
  });

  it('claims nothing while a probe is in flight, confirmed or not', () => {
    for (const verified of [true, false]) {
      for (const flag of [stored, channel()]) {
        const liveness = projectChannelLiveness(flag, { verified, probe: 'probing' }, NOW);
        expect(liveness.claim).toBe('probing');
        expect(liveness.claimLabel).toBe('Probing');
        expect(liveness.confirmed).toBe(false);
        expect(liveness.stale).toBe(false);
        expect(liveness.tone).toBe('default');
        expect(liveness.basis).toBe('A probe is in flight, so no connection is claimed until it settles.');
      }
    }
  });

  it('keeps the claim a probe confirmed even when the stored flag never turned on', () => {
    const liveness = projectChannelLiveness(channel(), { verified: true, probe: 'none' }, NOW);
    expect(liveness.claim).toBe('confirmed');
    expect(liveness.flag).toBe('off');
    expect(liveness.recordedConnected).toBe(false);
  });

  it('reads a channel with no stored login as not connected, not as broken', () => {
    const liveness = projectChannelLiveness(channel(), settled, NOW);
    expect(liveness.claim).toBe('not-connected');
    expect(liveness.claimLabel).toBe('Not connected');
    expect(liveness.tone).toBe('default');
    expect(liveness.confirmed).toBe(false);
    expect(liveness.storedAt).toBeNull();
    expect(liveness.basis).toBe('No stored login flag is set for this channel. Daedalus only checks a channel when you ask it to.');
  });

  it('names the last recorded login for a channel that is not connected', () => {
    const liveness = projectChannelLiveness(channel({ channel_id: '123', connected: false, last_connected: ago(6 * HOUR) }), settled, NOW);
    expect(liveness.claim).toBe('not-connected');
    expect(liveness.basis).toContain('last recorded login was 6h ago');
  });

  it('claims no connection at all for a flag it cannot read', () => {
    const liveness = projectChannelLiveness(channel(null), { verified: false, probe: 'none' }, NOW);
    expect(liveness.claim).toBe('flag-unreadable');
    expect(liveness.claimLabel).toBe('Flag not readable');
    expect(liveness.tone).toBe('warn');
    expect(liveness.confirmed).toBe(false);
    expect(liveness.basis).toBe('The stored record carries no login flag Daedalus can read, so no connection is claimed.');
  });

  it('keeps a store value out of the sentence an operator reads', () => {
    const drifted = channel({ channel_id: '123', connected: 'sk-legacy-token-value' });
    for (const evidence of [settled, { verified: true, probe: 'none' as const }, { verified: false, probe: 'probing' as const }]) {
      const liveness = projectChannelLiveness(drifted, evidence, NOW);
      expect(liveness.announcement).not.toMatch(/sk-legacy|token|channel_id|123/);
    }
  });

  it('is a pure function of its inputs', () => {
    const record = channel({ channel_id: '123', connected: true, last_connected: ago(HOUR) });
    const first = projectChannelLiveness(record, settled, NOW);
    const second = projectChannelLiveness(record, settled, NOW);
    expect(first).toEqual(second);
    (record.config as Record<string, unknown>).connected = false;
    expect(projectChannelLiveness(record, settled, NOW).storedAt).toBe(first.storedAt);
  });
});

describe('probe phase from a row operation', () => {
  it('maps only a connect write to a probe in flight or a probe that failed', () => {
    expect(channelProbePhase(undefined)).toBe('none');
    expect(channelProbePhase({ action: 'connect', phase: 'writing' })).toBe('probing');
    expect(channelProbePhase({ action: 'connect', phase: 'verification-failed' })).toBe('failed');
  });

  it('claims no probe for a phase that never sent anything', () => {
    const phases = ['writing', 'write-failed', 'reconciling', 'read-failed', 'verification-failed'];
    for (const action of ['disconnect', 'remove'] as const) {
      for (const phase of phases) expect(channelProbePhase({ action, phase })).toBe('none');
    }
    for (const phase of ['write-failed', 'reconciling', 'read-failed'] as const) {
      expect(channelProbePhase({ action: 'connect', phase })).toBe('none');
    }
  });
});
