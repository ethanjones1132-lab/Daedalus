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

const BOOT: AlertChannelId = 'boot-read';
const EVENTS: AlertChannelId = 'registry-events';
const MISSED: AlertChannelId = 'missed-cron-events';

function settled(
  channels: Partial<Record<AlertChannelId, 'live' | 'failed'>> = {},
  attempt = 0,
): AlertChannelState {
  let state = initialAlertChannelState(attempt);
  for (const channel of ALERT_CHANNELS) {
    const status = channels[channel];
    if (!status) continue;
    state = reduceAlertChannel(state, { type: status, attempt, channel });
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
    expect(ALERT_CHANNELS.map((c) => state.channels[c])).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    expect(projectAlertChannel(state)).toEqual({
      status: 'quiet',
      message: null,
      reasons: [],
      retryLabel: RETRY_LABEL,
      busy: true,
    });
  });

  it('names all three channels in a fixed order so the surface cannot depend on resolution order', () => {
    expect(ALERT_CHANNELS).toEqual([BOOT, EVENTS, MISSED]);
  });

  it('records a settlement for one channel without touching the others', () => {
    const state = settled({ [BOOT]: 'live' });
    expect(state.channels[BOOT]).toBe('live');
    expect(state.channels[EVENTS]).toBe('pending');
    expect(state.channels[MISSED]).toBe('pending');
  });

  it('keeps a second failure alongside a first rather than collapsing to one', () => {
    const state = settled({ [BOOT]: 'failed', [MISSED]: 'failed' });
    expect(state.channels[BOOT]).toBe('failed');
    expect(state.channels[EVENTS]).toBe('pending');
    expect(state.channels[MISSED]).toBe('failed');
  });

  it('ignores a settlement from a superseded attempt and returns the identical state', () => {
    const current = settled({ [BOOT]: 'failed' }, 2);
    const next = reduceAlertChannel(current, { type: 'live', attempt: 1, channel: BOOT });
    expect(next).toBe(current);
    expect(next.channels[BOOT]).toBe('failed');
  });

  it('ignores a begin for an attempt already in flight', () => {
    const current = settled({ [BOOT]: 'failed' }, 2);
    const next = reduceAlertChannel(current, { type: 'begin', attempt: 2 });
    expect(next).toBe(current);
  });

  it('re-arms every channel when a newer attempt begins', () => {
    const current = settled({ [BOOT]: 'failed', [EVENTS]: 'failed' }, 1);
    const next = reduceAlertChannel(current, { type: 'begin', attempt: 2 });
    expect(next.attempt).toBe(2);
    expect(ALERT_CHANNELS.map((c) => next.channels[c])).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('accumulates settlements within one attempt regardless of arrival order', () => {
    const state = dispatchAll(initialAlertChannelState(4), [
      { type: 'failed', attempt: 4, channel: MISSED },
      { type: 'live', attempt: 4, channel: BOOT },
      { type: 'live', attempt: 4, channel: EVENTS },
    ]);
    expect(state.channels).toEqual({
      [BOOT]: 'live',
      [EVENTS]: 'live',
      [MISSED]: 'failed',
    });
  });

  it('adopts a settlement from an attempt ahead of the recorded one without inventing a begin', () => {
    const next = reduceAlertChannel(initialAlertChannelState(1), {
      type: 'failed',
      attempt: 3,
      channel: BOOT,
    });
    expect(next.attempt).toBe(3);
    expect(next.channels[BOOT]).toBe('failed');
    expect(next.channels[EVENTS]).toBe('pending');
  });

  it('never mutates the state it is given', () => {
    const state = initialAlertChannelState(1);
    const snapshot = structuredClone(state);
    reduceAlertChannel(state, { type: 'failed', attempt: 1, channel: BOOT });
    reduceAlertChannel(state, { type: 'begin', attempt: 2 });
    expect(state).toEqual(snapshot);
  });
});

