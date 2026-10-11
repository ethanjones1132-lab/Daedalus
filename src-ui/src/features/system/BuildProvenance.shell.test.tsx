import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { NavigationProvider } from '../../shell/navigation';
import { Shell } from '../../shell/Shell';
import { resetSharedBuildProvenanceStores, type BuildInfo } from '../../domain/build-provenance';
import { doctor, healthFor, status } from '../health/test-fixtures';

// The build badge is mounted once now (titlebar). The Health page's provenance
// panel reads the same shared store, so the two must show one observation —
// one native read, one re-check per window focus. (Legacy: two badges, sidebar
// footer + header, sharing the store.) Before the store, each mount read
// `get_build_info` once on its own and never again, so a source tree that
// advanced after boot stayed visually clean.

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./HealthBanner', () => ({ default: () => null }));
vi.mock('./SystemStatusBar', () => ({ default: () => null }));

function buildInfo(overrides: Partial<BuildInfo> = {}): BuildInfo {
  return {
    version: '0.6.0',
    git_sha: 'a1b2c3d4e5f6a7b8',
    git_short: 'a1b2c3d4e5',
    dirty: false,
    build_time: '2026-09-25T10:00:00Z',
    source_sha: 'a1b2c3d4e5f6a7b8',
    stale: false,
    ...overrides,
  };
}

function buildInfoCalls(): number {
  return vi.mocked(invoke).mock.calls.filter((call) => call[0] === 'get_build_info').length;
}

function serve(build: () => BuildInfo) {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'get_build_info') return build();
    if (command === 'jarvis_check_status') return status;
    if (command === 'get_system_health') return healthFor('ollama', true);
    if (command === 'get_doctor_report') return doctor;
    return null;
  });
}

function mountHealthInShell() {
  render(
    <NavigationProvider initial="health">
      <Shell />
    </NavigationProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  resetSharedBuildProvenanceStores();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 503 })));
  vi.stubGlobal('scrollTo', vi.fn());
  Element.prototype.scrollTo = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  vi.mocked(invoke).mockReset();
  serve(() => buildInfo());
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  Reflect.deleteProperty(Element.prototype, 'scrollTo');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Shell build provenance', () => {
  it('reads build provenance once for the titlebar badge and the Health page panel', async () => {
    mountHealthInShell();
    await waitFor(() => expect(screen.getAllByText(/v0\.6\.0/)).toHaveLength(2));
    expect(buildInfoCalls()).toBe(1);
  });

  it('mounts exactly one titlebar badge, even off the Health page', async () => {
    render(<NavigationProvider initial="overview"><Shell /></NavigationProvider>);
    await waitFor(() => expect(screen.getAllByText(/v0\.6\.0/)).toHaveLength(1));
    expect(buildInfoCalls()).toBe(1);
  });

  it('shows the same verdict in the badge and the panel', async () => {
    serve(() => buildInfo({ source_sha: null }));
    mountHealthInShell();
    await waitFor(() => expect(screen.getAllByText(/unverifiable/i)).toHaveLength(2));
  });

  it('catches a source tree that advanced after boot on window focus', async () => {
    mountHealthInShell();
    await waitFor(() => expect(screen.getAllByText(/v0\.6\.0/)).toHaveLength(2));
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument();
    serve(() => buildInfo({ source_sha: 'fresher01', stale: true }));
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(screen.getAllByText(/stale/i)).toHaveLength(2));
    expect(buildInfoCalls()).toBe(2);
  });

  it('re-checks once, not once per mounted reader, on window focus', async () => {
    mountHealthInShell();
    await waitFor(() => expect(buildInfoCalls()).toBe(1));
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(buildInfoCalls()).toBe(2));
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(buildInfoCalls()).toBe(3));
  });

  it('re-checks from the panel as well as the badge', async () => {
    mountHealthInShell();
    await waitFor(() => expect(buildInfoCalls()).toBe(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Recheck build provenance' }));
    await waitFor(() => expect(buildInfoCalls()).toBe(2));
  });
});
