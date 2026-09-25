import { describe, expect, it } from 'vitest';
import {
  projectHealthSubsystems,
  recoverAnnouncement,
  subsystemByKey,
  type HealthSubsystems,
} from './health-banner-subsystems';
import type { JarvisStatus } from './types';

const stockOpenRouter: JarvisStatus = {
  ollama_running: false,
  model_available: false,
  bun_server_running: true,
  bun_server_url: 'http://127.0.0.1:19877',
  claude_proxy_running: false,
  bridge_active: true,
  bridge_port: 19879,
  bun_available: true,
  active_backend: 'openrouter',
  model: 'openrouter/free',
  openrouter_key_set: true,
};

const row = (subsystems: HealthSubsystems, key: string) => {
  const found = subsystemByKey(subsystems, key as Parameters<typeof subsystemByKey>[1]);
  if (!found) throw new Error(`no subsystem row for ${key}`);
  return found;
};

describe('not-required services are reported as not required, not as faults', () => {
  it('keeps a stopped Ollama and Claude proxy out of the fault set for a non-Ollama backend', () => {
    const subsystems = projectHealthSubsystems({
      ...stockOpenRouter,
      ollama_running: false,
      claude_proxy_running: false,
    });

    expect(row(subsystems, 'ollama')).toMatchObject({ state: 'down', requirement: 'not_required' });
    expect(row(subsystems, 'claude_proxy')).toMatchObject({ state: 'down', requirement: 'not_required' });
    expect(row(subsystems, 'ollama').announcement).toBe(
      'Ollama is not running and not required by the active inference backend.',
    );
    expect(subsystems.faults).toEqual([]);
  });

  it('still names a service the active backend does require', () => {
    const subsystems = projectHealthSubsystems({
      ...stockOpenRouter,
      active_backend: 'claude_cli',
      claude_proxy_running: false,
    });

    expect(row(subsystems, 'claude_proxy')).toMatchObject({ state: 'down', requirement: 'required' });
    expect(subsystems.faults.map((fault) => fault.key)).toEqual(['claude_proxy']);
    expect(row(subsystems, 'claude_proxy').announcement).toBe(
      'Claude proxy is not running and required by the active inference backend.',
    );
  });

  it('requires the OpenRouter key only for the OpenRouter backend', () => {
    const openrouter = projectHealthSubsystems(stockOpenRouter);
    expect(row(openrouter, 'openrouter_key')).toMatchObject({ state: 'up', requirement: 'required' });
    expect(row(openrouter, 'openrouter_key').announcement).toBe(
      'OpenRouter key is set and required by the active inference backend.',
    );

    const claude = projectHealthSubsystems({ ...stockOpenRouter, active_backend: 'claude_cli' });
    expect(row(claude, 'openrouter_key')).toMatchObject({ state: 'up', requirement: 'not_required' });
  });
});

describe('an unprobed service is never presented as measured', () => {
  it('never reads the model row as loaded for a non-Ollama backend', () => {
    // Native computes `model_available` as `!is_ollama` for a non-Ollama backend
    // (src-tauri/src/jarvis/runner.rs:1355,1386-1387) — a constant, not a probe.
    const subsystems = projectHealthSubsystems({ ...stockOpenRouter, model_available: true });

    expect(row(subsystems, 'model')).toMatchObject({ state: 'unprobed', requirement: 'not_required' });
    expect(row(subsystems, 'model').detail).toBe('openrouter/free');
    expect(row(subsystems, 'model').announcement).toBe(
      'Local model was not probed and not required by the active inference backend.',
    );
    expect(subsystems.faults).toEqual([]);
  });

  it('does not blame the model when Ollama itself is down', () => {
    const subsystems = projectHealthSubsystems({
      ...stockOpenRouter,
      active_backend: 'ollama',
      ollama_running: false,
      model_available: false,
      model: 'qwen3:8b',
    });

    expect(row(subsystems, 'ollama')).toMatchObject({ state: 'down', requirement: 'required' });
    expect(row(subsystems, 'model')).toMatchObject({ state: 'unprobed', requirement: 'required' });
    expect(row(subsystems, 'model').detail).toBeNull();
    expect(row(subsystems, 'model').announcement).toBe(
      'Local model was not probed and required by the active inference backend.',
    );
    expect(subsystems.faults.map((fault) => fault.key)).toEqual(['ollama']);
  });

  it('reports a model that Ollama has actually probed as loaded or not loaded', () => {
    const loaded = projectHealthSubsystems({
      ...stockOpenRouter,
      active_backend: 'ollama',
      ollama_running: true,
      model_available: true,
      model: 'qwen3:8b',
    });
    expect(row(loaded, 'model')).toMatchObject({ state: 'up', requirement: 'required', detail: 'qwen3:8b' });
    expect(loaded.faults).toEqual([]);

    const missing = projectHealthSubsystems({
      ...stockOpenRouter,
      active_backend: 'ollama',
      ollama_running: true,
      model_available: false,
      model: 'qwen3:8b',
    });
    expect(row(missing, 'model')).toMatchObject({ state: 'down', requirement: 'required' });
    expect(missing.faults.map((fault) => fault.key)).toEqual(['model']);
  });
});

