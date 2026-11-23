import { describe, expect, it } from 'vitest';
import {
  backendBlockedReason,
  backendNotListening,
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
        {
          key: 'llama_cpp.server_path',
          label: 'llama.cpp server_path',
          envVar: 'JARVIS_LLAMA_SERVER_PATH',
          reason: null,
          path: null,
        },
      ],
    });
    expect(needsBackendSetup(parsed)).toBe(true);
  });

  it('reads a program item\'s own sentence from the Native payload', () => {
    // DD-115: the executable lookup's answer travels as the item's sentence.
    const reason = 'ollama was not found — install Ollama, add it to PATH, or set JARVIS_OLLAMA_BIN';
    const parsed = parseBackendReadiness({
      state: 'missing_config',
      backend: 'ollama',
      missing: [
        { key: 'ollama.executable', label: 'ollama executable', env_var: 'JARVIS_OLLAMA_BIN', reason },
      ],
    });

    expect(parsed?.missing).toEqual([
      { key: 'ollama.executable', label: 'ollama executable', envVar: 'JARVIS_OLLAMA_BIN', reason, path: null },
    ]);
    expect(needsBackendSetup(parsed)).toBe(true);
  });

  it('reads an unusable artifact as missing_file carrying the setting and path', () => {
    // DD-111: a configured path that is not a file is its own fault. The path
    // travels beside the setting so both the composer and the health band can
    // print the same one.
    const parsed = parseBackendReadiness({
      state: 'missing_file',
      backend: 'llama_cpp',
      missing: [
        {
          key: 'llama_cpp.server_path',
          label: 'llama.cpp server_path',
          env_var: 'JARVIS_LLAMA_SERVER_PATH',
          path: 'C:/tools/llama-server.exe',
        },
      ],
    });

    expect(parsed).toEqual({
      state: 'missing_file',
      backend: 'llama_cpp',
      missing: [
        {
          key: 'llama_cpp.server_path',
          label: 'llama.cpp server_path',
          envVar: 'JARVIS_LLAMA_SERVER_PATH',
          reason: null,
          path: 'C:/tools/llama-server.exe',
        },
      ],
    });
    expect(needsBackendSetup(parsed)).toBe(true);
    expect(backendNotListening(parsed)).toBe(false);
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

    expect(parsed?.missing).toEqual([
      { key: 'llama_cpp.model_path', label: 'llama_cpp.model_path', envVar: null, reason: null, path: null },
    ]);
  });

  it('never asks for setup when the backend is ready', () => {
    expect(needsBackendSetup({ state: 'ready', backend: 'llama_cpp', missing: [] })).toBe(false);
    expect(needsBackendSetup(null)).toBe(false);
  });

  it('reads a configured backend with a silent port as not_listening, not ready', () => {
    // DD-067: complete settings are not an answering backend. Nothing is
    // missing, so this is not a setup state, but a turn would still fail.
    const parsed = parseBackendReadiness({
      state: 'not_listening',
      backend: 'llama_cpp',
      missing: [],
    });

    expect(parsed).toEqual({ state: 'not_listening', backend: 'llama_cpp', missing: [] });
    expect(needsBackendSetup(parsed)).toBe(false);
    expect(backendNotListening(parsed)).toBe(true);

    expect(backendNotListening({ state: 'ready', backend: 'llama_cpp', missing: [] })).toBe(false);
    expect(backendNotListening({ state: 'missing_config', backend: 'llama_cpp', missing: [] })).toBe(
      false,
    );
    expect(backendNotListening(null)).toBe(false);
  });

  it('keeps the state parse strict: a state this build does not know stays unreadable', () => {
    expect(
      parseBackendReadiness({ state: 'starting', backend: 'llama_cpp', missing: [] }),
    ).toBeNull();
    expect(
      parseBackendReadiness({ state: 'NOT_LISTENING', backend: 'llama_cpp', missing: [] }),
    ).toBeNull();
  });
});

