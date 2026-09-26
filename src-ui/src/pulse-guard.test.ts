// Pulse-liveness guard.
//
// `animate-pulse` is this app's liveness vocabulary: a pulsing dot says *this is
// alive right now*. Three surfaces have already been caught shipping one on a
// value no read could end — a channel's stored login flag, a never-probed device,
// the gateway's literal constants — and each of those fixes shipped the same
// assertion, scoped to its own row. Three surfaces were fixed; no rule was
// enforced, so the fourth shipped green (`App.tsx`'s sidebar footer pulsed beside
// the literal word `live` in a component that receives no read at all, and the
// health strip's dot animated underneath its own "may be stale" alert).
//
// So this is the rule, as a ratchet: every `animate-pulse` in the UI source is
// either allowlisted with the read that can end it, or the guard fails. A new
// pulsing dot cannot ship until someone writes down which read ends it — and a
// claim no read can end has no such sentence to write.
//
// It reads the source as text rather than rendering anything: the rule spans
// files, and rendering the app needs Tauri IPC mocks. No Rust toolchain, no Tauri.

import { describe, expect, it } from 'vitest';
import { findPulseSites, matchPulseAllowlist, type PulseAllowlistEntry } from './lib/pulse-guard';

// Vite `?raw` glob — every non-test source module as a string, so a new file with
// a pulsing dot is scanned without touching this file.
const sources = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * Every animation in the UI source, with the evidence that the claim it carries
 * can end. Two kinds are allowed:
 *
 * - `decorative` — the motion makes no claim about a measurement, so there is
 *   nothing for a read to end.
 * - `read-gated` — the motion *is* a claim, and the file gates it on a read that
 *   can be confirmed, can fail, and is stated on the surface.
 */
const ALLOWLIST: PulseAllowlistEntry[] = [
  {
    file: './components/ui/index.tsx',
    text: "pulse && 'animate-pulse',",
    kind: 'decorative',
    reason:
      'StatusDot primitive: the animation is the caller’s claim, and `pulse` defaults to false. Each caller owns the read behind its own claim and pins it in its own suite (GatewayView.metrics, DevicesView.presence, ChannelsView.liveness).',
  },
  {
    file: './components/ui/index.tsx',
    text: '<span className="animate-pulse">{message}</span>',
    kind: 'decorative',
    reason:
      'LoadingState: the motion says "a read is in flight", which is true for exactly as long as the read is in flight and is not a measurement. The read that ends it is the one that unmounts the primitive.',
  },
  {
    file: './components/jarvis/JarvisView.tsx',
    text: '<div className="h-3 w-3/4 rounded bg-iron/40 animate-pulse" />',
    kind: 'decorative',
    reason:
      'Session-history skeleton placeholder, rendered only while `loadingHistory` is true. The bars are the absence of a reading, not a reading.',
  },
  {
    file: './components/jarvis/JarvisView.tsx',
    text: '<div className="mt-1 h-3 w-1/2 rounded bg-iron/30 animate-pulse" />',
    kind: 'decorative',
    reason:
      'Session-history skeleton placeholder, rendered only while `loadingHistory` is true. The bars are the absence of a reading, not a reading.',
  },
  {
    file: './components/jarvis/HermesChat.tsx',
    text: "m.streaming && 'animate-pulse',",
    kind: 'read-gated',
    reason:
      'A streaming message bubble, gated on `m.streaming`: the terminal frame that ends the turn is what clears the flag, and the cancelled and error branches below the bubble are those terminal states.',
  },
  {
    file: './components/jarvis/CronView.tsx',
    text: '<span aria-hidden="true" className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-neon mr-1.5 animate-pulse" />',
    kind: 'read-gated',
    reason:
      'The in-flight `Running` pill, gated on `!inFlightStale`: the 3s `get_in_flight_cron_jobs` poll marks a failed read stale, so the animation stops the moment the read that fed it fails, and the pill says `(stale)` while it is stopped.',
  },
  {
    file: './components/jarvis/HealthBanner.tsx',
    text: "<span aria-hidden=\"true\" className={cn('w-2 h-2 rounded-full', liveness.pulse && 'animate-pulse', stripStyle.dot)} />",
    kind: 'read-gated',
    reason:
      'The health strip dot, gated on `liveness.pulse`: the animation is dropped the moment the read behind the retained observation fails, and the retained subsystem rows are marked `(stale)` in the same render.',
  },
  {
    file: './App.tsx',
    text: "<span aria-hidden=\"true\" className={cn('w-1.5 h-1.5 rounded-full', liveness.dot, liveness.pulse && 'animate-pulse')} />",
    kind: 'read-gated',
    reason:
      'The sidebar footer liveness badge, gated on `liveness.pulse`: the projection reads the shell’s own Action-registry alert channel (boot read plus both event subscriptions), so a refused channel stops the animation and replaces the word `live` with `events down`.',
  },
];

describe('pulse-liveness guard', () => {
  it('finds every animation in the UI source, so the allowlist below cannot pass vacuously', () => {
    const sites = findPulseSites(sources);
    expect(sites.length).toBeGreaterThan(0);
    // The primitive is the anchor: if the scan ever stopped finding it, every
    // other case in this file would be measuring nothing.
    expect(
      sites.some((site) => site.text.includes("pulse && 'animate-pulse'")),
      'the scan should still find the StatusDot primitive',
    ).toBe(true);
  });

  it('allows no animation that the documented read-gating does not account for', () => {
    const sites = findPulseSites(sources);
    const { undocumented, unused } = matchPulseAllowlist(sites, ALLOWLIST);
    expect(
      undocumented,
      'animate-pulse sites with no documented read behind them — either gate the animation on a read that can fail, or add an entry above saying which read ends it',
    ).toEqual([]);
    expect(
      unused.map((entry) => `${entry.file}: ${entry.text}`),
      'allowlist entries that match no site — the animation moved or was deleted, so the entry is now a claim about nothing',
    ).toEqual([]);
  });

  it('keeps every claim-carrying animation documented in terms of the gate that ends it', () => {
    const claims = ALLOWLIST.filter((entry) => entry.kind === 'read-gated');
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      // A `read-gated` entry that never names the gate is a comment, not evidence.
      expect(
        claim.reason,
        `${claim.file}: ${claim.text} must name the state its animation is gated on`,
      ).toMatch(/gated on `[^`]+`/);
    }
  });

  it('documents every entry as a real sentence, because the reason is the guard', () => {
    for (const item of ALLOWLIST) {
      expect(item.reason.length, `${item.file}: ${item.text}`).toBeGreaterThan(60);
    }
  });
});