describe('alert channel projection', () => {
  it('stays quiet while every channel is still pending — an unanswered read is not a fault', () => {
    expect(projectAlertChannel(settled()).status).toBe('quiet');
  });

  it('stays quiet once every channel is confirmed', () => {
    const view = projectAlertChannel(
      settled({ [BOOT]: 'live', [EVENTS]: 'live', [MISSED]: 'live' }),
    );
    expect(view).toEqual({
      status: 'quiet',
      message: null,
      reasons: [],
      retryLabel: RETRY_LABEL,
      busy: false,
    });
  });

  it('stays quiet when only some channels are confirmed', () => {
    expect(
      projectAlertChannel(settled({ [BOOT]: 'live', [EVENTS]: 'live' })).status,
    ).toBe('quiet');
  });

  it('names the boot read as failed with its own fixed reason', () => {
    const view = projectAlertChannel(settled({ [BOOT]: 'failed' }));
    expect(view.status).toBe('unavailable');
    expect(view.message).toBe(ALERT_CHANNEL_HEADLINE);
    expect(view.reasons).toEqual([ALERT_CHANNEL_REASONS[BOOT]]);
    expect(view.busy).toBe(false);
  });

  it('names the registry subscription as failed with its own fixed reason', () => {
    const view = projectAlertChannel(settled({ [EVENTS]: 'failed' }));
    expect(view.reasons).toEqual([ALERT_CHANNEL_REASONS[EVENTS]]);
  });

  it('names the missed-cron subscription as failed with its own fixed reason', () => {
    const view = projectAlertChannel(settled({ [MISSED]: 'failed' }));
    expect(view.reasons).toEqual([ALERT_CHANNEL_REASONS[MISSED]]);
  });

  it('lists every failed channel in the fixed order, not the order they failed', () => {
    const view = projectAlertChannel(
      settled({ [MISSED]: 'failed', [BOOT]: 'failed', [EVENTS]: 'failed' }),
    );
    expect(view.reasons).toEqual([
      ALERT_CHANNEL_REASONS[BOOT],
      ALERT_CHANNEL_REASONS[EVENTS],
      ALERT_CHANNEL_REASONS[MISSED],
    ]);
  });

  it('omits a confirmed channel from a partial failure', () => {
    const view = projectAlertChannel(
      settled({ [BOOT]: 'live', [EVENTS]: 'failed', [MISSED]: 'live' }),
    );
    expect(view.reasons).toEqual([ALERT_CHANNEL_REASONS[EVENTS]]);
  });

  it('re-reads busy only while the boot read itself is unanswered', () => {
    expect(projectAlertChannel(settled({ [BOOT]: 'failed' })).busy).toBe(false);
    expect(projectAlertChannel(settled({ [BOOT]: 'live' })).busy).toBe(false);
    expect(projectAlertChannel(settled({ [MISSED]: 'failed' })).busy).toBe(true);
  });

  it('offers the one retry label the shell already uses', () => {
    expect(RETRY_LABEL).toBe('Retry');
    expect(projectAlertChannel(settled({ [BOOT]: 'failed' })).retryLabel).toBe('Retry');
  });

  it('returns to quiet after a retry confirms every channel', () => {
    const failed = settled({ [BOOT]: 'failed', [EVENTS]: 'failed' }, 1);
    expect(projectAlertChannel(failed).status).toBe('unavailable');
    const retried = dispatchAll(reduceAlertChannel(failed, { type: 'begin', attempt: 2 }), [
      { type: 'live', attempt: 2, channel: BOOT },
      { type: 'live', attempt: 2, channel: EVENTS },
      { type: 'live', attempt: 2, channel: MISSED },
    ]);
    expect(projectAlertChannel(retried).status).toBe('quiet');
  });

  it('never carries a caught reason into its copy', () => {
    const secret = 'synthetic private native detail';
    const view = projectAlertChannel(settled({ [BOOT]: 'failed' }));
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(ALERT_CHANNEL_HEADLINE).not.toContain(secret);
    for (const reason of Object.values(ALERT_CHANNEL_REASONS)) {
      expect(reason).not.toContain(secret);
    }
  });

  it('gives every channel a distinct, non-empty fixed reason', () => {
    const reasons = Object.values(ALERT_CHANNEL_REASONS);
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const reason of reasons) expect(reason.trim().length).toBeGreaterThan(0);
    expect(ALERT_CHANNEL_HEADLINE.trim().length).toBeGreaterThan(0);
  });
});
