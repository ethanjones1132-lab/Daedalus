import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HealthPage from './HealthPage';
import { resetSharedBuildProvenanceStores } from '../../domain/build-provenance';
import { cleanBuild, doctor, healthFor, status } from './test-fixtures';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const inference = {
  window_size: 12,
  generated_at: 1,
  backends: [
    { backend: 'llama_cpp', requests: 9, errors: 0, error_rate: 0, p50_ms: 820, p95_ms: 2100, total_tokens_in: 1, total_tokens_out: 2, last_model: 'gemma-4' },
    { backend: 'openrouter/free', error_rate: undefined, errors: undefined, requests: undefined, p50_ms: 120, p95_ms: 340 },
    { backend: 'opencode_go', requests: 3, errors: 2, error_rate: 0.66, p50_ms: 900, p95_ms: 4000, total_tokens_in: 1, total_tokens_out: 1, last_error: 'upstream 502' },
  ],
  recent_attempts: [
    { stage: 'synthesizer', provider: 'opencode_go', model: 'deepseek-v4-flash', outcome: 'empty_completion', latency_ms: 21000, first_token_ms: 900, fallback_attempt: 1 },
  ],
  runtime: { event_loop_delay_ms: { p95: 4 }, event_loop_utilization: 0.31, rss_bytes: 200 * 1024 * 1024 },
  conductor_cache: {
    window_size: 6, cache_hit_rate: 0.83, avg_prefix_recomputed: 412,
    records: [{ prefix_tokens_recomputed: 900 }, { prefix_tokens_recomputed: 400 }, { prefix_tokens_recomputed: 120 }],
    generated_at: 1,
  },
};

function serve(http: Record<string, unknown | null>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    const body = http[path];
    return body === undefined || body === null
      ? new Response('null', { status: 503 })
      : new Response(JSON.stringify(body), { status: 200 });
  }));
}

beforeEach(() => {
  resetSharedBuildProvenanceStores();
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string) => Promise.resolve(({
    jarvis_check_status: status,
    get_system_health: healthFor('ollama', true),
    get_doctor_report: doctor,
    get_build_info: cleanBuild,
  } as Record<string, unknown>)[command] ?? true));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const openRuntime = async () => fireEvent.click(await screen.findByRole('tab', { name: 'Runtime' }));

describe('Health page runtime telemetry', () => {
  it('renders runtime provenance, readiness, inference, orchestration, cache and directives', async () => {
    serve({
      '/health/inference': inference,
      '/health': { version: '3.0.0', git_sha: '0ca584bb611fbb77e16d45c83bedf74c1d160846', model: 'openrouter/free', model_resolved: true, built_at: '2026-10-01' },
      '/health/readiness': { conductor: { enabled: true, state: 'ready', model: 'qwen3:4b', started_at: 1, completed_at: 2, latency_ms: 1800, error: null } },
      '/health/conductor-directives': { window_size: 5, by_type: { continue: 3, abort_stage: 1, reorder: 1 }, records: [], generated_at: 1 },
    });
    render(<HealthPage />);
    await openRuntime();
    expect(await screen.findByText('3.0.0 · 0ca584bb611f · openrouter/free')).toBeInTheDocument();
    expect(screen.getByText('model resolved')).toBeInTheDocument();
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.getByText('qwen3:4b · warm-up 1800ms')).toBeInTheDocument();
    expect(screen.getByText('Inference (last 12 turns)')).toBeInTheDocument();
    // A backend with missing counters tolerates the gap instead of throwing.
    expect(screen.getByText('0/1 err')).toBeInTheDocument();
    expect(screen.getByText('2/3 err')).toBeInTheDocument();
    expect(screen.getByText('upstream 502')).toBeInTheDocument();
    expect(screen.getByText('synthesizer · opencode_go/deepseek-v4-flash · empty_completion · 21000ms · first 900ms')).toBeInTheDocument();
    expect(screen.getByText('83% hit')).toBeInTheDocument();
    expect(screen.getByText('avg prefix recomputed: 412 tokens')).toBeInTheDocument();
    expect(screen.getByText('continue')).toBeInTheDocument();
    expect(screen.getByText('5 recent')).toBeInTheDocument();
  });

  it('feeds the hero readouts from the same telemetry', async () => {
    serve({ '/health/inference': inference });
    render(<HealthPage />);
    expect(await screen.findByText('83%')).toBeInTheDocument();
    expect(screen.getByText('hit rate · 6 turns')).toBeInTheDocument();
    expect(screen.getByText('66%')).toBeInTheDocument();
    expect(screen.getByText('worst of 12 turns')).toBeInTheDocument();
  });

  it('says runtime telemetry is unavailable (not empty) when the Bun server does not answer, and recovers on Retry', async () => {
    serve({});
    render(<HealthPage />);
    await openRuntime();
    const alert = await screen.findByRole('alert', { name: 'Runtime telemetry observation' });
    expect(alert).toHaveTextContent('Runtime telemetry is unavailable.');
    expect(screen.queryByText('No inference turns recorded yet.')).not.toBeInTheDocument();

    serve({ '/health/inference': { ...inference, window_size: 0, backends: [], recent_attempts: [], runtime: undefined, conductor_cache: null } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry runtime telemetry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByText('No inference turns recorded yet.')).toBeInTheDocument();
  });

  it('keeps previously observed telemetry, marked as possibly stale, when a re-read fails everywhere', async () => {
    serve({ '/health/inference': inference });
    render(<HealthPage />);
    await openRuntime();
    expect(await screen.findByText('Inference (last 12 turns)')).toBeInTheDocument();
    serve({});
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    const alert = await screen.findByRole('alert', { name: 'Runtime telemetry observation' });
    expect(alert).toHaveTextContent('Showing previously observed data; it may be stale.');
    expect(screen.getByText('Inference (last 12 turns)')).toBeInTheDocument();
  });
});
