// The ten `deferred` entries of the raw-error guard, closed at the boundary.
//
// `src-ui/src/read-error-guard.test.ts` is the rule: every line that stringifies a
// caught value is documented, a `deferred` entry is a live leak that names the row
// owning it, and a fixed site leaves an entry matching nothing. It reads source as
// text, so it can prove a value is no longer *printed by a line* — it cannot prove
// the operator sees a sentence they can act on. This file is the other half: it
// drives the real surfaces, rejects the real commands with an error carrying
// exactly the substrings an operator must never be shown, and asserts BOTH
// directions — no native-supplied text anywhere in the document, and the surface's
// own fixed sentence / toast title / Retry present. The confirmed half is pinned
// too: a read that succeeds still renders its rows, a confirmed empty read still
// reads empty, and a write that succeeds still confirms.
//
// The four surfaces named here are the four that were still leaking: the model
// profile list and its three writes, the settings read and its per-key save, the
// skill revision read and its restore, and the Session list plus the chat turn.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ModelProfilesView from './ModelProfilesView';
import SettingsView from './SettingsView';
import { SkillsView } from './SkillsView';
import JarvisView from './JarvisView';
import { ToastProvider } from '../ui';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./SystemStatusBar', () => ({ default: () => null }));

/**
 * Everything a rejecting layer is allowed to carry, and nothing may show any of it.
 * The store path and the home directory are the repo's own stated hazard: "a native
 * error string can embed store or session detail".
 */
const LEAK = 'Native store is locked: /Users/operator/.jarvis/daedalus.sqlite3 (SQLITE_BUSY)';
const LEAK_FRAGMENTS = [
  'SQLITE_BUSY',
  'daedalus.sqlite3',
  '/Users/operator/.jarvis',
  'Native store is locked',
];

/** The DOM must not carry any part of the rejection, in any element's copy. */
function expectNoNativeText() {
  const printed = document.body.textContent ?? '';
  for (const fragment of LEAK_FRAGMENTS) {
    expect(printed.includes(fragment), `the native rejection leaked into the surface: ${fragment}`).toBe(false);
  }
}

const reject = (message: string) => Promise.reject(new Error(message));

beforeEach(() => {
  invokeMock.mockReset();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ candidates: [] }) })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ═══════════════════════════════════════════════════════════════
// Model profiles — the list read and its three writes
// ═══════════════════════════════════════════════════════════════

const profile = {
  id: 'p-1', name: 'studio-fast', provider: 'openrouter', model: 'qwen/qwen3-coder:free',
  api_base: 'https://openrouter.ai/api/v1', max_tokens: 4096, temperature: 0.7, top_p: 1,
  system_prompt: '', is_active: true, engine: 'native', created_at: '2026-09-01',
};

