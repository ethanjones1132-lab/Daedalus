import { describe, expect, it } from 'vitest';
import {
  ALERT_CHANNELS,
  ALERT_CHANNEL_HEADLINE,
  ALERT_CHANNEL_REASONS,
  RETRY_LABEL,
  initialAlertChannelState,
  projectAlertChannel,
  reduceAlertChannel,
  type AlertChannelAction,
  type AlertChannelId,
  type AlertChannelState,
} from './registry-alert-channel';

const ALERTS_READ: AlertChannelId = 'alerts-read';
const ALERTS_EVENTS: AlertChannelId = 'alerts-events';
const MISSED_READ: AlertChannelId = 'missed-read';
const MISSED_EVENTS: AlertChannelId = 'missed-events';

function settled(
  channels: Partial<Record<AlertChannelId, 'live' | 'subscribed' | 'failed'>> = {},
  attempt = 0,
): AlertChannelState {
  let state = initialAlertChannelState(attempt);
  for (const channel of ALERT_CHANNELS) {
    const status = channels[channel];
    if (!status) continue;
    state = reduceAlertChannel(state, { type: status, attempt, channel } as AlertChannelAction);
  }
  return state;
}

function dispatchAll(
  state: AlertChannelState,
  actions: AlertChannelAction[],
): AlertChannelState {
  return actions.reduce(reduceAlertChannel, state);
}

describe('alert channel state', () => {
  it('starts with every channel pending and claims nothing', () => {
    const state = initialAlertChannelState();
    expect(state.attempt).toBe(0);
    expect(ALERT_CHANNELS.map((c) => state.channels[c])).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(projectAlertChannel(state)).toEqual({
      status: 'quiet',
      message: null,
      reasons: [],
      retryLabel: RETRY_LABEL,
      busy: true,
    });
  });

  it('names all four channels in a fixed order, both delivery paths per subject', () => {
    expect(ALERT_CHANNELS).toEqual([ALERTS_READ, ALERTS_EVENTS, MISSED_READ, MISSED_EVENTS]);
  });

  it('records a settlement for one channel without touching the others', () => {
    const state = settled({ [ALERTS_READ]: 'live' });
    expect(state.channels[ALERTS_READ]).toBe('live');
    expect(state.channels[ALERTS_EVENTS]).toBe('pending');
    expect(state.channels[MISSED_READ]).toBe('pending');
    expect(state.channels[MISSED_EVENTS]).toBe('pending');
  });

  it('records an established subscription without promoting it to live delivery evidence', () => {
    const state = settled({ [ALERTS_EVENTS]: 'subscribed' });
    expect(state.channels[ALERTS_EVENTS]).toBe('subscribed');
    expect(state.channels[ALERTS_EVENTS]).not.toBe('live');
  });

  it('keeps a second failure alongside a first rather than collapsing to one', () => {
    const state = settled({ [ALERTS_READ]: 'failed', [MISSED_READ]: 'failed' });
    expect(state.channels[ALERTS_READ]).toBe('failed');
    expect(state.channels[ALERTS_EVENTS]).toBe('pending');
    expect(state.channels[MISSED_READ]).toBe('failed');
  });

  it('ignores a settlement from a superseded attempt and returns the identical state', () => {
    const current = settled({ [ALERTS_READ]: 'failed' }, 2);
    const next = reduceAlertChannel(current, { type: 'live', attempt: 1, channel: ALERTS_READ });
    expect(next).toBe(current);
    expect(next.channels[ALERTS_READ]).toBe('failed');
  });

  it('ignores a begin for an attempt already in flight', () => {
    const current = settled({ [ALERTS_READ]: 'failed' }, 2);
    const next = reduceAlertChannel(current, { type: 'begin', attempt: 2 });
    expect(next).toBe(current);
  });

  it('re-arms every channel when a newer attempt begins', () => {
    const current = settled(
      { [ALERTS_READ]: 'failed', [ALERTS_EVENTS]: 'failed' },
      1,
    );
    const next = reduceAlertChannel(current, { type: 'begin', attempt: 2 });
    expect(next.attempt).toBe(2);
    expect(ALERT_CHANNELS.map((c) => next.channels[c])).toEqual(['pending', 'pending', 'pending', 'pending']);
  });

  it('accumulates settlements within one attempt regardless of arrival order', () => {
    const state = dispatchAll(initialAlertChannelState(4), [
      { type: 'failed', attempt: 4, channel: MISSED_READ },
      { type: 'live', attempt: 4, channel: ALERTS_READ },
      { type: 'subscribed', attempt: 4, channel: ALERTS_EVENTS },
      { type: 'live', attempt: 4, channel: MISSED_EVENTS },
    ]);
    expect(state.channels).toEqual({
      [ALERTS_READ]: 'live',
      [ALERTS_EVENTS]: 'subscribed',
      [MISSED_READ]: 'failed',
      [MISSED_EVENTS]: 'live',
    });
  });

  it('adopts a settlement from an attempt ahead of the recorded one without inventing a begin', () => {
    const next = reduceAlertChannel(initialAlertChannelState(1), {
      type: 'failed',
      attempt: 3,
      channel: ALERTS_READ,
    });
    expect(next.attempt).toBe(3);
    expect(next.channels[ALERTS_READ]).toBe('failed');
    expect(next.channels[ALERTS_EVENTS]).toBe('pending');
  });

  it('never mutates the state it is given', () => {
    const state = initialAlertChannelState(1);
    const snapshot = structuredClone(state);
    reduceAlertChannel(state, { type: 'failed', attempt: 1, channel: ALERTS_READ });
    reduceAlertChannel(state, { type: 'begin', attempt: 2 });
    expect(state).toEqual(snapshot);
  });
});