describe('missing-setting prose', () => {
  it('names the Settings label and the environment alternative', () => {
    expect(
      missingSettingText({
        key: 'llama_cpp.server_path',
        label: 'llama.cpp server_path',
        envVar: 'JARVIS_LLAMA_SERVER_PATH',
        reason: null,
        path: null,
      }),
    ).toBe('llama.cpp server_path (or JARVIS_LLAMA_SERVER_PATH)');
    expect(
      missingSettingText({ key: 'openrouter.api_key', label: 'OpenRouter API key', envVar: null, reason: null, path: null }),
    ).toBe('OpenRouter API key');
  });

  it('names an unusable artifact\'s setting and exact path', () => {
    // DD-111: the sentence must not read as an unconfigured backend — the field
    // is set, it just points at something that is not a file.
    expect(
      missingSettingText({
        key: 'llama_cpp.server_path',
        label: 'llama.cpp server_path',
        envVar: 'JARVIS_LLAMA_SERVER_PATH',
        reason: null,
        path: 'C:/tools/llama-server.exe',
      }),
    ).toBe('llama.cpp server_path points to C:/tools/llama-server.exe, which is not a file');
  });

  it('prefers a program\'s own sentence over the field label', () => {
    expect(
      missingSettingText({
        key: 'ollama.executable',
        label: 'ollama executable',
        envVar: 'JARVIS_OLLAMA_BIN',
        reason: 'ollama was not found — install Ollama, add it to PATH, or set JARVIS_OLLAMA_BIN',
        path: null,
      }),
    ).toBe('ollama was not found — install Ollama, add it to PATH, or set JARVIS_OLLAMA_BIN');
  });

  it('joins one, two and three fields as prose', () => {
    const one = [{ key: 'a', label: 'a', envVar: null, reason: null, path: null }];
    const two = [...one, { key: 'b', label: 'b', envVar: null, reason: null, path: null }];
    const three = [...two, { key: 'c', label: 'c', envVar: null, reason: null, path: null }];

    expect(joinMissingSettings(one)).toBe('a');
    expect(joinMissingSettings(two)).toBe('a and b');
    expect(joinMissingSettings(three)).toBe('a, b and c');
  });
});

describe('the composer\'s blocked reason', () => {
  it('uses a missing program\'s own sentence and names the program', () => {
    // DD-115: Send must be disabled because the executable is absent, and the
    // sentence the operator reads is the one Native derived — through the same
    // parser the shell uses on the IPC payload.
    const reason = 'ollama was not found — install Ollama, add it to PATH, or set JARVIS_OLLAMA_BIN';
    const blocked = backendBlockedReason(
      parseBackendReadiness({
        state: 'missing_config',
        backend: 'ollama',
        missing: [
          { key: 'ollama.executable', label: 'ollama executable', env_var: 'JARVIS_OLLAMA_BIN', reason },
        ],
      }),
    );

    expect(blocked).toContain('ollama was not found');
    expect(blocked).toBe(`${reason}. Set it in Settings to chat.`);
  });

  it('keeps the blank-setting wording for configured backends', () => {
    const blocked = backendBlockedReason({
      state: 'missing_config',
      backend: 'llama_cpp',
      missing: [
        {
          key: 'llama_cpp.server_path',
          label: 'llama.cpp server_path',
          envVar: 'JARVIS_LLAMA_SERVER_PATH',
          reason: null,
          path: null,
        },
      ],
    });

    expect(blocked).toBe(
      'llama.cpp is missing llama.cpp server_path (or JARVIS_LLAMA_SERVER_PATH). Set it in Settings to chat.',
    );
  });

  it('names an unusable artifact\'s setting and path instead of a starting backend', () => {
    // DD-111: Send stays disabled, and the reason is the path that is not a
    // file — never "it may still be starting". The health band prints the same
    // path for the same fault.
    const blocked = backendBlockedReason(
      parseBackendReadiness({
        state: 'missing_file',
        backend: 'llama_cpp',
        missing: [
          {
            key: 'llama_cpp.model_path',
            label: 'llama.cpp model_path',
            env_var: 'JARVIS_LLAMA_MODEL_PATH',
            path: 'D:/models/not-installed.gguf',
          },
        ],
      }),
    );

    expect(blocked).toContain('llama.cpp model_path');
    expect(blocked).toContain('D:/models/not-installed.gguf');
    expect(blocked).not.toContain('still starting');
    expect(blocked).toBe(
      'llama.cpp model_path points to D:/models/not-installed.gguf, which is not a file. Set it in Settings to chat.',
    );
  });

  it('is null when the backend is ready and names the silent port otherwise', () => {
    expect(backendBlockedReason({ state: 'ready', backend: 'ollama', missing: [] })).toBeNull();
    expect(backendBlockedReason(null)).toBeNull();
    expect(backendBlockedReason({ state: 'not_listening', backend: 'llama_cpp', missing: [] })).toBe(
      'llama.cpp is configured, but nothing is answering its port yet — it may still be starting.',
    );
  });
});
