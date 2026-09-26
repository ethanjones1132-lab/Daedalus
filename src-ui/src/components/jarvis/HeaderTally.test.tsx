// A header states its count inside its own name and finishes the sentence in the
// slot beside it: `{n} enabled`, `{n} connected`, `{n} delivery verified`.
//
// The count half of that sentence was routed through `lib/list-tally.ts` by the
// section-count row, and the pills were left exactly as they were: rendered from
// a `useState<T[]>([])` (or a `useMemo` over one) at the top of a header that sits
// above and independently of the read gate the same component implements in its
// body, and the primitive renders the `action` slot unconditionally. So an
// unanswered read and a failed one both printed confident zeros — `0 enabled`,
// `0 connected`, `0 delivery verified` — beside the surface's own fixed sentence
// saying the list could not be loaded, and an operator had no way to tell which of
// the four numbers on that header was real.
//
// Each case below drives the real surface and pins the same three states the
// count half is held to: nothing stated while the read is unanswered, nothing
// stated once it has failed, and the real number with its existing tone once it
// has answered — including a real `0`, which is a measurement and not a silence.

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChannelsView from './ChannelsView';
import { SkillsView } from './SkillsView';
import PluginsView from './PluginsView';
import { ToastProvider } from '../ui';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function literal(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

const channel = {
  id: 'ch1', name: 'Alpha channel', type: 'discord', enabled: true,
  config: { channel_id: '123', connected: false }, connected: false, last_used: null,
  created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-16T00:00:00Z',
};
const connectedChannel = { ...channel, config: { ...channel.config, connected: true } };
const skill = {
  id: 's1', name: 'Alpha skill', description: 'Alpha description', path: 'agents/a/alpha.md',
  enabled: true, metadata: null, body: 'body', version: 1, improvement_score: 0.4,
  created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-16T00:00:00Z',
};
const disabledSkill = { ...skill, id: 's2', name: 'Beta skill', enabled: false };
const plugin = {
  id: 'p1', name: 'Alpha plugin', version: '1.2.0', enabled: true,
  description: 'Synthetic description', source: 'synthetic',
};

/** Every command a surface issues that is not the list read under test. */
const QUIET: Record<string, unknown> = {
  sync_distilled_skill_candidates: 0,
  jarvis_get_skills: [],
  jarvis_get_tools: [],
  jarvis_get_tier_stats: { hot: 0, warm: 0, cold: 0 },
};

beforeEach(() => {
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command in QUIET) return Promise.resolve(QUIET[command]);
    throw new Error(`Unexpected command: ${command}`);
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ receipts: [] }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** The `Pill` a tally prints, read off its own text rather than off its class. */
function pill(text: RegExp) {
  return screen.queryByText(text)?.closest('span') ?? null;
}

/** What a slot states, per unit word: no number may reach it in an unread state. */
const CASES = [
  {
    View: SkillsView,
    list: 'list_skills',
    failure: 'Could not load skills.',
    units: ['enabled'],
    confirmed: { rows: [skill], stated: ['1 enabled'] },
    confirmedZero: { rows: [disabledSkill], stated: ['0 enabled'] },
    // The header itself, so an absent tally is attributable to the tally rather
    // than to a slot that failed to render.
    slotStillRendered: () => screen.getByRole('heading', { level: 2 }),
  },
  {
    View: ChannelsView,
    list: 'list_channels',
    failure: 'Could not refresh channels.',
    units: ['connected', 'delivery verified'],
    confirmed: { rows: [connectedChannel], stated: ['1 connected', '0 delivery verified'] },
    confirmedZero: { rows: [channel], stated: ['0 connected', '0 delivery verified'] },
    // The one control in this slot that is not a tally, which is also the
    // sharper witness: it is a sibling of the pills inside the same slot.
    slotStillRendered: () => screen.getByRole('button', { name: '+ New channel' }),
  },
  {
    View: PluginsView,
    list: 'get_plugins',
    failure: 'Could not load plugins.',
    units: ['enabled'],
    confirmed: { rows: [plugin], stated: ['1 enabled'] },
    confirmedZero: { rows: [{ ...plugin, enabled: false }], stated: ['0 enabled'] },
    slotStillRendered: () => screen.getByRole('heading', { level: 2 }),
  },
];

describe.each(CASES)('a header tally answers for the read beneath it', ({
  View, list, failure, units, confirmed, confirmedZero, slotStillRendered,
}) => {
  function only(listResult: () => Promise<unknown>) {
    invokeMock.mockImplementation((command: string) => {
      if (command === list) return listResult();
      if (command in QUIET) return Promise.resolve(QUIET[command]);
      throw new Error(`Unexpected command: ${command}`);
    });
  }

  function noTallyReachesTheSlot() {
    for (const unit of units) {
      // Any number in this unit's pill is the lie, whichever number it is: the
      // read that would make `0` and the read that would make `3` have both
      // not happened.
      expect(pill(new RegExp(`^\\d+ ${literal(unit).source}$`)), `a ${unit} tally`).toBeNull();
    }
  }

  it('states no tally at all while the read is unanswered', async () => {
    const read = deferred<unknown>();
    only(() => read.promise);
    render(<ToastProvider><View /></ToastProvider>);
    await act(async () => {});

    expect(slotStillRendered()).toBeInTheDocument();
    noTallyReachesTheSlot();
    expect(invokeMock.mock.calls.filter(([command]) => command === list)).toHaveLength(1);
  });

  it('states no tally once the read has failed, and says so in the body', async () => {
    const read = deferred<unknown>();
    only(() => read.promise);
    render(<ToastProvider><View /></ToastProvider>);
    await act(async () => { read.reject(new Error('synthetic private native detail')); });

    expect(slotStillRendered()).toBeInTheDocument();
    noTallyReachesTheSlot();
    expect(screen.getByText(literal(failure))).toBeInTheDocument();
  });

  it('states the real tallies with their existing tones once a read has confirmed them', async () => {
    only(() => Promise.resolve(confirmed.rows));
    render(<ToastProvider><View /></ToastProvider>);

    for (const text of confirmed.stated) {
      const stated = await screen.findByText(text);
      const className = stated.closest('span')?.className ?? '';
      // `success` is the pill's emerald tone, and it is what an operator reads
      // as "this is a measurement". A number in the quiet tone beside a
      // confirmed non-empty tally would be a tone disagreeing with its read.
      if (/^0 /.test(text)) expect(className, text).not.toContain('emerald');
      else expect(className, text).toContain('emerald');
    }
  });

  it('keeps a confirmed zero a real zero, in the quiet tone it has always used', async () => {
    only(() => Promise.resolve(confirmedZero.rows));
    render(<ToastProvider><View /></ToastProvider>);

    // `0 enabled` on a confirmed list is a measurement. Collapsing it into
    // silence is the same mistake as printing a zero a failed read invented:
    // an empty install has to stay distinguishable from an unreadable one.
    for (const text of confirmedZero.stated) {
      const stated = await screen.findByText(text);
      expect(stated.closest('span')?.className, text).not.toContain('emerald');
    }
  });
});
