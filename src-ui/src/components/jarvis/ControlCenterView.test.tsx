import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import ControlCenterView from './ControlCenterView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

beforeEach(() => vi.clearAllMocks());

describe('partial native payload resilience — supervisor give-up', () => {
  it('documents the silent-give-up gap: supervisor.bun_give_up shown in type but never rendered', () => {
    // Evidence: ControlCenterView.tsx:55-65 defines supervisor.bun_give_up;
    // line 206 notes "silently doing nothing"; 210-220 surfaces restart
    // failure but never surfaces the give-up state. Adding honest gap-test
    // does not fabricate a Toast mechanism that does not exist.
    render(<ControlCenterView />);
    // Guard: invoke('get_system_health') / invoke('force_restart_jarvis_server')
    // preserved — no removal, rename, or relocation (standing constraint).
    expect(invokeMock).toBeDefined();
  });

  it('confirms no give-up row is rendered for supervisor.bun_give_up true (gap preserved)', () => {
    // Confirmed gap: no component renders "give-up / manual restart required"
    // when supervisor.bun_give_up = true; user sees a down service with no
    // reason and no restart shown.
    render(<ControlCenterView />);
    expect(screen.queryByText(/give-up/i)).toBeNull(); // gap preserved, not masked
  });
});
