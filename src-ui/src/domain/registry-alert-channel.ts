// ═══════════════════════════════════════════════════════════════
// ── registry-alert-channel — can registry alerts reach the operator? ──
//
// Two alert subjects (registry alerts, missed-cron warnings) each have two
// delivery paths: a read command (once at boot, then on a poll interval) and
// an event subscription. The read path is the deliverer; events are an
// accelerator whose *arrival* is evidence, never merely their subscription.
//
// "Alerts cannot reach you" may only be claimed when both paths of a subject
// are proven dead: a refused subscription on its own is not proof — the read
// path may still deliver — and a merely-subscribed channel with no event yet
// is an unknown, not a fault ("no claim either way"). No caught value is ever
// carried to the surface: a native message is not the operator's to read.
// ═══════════════════════════════════════════════════════════════

export type AlertChannelId = 'alerts-read' | 'alerts-events' | 'missed-read' | 'missed-events';
export type AlertChannelStatus = 'pending' | 'subscribed' | 'live' | 'failed';

// Fixed order: the banner lists reasons by channel, never by the order two
// refusals happened to arrive in.
export const ALERT_CHANNELS: readonly AlertChannelId[] = [
  'alerts-read',
  'alerts-events',
  'missed-read',
  'missed-events',
];

export const DELIVERY_CHAINS: ReadonlyArray<{ read: AlertChannelId; events: AlertChannelId }> = [
  { read: 'alerts-read', events: 'alerts-events' },
  { read: 'missed-read', events: 'missed-events' },
];

export const ALERT_CHANNEL_HEADLINE =
  'Some Action registry and missed-cron alerts cannot reach you right now.';

export const ALERT_CHANNEL_REASONS: Record<AlertChannelId, string> = {
  'alerts-read': 'Periodic reads of registry alerts are failing.',
  'alerts-events': 'New registry alerts are not arriving over events.',
  'missed-read': 'Periodic reads of missed cron jobs are failing.',
  'missed-events': 'Missed-cron warnings are not arriving over events.',
};

// The label the shell's other read failures already use.
export const RETRY_LABEL = 'Retry';

export interface AlertChannelState {
  attempt: number;
  channels: Record<AlertChannelId, AlertChannelStatus>;
}

export type AlertChannelAction =
  | { type: 'begin'; attempt: number }
  /** Delivered evidence: a successful read, or an event that actually arrived. */
  | { type: 'live'; attempt: number; channel: AlertChannelId }
  /** An established subscription: a potential path, never claimed as working. */
  | { type: 'subscribed'; attempt: number; channel: AlertChannelId }
  | { type: 'failed'; attempt: number; channel: AlertChannelId };

export interface AlertChannelView {
  // `quiet` is the only state that renders nothing, and it is a contract: a
  // channel that has not been proven dead makes no claim either way.
  status: 'quiet' | 'unavailable';
  message: string | null;
  reasons: string[];
  retryLabel: string;
  busy: boolean;
}

export function initialAlertChannelState(attempt = 0): AlertChannelState {
  return {
    attempt,
    channels: {
      'alerts-read': 'pending',
      'alerts-events': 'pending',
      'missed-read': 'pending',
      'missed-events': 'pending',
    },
  };
}

// A settlement from a torn-down attempt is ignored outright, so a refusal that
// lands after a Retry cannot resurrect a failure the newer attempt cleared.
export function reduceAlertChannel(
  state: AlertChannelState,
  action: AlertChannelAction,
): AlertChannelState {
  if (action.attempt < state.attempt) return state;
  if (action.type === 'begin') {
    if (action.attempt === state.attempt) return state;
    return initialAlertChannelState(action.attempt);
  }
  const status: AlertChannelStatus =
    action.type === 'live' ? 'live' : action.type === 'subscribed' ? 'subscribed' : 'failed';
  // A settlement can outrun its own `begin` when the shell re-arms inside one
  // synchronous block; adopt the attempt rather than dropping the result.
  const base = action.attempt === state.attempt
    ? state.channels
    : initialAlertChannelState(action.attempt).channels;
  return { attempt: action.attempt, channels: { ...base, [action.channel]: status } };
}

export function projectAlertChannel(state: AlertChannelState): AlertChannelView {
  // Both paths of a subject must be *proven* dead before the banner may
  // claim that subject's alerts cannot reach the operator. A failed read
  // with a merely-subscribed event channel is an unknown, and a proven
  // read delivery silences a refused subscription outright.
  const deadChains = DELIVERY_CHAINS.filter(
    ({ read, events }) => state.channels[read] === 'failed' && state.channels[events] === 'failed',
  );
  if (deadChains.length === 0) {
    return {
      status: 'quiet',
      message: null,
      reasons: [],
      retryLabel: RETRY_LABEL,
      busy: state.channels['alerts-read'] === 'pending',
    };
  }
  const reasons = deadChains.flatMap(({ read, events }) => [
    ALERT_CHANNEL_REASONS[read],
    ALERT_CHANNEL_REASONS[events],
  ]);
  // Name only the subjects that are actually unreachable: "and missed-cron"
  // must not appear when the registry chain still works.
  const message = deadChains.length === DELIVERY_CHAINS.length
    ? ALERT_CHANNEL_HEADLINE
    : deadChains[0].read === 'alerts-read'
      ? 'Action registry alerts cannot reach you right now.'
      : 'Missed-cron alerts cannot reach you right now.';
  return {
    status: 'unavailable',
    message,
    reasons,
    retryLabel: RETRY_LABEL,
    // Only the boot read gates the button: the operator cannot re-read what is
    // already in hand, and refused subscriptions are re-armed by the same click.
    busy: state.channels['alerts-read'] === 'pending',
  };
}
