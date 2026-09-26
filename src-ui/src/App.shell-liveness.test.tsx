// The sidebar footer's liveness badge.
//
// The badge shipped as a constant: a pulsing cyan dot beside the literal word
// `live`, in a component that receives nothing but `{ currentView, onNavigate }`.
// There was no read behind it, so nothing could end the animation — not a failed
// poll, not a dead event subscription, not a rebuilt bundle.
//
// These contracts are written against the unchanged shell first: the badge has to
// exist, name the read it is reporting, and only animate while that read is
// confirmed. A confirmed channel is the other half of the same row: the pulse and
// the word `live` still render, on a claim that can now end.

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
// The strip has its own read and its own liveness contract; this row is about the
// shell's badge, and a live strip would add a second animated dot to every query.
vi.mock('./components/jarvis/HealthBanner', () => ({ default: () => null }));
vi.mock('./components/jarvis/MythosCompanionSprite', () => ({ MythosCompanionSprite: () => null }));

const REGISTRY_EVENT = 'action-registry://alerts';
const MISSED_EVENT = 'cron://missed-jobs';
const READ = 'get_action_registry_alerts';
const NATIVE_DETAIL = 'synthetic private native detail';

type ListenOutcome = 'resolve' | 'reject' | 'defer';
type ReadOutcome = 'empty' | 'reject';

let readScript: ReadOutcome[];
let listenScript: Record<string, ListenOutcome[]>;
let listenCounts: Record<string, number>;
let readCount: number;
let deferredListens: Array<{ name: string; index: number; resolve: (unlisten: () => void) => void; reject: (reason: Error) => void }>;

beforeEach(() => {
  localStorage.setItem('jarvis-current-view', 'sessions');
  readScript = ['empty'];
  listenScript = { [REGISTRY_EVENT]: ['resolve'], [MISSED_EVENT]: ['resolve'] };
  listenCounts = {};
  readCount = 0;
  deferredListens = [];
  listenMock.mockReset();
  listenMock.mockImplementation((name: string) => {
    const index = (listenCounts[name] = (listenCounts[name] ?? -1) + 1);
    const outcome = listenScript[name]?.[index] ?? 'resolve';
    if (outcome === 'resolve') return Promise.resolve(() => {});
    if (outcome === 'reject') return Promise.reject(new Error(NATIVE_DETAIL));
    return new Promise<() => void>((resolve, reject) => {
      deferredListens.push({ name, index, resolve, reject });
    });
  });
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === READ) {
      const outcome = readScript[readCount] ?? 'empty';
      readCount += 1;
      if (outcome === 'empty') return [];
      throw new Error(NATIVE_DETAIL);
    }
    return [];
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

const mount = async () => { await act(async () => { render(<App />); }); };
const badge = () => screen.getByRole('status', { name: 'Shell liveness' });
const badgeDot = () => badge().querySelector('span');
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const settleListen = async (name: string, index: number, outcome: 'resolve' | 'reject') => {
  const pending = deferredListens.find((entry) => entry.name === name && entry.index === index);
  if (!pending) throw new Error(`no deferred listen for ${name}#${index}`);
  await act(async () => {
    if (outcome === 'resolve') pending.resolve(() => {});
    else pending.reject(new Error(NATIVE_DETAIL));
  });
};

describe('the shell liveness badge reports the read behind it', () => {
  it('animates and says live only once every alert channel has answered, and names the read', async () => {
    await mount();
    await waitFor(() => expect(badge()).toHaveTextContent('live'));

    expect(badgeDot()).toHaveClass('animate-pulse');
    // The word alone used to be the whole claim. The badge now names the read it
    // reports, in text a screen reader reaches, not only in colour or motion.
    expect(badge()).toHaveTextContent(/Action registry alert/i);
    expect(badgeDot()).toHaveClass('bg-cyan-neon');
    // The confirmed-success half of this row: the existing word and colour survive.
    expect(screen.getByText('live')).toBeInTheDocument();
  });

  it('claims nothing while a channel is still unanswered', async () => {
    listenScript = { [REGISTRY_EVENT]: ['defer'], [MISSED_EVENT]: ['resolve'] };
    await mount();
    await flush();
    await waitFor(() => expect(badge()).toHaveTextContent('checking'));

    expect(badgeDot()).not.toHaveClass('animate-pulse');
    expect(badge()).toHaveTextContent(/not all answered/i);
    expect(screen.queryByText('live')).not.toBeInTheDocument();
  });

  it('stops animating and stops saying live when a subscription is refused', async () => {
    listenScript = { [REGISTRY_EVENT]: ['reject'], [MISSED_EVENT]: ['resolve'] };
    await mount();
    await flush();
    await waitFor(() => expect(badge()).toHaveTextContent('events down'));

    expect(badgeDot()).not.toHaveClass('animate-pulse');
    expect(badgeDot()).toHaveClass('bg-amber-400');
    expect(screen.queryByText('live')).not.toBeInTheDocument();
  });

  it('stops animating when the refused channel is the boot read', async () => {
    readScript = ['reject'];
    await mount();
    await flush();
    await waitFor(() => expect(badge()).toHaveTextContent('events down'));

    expect(badgeDot()).not.toHaveClass('animate-pulse');
    expect(badge()).toHaveTextContent(/alert/i);
  });

  it('resumes the confirmed claim when a subscription granted after the first attempt answers', async () => {
    listenScript = { [REGISTRY_EVENT]: ['defer'], [MISSED_EVENT]: ['resolve'] };
    await mount();
    await flush();
    await waitFor(() => expect(badge()).toHaveTextContent('checking'));

    await settleListen(REGISTRY_EVENT, 0, 'resolve');
    await waitFor(() => expect(badge()).toHaveTextContent('live'));
    expect(badgeDot()).toHaveClass('animate-pulse');
  });

  it('never leaks a caught native message into the badge', async () => {
    listenScript = { [REGISTRY_EVENT]: ['reject'], [MISSED_EVENT]: ['reject'] };
    readScript = ['reject'];
    await mount();
    await flush();
    await waitFor(() => expect(badge()).toHaveTextContent('events down'));

    expect(badge().textContent).not.toContain(NATIVE_DETAIL);
    expect(badgeDot()).not.toHaveClass('animate-pulse');
  });
});
