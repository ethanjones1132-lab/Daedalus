import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { JarvisConfig, RoutingStage } from '../../domain/types';
import { OrchestrationPanel } from './OrchestrationPanel';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const baseConfig = {
  version: 'test',
  active_backend: 'llama_cpp',
  llama_cpp: { base_url: 'http://127.0.0.1:8080/v1', model: 'serving-alias.gguf' },
  ollama: { base_url: 'http://localhost:11434/v1', model: 'local-model:latest' },
  openrouter: { base_url: 'https://openrouter.ai/api/v1', model: 'openrouter/free', api_key: '' },
  opencode_zen: { base_url: 'https://opencode.ai/zen/v1', api_key: '' },
  opencode_go: { base_url: 'https://opencode.ai/zen/go/v1', api_key: '' },
  vllm: { enabled: false, base_url: '', model: '', api_key_env: '' },
  orchestrator: { enabled: true, unknown_future_field: { keep: true } },
} as unknown as JarvisConfig;

function Harness({ initial = baseConfig }: { initial?: JarvisConfig }) {
  const [config, setConfig] = useState(initial);
  return <OrchestrationPanel config={config} update={(update) => setConfig(update)} />;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({
    operation_id: 'probe-1', stage: 'planner', status: 'success',
    attempts: [{ stage: 'planner', provider: 'ollama', model: 'org/model:tag', choice: 'primary', outcome: 'answered', answered: true, cloud: false, duration_ms: 43 }],
    rejected_candidates: [{ stage: 'planner', provider: 'openrouter', model: 'cloud/model', reason: 'cloud_helpers_disabled' }],
    answered_by: { stage: 'planner', provider: 'ollama', model: 'org/model:tag', cloud: false },
    left_machine: false, duration_ms: 52,
  });
});
afterEach(cleanup);

const stages: RoutingStage[] = ['coordinator', 'planner', 'executor', 'reviewer', 'rewriter', 'synthesizer'];

