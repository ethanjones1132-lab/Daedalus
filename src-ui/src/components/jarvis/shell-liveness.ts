// ═══════════════════════════════════════════════════════════════
// ── shell-liveness — what the sidebar's `live` badge is reporting
// ═══════════════════════════════════════════════════════════════
//
// The badge shipped as a constant: a pulsing dot and the word `live` in a
// component that receives only `{ currentView, onNavigate }`. Nothing in the file
// could stop it, so it animated identically while every poll was failing, while
// the health strip was admitting its observation was stale, and while the two
// event subscriptions that would be the evidence were dead.
//
// The shell does own one read: the Action-registry alert channel — a boot read
// plus two event subscriptions, armed together and each one able to refuse. That
// read is real, it can be confirmed, and it can fail for the life of the
// process, which makes it the one thing in the shell that can honestly answer
// "is the shell receiving anything right now".
//
// This module is the whole of that claim. It turns the channel state into three
// fixed claims, and it never carries a caught value to the surface: a native
// message is not the operator's to read.
// ═══════════════════════════════════════════════════════════════

import type { AlertChannelState } from './registry-alert-channel';

export type ShellLivenessClaim =
  /** Every channel answered. The only claim that animates. */
  | 'confirmed'
  /** No channel refused and not all have answered. The badge claims nothing. */
  | 'unanswered'
  /** At least one channel refused, and will not answer again on its own. */
  | 'unavailable';

export interface ShellLivenessView {
  claim: ShellLivenessClaim;
  /** The word the operator reads in the footer. Short on purpose. */
  label: string;
  /** One sentence saying which read the badge is reporting, in the surface. */
  basis: string;
  /** The animation, and only the animation, follows this. */
  pulse: boolean;
  dot: string;
  text: string;
}

const CONFIRMED_BASIS =
  'The Action registry alert boot read and both event subscriptions answered. This badge reports those three channels and nothing else.';
const UNAVAILABLE_BASIS =
  'At least one Action registry alert channel refused, so some registry alerts cannot reach you. The banner above the workspace names each one.';
const UNANSWERED_BASIS =
  'The Action registry alert channels have not all answered yet, so this badge makes no liveness claim.';

export function projectShellLiveness(state: AlertChannelState): ShellLivenessView {
  const channels = Object.values(state.channels);
  if (channels.includes('failed')) {
    return {
      claim: 'unavailable',
      label: 'events down',
      basis: UNAVAILABLE_BASIS,
      pulse: false,
      dot: 'bg-amber-400',
      text: 'text-warning',
    };
  }
  if (channels.includes('pending')) {
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
