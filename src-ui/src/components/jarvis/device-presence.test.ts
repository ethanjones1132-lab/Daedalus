import { describe, expect, it } from 'vitest';
import {
  DEVICE_STATUSES,
  PAIRING_WINDOW_MS,
  formatDeviceAge,
  projectDevicePresence,
  type DeviceRecord,
} from './device-presence';

const NOW = Date.parse('2026-09-25T12:00:00.000Z');

function record(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return { status: 'online', last_seen: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(), ...overrides };
}

describe('projectDevicePresence — a stored online claim with a check-in behind it', () => {
  it('reads as checked in when the stamp predates the pairing window', () => {
    const presence = projectDevicePresence(record(), NOW);
    expect(presence.claim).toBe('checked-in');
    expect(presence.claimLabel).toBe('Checked in');
    expect(presence.checkedIn).toBe(true);
    expect(presence.checkIn).toBe('check-in');
    expect(presence.tone).toBe('success');
    expect(presence.lastSeenAt).toBe(NOW - 3 * 60 * 60 * 1000);
    expect(presence.lastSeenAgeMs).toBe(3 * 60 * 60 * 1000);
    expect(presence.lastSeenAge).toBe('3h');
  });

  it('prints the basis as text naming the stored timestamp', () => {
    const presence = projectDevicePresence(record(), NOW);
    expect(presence.basis).toBe('Last stamped 3h ago. This is a stored timestamp — Daedalus does not probe devices.');
    expect(presence.announcement).toContain('Checked in');
    expect(presence.announcement).toContain('3h ago');
  });

  it('keeps the stored status string verbatim', () => {
    expect(projectDevicePresence(record({ status: 'OnLiNe' }), NOW).recorded).toBe('OnLiNe');
  });

  it('accepts a stamp at the far edge of the pairing window as a check-in', () => {
    const at = NOW - PAIRING_WINDOW_MS;
    expect(projectDevicePresence(record({ last_seen: new Date(at).toISOString() }), NOW).claim).toBe('checked-in');
  });
});

describe('projectDevicePresence — a freshly paired device was never probed', () => {
  it('does not read as online when the stamp is the pairing moment', () => {
    const presence = projectDevicePresence(record({ last_seen: new Date(NOW - 4_000).toISOString() }), NOW);
    expect(presence.claim).toBe('not-checked-in');
    expect(presence.claimLabel).toBe('Not checked in');
    expect(presence.checkedIn).toBe(false);
    expect(presence.checkIn).toBe('pairing-stamp');
    expect(presence.tone).toBe('warn');
  });

  it('names the pairing stamp as the basis instead of a heartbeat', () => {
    const presence = projectDevicePresence(record({ last_seen: new Date(NOW - 4_000).toISOString() }), NOW);
    expect(presence.basis).toBe('Stamped 4s ago, and Daedalus only writes that field when a device is paired, so no check-in is recorded.');
    expect(presence.announcement).toContain('Not checked in');
  });

  it('treats any stamp inside the pairing window as the pairing moment', () => {
    for (const ageMs of [0, 1, PAIRING_WINDOW_MS - 1]) {
      const presence = projectDevicePresence(record({ last_seen: new Date(NOW - ageMs).toISOString() }), NOW);
      expect(presence.checkIn).toBe('pairing-stamp');
      expect(presence.checkedIn).toBe(false);
    }
  });

  it('clamps a slightly future stamp to the pairing moment rather than a check-in', () => {
    const presence = projectDevicePresence(record({ last_seen: new Date(NOW + 2_000).toISOString() }), NOW);
    expect(presence.checkIn).toBe('pairing-stamp');
    expect(presence.lastSeenAgeMs).toBe(0);
    expect(presence.lastSeenAge).toBe('0s');
  });

  it('rejects a stamp far in the future as unreadable rather than as a check-in', () => {
    const presence = projectDevicePresence(record({ last_seen: new Date(NOW + 6 * 60 * 60 * 1000).toISOString() }), NOW);
    expect(presence.claim).toBe('not-verified');
    expect(presence.checkIn).toBe('unreadable-stamp');
    expect(presence.checkedIn).toBe(false);
    expect(presence.lastSeenAt).toBeNull();
  });
});

describe('projectDevicePresence — an unreadable stamp can never back a check-in', () => {
  const unreadable = ['never', 'yesterday', 'null', 'undefined', 12345, {}] as const;
  const blank = ['', '   ', null, undefined] as const;

  it.each([...unreadable, ...blank])('refuses to read a %p last-seen value as a check-in', (last_seen) => {
    const presence = projectDevicePresence({ status: 'online', last_seen }, NOW);
    expect(presence.claim).toBe('not-verified');
    expect(presence.claimLabel).toBe('Not verified');
    expect(presence.checkedIn).toBe(false);
    expect(presence.tone).toBe('warn');
    expect(presence.lastSeenAt).toBeNull();
    expect(presence.lastSeenAgeMs).toBeNull();
    expect(presence.lastSeenAge).toBe('unknown');
  });

  it.each(unreadable)('names a present but unreadable %p stamp as unreadable', (last_seen) => {
    expect(projectDevicePresence({ status: 'online', last_seen }, NOW).checkIn).toBe('unreadable-stamp');
  });

  it.each(blank)('names an absent or blank %p stamp as unstamped', (last_seen) => {
    expect(projectDevicePresence({ status: 'online', last_seen }, NOW).checkIn).toBe('unstamped');
  });

  it('never echoes an unparsable stored value back as if it were a time', () => {
    const presence = projectDevicePresence({ status: 'online', last_seen: 'yesterday' }, NOW);
    expect(presence.basis).toBe('Stored status "online" with a last-seen value Daedalus cannot read, so no check-in can be shown.');
    expect(presence.basis).not.toContain('yesterday');
  });

  it('refuses a non-finite epoch string', () => {
    expect(projectDevicePresence({ status: 'online', last_seen: '275760-09-13T00:00:00.000Z' }, NOW).claim).toBe('not-verified');
  });
});

