import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HealthPage from './HealthPage';
import { resetSharedBuildProvenanceStores } from '../../domain/build-provenance';
import { cleanBuild, doctor, healthFor, status, stubUnreachableBun } from './test-fixtures';
import type { JarvisStatus } from '../../domain/types';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function serve(statusValue: JarvisStatus, health: unknown) {
  invokeMock.mockImplementation((command: string) => {
    const table: Record<string, unknown> = {
      jarvis_check_status: statusValue,
      get_system_health: health,
      get_doctor_report: doctor,
      get_build_info: cleanBuild,
    };
    return Promise.resolve(table[command] ?? true);
  });
}

beforeEach(() => {
  stubUnreachableBun();
  resetSharedBuildProvenanceStores();
  invokeMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const gauge = (name: string) => screen.getByRole('article', { name: `${name} gauge` });

describe('Health page verdict and gauges', () => {
  it('reads the same verdict the global banner reads, in words', async () => {
    serve({ ...status, openrouter_key_set: false, active_backend: 'openrouter' }, healthFor('ollama', true));
    render(<HealthPage />);
    expect(await screen.findByText('Backend "openrouter" is unreachable')).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('says the system is ready when the active backend is healthy', async () => {
    serve(status, healthFor('ollama', true));
    render(<HealthPage />);
    expect(await screen.findByText('All systems ready')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('treats llama_cpp (the default Inference backend) as a local backend that must be running', async () => {
    const llama: JarvisStatus = {
      ...status,
      active_backend: 'llama_cpp',
      ollama_running: false,
      model_available: true,
      llama_cpp_running: true,
      model: 'gemma-4-26B-A4B-it-IQ2_M.gguf',
    };
    serve(llama, {
      ...healthFor('ollama', true),
      ollama: { running: false, model: null, url: 'http://127.0.0.1:11434' },
      llama_cpp: { running: true, model: 'gemma-4-26B-A4B-it-IQ2_M.gguf', url: 'http://127.0.0.1:8080' },
    });
    render(<HealthPage />);
    expect(await screen.findByText('All systems ready')).toBeInTheDocument();
    expect(screen.queryByText('Offline')).not.toBeInTheDocument();

    const gemma = gauge('Gemma llama.cpp');
    expect(within(gemma).getByText('Running')).toBeInTheDocument();
    expect(within(gemma).getByText('Required by the active Inference backend')).toBeInTheDocument();
    expect(within(gemma).getByText('http://127.0.0.1:8080')).toBeInTheDocument();
    // The Bun server owns the llama.cpp process lifecycle: no restart command to call.
    expect(screen.queryByRole('button', { name: 'Restart Gemma llama.cpp' })).not.toBeInTheDocument();

    const ollama = gauge('Ollama');
    expect(within(ollama).getByText('Stopped')).toBeInTheDocument();
    expect(within(ollama).getByText('Not required by the active Inference backend')).toBeInTheDocument();
  });

  it('reads Offline when the llama.cpp server is stopped', async () => {
    const llama: JarvisStatus = { ...status, active_backend: 'llama_cpp', llama_cpp_running: false };
    serve(llama, {
      ...healthFor('ollama', true),
      llama_cpp: { running: false, model: 'gemma', url: 'http://127.0.0.1:8080' },
    });
    render(<HealthPage />);
    expect(await screen.findByText('Backend "llama_cpp" is unreachable')).toBeInTheDocument();
    expect(within(gauge('Gemma llama.cpp')).getByText('Stopped')).toBeInTheDocument();
  });

  it('prints the requirement for every gauge and flags a paused supervisor on a stopped service', async () => {
    serve({ ...status, active_backend: 'claude_cli', claude_proxy_running: true }, {
      ...healthFor('bun', false),
      supervisor: { bun_give_up: true, proxy_give_up: false, ollama_give_up: false },
    });
    render(<HealthPage />);
    await screen.findByRole('article', { name: 'Bun server gauge' });
    expect(within(gauge('Bun server')).getByText('Stopped')).toBeInTheDocument();
    expect(within(gauge('Bun server')).getByText('auto-restart paused')).toBeInTheDocument();
    expect(within(gauge('Claude proxy')).getByText('Required by the active Inference backend')).toBeInTheDocument();
    expect(within(gauge('Ollama')).getByText('Not required by the active Inference backend')).toBeInTheDocument();
    expect(within(gauge('Bridge')).getByText('Required for external Agent bridge connections, not for Session turns')).toBeInTheDocument();
  });

  it('does not guess the required set while the status read has not answered', async () => {
    invokeMock.mockImplementation((command: string) =>
      command === 'jarvis_check_status'
        ? Promise.reject(new Error('down'))
        : Promise.resolve(({ get_system_health: healthFor('ollama', true), get_doctor_report: doctor, get_build_info: cleanBuild } as Record<string, unknown>)[command]));
    render(<HealthPage />);
    await screen.findByRole('article', { name: 'Ollama gauge' });
    expect(within(gauge('Ollama')).getByText(/Requirement unknown/)).toBeInTheDocument();
    expect(screen.getByText('Health observation is unavailable.')).toBeInTheDocument();
  });

  it('re-reads status after a confirmed restart so the verdict agrees with the gauge', async () => {
    let bunUp = false;
    invokeMock.mockImplementation((command: string) => {
      const table: Record<string, () => unknown> = {
        jarvis_check_status: () => ({ ...status, bun_server_running: bunUp }),
        get_system_health: () => healthFor('bun', bunUp),
        get_doctor_report: () => doctor,
        get_build_info: () => cleanBuild,
        jarvis_restart_server: () => { bunUp = true; return true; },
      };
      return Promise.resolve(table[command]?.() ?? true);
    });
    render(<HealthPage />);
    expect(await screen.findByText('Starting Bun server — tools and skills are warming up')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restart Bun server' }));
    expect(await screen.findByText('All systems ready')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Restart Bun server' })).toHaveTextContent('restart confirmed');
  });

  it('shows memory and disk as dials with the numbers as text', async () => {
    serve(status, healthFor('ollama', true));
    render(<HealthPage />);
    // One decimal place is the shared decoder's rendering for both dials.
    expect(await screen.findByText('30.0%')).toBeInTheDocument();
    expect(screen.getByText('20.0%')).toBeInTheDocument();
    expect(screen.getByText('300 / 1000 MB in use')).toBeInTheDocument();
    expect(screen.getByText('20G / 100G used · 80G free')).toBeInTheDocument();
  });

  it('lists doctor warnings and errors by word, not only colour', async () => {
    invokeMock.mockImplementation((command: string) => Promise.resolve(({
      jarvis_check_status: status,
      get_system_health: healthFor('ollama', true),
      get_build_info: cleanBuild,
      get_doctor_report: {
        checks: [
          { name: 'Disk headroom', status: 'warn', detail: '8% free' },
          { name: 'Tool runtime', status: 'error', detail: 'bun not on PATH' },
          { name: 'soul.md', status: 'ok', detail: 'found' },
        ],
        summary: { total: 3, ok: 1, warn: 1, error: 1, overall: 'error' },
        timestamp: '2026-10-10T12:00:00Z',
      },
    } as Record<string, unknown>)[command]));
    render(<HealthPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Diagnostics' }));
    expect(await screen.findByText('1 ok · 1 warn · 1 error')).toBeInTheDocument();
    expect(screen.getByText('Disk headroom').closest('li')).toHaveTextContent('warn');
    expect(screen.getByText('Tool runtime').closest('li')).toHaveTextContent('error');
    expect(screen.getByText('2026-10-10T12:00:00Z')).toBeInTheDocument();
  });
});
