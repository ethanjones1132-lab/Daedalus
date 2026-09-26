// The health strip's dot answers to the read behind it.
//
// The strip keeps its last observation when a read fails, so the retained reading
// is real — but the pulsing dot kept animating on top of the alert that says
// `Health observation is unavailable. Showing previously observed health details;
// they may be stale.` An animation is this app's liveness vocabulary, so the one
// element still asserting "this is alive right now" was sitting underneath the
// surface admitting it cannot observe. The same read also left every retained
// subsystem row looking current.
//
// Written against the unchanged strip first. The confirmed half is the same
// contract from the other side: a freshly confirmed fault still pulses, still
// shows its colour, and still says what it measured.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import HealthBanner from './HealthBanner';
import type { JarvisStatus } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const healthy: JarvisStatus = {
  ollama_running: false, model_available: false, bun_server_running: true,
  bun_server_url: 'http://127.0.0.1:19877', claude_proxy_running: false,
  bridge_active: true, bridge_port: 19879, bun_available: true,
  active_backend: 'openrouter', model: 'observed-model', openrouter_key_set: true,
};
const offline: JarvisStatus = { ...healthy, openrouter_key_set: false };

function deferred() {
  let resolve!: (value: JarvisStatus) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<JarvisStatus>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let requests: Array<ReturnType<typeof deferred>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  requests = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(() => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const mount = async () => { await act(async () => { render(<HealthBanner />); }); };
const settle = async (index: number, status: JarvisStatus = healthy) => {
  await act(async () => { requests[index].resolve(status); });
};
const fail = async (index: number) => {
  await act(async () => { requests[index].reject(new Error('synthetic private native detail')); });
};
const advance = async (ms = 15000) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const expand = () => fireEvent.click(screen.getByRole('button', { name: /details/ }));
const strip = () => screen.getByRole('button', { name: /details|hide/ });
const dot = () => strip().querySelector('span');

describe('the health strip dot answers to its observation', () => {
  it('animates a freshly confirmed fault, in the colour the read produced', async () => {
    await mount();
    await settle(0, offline);

    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(dot()).toHaveClass('animate-pulse');
    expect(dot()).toHaveClass('bg-red-400');
  });

  it('stops animating once the read behind the observation fails', async () => {
    await mount();
    await settle(0, offline);
    expect(dot()).toHaveClass('animate-pulse');

    await advance();
    await fail(1);

    expect(screen.getByRole('alert')).toHaveTextContent('may be stale');
    expect(dot()).not.toHaveClass('animate-pulse');
    // The reading is retained rather than deleted, and it keeps the colour the
    // failed read's level carries.
    expect(dot()).toHaveClass('bg-amber-400');
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });

  it('marks every retained subsystem row as a previous observation', async () => {
    await mount();
    await settle(0, offline);
    expand();
    const before = screen.getByRole('listitem', { name: /Bun server/ });
    expect(before.textContent).not.toContain('(stale)');

    await advance();
    await fail(1);

    // The subsystem rows are the listitems that carry a row announcement; the
    // trailing `active: <backend>` entry is not a measurement and is not marked.
    const rows = screen.getAllByRole('listitem').filter((row) => row.getAttribute('aria-label'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toHaveTextContent('(stale)');
    }
    const bun = screen.getByRole('listitem', { name: /Bun server/ });
    // The measurement is retained, not replaced by the failure.
    expect(within(bun).getByText('is running')).toBeInTheDocument();
    expect(bun.getAttribute('aria-label')).toContain('previously observed');
  });

  it('animates again only after a read confirms the observation afresh', async () => {
    await mount();
    await settle(0, offline);
    await advance();
    await fail(1);
    expect(dot()).not.toHaveClass('animate-pulse');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    // A refresh that has not come back is not a fresh observation, so the claim
    // stays un-animated while the read is in flight.
    expect(dot()).not.toHaveClass('animate-pulse');
    await settle(2, offline);
    expect(dot()).toHaveClass('animate-pulse');
  });

  it('keeps animating while a confirmed observation is only being refreshed', async () => {
    await mount();
    await settle(0, offline);
    await advance();

    expect(screen.getByRole('status', { name: 'Health observation' })).toHaveTextContent('Refreshing health');
    // The strip says out loud that a re-read is in flight, and the reading on
    // screen is the last confirmed one, so the animation stays and the operator is
    // told the age of it rather than left to infer it.
    expect(dot()).toHaveClass('animate-pulse');
    await fail(1);
    expect(dot()).not.toHaveClass('animate-pulse');
  });

  it('never animates while there is no observation at all', async () => {
    await mount();
    await fail(0);

    // No snapshot means no strip, so there is no dot that could claim liveness.
    expect(screen.queryByRole('button', { name: /details/ })).not.toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeNull();
  });
});
