import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessApiError, harnessApi } from './harness-api';

const { bunFetch } = vi.hoisted(() => ({ bunFetch: vi.fn() }));
vi.mock('../../lib/bun-origin', () => ({ bunFetch }));

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('harness api run controls', () => {
  beforeEach(() => {
    bunFetch.mockReset();
  });

  it('posts the selected manifest id so the server starts a run from it', async () => {
    bunFetch.mockResolvedValue(jsonResponse(202, { run_id: 'run-9' }));

    await expect(harnessApi.startRun({ projectRoot: 'C:/projects/one', manifestId: 'manifest-1' }))
      .resolves.toEqual({ run_id: 'run-9' });

    expect(bunFetch).toHaveBeenCalledWith('/harness/runs', {
      method: 'POST',
      body: JSON.stringify({ project_root: 'C:/projects/one', manifest_id: 'manifest-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('classifies a server without execution as unavailable instead of a failed start', async () => {
    bunFetch.mockResolvedValue(jsonResponse(503, { error: 'harness_execution_unavailable' }));

    const error = await harnessApi.startRun({ projectRoot: 'C:/projects/one', manifestId: 'manifest-1' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HarnessApiError);
    expect((error as HarnessApiError).isExecutionUnavailable()).toBe(true);
    expect((error as HarnessApiError).isRunNotFound()).toBe(false);
  });

  it('posts cancel to the run cancel route and returns the stop reason', async () => {
    bunFetch.mockResolvedValue(jsonResponse(200, { run_id: 'run-9', stop_reason: 'cancelled' }));

    await expect(harnessApi.cancelRun('C:/projects/one', 'run-9'))
      .resolves.toEqual({ run_id: 'run-9', stop_reason: 'cancelled' });

    expect(bunFetch).toHaveBeenCalledWith(
      '/harness/runs/run-9/cancel?project_root=C%3A%2Fprojects%2Fone',
      { method: 'POST', headers: {} },
    );
  });

  it('keeps run_not_running distinct from a stale manifest revision', async () => {
    bunFetch.mockResolvedValue(jsonResponse(409, { error: 'run_not_running' }));

    const error = await harnessApi.cancelRun('C:/projects/one', 'run-9').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HarnessApiError);
    expect((error as HarnessApiError).code).toBe('run_not_running');
    expect((error as HarnessApiError).isRunNotRunning()).toBe(true);
    expect((error as HarnessApiError).code).not.toBe('stale_revision');
  });
});
