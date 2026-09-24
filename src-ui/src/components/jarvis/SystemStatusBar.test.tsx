import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SystemStatusBar from './SystemStatusBar';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 500 })));
});

describe('SystemStatusBar resilience', () => {
  // get_system_health is served by the native surface, and an older shell or an
  // error path can answer without the section this bar reads. Reaching into a
  // missing section threw during render, and because the bar sits in the
  // JarvisView header the throw unmounted the whole view.
  it.each([
    ['a payload with no sections', {}],
    ['a non-object payload', true],
    ['no payload at all', null],
  ])('still renders given %s', async (_label, payload) => {
    invokeMock.mockImplementation(async (command: string) =>
      command === 'get_system_health' ? payload : null);

    render(<SystemStatusBar />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('get_system_health'));
    expect(await screen.findByText('BUN ?')).toBeInTheDocument();
  });
});
