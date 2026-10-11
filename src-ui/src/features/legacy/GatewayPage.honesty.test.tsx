import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import GatewayPage from './GatewayPage';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const base = {
  running: true, port: 19876, active_connections: 0, uptime_seconds: 0,
  version: '1.0.0', timestamp: '2026-09-16T10:00:00Z',
};

beforeEach(() => { vi.mocked(invoke).mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Gateway honest readouts', () => {
  it('labels the backend placeholder zeros as not measured instead of showing them', async () => {
    vi.mocked(invoke).mockResolvedValue(base);
    await act(async () => { render(<GatewayPage />); });
    expect(await screen.findByText('Gateway is running')).toBeInTheDocument();
    expect(screen.getAllByText('not measured')).toHaveLength(2);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('shows real connection and uptime values when the backend reports them', async () => {
    vi.mocked(invoke).mockResolvedValue({ ...base, active_connections: 4, uptime_seconds: 125 });
    await act(async () => { render(<GatewayPage />); });
    expect(await screen.findByText('4')).toBeInTheDocument();
    expect(screen.getByText('2m 5s')).toBeInTheDocument();
    expect(screen.queryByText('not measured')).not.toBeInTheDocument();
  });

  it('is labelled legacy and is not presented as the Bun server', async () => {
    vi.mocked(invoke).mockResolvedValue(base);
    await act(async () => { render(<GatewayPage />); });
    expect(screen.getByText('legacy')).toBeInTheDocument();
    expect(screen.getByText(/It is not the Bun server/)).toBeInTheDocument();
  });
});
