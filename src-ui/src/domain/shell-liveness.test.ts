import { describe, expect, it } from 'vitest';
import {
  initialAlertChannelState,
  reduceAlertChannel,
  type AlertChannelId,
  type AlertChannelState,
  type AlertChannelStatus,
} from './registry-alert-channel';
import { projectShellLiveness } from './shell-liveness';

function withChannels(
  statuses: Partial<Record<AlertChannelId, AlertChannelStatus>>,
): AlertChannelState {
  return {
    attempt: 1,
    channels: {
      'alerts-read': statuses['alerts-read'] ?? 'pending',
      'alerts-events': statuses['alerts-events'] ?? 'pending',
      'missed-read': statuses['missed-read'] ?? 'pending',
      'missed-events': statuses['missed-events'] ?? 'pending',
    },
  };
}

/** Everything answered: reads delivered, subscriptions established. */
const ALL_ANSWERED: AlertChannelState = withChannels({
  'alerts-read': 'live',
  'alerts-events': 'subscribed',
  'missed-read': 'live',
  'missed-events': 'subscribed',
});

describe('the shell liveness badge', () => {
  it('animates and says live only when every channel has answered', () => {
    const view = projectShellLiveness(ALL_ANSWERED);
    expect(view.claim).toBe('confirmed');
    expect(view.label).toBe('live');
    expect(view.pulse).toBe(true);
    expect(view.dot).toContain('bg-cyan-neon');
  });

  it('agrees with the delivery banner: a live read silences a refused subscription', () => {
    // The banner stays quiet here, so the badge must not contradict it with
    // "events down" — it says delivery continues, degraded.
    const degraded = projectShellLiveness({ ...ALL_ANSWERED, channels: { ...ALL_ANSWERED.channels, 'alerts-events': 'failed' } });
    expect(degraded.claim).toBe('degraded');
    expect(degraded.label).toBe('reads partial');
    expect(degraded.pulse).toBe(false);
    expect(degraded.dot).not.toContain('bg-amber-400');
    expect(degraded.basis).toMatch(/delivery continues/);
  });

  it('says unreadable only when both delivery paths of a subject are dead', () => {
    const unreachable = projectShellLiveness({ ...ALL_ANSWERED, channels: { ...ALL_ANSWERED.channels, 'missed-read': 'failed', 'missed-events': 'failed' } });
    expect(unreachable.claim).toBe('unavailable');
    expect(unreachable.label).toBe('unreachable');
    expect(unreachable.pulse).toBe(false);
    expect(unreachable.dot).toContain('bg-amber-400');
    expect(unreachable.basis).toMatch(/cannot reach you/);
    // The refused pair does not drag the still-delivering subject into the claim.
    expect(unreachable.basis).not.toMatch(/every delivery path/);
  });

  it('names the channels it is reporting, so the word `live` is not the whole claim', () => {
    const view = projectShellLiveness(ALL_ANSWERED);
    expect(view.basis).toMatch(/delivery channels/);
    expect(view.basis).toMatch(/answered|delivered/);
    // A fixed sentence: no channel name, count, or caught value interpolated.
    expect(projectShellLiveness(ALL_ANSWERED).basis).toBe(view.basis);
  });

  it.each([
    { label: 'one channel pending', state: withChannels({ 'alerts-read': 'live', 'alerts-events': 'live' }) },
    { label: 'all four pending', state: withChannels({}) },
  ])('claims nothing while $label', ({ state }) => {
    const view = projectShellLiveness(state);
    expect(view.claim).toBe('unanswered');
    expect(view.label).toBe('checking');
    expect(view.pulse).toBe(false);
    expect(view.basis).toMatch(/not all answered/);
  });

  it.each<[AlertChannelId]>([
    ['alerts-read'], ['missed-read'],
  ])(
    'treats a refused read as degraded delivery while its event channel answers',
    (channel) => {
      const view = projectShellLiveness({ ...ALL_ANSWERED, channels: { ...ALL_ANSWERED.channels, [channel]: 'failed' } });
      expect(view.claim).toBe('degraded');
      expect(view.pulse).toBe(false);
    },
  );

  it('does not claim confirmed delivery from a refused read with a live event channel alone', () => {
    // Reads are the deliverer; a confirmed badge requires them to have answered
    // with a successful read, not a refusal.
    const view = projectShellLiveness(withChannels({
      'alerts-read': 'failed',
      'alerts-events': 'live',
      'missed-read': 'live',
      'missed-events': 'live',
    }));
    expect(view.claim).toBe('degraded');
  });

  it('prefers the strongest claim over the unanswered one', () => {
    const view = projectShellLiveness(withChannels({
      'alerts-read': 'live',
      'alerts-events': 'failed',
      'missed-read': 'pending',
      'missed-events': 'pending',
    }));
    expect(view.claim).toBe('degraded');
    expect(view.pulse).toBe(false);
  });

  it('returns to the confirmed claim when a re-armed attempt answers', () => {
    let state = initialAlertChannelState();
    state = reduceAlertChannel(state, { type: 'begin', attempt: 1 });
    state = reduceAlertChannel(state, { type: 'failed', attempt: 1, channel: 'alerts-events' });
    state = reduceAlertChannel(state, { type: 'failed', attempt: 1, channel: 'missed-events' });
    expect(projectShellLiveness(state).label).toBe('reads partial');

    state = reduceAlertChannel(state, { type: 'begin', attempt: 2 });
    expect(projectShellLiveness(state).label).toBe('checking');

    for (const channel of ['alerts-read', 'alerts-events', 'missed-read', 'missed-events'] as AlertChannelId[]) {
      state = reduceAlertChannel(state, { type: 'live', attempt: 2, channel });
    }
    const view = projectShellLiveness(state);
    expect(view.claim).toBe('confirmed');
    expect(view.label).toBe('live');
    expect(view.pulse).toBe(true);
  });

  it('keeps the claims visually distinct without colour alone', () => {
    const labels = [
      projectShellLiveness(ALL_ANSWERED).label,
      projectShellLiveness(withChannels({})).label,
      projectShellLiveness(withChannels({ 'alerts-read': 'failed', 'alerts-events': 'subscribed', 'missed-read': 'live', 'missed-events': 'subscribed' })).label,
      projectShellLiveness(withChannels({ 'alerts-read': 'failed', 'alerts-events': 'failed', 'missed-read': 'live', 'missed-events': 'live' })).label,
    ];
    expect(new Set(labels).size).toBe(4);
  });
});