describe('projectDevicePresence — a stored status the app does not define', () => {
  it('reports a stored offline without claiming a check-in', () => {
    const presence = projectDevicePresence(record({ status: 'offline' }), NOW);
    expect(presence.claim).toBe('offline');
    expect(presence.claimLabel).toBe('Offline');
    expect(presence.tone).toBe('default');
    expect(presence.checkedIn).toBe(false);
    expect(presence.checkIn).toBe('check-in');
    expect(presence.basis).toBe('Stored status "offline"; last stamped 3h ago.');
  });

  it('reports a stored unknown the way the Nodes surface does, not as a failure', () => {
    const presence = projectDevicePresence(record({ status: 'unknown' }), NOW);
    expect(presence.claim).toBe('unknown');
    expect(presence.claimLabel).toBe('Unknown');
    expect(presence.tone).toBe('warn');
    expect(presence.basis).toBe('Stored status "unknown"; no check-in has been recorded for this device.');
  });

  it('never promotes a status Daedalus does not define to online', () => {
    for (const status of ['connected', 'ok', 'online-ish', 'ONLINE2', 'on line', 'online.']) {
      const presence = projectDevicePresence(record({ status }), NOW);
      expect(presence.claim).toBe('unrecognised');
      expect(presence.checkedIn).toBe(false);
      expect(presence.tone).toBe('default');
    }
  });

  it('reads a stored status that only differs by case or surrounding space', () => {
    expect(projectDevicePresence(record({ status: 'ONLINE' }), NOW).claim).toBe('checked-in');
    expect(projectDevicePresence(record({ status: ' Online ' }), NOW).claim).toBe('checked-in');
    expect(projectDevicePresence(record({ status: ' Online ' }), NOW).recorded).toBe(' Online ');
  });

  it('names the unrecognised status as recorded, bounded', () => {
    const presence = projectDevicePresence(record({ status: 'semi-online-probably' }), NOW);
    expect(presence.claim).toBe('unrecognised');
    expect(presence.basis).toBe('Stored status "semi-online-probably" is not a status Daedalus defines, so no liveness claim is made.');
    expect(projectDevicePresence(record({ status: 'x'.repeat(200) }), NOW).basis).toContain('…');
    expect(projectDevicePresence(record({ status: 'x'.repeat(200) }), NOW).recorded).toHaveLength(200);
  });

  it('refuses a record whose status is not a readable string', () => {
    for (const status of ['', '   ', null, undefined, 7, {}]) {
      const presence = projectDevicePresence({ status, last_seen: record().last_seen }, NOW);
      expect(presence.claim).toBe('not-verified');
      expect(presence.recorded).toBe('');
      expect(presence.basis).toBe('The stored record carries no readable status, so no liveness claim is made.');
    }
  });

  it('says the stored status is missing a readable stamp for a non-online record', () => {
    expect(projectDevicePresence({ status: 'offline', last_seen: '' }, NOW).basis).toBe('Stored status "offline"; no readable last-seen value is stored.');
  });
});

describe('the device status vocabulary is the one Native writes', () => {
  it('defines exactly the statuses Daedalus can speak about', () => {
    expect([...DEVICE_STATUSES].sort()).toEqual(['offline', 'online', 'unknown']);
  });

  it('matches the sibling Nodes vocabulary for a never-observed record', () => {
    expect(projectDevicePresence(record({ status: 'unknown' }), NOW).tone).toBe('warn');
  });
});

describe('formatDeviceAge', () => {
  it.each([
    [0, '0s'],
    [999, '1s'],
    [45_000, '45s'],
    [59_999, '60s'],
    [60_000, '1m'],
    [59 * 60_000, '59m'],
    [60 * 60_000, '1h'],
    [23 * 3_600_000, '23h'],
    [24 * 3_600_000, '1d'],
    [9 * 86_400_000, '9d'],
  ])('renders %ims as %s', (ms, expected) => {
    expect(formatDeviceAge(ms)).toBe(expected);
  });

  it('prints unknown for a missing age rather than a number', () => {
    expect(formatDeviceAge(null)).toBe('unknown');
  });
});

describe('projectDevicePresence — the projection is a pure read of the record', () => {
  it('never mutates its input', () => {
    const input = record();
    const snapshot = JSON.stringify(input);
    projectDevicePresence(input, NOW);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('is deterministic for a fixed clock', () => {
    expect(projectDevicePresence(record(), NOW)).toEqual(projectDevicePresence(record(), NOW));
  });

  it('reads only status and last_seen, so extra stored fields cannot change the claim', () => {
    const widened = { ...record(), name: 'Studio Mac', id: 'd1', device_type: 'desktop', extra: true } as DeviceRecord;
    expect(projectDevicePresence(widened, NOW)).toEqual(projectDevicePresence(record(), NOW));
  });
});
