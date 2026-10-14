// ═══════════════════════════════════════════════════════════════
// ── registry-alert-channel — is the shell's alert channel alive? ──
//
// The app shell reads Action registry alerts once at boot and subscribes to
// two event channels that deliver the same information later. None of those
// three paths is a poll, so none of them is ever retried on its own: a refused
// subscription stays dead for the life of the process, and a refused boot read
// is discarded. The shell used to swallow all three, which left a quiet Actions
// tab as the only evidence a real high-severity registry fault would never be
// delivered.
//
// This module is the whole of that claim. It records whether each channel
// answered, projects that into fixed copy, and never carries a caught value to
// the surface: a native message is not the operator's to read.
// ═══════════════════════════════════════════════════════════════

export type AlertChannelId = 'boot-read' | 'registry-events' | 'missed-cron-events';
export type AlertChannelStatus = 'pending' | 'live' | 'failed';

// Fixed order: the banner lists reasons by channel, never by the order two
// refusals happened to arrive in.
export const ALERT_CHANNELS: readonly AlertChannelId[] = [
  'boot-read',
  'registry-events',
  'missed-cron-events',
];

export const ALERT_CHANNEL_HEADLINE =
  'Some Action registry alerts cannot reach you right now.';

export const ALERT_CHANNEL_REASONS: Record<AlertChannelId, string> = {
  'boot-read': 'Existing registry alerts could not be read.',
  'registry-events': 'New registry alerts are not arriving.',
  'missed-cron-events': 'Missed-cron warnings are not arriving.',
};

// The label the shell's other read failures already use.
export const RETRY_LABEL = 'Retry';

export interface AlertChannelState {
  attempt: number;
  channels: Record<AlertChannelId, AlertChannelStatus>;
}

export type AlertChannelAction =
  | { type: 'begin'; attempt: number }
  | { type: 'live'; attempt: number; channel: AlertChannelId }
  | { type: 'failed'; attempt: number; channel: AlertChannelId };

export interface AlertChannelView {
  // `quiet` is the only state that renders nothing, and it is a contract: a
  // channel that has not answered yet makes no claim either way.
  status: 'quiet' | 'unavailable';
  message: string | null;
  reasons: string[];
  retryLabel: string;
  busy: boolean;
}

export function initialAlertChannelState(attempt = 0): AlertChannelState {
  return {
    attempt,
    channels: { 'boot-read': 'pending', 'registry-events': 'pending', 'missed-cron-events': 'pending' },
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
  const status: AlertChannelStatus = action.type === 'live' ? 'live' : 'failed';
  // A settlement can outrun its own `begin` when the shell re-arms inside one
  // synchronous block; adopt the attempt rather than dropping the result.
  const base = action.attempt === state.attempt
    ? state.channels
    : initialAlertChannelState(action.attempt).channels;
  return { attempt: action.attempt, channels: { ...base, [action.channel]: status } };
}

export function projectAlertChannel(state: AlertChannelState): AlertChannelView {
  const reasons = ALERT_CHANNELS
    .filter((channel) => state.channels[channel] === 'failed')
    .map((channel) => ALERT_CHANNEL_REASONS[channel]);
  if (reasons.length === 0) {
    return {
      status: 'quiet',
      message: null,
      reasons: [],
      retryLabel: RETRY_LABEL,
      busy: state.channels['boot-read'] === 'pending',
    };
  }
  return {
    status: 'unavailable',
    message: ALERT_CHANNEL_HEADLINE,
    reasons,
    retryLabel: RETRY_LABEL,
    // Only the boot read gates the button: the operator cannot re-read what is
    // already in hand, and a refused subscription is re-armed by the same click.
    busy: state.channels['boot-read'] === 'pending',
  };
}
