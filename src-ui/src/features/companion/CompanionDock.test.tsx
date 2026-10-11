import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import CompanionDock from './CompanionDock';
import OverviewPage from '../overview/OverviewPage';
import type { CompanionState } from '../../domain/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const companion: CompanionState = {
  enabled: true, name: 'Ember', species: 'owl', rarity: 'epic', mood: 'thinking',
  happiness: 82, energy: 41, level: 4, xp: 130, xp_to_next: 400, interactions_total: 9,
  current_message: 'Tidying the soul.md drafts.', is_speaking: false, is_petting: false,
};
let companionResult: CompanionState | null | Error;

beforeEach(() => {
  companionResult = companion;
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'jarvis_get_companion') {
      if (companionResult instanceof Error) throw companionResult;
      return companionResult;
    }
    if (command === 'list_cron_jobs') return [{ enabled: true, prompt: 'nightly backup' }];
    if (command === 'list_pending_missed_jobs') return [];
    if (command === 'get_system_health') return { ollama: { running: true, model: 'm', url: '' }, bun_server: { running: true, url: '' }, bridge: { running: true, port: 1 }, disk: { total: '1G', used: '1G', available: '0', use_percent: '10%' }, memory: { total_mb: 10, available_mb: 5, used_mb: 5, used_percent: 50 }, timestamp: '' };
    if (command === 'list_agents' || command === 'list_sessions') return [];
    return null;
  });
});
afterEach(() => cleanup());

const mount = async (ui = <CompanionDock collapsed={false} />) => { await act(async () => { render(ui); }); };

describe('CompanionDock', () => {
  it('loads the companion itself, with no JarvisView mounted', async () => {
    await mount();
    expect(screen.getByText('Ember')).toBeInTheDocument();
    expect(screen.getByText(/thinking · Lv 4/)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Cron awareness' })).toHaveTextContent('Monitoring 1 active cron.');
  });

  it('announces awareness politely and keeps the live region when collapsed', async () => {
    await mount(<CompanionDock collapsed />);
    const region = screen.getByRole('status', { name: 'Cron awareness' });
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveClass('sr-only');
    expect(region).toHaveTextContent('Monitoring 1 active cron.');
  });

  it('opens a read-only card on click and closes it with Escape, returning focus', async () => {
    await mount();
    const trigger = screen.getByRole('button', { expanded: false });
    fireEvent.click(trigger);
    const card = screen.getByRole('dialog', { name: 'Ember companion' });
    expect(within(card).getByText('Level 4')).toBeInTheDocument();
    expect(within(card).getByText('130 / 400 XP')).toBeInTheDocument();
    expect(within(card).getByRole('meter', { name: 'Level 4 experience' })).toHaveAttribute('aria-valuenow', '33');
    expect(within(card).getByRole('meter', { name: 'Happiness' })).toHaveAttribute('aria-valuenow', '82');
    expect(within(card).getByText('Tidying the soul.md drafts.')).toBeInTheDocument();
    expect(within(card).getByLabelText('Rarity epic, 4 of 5 stars')).toHaveClass('text-accent');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes the card on an outside press', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is honest when the companion cannot be read', async () => {
    companionResult = new Error('boom');
    await mount();
    expect(screen.getByText('Companion unavailable.')).toBeInTheDocument();
  });

  it('says so when the companion is switched off', async () => {
    companionResult = { ...companion, enabled: false };
    await mount();
    expect(screen.getByText('Companion is switched off.')).toBeInTheDocument();
  });

  it('shares one poll between the dock and the Overview hero', async () => {
    await mount(<><CompanionDock collapsed={false} /><OverviewPage /></>);
    const calls = (name: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === name).length;
    expect(calls('jarvis_get_companion')).toBe(1);
    expect(calls('list_cron_jobs')).toBe(1);
  });

  it('shows the missed-jobs sentence when cron://missed-jobs reports jobs, and refreshes when it reports none', async () => {
    await mount();
    const handler = vi.mocked(listen).mock.calls.find(([name]) => name === 'cron://missed-jobs')![1] as (e: { payload: unknown[] }) => void;
    await act(async () => { handler({ payload: [{}, {}] }); });
    expect(screen.getByRole('status', { name: 'Cron awareness' })).toHaveTextContent('Reflecting on 2 missed self-improvement routines...');
    await act(async () => { handler({ payload: [] }); });
    expect(screen.getByRole('status', { name: 'Cron awareness' })).toHaveTextContent('Monitoring 1 active cron.');
  });
});
