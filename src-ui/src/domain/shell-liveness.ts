// ═══════════════════════════════════════════════════════════════
// ── shell-liveness — what the sidebar's `live` badge is reporting
// ═══════════════════════════════════════════════════════════════
//
// The badge shipped as a constant: a pulsing dot and the word `live` in a
// component that receives only `{ currentView, onNavigate }`. Nothing in the
// file could stop it, so it animated identically while every delivery path was
// failing and while the channels that would be the evidence were dead.
//
// The shell owns the alert delivery channels: a read of registry alerts and of
// pending missed cron jobs (boot read, then on a poll interval) plus one event
// subscription per subject. Those four channels are real, they can be
// confirmed, and they can fail, which makes them the one thing in the shell
// that can honestly answer "is the shell receiving anything right now".
//
// This module is the whole of that claim, and it stays consistent with the
// delivery banner: "cannot reach you" is said only when both paths of a
// subject are proven dead, a refused subscription beside a delivering read is
// degraded rather than dead, and an unanswered channel claims nothing. No
// caught value is ever carried to the surface.
// ═══════════════════════════════════════════════════════════════

import type { AlertChannelState } from './registry-alert-channel';
import { DELIVERY_CHAINS } from './registry-alert-channel';

export type ShellLivenessClaim =
  /** Every read delivered and every subscription answered. The only claim that animates. */
  | 'confirmed'
  /** A refused path beside an answering one: delivery continues, but not through every path. */
  | 'degraded'
  /** Nothing refused, not everything answered. The badge claims nothing. */
  | 'unanswered'
  /** Both delivery paths of a subject refused: some alerts cannot reach the operator. */
  | 'unavailable';

export interface ShellLivenessView {
  claim: ShellLivenessClaim;
  /** The word the operator reads in the footer. Short on purpose. */
  label: string;
  /** One sentence saying which channels the badge is reporting, in the surface. */
  basis: string;
  /** The animation, and only the animation, follows this. */
  pulse: boolean;
  dot: string;
  text: string;
}

const CONFIRMED_BASIS =
  'Both alert reads delivered and both event channels answered. This badge reports those four delivery channels and nothing else.';
const DEGRADED_BASIS =
  'A delivery path refused, but the paired path of that subject still answers, so delivery continues. This badge reports those four channels and nothing else.';
const UNAVAILABLE_BASIS =
  'Both delivery paths of an alert subject refused, so some alerts cannot reach you. The banner above the workspace names each one.';
const UNANSWERED_BASIS =
  'The alert delivery channels have not all answered yet, so this badge makes no liveness claim.';

export function projectShellLiveness(state: AlertChannelState): ShellLivenessView {
  const pairs = DELIVERY_CHAINS.map(({ read, events }) => ({
    read: state.channels[read],
    events: state.channels[events],
  }));
  if (pairs.some(({ read, events }) => read === 'failed' && events === 'failed')) {
    return {
      claim: 'unavailable',
      label: 'unreachable',
      basis: UNAVAILABLE_BASIS,
      pulse: false,
      dot: 'bg-amber-400',
      text: 'text-warning',
    };
  }
  if (pairs.some(({ read, events }) => read === 'failed' || events === 'failed')) {
    return {
      claim: 'degraded',
      label: 'reads partial',
      basis: DEGRADED_BASIS,
      pulse: false,
      dot: 'bg-ink-3',
      text: 'text-ink-3',
    };
  }
  if (pairs.some(({ read, events }) => read === 'pending' || events === 'pending')) {
    return {
      claim: 'unanswered',
      label: 'checking',
      basis: UNANSWERED_BASIS,
      pulse: false,
      dot: 'bg-cyan-neon/40',
      text: 'text-cyan-glow/70',
    };
  }
  return {
    claim: 'confirmed',
    label: 'live',
    basis: CONFIRMED_BASIS,
    pulse: true,
    // The glow belongs to the confirmed claim: it is the same emphasis the
    // constant badge shipped with, and it now stops with the animation.
    dot: 'bg-cyan-neon shadow-[0_0_6px_rgba(34,211,238,0.7)]',
    text: 'text-cyan-glow',
  };
}
