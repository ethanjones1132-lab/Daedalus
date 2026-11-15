import { describe, expect, it } from 'vitest';
import {
  joinMissingSettings,
  missingSettingText,
  needsBackendSetup,
  parseBackendReadiness,
} from './backend-readiness';

describe('parseBackendReadiness', () => {
  it('reads the Native wire shape, including the env var that also satisfies a field', () => {
    const parsed = parseBackendReadiness({
      state: 'missing_config',
      backend: 'llama_cpp',
      missing: [
        { key: 'llama_cpp.server_path', label: 'llama.cpp server_path', env_var: 'JARVIS_LLAMA_SERVER_PATH' },
      ],
    });

    expect(parsed).toEqual({
      state: 'missing_config',
      backend: 'llama_cpp',
      missing: [
        { key: 'llama_cpp.server_path', label: 'llama.cpp server_path', envVar: 'JARVIS_LLAMA_SERVER_PATH' },
      ],
    });
    expect(needsBackendSetup(parsed)).toBe(true);
  });

  it('treats an unreadable answer as no claim at all', () => {
    expect(parseBackendReadiness(null)).toBeNull();
    expect(parseBackendReadiness(true)).toBeNull();
    expect(parseBackendReadiness({ backend: 'llama_cpp', missing: [] })).toBeNull();
    expect(parseBackendReadiness({ state: 'unknown', backend: 'llama_cpp', missing: [] })).toBeNull();
  });

  it('drops entries it cannot name instead of inventing one', () => {
    const parsed = parseBackendReadiness({
      state: 'missing_config',
      backend: 'llama_cpp',
      missing: [
        { label: 'no key' },
        'nonsense',
        { key: 'llama_cpp.model_path', label: '' },
      ],
    });

    expect(parsed?.missing).toEqual([{ key: 'llama_cpp.model_path', label: 'llama_cpp.model_path', envVar: null }]);
  });

  it('never asks for setup when the backend is ready', () => {
    expect(needsBackendSetup({ state: 'ready', backend: 'llama_cpp', missing: [] })).toBe(false);
    expect(needsBackendSetup(null)).toBe(false);
  });
});

describe('missing-setting prose', () => {
  it('names the Settings label and the environment alternative', () => {
    expect(
      missingSettingText({ key: 'llama_cpp.server_path', label: 'llama.cpp server_path', envVar: 'JARVIS_LLAMA_SERVER_PATH' }),
    ).toBe('llama.cpp server_path (or JARVIS_LLAMA_SERVER_PATH)');
    expect(missingSettingText({ key: 'openrouter.api_key', label: 'OpenRouter API key', envVar: null })).toBe(
      'OpenRouter API key',
    );
  });

  it('joins one, two and three fields as prose', () => {
    const one = [{ key: 'a', label: 'a', envVar: null }];
    const two = [...one, { key: 'b', label: 'b', envVar: null }];
    const three = [...two, { key: 'c', label: 'c', envVar: null }];

    expect(joinMissingSettings(one)).toBe('a');
    expect(joinMissingSettings(two)).toBe('a and b');
    expect(joinMissingSettings(three)).toBe('a, b and c');
  });
});
