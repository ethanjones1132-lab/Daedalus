// ═══════════════════════════════════════════════════════════════
// BuildBadge — build provenance visible + stale-guard regression
// ═══════════════════════════════════════════════════════════════
// Must fail if provenance is hidden or stale-marker suppressed.

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BuildBadge from './BuildBadge';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

beforeEach(() => { vi.clearAllMocks(); });

describe('BuildBadge provenance', () => {
  it('renders version + sha when get_build_info returns', async () => {
    invokeMock.mockResolvedValue({ version: '0.3.1', git_sha: 'a1b2c3d', git_short: 'a1b2c3d', dirty: false, stale: false, build_time: '2026-08-26', source_sha: 'a1b2c3d' });
    render(<BuildBadge />);
    await waitFor(() => expect(screen.getByText(/v0\.3\.1/)).toBeDefined());
    expect(screen.getByText(/a1b2c3d/)).toBeDefined();
  });

  it('shows stale warning when source has advanced', async () => {
    invokeMock.mockResolvedValue({ version: '0.3.1', git_sha: 'deadbee', git_short: 'deadbee', dirty: false, stale: true, build_time: '2026-08-26', source_sha: 'fresher01' });
    render(<BuildBadge />);
    await waitFor(() => expect(screen.getByText(/STALE/i)).toBeDefined());
  });

  it('falls back to v… when command unavailable (older binary)', () => {
    invokeMock.mockRejectedValue(new Error('not registered'));
    render(<BuildBadge />);
    expect(screen.getByText('v…')).toBeDefined();
  });
});
