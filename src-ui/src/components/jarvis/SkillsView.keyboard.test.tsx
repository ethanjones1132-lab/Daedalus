import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Tauri IPC layer, same pattern as SkillsView.test.tsx.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { SkillsView } from './SkillsView';
import { ToastProvider } from '../ui';

const bundledSkill = {
  id: 'skill_bundled_1',
  name: 'code-review',
  description: 'Review code changes',
  path: '',
  enabled: true,
  metadata: JSON.stringify({ category: 'development', source: 'bundled' }),
  body: '# Code review\nInspect the diff before shipping.',
  version: 2,
  improvement_score: 0,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
};

const secondSkill = {
  ...bundledSkill,
  id: 'skill_bundled_2',
  name: 'test-writer',
  description: 'Write unit tests for new code',
  body: '# Test writer\nCover every branch.',
  version: 1,
};

function inspectButton(name: string) {
  return screen.getByRole('button', { name: `Inspect skill: ${name}` });
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'sync_distilled_skill_candidates') return 0;
    if (cmd === 'list_skills') return [bundledSkill, secondSkill];
    return null;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ candidates: [] }) }) as unknown as Response),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSkillsView() {
  return render(
    <ToastProvider>
      <SkillsView />
    </ToastProvider>,
  );
}

async function mount() {
  const view = renderSkillsView();
  await screen.findByText('code-review');
  return view;
}

describe('SkillsView — keyboard skill inspection', () => {
  it.each(['{Enter}', ' '])('selects a skill with %s through a named inspection button', async (key) => {
    const user = userEvent.setup();
    await mount();

    const button = inspectButton('code-review');
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(button).toHaveAttribute('aria-controls');
    // The detail region is not mounted before selection.
    expect(document.getElementById(button.getAttribute('aria-controls')!)).toBeNull();

    button.focus();
    await user.keyboard(key);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    const region = document.getElementById(button.getAttribute('aria-controls')!);
    expect(region).not.toBeNull();
    expect(within(region!).getByText('Inspect the diff before shipping.')).toBeInTheDocument();
    expect(button).toHaveFocus();

    await user.keyboard(' ');
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the Enable/Disable control outside the inspection button and tab-reachable', async () => {
    const user = userEvent.setup();
    await mount();

    const button = inspectButton('code-review');
    expect(button.querySelector('button, a, input, select, textarea')).toBeNull();
    button.focus();
    await user.tab();
    const toggle = within(button.closest('li')!).getByRole('button', { name: 'Disable' });
    expect(toggle).toHaveFocus();
    // Activating the toggle must not change the inspected selection.
    await user.click(toggle);
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'disable_skill')).toBe(true);
    expect(inspectButton('code-review')).toHaveAttribute('aria-pressed', 'false');
  });

  it('switches the inspected detail when another skill is selected', async () => {
    const user = userEvent.setup();
    await mount();

    const first = inspectButton('code-review');
    await user.click(first);
    const firstRegionId = first.getAttribute('aria-controls')!;
    expect(within(document.getElementById(firstRegionId)!).getByText('Inspect the diff before shipping.')).toBeInTheDocument();

    const second = inspectButton('test-writer');
    await user.click(second);
    expect(second).toHaveAttribute('aria-pressed', 'true');
    expect(first).toHaveAttribute('aria-pressed', 'false');
    const secondRegion = document.getElementById(second.getAttribute('aria-controls')!);
    expect(secondRegion).not.toBeNull();
    expect(secondRegion).toBe(screen.getByRole('region', { name: 'Skill details: test-writer' }));
    expect(document.getElementById(firstRegionId)).toBeNull();
    expect(within(secondRegion!).getByText('Cover every branch.')).toBeInTheDocument();
  });

  it('restores focus to the inspection button when the detail is closed', async () => {
    const user = userEvent.setup();
    await mount();

    const button = inspectButton('code-review');
    await user.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    const close = screen.getByRole('button', { name: 'Close' });
    await user.click(close);

    await waitFor(() => {
      expect(inspectButton('code-review')).toHaveFocus();
    });
    expect(inspectButton('code-review')).toHaveAttribute('aria-pressed', 'false');
    expect(document.getElementById(button.getAttribute('aria-controls')!)).toBeNull();
  });

  it('preserves mouse selection through the card content', async () => {
    await mount();

    const row = screen.getByText('Review code changes');
    fireEvent.click(row);

    const button = inspectButton('code-review');
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'));
    const regionId = button.getAttribute('aria-controls');
    expect(regionId).toBeTruthy();
    expect(within(document.getElementById(regionId!)!).getByText('Inspect the diff before shipping.')).toBeInTheDocument();
  });

  it('retains search and filter behavior and returns focus to search when the opener is filtered out', async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(inspectButton('code-review'));
    const search = screen.getByPlaceholderText('Search skills…');
    await user.type(search, 'test-writer');
    expect(screen.queryByRole('button', { name: 'Inspect skill: code-review' })).not.toBeInTheDocument();
    expect(inspectButton('test-writer')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(search).toHaveFocus();
    expect(search).toHaveValue('test-writer');
    await user.selectOptions(screen.getByRole('combobox'), 'disabled');
    expect(screen.getByText('No skills match the current filter.')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox'), 'enabled');
    expect(inspectButton('test-writer')).toBeInTheDocument();
  });
});