describe('an unconfirmed backend is never guessed', () => {
  it.each([undefined, null, '', 'llama_cpp', 42])(
    'leaves every backend-dependent requirement unknown for %s',
    (activeBackend) => {
      const subsystems = projectHealthSubsystems({ ...stockOpenRouter, active_backend: activeBackend as never });

      expect(subsystems.backend).toBe('unknown');
      for (const key of ['ollama', 'model', 'openrouter_key', 'claude_proxy'] as const) {
        expect(row(subsystems, key).requirement).toBe('unknown');
      }
      expect(row(subsystems, 'bun').requirement).toBe('required');
      expect(row(subsystems, 'ollama').announcement).toContain(
        'whether it is required is unknown because the active inference backend is not confirmed',
      );
      // An unconfirmed required set is never a confirmed fault either: the same
      // observation under a confirmed backend is what names a fault.
      expect(subsystems.faults).toEqual([]);
    },
  );
});

describe('a partial native payload reads as unknown, never as down', () => {
  it('does not read missing booleans as stopped services', () => {
    const partial = { active_backend: 'ollama' } as JarvisStatus;
    const subsystems = projectHealthSubsystems(partial);

    for (const key of ['bun', 'bridge', 'ollama', 'claude_proxy'] as const) {
      expect(row(subsystems, key).state).toBe('unknown');
    }
    expect(row(subsystems, 'model').state).toBe('unprobed');
    expect(subsystems.faults).toEqual([]);
  });

  it('does not read a non-boolean flag as a measurement', () => {
    const subsystems = projectHealthSubsystems({
      ...stockOpenRouter,
      bun_server_running: 'yes',
      openrouter_key_set: 1,
    } as unknown as JarvisStatus);

    expect(row(subsystems, 'bun').state).toBe('unknown');
    expect(row(subsystems, 'openrouter_key').state).toBe('unknown');
    expect(subsystems.faults).toEqual([]);
  });

  it('ignores a non-numeric bridge port instead of printing it', () => {
    const subsystems = projectHealthSubsystems({
      ...stockOpenRouter,
      bridge_active: true,
      bridge_port: '19879',
    } as unknown as JarvisStatus);

    expect(row(subsystems, 'bridge')).toMatchObject({ state: 'up', detail: null });
  });
});

describe('every row carries text for the state it claims', () => {
  it('gives each subsystem a name, a state word, and a requirement clause', () => {
    const subsystems = projectHealthSubsystems({ ...stockOpenRouter, bun_server_running: false });

    expect(subsystems.rows.map((row_) => row_.name)).toEqual([
      'Bun server',
      'Bridge',
      'Ollama',
      'Local model',
      'OpenRouter key',
      'Claude proxy',
    ]);
    for (const row_ of subsystems.rows) {
      expect(row_.stateWord).not.toBe('');
      expect(row_.announcement).toBe(`${row_.name} ${row_.stateWord}${row_.requirementClause}.`);
    }
    expect(row(subsystems, 'bun')).toMatchObject({ state: 'down', requirement: 'required' });
    expect(subsystems.faults.map((fault) => fault.key)).toEqual(['bun']);
  });

  it('prints the required set as its own visible words, not only in the accessible name', () => {
    const openrouter = projectHealthSubsystems(stockOpenRouter);
    expect(row(openrouter, 'bun').requirementLabel).toBe('required');
    expect(row(openrouter, 'ollama').requirementLabel).toBe('not required');
    expect(row(openrouter, 'ollama').announcement).toContain('not required by the active inference backend');

    const unconfirmed = projectHealthSubsystems({ ...stockOpenRouter, active_backend: '' });
    expect(row(unconfirmed, 'ollama').requirementLabel).toBe('requirement unknown');
  });
});

describe('recovery is announced as text', () => {
  it('names the confirmed backend and the services that were not required', () => {
    const subsystems = projectHealthSubsystems(stockOpenRouter);

    expect(recoverAnnouncement(subsystems)).toBe(
      'Health recovered: all services required by the active inference backend (openrouter) are running. Not required by this backend: Ollama, Local model and Claude proxy.',
    );
  });

  it('names the two rows the Ollama backend does not need and no others', () => {
    const subsystems = projectHealthSubsystems({
      ...stockOpenRouter,
      active_backend: 'ollama',
      ollama_running: true,
      model_available: true,
    });

    expect(recoverAnnouncement(subsystems)).toBe(
      'Health recovered: all services required by the active inference backend (ollama) are running. Not required by this backend: OpenRouter key and Claude proxy.',
    );
  });

  it('announces nothing when the active inference backend is not confirmed', () => {
    // An unconfirmed required set cannot certify recovery, so the strip must
    // never speak a recovery sentence it cannot support.
    expect(recoverAnnouncement(projectHealthSubsystems({ ...stockOpenRouter, active_backend: 'llama_cpp' }))).toBe('');
  });
});