describe('OrchestrationPanel', () => {
  it('shows an old llama.cpp target until the user explicitly updates it', () => {
    render(<Harness initial={{ ...baseConfig, orchestrator: { enabled: true,
      stage_models: { planner: { provider: 'llama_cpp', model: 'old-alias.gguf' } } } }} />);
    const model = screen.getByRole('textbox', { name: 'planner primary model' });
    expect(model).toHaveValue('old-alias.gguf');
    fireEvent.click(screen.getByRole('button', { name: 'Use configured llama.cpp model for planner primary' }));
    expect(model).toHaveValue('serving-alias.gguf');
  });

  it('does not label cloud targets blocked when a cloud backend was explicitly selected', () => {
    render(<Harness initial={{ ...baseConfig, active_backend: 'openrouter', orchestrator: { enabled: true,
      allow_cloud_helpers: false, stage_models: { planner: { provider: 'openrouter', model: 'org/model:tag' } } } }} />);
    expect(screen.queryByText(/configured but blocked while cloud helpers are off/)).not.toBeInTheDocument();
  });
  it('defaults cloud helpers off and selects Direct/Orchestrated from the runtime switch', () => {
    const direct = { ...baseConfig, orchestrator: { enabled: false } } as JarvisConfig;
    render(<Harness initial={direct} />);
    const mode = screen.getByRole('group', { name: 'Orchestration mode' });
    expect(within(mode).getByRole('button', { name: 'Direct' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('switch', { name: 'Allow cloud helpers' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(within(mode).getByRole('button', { name: 'Orchestrated' }));
    expect(within(mode).getByRole('button', { name: 'Orchestrated' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders primary editors for all six stages and keeps custom model IDs intact', () => {
    render(<Harness />);
    for (const stage of stages) {
      expect(screen.getByRole('combobox', { name: `${stage} primary provider` })).toBeInTheDocument();
    }
    fireEvent.change(screen.getByRole('combobox', { name: 'planner primary provider' }), { target: { value: 'ollama' } });
    const model = screen.getByRole('textbox', { name: 'planner primary model' });
    fireEvent.change(model, { target: { value: 'org/model:tag' } });
    expect(model).toHaveValue('org/model:tag');
    expect(screen.getByText(/stage policies apply to Orchestrated turns/i)).toBeInTheDocument();
  });

  it('keeps stage policy while Direct is selected and uses the configured llama.cpp serving alias', () => {
    const policyConfig = {
      ...baseConfig,
      orchestrator: {
        ...baseConfig.orchestrator,
        stage_models: { planner: { provider: 'ollama', model: 'saved/model:tag' } },
      },
    } as JarvisConfig;
    render(<Harness initial={policyConfig} />);
    fireEvent.click(screen.getByRole('button', { name: 'Direct' }));
    expect(screen.getByRole('textbox', { name: 'planner primary model' })).toHaveValue('saved/model:tag');
    expect(screen.getByText(/Stage policies apply to Orchestrated turns/i)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'coordinator primary provider' }), { target: { value: 'llama_cpp' } });
    const llamaModel = screen.getByRole('textbox', { name: 'coordinator primary model' });
    expect(llamaModel).toHaveValue('serving-alias.gguf');
    expect(llamaModel).toHaveAttribute('readonly');
  });

  it('adds, removes, reorders fallbacks, and preserves an empty chain as disabled', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Customize planner fallbacks' }));
    expect(screen.getByText('No fallback candidates. This stage will stop after its primary fails.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add planner fallback' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add planner fallback' }));
    const first = screen.getByRole('textbox', { name: 'planner fallback 1 model' });
    const second = screen.getByRole('textbox', { name: 'planner fallback 2 model' });
    fireEvent.change(first, { target: { value: 'first/model:tag' } });
    fireEvent.change(second, { target: { value: 'second/model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move planner fallback 1 down' }));
    expect(screen.getByRole('textbox', { name: 'planner fallback 1 model' })).toHaveValue('second/model');
    fireEvent.click(screen.getByRole('button', { name: 'Remove planner fallback 1' }));
    expect(screen.getAllByRole('textbox', { name: /planner fallback .* model/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Use automatic planner fallbacks' }));
    expect(screen.getAllByText('Automatic fallback ranking')).toHaveLength(stages.length);
  });

  it('shows a cloud-blocked target without enabling cloud helpers and reports the actual probe trace', async () => {
    const configured = {
      ...baseConfig,
      orchestrator: {
        enabled: true,
        allow_cloud_helpers: false,
        stage_models: { planner: { provider: 'openrouter', model: 'cloud/model:tag' } },
      },
    } as JarvisConfig;
    render(<Harness initial={configured} />);
    expect(screen.getByText(/configured but blocked while cloud helpers are off/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test planner route' }));
    await screen.findByText(/Request left this machine: no/i);
    expect(invokeMock).toHaveBeenCalledWith('jarvis_test_orchestration_route', expect.objectContaining({
      stage: 'planner', config: configured,
    }));
    expect(screen.getByText(/ollama.*org\/model:tag.*answered/i)).toBeInTheDocument();
    expect(screen.getByText(/openrouter.*cloud\/model.*cloud_helpers_disabled/i)).toBeInTheDocument();
    expect(screen.queryByText(/OK/)).not.toBeInTheDocument();
  });

  it('cancels on duplicate prevention, edits, and unmount, and ignores stale results', async () => {
    const probe = deferred<Record<string, unknown>>();
    invokeMock.mockReturnValueOnce(probe.promise).mockResolvedValue({ operation_id: 'probe-1', cancelled: true });
    const configuredPrimary = {
      ...baseConfig,
      orchestrator: { ...baseConfig.orchestrator, stage_models: { planner: { provider: 'ollama', model: 'initial/model' } } },
    } as JarvisConfig;
    const view = render(<Harness initial={configuredPrimary} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test planner route' }));
    expect(screen.getByRole('button', { name: 'Cancel planner route test' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test executor route' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'planner primary model' }), { target: { value: 'edited/model' } });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('jarvis_cancel_orchestration_route_test', { operationId: expect.any(String) }));
    await act(async () => probe.resolve({
      operation_id: 'probe-1', stage: 'planner', status: 'success', attempts: [], rejected_candidates: [],
      left_machine: false, duration_ms: 10,
    }));
    expect(screen.queryByText('probe-1')).not.toBeInTheDocument();
    view.unmount();
  });

  it('cancels an active operation when the panel unmounts', async () => {
    const probe = deferred<Record<string, unknown>>();
    invokeMock.mockReturnValueOnce(probe.promise).mockResolvedValue({ operation_id: 'probe-2', cancelled: true });
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Test synthesizer route' }));
    view.unmount();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('jarvis_cancel_orchestration_route_test', { operationId: expect.any(String) }));
    await act(async () => probe.resolve({}));
  });

  it.each(['failed', 'cancelled', 'timeout'] as const)('displays the %s diagnostic outcome without answer content', async (status) => {
    invokeMock.mockResolvedValueOnce({
      operation_id: `probe-${status}`, stage: 'reviewer', status, attempts: [], rejected_candidates: [],
      left_machine: false, duration_ms: 90,
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Test reviewer route' }));
    const diagnostic = await screen.findByRole('region', { name: 'Reviewer route test result' });
    expect(within(diagnostic).getByText(new RegExp(`Route test ${status}`))).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Reviewer routing' })).getByText(/Test uses this stage and the current unsaved draft/)).toBeInTheDocument();
    expect(screen.queryByText(/Reply with exactly OK/)).not.toBeInTheDocument();
  });
});
