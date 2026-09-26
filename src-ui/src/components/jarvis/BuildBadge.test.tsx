// ═══════════════════════════════════════════════════════════════
// BuildBadge — build provenance visible, stale-guard, and the third
// state: a build whose provenance cannot be checked is not clean
// ═══════════════════════════════════════════════════════════════
// Must fail if provenance is hidden, if stale/unverifiable is
// suppressed, or if unavailable provenance is allowed to look clean.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BuildBadge from './BuildBadge';
import { resetSharedBuildProvenanceStores, type BuildInfo } from './build-provenance';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function buildInfo(overrides: Partial<BuildInfo> = {}): BuildInfo {
  return {
    version: '0.3.1',
    git_sha: 'a1b2c3d4e5f6a7b8',
    git_short: 'a1b2c3d4e5',
    dirty: false,
    build_time: '2026-08-26',
    source_sha: 'a1b2c3d4e5f6a7b8',
    stale: false,
    ...overrides,
  };
}

function buildInfoCalls(): number {
  return invokeMock.mock.calls.filter(call => call[0] === 'get_build_info').length;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSharedBuildProvenanceStores();
});

describe('BuildBadge provenance', () => {
  it('renders version + sha when get_build_info returns', async () => {
    invokeMock.mockResolvedValue(buildInfo());
    render(<BuildBadge />);
    await waitFor(() => expect(screen.getByText(/v0\.3\.1/)).toBeDefined());
    expect(screen.getByText(/a1b2c3d4e5/)).toBeDefined();
  });

  it('shows stale warning when source has advanced', async () => {
    invokeMock.mockResolvedValue(buildInfo({ git_sha: 'deadbeef', source_sha: 'fresher01', stale: true }));
    render(<BuildBadge />);
    await waitFor(() => expect(screen.getByText(/stale/i)).toBeDefined());
  });

  it('falls back to v… when command unavailable (older binary)', async () => {
    invokeMock.mockRejectedValue(new Error('not registered'));
    render(<BuildBadge />);
    expect(screen.getByText('v…')).toBeDefined();
    await waitFor(() => expect(screen.getByText(/unverifiable/i)).toBeDefined());
  });
});

describe('BuildBadge unverifiable provenance', () => {
  it('never presents a binary whose source tree is unavailable as clean', async () => {
    // Native reports `stale: false` when the source tree cannot be located
    // (`src-tauri/src/commands/system.rs:322-350`). That is "not checked",
    // not "checked and current".
    invokeMock.mockResolvedValue(buildInfo({ source_sha: null }));
    render(<BuildBadge />);
    await waitFor(() => expect(screen.getByText(/unverifiable/i)).toBeDefined());
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /source tree is not available/i })).toBeInTheDocument();
  });

  it('never presents a build with no recorded source sha as clean', async () => {
    invokeMock.mockResolvedValue(buildInfo({ git_sha: 'unknown', git_short: 'unknown', source_sha: null }));
    render(<BuildBadge />);
    await waitFor(() => expect(screen.getByText(/unverifiable/i)).toBeDefined());
  });

  it('never presents an equal-but-dirty build as a confirmed match', async () => {
    invokeMock.mockResolvedValue(buildInfo({ dirty: true }));
    render(<BuildBadge />);
    await waitFor(() => expect(screen.getByText(/unverifiable/i)).toBeDefined());
    expect(screen.getByRole('button', { name: /modified working tree/i })).toBeInTheDocument();
  });

  it('keeps the last observed build readable when a recheck fails', async () => {
    invokeMock
      .mockResolvedValueOnce(buildInfo())
      .mockRejectedValueOnce(new Error('not registered'));
    render(<BuildBadge />);
    await waitFor(() => expect(screen.getByText(/v0\.3\.1/)).toBeDefined());
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText(/unverifiable/i)).toBeDefined());
    expect(screen.getByText(/v0\.3\.1/)).toBeDefined();
  });
});

describe('BuildBadge revalidation', () => {
  it('shares one observation between two mounted badges', async () => {
    invokeMock.mockResolvedValue(buildInfo());
    render(<><BuildBadge /><BuildBadge /></>);
    await waitFor(() => expect(screen.getAllByText(/v0\.3\.1/)).toHaveLength(2));
    expect(buildInfoCalls()).toBe(1);
  });

  it('re-reads on a deliberate click so a moved source tree is caught', async () => {
    invokeMock
      .mockResolvedValueOnce(buildInfo())
      .mockResolvedValueOnce(buildInfo({ source_sha: 'fresher01', stale: true }));
    render(<BuildBadge />);
    await waitFor(() => expect(screen.getByText(/v0\.3\.1/)).toBeDefined());
    expect(buildInfoCalls()).toBe(1);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText(/stale/i)).toBeDefined());
    expect(buildInfoCalls()).toBe(2);
  });

  it('re-reads once on window focus', async () => {
    invokeMock.mockResolvedValue(buildInfo());
    render(<><BuildBadge /><BuildBadge /></>);
    await waitFor(() => expect(buildInfoCalls()).toBe(1));
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(buildInfoCalls()).toBe(2));
  });

  it('does not re-read on a focus that arrives while a read is in flight', async () => {
    const pending = deferred<BuildInfo>();
    invokeMock.mockImplementation(() => pending.promise);
    render(<BuildBadge />);
    await waitFor(() => expect(buildInfoCalls()).toBe(1));
    fireEvent(window, new Event('focus'));
    expect(buildInfoCalls()).toBe(1);
    pending.resolve(buildInfo());
    await waitFor(() => expect(screen.getByText(/v0\.3\.1/)).toBeDefined());
  });

  it('keeps the recheck control operable while a read is in flight', async () => {
    const pending = deferred<BuildInfo>();
    invokeMock.mockImplementation(() => pending.promise);
    render(<BuildBadge />);
    await waitFor(() => expect(buildInfoCalls()).toBe(1));
    const control = screen.getByRole('button');
    expect(control).toBeEnabled();
    expect(control).toHaveAttribute('aria-busy', 'true');
    // A click during a hung read is absorbed rather than stranded: the control
    // stays operable and issues no second request.
    fireEvent.click(control);
    expect(buildInfoCalls()).toBe(1);
    pending.resolve(buildInfo());
    await waitFor(() => expect(screen.getByRole('button', { name: /matches source/i })).toBeEnabled());
  });

  it('confirms a match in text rather than leaving the state to colour', async () => {
    invokeMock.mockResolvedValue(buildInfo());
    render(<BuildBadge />);
    await waitFor(() => expect(screen.getByText(/v0\.3\.1/)).toBeDefined());
    expect(screen.getByRole('button', { name: /matches source/i })).toBeInTheDocument();
  });
});