describe('alert channel projection', () => {
  it('stays quiet while every channel is still pending — an unanswered read is not a fault', () => {
    expect(projectAlertChannel(settled()).status).toBe('quiet');
  });

  it('stays quiet when both subjects are confirmed delivered', () => {
    const view = projectAlertChannel(settled({
      [ALERTS_READ]: 'live', [ALERTS_EVENTS]: 'live', [MISSED_READ]: 'live', [MISSED_EVENTS]: 'live',
    }));
    expect(view).toEqual({
      status: 'quiet',
      message: null,
      reasons: [],
      retryLabel: RETRY_LABEL,
      busy: false,
    });
  });

  it('never claims unreachability from a refused subscription while reads deliver', () => {
    // The historical bug: a refused event subscription was announced as a dead
    // alert channel although the same data still arrives through reads.
    expect(projectAlertChannel(settled({ [ALERTS_READ]: 'live', [ALERTS_EVENTS]: 'failed' })).status).toBe('quiet');
    expect(projectAlertChannel(settled({ [MISSED_READ]: 'live', [MISSED_EVENTS]: 'failed' })).status).toBe('quiet');
  });

  it('stays quiet when reads fail but the event channel is merely subscribed — an unknown, not a fault', () => {
    expect(projectAlertChannel(settled({ [ALERTS_READ]: 'failed', [ALERTS_EVENTS]: 'subscribed' })).status).toBe('quiet');
  });

  it('claims unreachability only when both delivery paths of a subject are proven dead, naming only that subject', () => {
    const alertsView = projectAlertChannel(settled({ [ALERTS_READ]: 'failed', [ALERTS_EVENTS]: 'failed' }));
    expect(alertsView.status).toBe('unavailable');
    expect(alertsView.message).toBe('Action registry alerts cannot reach you right now.');
    expect(alertsView.reasons).toEqual([
      ALERT_CHANNEL_REASONS[ALERTS_READ],
      ALERT_CHANNEL_REASONS[ALERTS_EVENTS],
    ]);

    const missedView = projectAlertChannel(settled({ [MISSED_READ]: 'failed', [MISSED_EVENTS]: 'failed' }));
    expect(missedView.status).toBe('unavailable');
    expect(missedView.message).toBe('Missed-cron alerts cannot reach you right now.');
    expect(missedView.reasons).toEqual([
      ALERT_CHANNEL_REASONS[MISSED_READ],
      ALERT_CHANNEL_REASONS[MISSED_EVENTS],
    ]);

    const both = projectAlertChannel(settled({
      [ALERTS_READ]: 'failed', [ALERTS_EVENTS]: 'failed',
      [MISSED_READ]: 'failed', [MISSED_EVENTS]: 'failed',
    }));
    expect(both.message).toBe(ALERT_CHANNEL_HEADLINE);
    expect(both.reasons).toHaveLength(4);
  });

  it('keeps the two subjects independent: one dead pair does not announce the other', () => {
    const view = projectAlertChannel(settled({
      [ALERTS_READ]: 'failed',
      [ALERTS_EVENTS]: 'failed',
      [MISSED_READ]: 'live',
      [MISSED_EVENTS]: 'failed',
    }));
    expect(view.reasons).toEqual([
      ALERT_CHANNEL_REASONS[ALERTS_READ],
      ALERT_CHANNEL_REASONS[ALERTS_EVENTS],
    ]);
  });

  it('gates busy on the registry alert read only', () => {
    // The button re-reads alerts; a missed-cron failure does not busy it, and
    // an unanswered alert read does.
    expect(projectAlertChannel(settled({ [ALERTS_READ]: 'failed' })).busy).toBe(false);
    expect(projectAlertChannel(settled({ [ALERTS_READ]: 'live' })).busy).toBe(false);
    expect(projectAlertChannel(settled({ [MISSED_READ]: 'failed' })).busy).toBe(true);
    expect(projectAlertChannel(settled({ [MISSED_EVENTS]: 'failed' })).busy).toBe(true);
    expect(projectAlertChannel(settled()).busy).toBe(true);
  });

  it('offers the one retry label the shell already uses', () => {
    expect(RETRY_LABEL).toBe('Retry');
    expect(projectAlertChannel(settled({ [ALERTS_READ]: 'failed' })).retryLabel).toBe('Retry');
  });

  it('returns to quiet after a retry confirms every channel', () => {
    const failed = settled({ [ALERTS_READ]: 'failed', [ALERTS_EVENTS]: 'failed' }, 1);
    expect(projectAlertChannel(failed).status).toBe('unavailable');
    const retried = dispatchAll(reduceAlertChannel(failed, { type: 'begin', attempt: 2 }), [
      { type: 'live', attempt: 2, channel: ALERTS_READ },
      { type: 'subscribed', attempt: 2, channel: ALERTS_EVENTS },
    ]);
    expect(projectAlertChannel(retried).status).toBe('quiet');
  });

  it('never carries a caught reason into its copy', () => {
    const secret = 'synthetic private native detail';
    const view = projectAlertChannel(settled({ [ALERTS_READ]: 'failed', [ALERTS_EVENTS]: 'failed' }));
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(ALERT_CHANNEL_HEADLINE).not.toContain(secret);
    for (const copy of Object.values(ALERT_CHANNEL_REASONS)) {
      expect(copy).not.toContain(secret);
    }
  });
});
