import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_PROFILE_DRAFT,
  validateCreateProfileDraft,
  type ModelProfileDraft,
} from './model-profile-creation-state';

describe('model profile creation state', () => {
  it('builds the exact flat Native-surface arguments from a trimmed draft', () => {
    const draft: ModelProfileDraft = {
      ...DEFAULT_MODEL_PROFILE_DRAFT,
      name: '  Daily coding  ',
      backend: ' openrouter ',
      model: ' vendor/model ',
      temperature: 0.25,
      maxTokens: 2048,
      topP: 0.9,
      engine: ' native ',
    };

    expect(validateCreateProfileDraft(draft)).toEqual({
      valid: true,
      args: {
        name: 'Daily coding',
        backend: 'openrouter',
        model: 'vendor/model',
        temperature: 0.25,
        maxTokens: 2048,
        topP: 0.9,
        engine: 'native',
      },
    });
  });

  it('requires the identity fields and rejects invalid numeric settings', () => {
    expect(validateCreateProfileDraft({
      ...DEFAULT_MODEL_PROFILE_DRAFT,
      name: ' ',
    })).toEqual({
      valid: false,
      message: 'Name, backend, and model are required.',
    });

    expect(validateCreateProfileDraft({
      ...DEFAULT_MODEL_PROFILE_DRAFT,
      name: 'Daily coding',
      model: 'vendor/model',
      maxTokens: Number.NaN,
    })).toEqual({
      valid: false,
      message: 'Enter valid numeric profile settings.',
    });
  });
});
