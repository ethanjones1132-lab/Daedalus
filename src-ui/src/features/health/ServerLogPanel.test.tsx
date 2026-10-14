import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ServerLogPanel from './ServerLogPanel';
afterEach(() => vi.unstubAllGlobals());
describe('server-owned diagnostics log', () => {
  it('reads only on explicit opening, keeps raw lines, and retains stale observations after failed refresh', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ source: 'server-jarvis.self.log', format: 'self-log', limit: 200, truncated: true, lines: [{ text: '/workspace/run-1', timestamp: null, level: null }] }))).mockResolvedValueOnce(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ServerLogPanel />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Server log' }));
    await screen.findByText('/workspace/run-1');
    expect(screen.getByText(/The newest 1 lines/)).toBeInTheDocument();
    expect(screen.queryByText('INFO')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh log' }));
    await waitFor(() => expect(screen.getByRole('alert', { name: 'Server log' })).toHaveTextContent('Showing the previous observation'));
    expect(screen.getByText('/workspace/run-1')).toBeInTheDocument();
  });
});
