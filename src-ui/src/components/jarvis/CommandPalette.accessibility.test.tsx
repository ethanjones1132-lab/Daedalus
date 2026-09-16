import { StrictMode, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CommandPalette from './CommandPalette';
import type { NavItem } from '../../types';

const items: NavItem[] = [
  { id: 'jarvis', label: 'Jarvis', icon: 'J' },
  { id: 'cron', label: 'Cron', icon: 'T' },
  { id: 'agents', label: 'Agents', icon: 'A' },
  { id: 'memory', label: 'Memory', icon: 'R' },
];

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Harness({ removeOpener = false, onClose = vi.fn(), onNavigate = vi.fn() }) {
  const [open, setOpen] = useState(false);
  const [removed, setRemoved] = useState(false);
  return <>
    {!removed && <button onClick={() => setOpen(true)}>Open palette</button>}
    <button>Outside</button>
    <CommandPalette open={open} items={items}
      onClose={() => { onClose(); setOpen(false); }}
      onNavigate={(id) => { onNavigate(id); if (removeOpener) setRemoved(true); }} />
  </>;
}

async function openPalette() {
  const opener = screen.getByRole('button', { name: 'Open palette' });
  opener.focus();
  fireEvent.click(opener);
  const input = screen.getByLabelText('Search views');
  await waitFor(() => expect(input).toHaveFocus());
  return { opener, input };
}

function activeOption(input: HTMLElement) {
  const id = input.getAttribute('aria-activedescendant');
  expect(id).toBeTruthy();
  const option = document.getElementById(id!);
  expect(option).toHaveAttribute('role', 'option');
  expect(option).toHaveAttribute('aria-selected', 'true');
  return option!;
}

describe('CommandPalette keyboard accessibility', () => {
  it.each(['', 'zzz'])('contains both Tab directions with query %j', async (query) => {
    render(<Harness />);
    const { input } = await openPalette();
    fireEvent.change(input, { target: { value: query } });
    // jsdom does not traverse Tab natively: verify cancellation and focus.
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(false);
    expect(input).toHaveFocus();
    expect(fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(input).toHaveFocus();
    screen.getByRole('button', { name: 'Outside' }).focus();
    expect(input).toHaveFocus();
  });

  it.each(['Escape', 'backdrop', 'Enter', 'mouse'])('restores focus and acts once on %s', async (action) => {
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    render(<StrictMode><Harness onClose={onClose} onNavigate={onNavigate} /></StrictMode>);
    const { input, opener } = await openPalette();
    fireEvent.click(input);
    expect(onClose).not.toHaveBeenCalled();
    if (action === 'backdrop') fireEvent.click(screen.getByRole('dialog'));
    else if (action === 'mouse') fireEvent.click(screen.getAllByRole('option')[1]);
    else {
      if (action === 'Enter') fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: action });
    }
    expect(onClose).toHaveBeenCalledTimes(1);
    if (action === 'Enter' || action === 'mouse') {
      expect(onNavigate).toHaveBeenCalledTimes(1);
      expect(onNavigate).toHaveBeenCalledWith('cron');
    } else expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    const outside = screen.getByRole('button', { name: 'Outside' });
    outside.focus();
    expect(outside).toHaveFocus();
  });

  it('falls back to the document when navigation removes the opener', async () => {
    render(<Harness removeOpener />);
    const { input, opener } = await openPalette();
    const focus = vi.spyOn(opener, 'focus');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(opener.isConnected).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(document.body).toHaveFocus();
    expect(document.body).not.toHaveAttribute('tabindex');
  });

  it('links search, results and stable selected option ids through filtering and reopening', async () => {
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} />);
    const { input } = await openPalette();
    expect(input).toHaveAttribute('role', 'combobox');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    const list = screen.getByRole('listbox', { name: 'Views' });
    expect(list.id).not.toBe('');
    expect(input).toHaveAttribute('aria-controls', list.id);
    expect(activeOption(input)).toHaveTextContent('Jarvis');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const cronId = activeOption(input).id;
    fireEvent.change(input, { target: { value: 'crn' } });
    expect(activeOption(input)).toHaveTextContent('Cron');
    expect(activeOption(input).id).toBe(cronId);
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(input).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    const reopened = await openPalette();
    expect(reopened.input).toHaveValue('');
    expect(activeOption(reopened.input)).toHaveTextContent('Jarvis');
    expect(screen.getByRole('listbox').id).toBe(list.id);
  });

  it('scrolls the active option into view as arrows cross the results viewport', async () => {
    // jsdom has no layout/scrollIntoView; assert the browser scroll request.
    const scroll = vi.fn();
    const { input } = await (async () => { render(<Harness />); return openPalette(); })();
    for (const option of screen.getAllByRole('option')) option.scrollIntoView = scroll;
    for (let index = 1; index < items.length; index++) {
      scroll.mockClear();
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(activeOption(input)).toHaveTextContent(items[index].label);
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scroll.mock.contexts[0]).toBe(activeOption(input));
    }
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeOption(input)).toHaveTextContent('Agents');
    expect(input).toHaveFocus();
  });

  it('keeps a valid active option when items shrink and does not refocus on callback changes', async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render(<CommandPalette open items={items} onClose={first} onNavigate={vi.fn()} />);
    const input = screen.getByLabelText('Search views');
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const focus = vi.spyOn(input, 'focus');
    rerender(<CommandPalette open items={items.slice(0, 1)} onClose={latest} onNavigate={vi.fn()} />);
    expect(activeOption(input)).toHaveTextContent('Jarvis');
    expect(focus).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(latest).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