describe('ModelProfilesView', () => {
  /** `over` answers only the command under test; everything else gets a confirmed read. */
  function mount(over: (command: string, args?: Record<string, unknown>) => Promise<unknown> | undefined) {
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      const answered = over(command, args);
      if (answered) return answered;
      if (command === 'list_model_profiles') return Promise.resolve([{ ...profile, is_active: false }]);
      if (command === 'sync_distilled_skill_candidates') return Promise.resolve(0);
      if (command === 'jarvis_get_skills' || command === 'jarvis_get_tools') return Promise.resolve([]);
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<ToastProvider><ModelProfilesView /></ToastProvider>);
  }

  it('names a failed list read instead of the Native error, and Retry re-reads the same command', async () => {
    let reads = 0;
    mount((command) => (command === 'list_model_profiles'
      ? (reads += 1, reject(LEAK))
      : undefined));

    expect(await screen.findByText('Could not load model profiles.')).toBeInTheDocument();
    expectNoNativeText();
    // A genuine empty read still says so; a failed one must not borrow its copy.
    expect(screen.queryByText(/No model profiles yet/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(await screen.findByText('Could not load model profiles.')).toBeInTheDocument();
    expectNoNativeText();
  });

  it.each([
    ['activation', 'set_active_profile', 'Activation failed', 'The active profile was not changed.'],
    ['deletion', 'delete_profile', 'Delete failed', 'The profile was not deleted.'],
    ['creation', 'create_profile', 'Create failed', 'The profile was not created.'],
  ] as const)('keeps the Native rejection out of the %s toast, under its existing title', async (_name, write, title, body) => {
    mount((command) => (command === write ? reject(LEAK) : undefined));
    await screen.findAllByText(profile.name);

    if (write === 'set_active_profile') {
      fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    } else if (write === 'delete_profile') {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    } else {
      fireEvent.click(screen.getByRole('button', { name: '+ New profile' }));
      fireEvent.change(screen.getByPlaceholderText('My profile'), { target: { value: 'new-profile' } });
      fireEvent.change(screen.getByPlaceholderText('openrouter'), { target: { value: 'openrouter' } });
      fireEvent.change(screen.getByPlaceholderText('qwen/qwen3-coder:free'), { target: { value: 'qwen/qwen3-coder:free' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));
    }

    const toast = await screen.findByRole('alert');
    expect(toast).toHaveTextContent(title);
    expect(toast).toHaveTextContent(body);
    expectNoNativeText();
  });

  it('still renders a confirmed list and a confirmed empty read', async () => {
    mount((command) => (command === 'list_model_profiles' ? Promise.resolve([profile]) : undefined));
    expect((await screen.findAllByText(profile.name)).length).toBeGreaterThan(0);
    expect(screen.queryByText('Could not load model profiles.')).not.toBeInTheDocument();

    cleanup();
    mount((command) => (command === 'list_model_profiles' ? Promise.resolve([]) : undefined));
    expect(await screen.findByText(/No model profiles yet/)).toBeInTheDocument();
  });

  it('still confirms a write that succeeded, so the honest path is not a permanently hedged one', async () => {
    const writes: string[] = [];
    mount((command) => {
      if (command === 'set_active_profile') {
        writes.push(command);
        return Promise.resolve({ provider: 'openrouter', model: profile.model });
      }
      if (command === 'list_model_profiles') return Promise.resolve([{ ...profile, is_active: false }]);
      return undefined;
    });
    await screen.findAllByText(profile.name);
    fireEvent.click(screen.getByRole('button', { name: 'Activate' }));

    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('Activated "studio-fast"');
    expect(toast).toHaveTextContent('openrouter/qwen/qwen3-coder:free');
    expectNoNativeText();
    expect(writes).toEqual(['set_active_profile']);
  });
});

// ═══════════════════════════════════════════════════════════════
// Settings — the read and the per-key save
// ═══════════════════════════════════════════════════════════════

describe('SettingsView', () => {
  /** `over` answers only the command under test; everything else gets a confirmed read. */
  function mount(over: (command: string, args?: Record<string, unknown>) => Promise<unknown> | undefined) {
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) =>
      over(command, args) ?? Promise.resolve(null));
    render(<ToastProvider><SettingsView /></ToastProvider>);
  }

  it('names a failed read instead of the Native error, and Retry re-reads the same command', async () => {
    let reads = 0;
    mount((command) => (command === 'get_all_settings' ? (reads += 1, reject(LEAK)) : undefined));

    expect(await screen.findByText('Could not load settings.')).toBeInTheDocument();
    expectNoNativeText();
    expect(screen.queryByText('No settings stored yet.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(await screen.findByText('Could not load settings.')).toBeInTheDocument();
    expectNoNativeText();
  });

  it('keeps the Native rejection out of the save toast, and keeps the operator edit to retry', async () => {
    mount((command) => {
      if (command === 'get_all_settings') return Promise.resolve({ temperature: '0.7' });
      if (command === 'set_setting') return reject(LEAK);
      return undefined;
    });
    const value = await screen.findByDisplayValue('0.7');
    fireEvent.change(value, { target: { value: '0.9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const toast = await screen.findByRole('alert');
    expect(toast).toHaveTextContent('Failed to save temperature');
    expect(toast).toHaveTextContent('The setting was not saved.');
    expectNoNativeText();
    // The edit is preserved and the key is still dirty, so the row can be saved again.
    expect(screen.getByDisplayValue('0.9')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('still renders a confirmed read, a confirmed empty read, and a confirmed save', async () => {
    mount((command) => {
      if (command === 'get_all_settings') return Promise.resolve({ temperature: '0.7' });
      if (command === 'set_setting') return Promise.resolve(null);
      return undefined;
    });
    const value = await screen.findByDisplayValue('0.7');
    expect(screen.queryByText('Could not load settings.')).not.toBeInTheDocument();
    fireEvent.change(value, { target: { value: '0.9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved temperature');
    expectNoNativeText();

    cleanup();
    mount((command) => (command === 'get_all_settings' ? Promise.resolve({}) : undefined));
    expect(await screen.findByText('No settings stored yet.')).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════
// Skill revisions — the read and the restore write
// ═══════════════════════════════════════════════════════════════

const skill = {
  id: 'a', name: 'code-review', description: 'Review code', path: '', enabled: true,
  metadata: null, body: '# Review', version: 2, improvement_score: 0,
  created_at: '2026-06-01', updated_at: '2026-06-01',
};
const revision = {
  id: 'rev-a', skill_id: 'a', version: 1, body_before: '', body_after: '# Review',
  change_reason: 'Synthetic revision', created_at: '2026-06-01',
};

describe('SkillsView revision history', () => {
  /** `over` answers only the command under test; everything else gets a confirmed read. */
  function mount(over: (command: string, args?: Record<string, unknown>) => Promise<unknown> | undefined) {
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      const answered = over(command, args);
      if (answered) return answered;
      if (command === 'list_skills') return Promise.resolve([skill]);
      if (command === 'skill_revisions_list') return Promise.resolve([revision]);
      if (command === 'skill_restore_revision') return Promise.resolve(true);
      if (command === 'sync_distilled_skill_candidates') return Promise.resolve(0);
      if (command === 'jarvis_get_skills' || command === 'jarvis_get_tools') return Promise.resolve([]);
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<ToastProvider><SkillsView /></ToastProvider>);
  }

  async function openRevisions() {
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect skill: code-review' }));
    const detail = within(screen.getByRole('region', { name: 'Skill details: code-review' }));
    fireEvent.click(detail.getByRole('tab', { name: 'Revisions' }));
    return detail;
  }

  it('names a failed revision read instead of the Native error, and Retry re-reads', async () => {
    let reads = 0;
    mount((command) => (command === 'skill_revisions_list' ? (reads += 1, reject(LEAK)) : undefined));
    const detail = await openRevisions();

    expect(await detail.findByText('Could not load skill revisions.')).toBeInTheDocument();
    expectNoNativeText();
    expect(detail.queryByText('No revision history for this skill yet.')).not.toBeInTheDocument();

    fireEvent.click(detail.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(await detail.findByText('Could not load skill revisions.')).toBeInTheDocument();
    expectNoNativeText();
  });

  it('keeps the Native rejection out of the restore toast', async () => {
    mount((command) => (command === 'skill_restore_revision' ? reject(LEAK) : undefined));
    const detail = await openRevisions();
    fireEvent.click(await detail.findByRole('button', { name: 'Restore' }));

    const toast = await screen.findByRole('alert');
    expect(toast).toHaveTextContent('Restore failed');
    expect(toast).toHaveTextContent('The skill was not restored to the earlier revision.');
    expectNoNativeText();
  });

  it('still renders a confirmed revision list, a confirmed empty read, and a confirmed restore', async () => {
    mount(() => undefined);
    const detail = await openRevisions();
    expect(await detail.findByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(detail.getByText('v1')).toBeInTheDocument();

    fireEvent.click(detail.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Revision restored');
    expectNoNativeText();

    cleanup();
    mount((command) => (command === 'skill_revisions_list' ? Promise.resolve([]) : undefined));
    const empty = await openRevisions();
    expect(await empty.findByText('No revision history for this skill yet.')).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════
// Sessions — the list read, and the chat turn's failure copy
// ═══════════════════════════════════════════════════════════════

const session = {
  id: 'session-1', name: 'Saved work', model: 'test-model', message_count: 2,
  created_at: '2026-09-16T00:00:00Z',
};

function sseStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const fetchMock = vi.fn(async () => new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    emit: async (frame: object) => {
      await act(async () => {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
      });
    },
    close: async () => { await act(async () => { controller.close(); }); },
  };
}

async function sendTurn(message: string) {
  const composer = await screen.findByLabelText('Chat input');
  fireEvent.change(composer, { target: { value: message } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  await screen.findByRole('status', { name: 'Session turn progress' });
}

describe('JarvisView Session list', () => {
  it('keeps the Native rejection out of the announced Session alert, and keeps its prefix and staleness clause', async () => {
    let failing = false;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'jarvis_list_sessions') {
        return failing ? reject(LEAK) : Promise.resolve([session]);
      }
      if (command === 'get_all_session_runs') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    render(<JarvisView initialSubView="sessions" />);
    expect(await screen.findByText('Saved work', { selector: 'span' })).toBeInTheDocument();

    failing = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh sessions' }));
    // A refresh that fails with rows already on screen must still report the failure…
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load sessions.');
    // …with the retained rows and the existing staleness clause intact…
    expect(screen.getByRole('alert')).toHaveTextContent('Showing previously loaded sessions');
    expect(screen.getByText('Saved work', { selector: 'span' })).toBeInTheDocument();
    // …and without a word of whatever the store said.
    expectNoNativeText();
  });

  it('still renders a confirmed Session list, and does not read one as empty', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'jarvis_list_sessions') return reject(LEAK);
      if (command === 'get_all_session_runs') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    render(<JarvisView initialSubView="sessions" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load sessions.');
    expect(alert).toHaveTextContent('Retry');
    expect(screen.queryByText('No sessions yet')).not.toBeInTheDocument();
    expectNoNativeText();

    cleanup();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'jarvis_list_sessions') return Promise.resolve([session]);
      if (command === 'get_all_session_runs') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    render(<JarvisView initialSubView="sessions" />);
    expect(await screen.findByText('Saved work', { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('JarvisView a failed chat turn', () => {
  function mount() {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'jarvis_list_sessions') return Promise.resolve([session]);
      if (command === 'jarvis_new_session') return session;
      if (command === 'get_session_history') return Promise.resolve([]);
      if (command === 'jarvis_get_session_grants') return Promise.resolve({ session_id: session.id, grants: [] });
      if (command === 'get_all_session_runs') return Promise.resolve([]);
      if (command === 'get_session_runs' || command === 'record_terminal_run') return Promise.resolve([]);
      return Promise.resolve(null);
    });
  }

  it('never narrates a failure that carries no stable code, because that text is the transport’s', async () => {
    mount();
    const stream = sseStream();
    render(<JarvisView />);
    await sendTurn('inspect the workspace');
    // An `error` frame with no code is the one shape the server does not classify,
    // so its text is whatever the failing layer chose to say.
    await stream.emit({ type: 'error', error: LEAK });
    await stream.close();

    await waitFor(() => expect(screen.getAllByRole('alert').some((node) =>
      node.textContent?.includes('The turn failed.') ?? false)).toBe(true));
    expectNoNativeText();
  });

  it('never narrates an HTTP failure body, which is arbitrary bytes from whatever answered', async () => {
    mount();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(LEAK, { status: 500 })));
    render(<JarvisView />);
    await sendTurn('inspect the workspace');

    await waitFor(() => expect(screen.getAllByRole('alert').some((node) =>
      node.textContent?.includes('The turn failed.') ?? false)).toBe(true));
    expectNoNativeText();
  });

  it('still shows the Conductor’s own coded turn failure, with the code’s label and hint', async () => {
    mount();
    const stream = sseStream();
    render(<JarvisView />);
    await sendTurn('inspect the workspace');
    await stream.emit({
      type: 'error',
      error: 'The turn exceeded its deadline before producing an answer.',
      code: 'turn_deadline_exceeded',
    });
    await stream.close();

    // The capability half: a coded failure is the Conductor's own claim about the
    // turn, and it is the operator's only diagnosis of why the turn stopped. It
    // stays, and `errorDisplayForCode` keeps turning the code into a next step.
    await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent(
      'The turn exceeded its deadline before producing an answer.',
    ));
    expect(screen.getByRole('log')).toHaveTextContent('turn deadline');
    expect(screen.getByRole('log')).toHaveTextContent('per-turn budget');
  });
});
