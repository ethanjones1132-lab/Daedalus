import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NavigationProvider } from '../../shell/navigation';
import HarnessPage from './HarnessPage';
import type { SavedHarnessManifest } from './harness-api';

const { listManifests } = vi.hoisted(() => ({ listManifests: vi.fn() }));
vi.mock('./harness-api', () => ({ harnessApi: { listManifests } }));

const savedManifest: SavedHarnessManifest = {
  manifest: {
    schema_version: 1,
    id: 'manifest-1',
    project_root: 'C:/projects/one',
    project_kind: 'typescript',
    purpose: 'bug_fix',
    template_family: 'typescript_node',
    guides: { rules: [], brief_template: '', skills: [], references: [], banned_defaults: [] },
    maker_agent_id: 'maker',
    checker: { enabled: true, agent_id: 'checker', rubric: '' },
    sensors: [],
    loop: { max_rounds: 2, abort_on_no_progress: true },
    approval: { required_for_new_commands: true },
  },
  revision: 3,
  manifest_hash: 'hash-1',
};

function mount() {
  return render(<NavigationProvider initial="harness"><HarnessPage /></NavigationProvider>);
}

afterEach(() => {
  cleanup();
  listManifests.mockReset();
});

describe('HarnessPage picker route', () => {
  it('shows an honest empty state and does not present it as a successful run', async () => {
    listManifests.mockResolvedValue([]);
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project root' }), { target: { value: 'C:/projects/one' } });

    expect(await screen.findByText('No saved manifest for this project and purpose.')).toBeInTheDocument();
    expect(screen.getByText(/No check or harness run has been performed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select a manifest' })).toBeDisabled();
    expect(screen.queryByText(/successful|passed|green/i)).not.toBeInTheDocument();
  });

  it('lists and selects a saved manifest for the chosen project and purpose', async () => {
    listManifests.mockResolvedValue([savedManifest]);
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project root' }), { target: { value: 'C:/projects/one' } });

    const manifest = await screen.findByRole('button', { name: /typescript · typescript_node/ });
    expect(manifest).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(manifest);
    expect(manifest).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Guide editing, live rounds, and run history are not part of this picker slice/)).toBeInTheDocument();
  });

  it('keeps a failed lookup distinct from a valid empty manifest list', async () => {
    listManifests.mockRejectedValue(new Error('offline'));
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project root' }), { target: { value: 'C:/projects/one' } });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not read saved harness manifests.');
    expect(alert).toHaveTextContent('this is not an empty list.');
    // The authored sentence is the whole reason; whatever the rejecting layer said
    // may embed store or project detail and is never echoed to the operator.
    expect(alert).not.toHaveTextContent('offline');
    expect(screen.queryByText('No saved manifest for this project and purpose.')).not.toBeInTheDocument();
  });

  it('treats an unreadable manifest body as a failed read, not an empty list', async () => {
    listManifests.mockResolvedValue(null as unknown as SavedHarnessManifest[]);
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project root' }), { target: { value: 'C:/projects/one' } });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('this is not an empty list.');
    expect(screen.queryByText('No saved manifest for this project and purpose.')).not.toBeInTheDocument();
  });
});
