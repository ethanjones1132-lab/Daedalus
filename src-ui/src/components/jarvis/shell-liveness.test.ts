import { describe, expect, it } from 'vitest';
import {
  initialAlertChannelState,
  reduceAlertChannel,
  type AlertChannelId,
  type AlertChannelState,
} from './registry-alert-channel';
import { projectShellLiveness } from './shell-liveness';

function withChannels(
  statuses: Partial<Record<AlertChannelId, 'pending' | 'live' | 'failed'>>,
): AlertChannelState {
  return {
    attempt: 1,
    channels: {
      'boot-read': statuses['boot-read'] ?? 'pending',
      'registry-events': statuses['registry-events'] ?? 'pending',
      'missed-cron-events': statuses['missed-cron-events'] ?? 'pending',
    },
  };
}

const ALL_LIVE: AlertChannelState = withChannels({
  'boot-read': 'live',
  'registry-events': 'live',
  'missed-cron-events': 'live',
});

describe('the shell liveness badge', () => {
  it('animates and says live only when every channel has answered', () => {
    const view = projectShellLiveness(ALL_LIVE);
    expect(view.claim).toBe('confirmed');
    expect(view.label).toBe('live');
    expect(view.pulse).toBe(true);
    expect(view.dot).toContain('bg-cyan-neon');
  });

  it('names the read it is reporting, so the word `live` is not the whole claim', () => {
    const view = projectShellLiveness(ALL_LIVE);
    expect(view.basis).toMatch(/Action registry alert/);
    expect(view.basis).toMatch(/answered/);
    // A fixed sentence: no channel name, count, or caught value interpolated.
    expect(projectShellLiveness(ALL_LIVE).basis).toBe(view.basis);
  });

  it.each([
    { label: 'one channel pending', state: withChannels({ 'boot-read': 'live', 'registry-events': 'live' }) },
    { label: 'all three pending', state: withChannels({}) },
  ])('claims nothing while $label', ({ state }) => {
    const view = projectShellLiveness(state);
    expect(view.claim).toBe('unanswered');
    expect(view.label).toBe('checking');
    expect(view.pulse).toBe(false);
    expect(view.basis).toMatch(/not all answered/);
  });

  it.each<[AlertChannelId]>([['boot-read'], ['registry-events'], ['missed-cron-events']])(
    'stops animating and stops saying live when %s is refused',
    (channel) => {
      const view = projectShellLiveness({ ...ALL_LIVE, channels: { ...ALL_LIVE.channels, [channel]: 'failed' } });
      expect(view.claim).toBe('unavailable');
      expect(view.label).toBe('events down');
      expect(view.pulse).toBe(false);
      expect(view.dot).toContain('bg-amber-400');
    },
  );

  it('prefers the refused claim over the unanswered one — a refusal is the stronger fact', () => {
    const view = projectShellLiveness(withChannels({
      'boot-read': 'live',
      'registry-events': 'failed',
      'missed-cron-events': 'pending',
    }));
    expect(view.claim).toBe('unavailable');
    expect(view.pulse).toBe(false);
  });

  it('returns to the confirmed claim when a re-armed attempt answers', () => {
    let state = initialAlertChannelState();
    state = reduceAlertChannel(state, { type: 'begin', attempt: 1 });
    state = reduceAlertChannel(state, { type: 'failed', attempt: 1, channel: 'registry-events' });
    expect(projectShellLiveness(state).label).toBe('events down');

    state = reduceAlertChannel(state, { type: 'begin', attempt: 2 });
    expect(projectShellLiveness(state).label).toBe('checking');

    for (const channel of ['boot-read', 'registry-events', 'missed-cron-events'] as AlertChannelId[]) {
      state = reduceAlertChannel(state, { type: 'live', attempt: 2, channel });
    }
    const view = projectShellLiveness(state);
    expect(view.label).toBe('live');
    expect(view.pulse).toBe(true);
  });

  it('keeps the three claims visually distinct without colour alone', () => {
    const labels = [
      projectShellLiveness(ALL_LIVE).label,
      projectShellLiveness(withChannels({})).label,
      projectShellLiveness(withChannels({ 'boot-read': 'failed' })).label,
    ];
    expect(new Set(labels).size).toBe(3);
  });
});
