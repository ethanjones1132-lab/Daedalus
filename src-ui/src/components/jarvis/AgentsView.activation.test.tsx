import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentsView from './AgentsView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

type Discovery = {
  id: string;
  slug: string;
  status: string;
  source_hash?: string;
  source_path?: string;
  source_size_bytes?: number;
};

type Projection = {
  slug: string;
  source_path: string;
  source_hash: string;
  projection_version: number;
  status: string;
  name?: string;
  description?: string;
  tools?: string[];
  version_tag?: string;
  source_size_bytes?: number;
  validation_errors?: string;
  active: boolean;
  activated_at?: string | null;
  deactivated_at?: string | null;
  created_at: string;
  updated_at: string;
};

const legacyAgent = {
  id: 'legacy-1', name: 'Legacy', description: '', model: 'legacy-model', backend: 'jarvis',
  system_prompt: '', enabled: true, config: null, created_at: '', updated_at: '',
};
const sourceHash = 'a'.repeat(64);
const sourcePath = '/agents/coder/soul.md';
const baseProjection: Projection = {
  slug: 'coder',
  source_path: sourcePath,
  source_hash: sourceHash,
  projection_version: 1,
  status: 'valid',
  name: 'Coder',
  source_size_bytes: 128,
  active: false,
  created_at: '',
  updated_at: '',
};

function response(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

let discovery: Discovery[];
let projections: Projection[];
let listProjections: () => Promise<Projection[]>;
let activateProjection: (projection: Projection) => Promise<Projection>;
let deactivateProjection: (slug: string) => Promise<Projection | null>;
const calls = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command);

beforeEach(() => {
  discovery = [{ id: 'coder', slug: 'coder', status: 'valid', source_hash: sourceHash, source_path: sourcePath }];
  projections = [{ ...baseProjection }];
  listProjections = () => Promise.resolve(projections);
  activateProjection = async (projection) => {
    projections = [{ ...projection, active: true, activated_at: '2026-01-01T00:00:00Z' }];
    return projections[0];
  };
  deactivateProjection = async (slug) => {
    const current = projections.find((projection) => projection.slug === slug);
    if (!current) return null;
    projections = [{ ...current, active: false, deactivated_at: '2026-01-01T00:00:00Z' }];
    return projections[0];
  };
  invokeMock.mockReset().mockImplementation((command: string, args?: Record<string, unknown>) => {
    if (command === 'list_agents') return Promise.resolve([legacyAgent]);
    if (command === 'list_channels' || command === 'list_agent_channel_bindings') return Promise.resolve([]);
    if (command === 'list_agent_projections') return listProjections();
    if (command === 'activate_agent_projection') return activateProjection(args?.projection as Projection);
    if (command === 'deactivate_agent_projection') return deactivateProjection(String(args?.slug));
    throw new Error(`Unexpected command: ${command}`);
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/agents') && init?.method !== 'POST') return response(discovery);
    if (url.endsWith('/agents/coder/activate')) return response({ success: true, projection: { ...baseProjection, active: true } });
    if (url.endsWith('/agents/coder/deactivate')) return response({ success: true, projection: { ...baseProjection, active: false } });
    throw new Error(`Unexpected fetch: ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Agent lifecycle activation', () => {
  it('activates a valid discovered Agent once and waits for confirmed readback', async () => {
    render(<AgentsView />);
    await screen.findByText('coder');

    const activate = screen.getByRole('button', { name: 'Activate agent coder' });
    await waitFor(() => expect(activate).toBeEnabled());
    fireEvent.click(activate);
    fireEvent.click(activate);

    await waitFor(() => expect(calls('activate_agent_projection')).toHaveLength(1));
    expect(calls('activate_agent_projection')[0][1]).toMatchObject({
      projection: expect.objectContaining({ slug: 'coder', source_hash: sourceHash }),
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deactivate agent coder' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Activate agent coder' })).not.toBeInTheDocument();
  });

  it('does not offer activation for an invalid Agent', async () => {
    discovery = [{ id: 'bad', slug: 'bad', status: 'invalid', source_hash: 'b'.repeat(64) }];
    render(<AgentsView />);
    await screen.findByText('bad');

    expect(screen.getByRole('button', { name: 'Activate agent bad' })).toBeDisabled();
    expect(calls('activate_agent_projection')).toHaveLength(0);
  });

  it('shows a changed source as stale and allows a fresh activation', async () => {
    projections = [{ ...baseProjection, active: true, activated_at: '2026-01-01T00:00:00Z' }];
    render(<AgentsView />);
    await screen.findByText('coder');
    expect(screen.getByRole('button', { name: 'Deactivate agent coder' })).toBeEnabled();

    discovery = [{ ...discovery[0], source_hash: 'c'.repeat(64) }];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh discovery' }));
    await screen.findByText(/source changed|stale/i);
    expect(screen.getByRole('button', { name: 'Activate agent coder' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Deactivate agent coder' })).toBeEnabled();
  });

  it('keeps deactivation available when the source is invalid', async () => {
    discovery = [{ id: 'coder', slug: 'coder', status: 'invalid' }];
    projections = [{ ...baseProjection, active: true, activated_at: '2026-01-01T00:00:00Z' }];
    render(<AgentsView />);
    await screen.findByText('coder');

    const deactivate = screen.getByRole('button', { name: 'Deactivate agent coder' });
    expect(deactivate).toBeEnabled();
    fireEvent.click(deactivate);
    await waitFor(() => expect(calls('deactivate_agent_projection')).toHaveLength(1));
    expect(calls('deactivate_agent_projection')[0][1]).toEqual({ slug: 'coder' });
  });

  it('does not repeat a native write when confirmation readback fails', async () => {
    let reads = 0;
    listProjections = () => {
      reads += 1;
      return reads === 1 ? Promise.resolve(projections) : Promise.reject(new Error('native projection read failed'));
    };
    render(<AgentsView />);
    await screen.findByText('coder');
    const activate = screen.getByRole('button', { name: 'Activate agent coder' });
    await waitFor(() => expect(activate).toBeEnabled());
    fireEvent.click(activate);
    await waitFor(() => expect(screen.getByText(/Agent change was saved, but confirmation readback failed/)).toBeInTheDocument());
    expect(calls('activate_agent_projection')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Retry reconciliation for coder' })).toBeEnabled();
  });
});
