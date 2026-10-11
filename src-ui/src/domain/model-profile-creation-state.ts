export interface ModelProfileDraft {
  name: string;
  backend: string;
  model: string;
  temperature: number;
  maxTokens: number;
  topP: number;
  engine: string;
}

export interface CreateProfileArgs extends Record<string, unknown> {
  name: string;
  backend: string;
  model: string;
  temperature: number;
  maxTokens: number;
  topP: number;
  engine: string;
}

export const DEFAULT_MODEL_PROFILE_DRAFT: ModelProfileDraft = {
  name: '',
  backend: 'openrouter',
  model: '',
  temperature: 0.7,
  maxTokens: 4096,
  topP: 1,
  engine: 'native',
};

export type CreateProfileValidation =
  | { valid: true; args: CreateProfileArgs }
  | { valid: false; message: string };

export function validateCreateProfileDraft(draft: ModelProfileDraft): CreateProfileValidation {
  const name = draft.name.trim();
  const backend = draft.backend.trim();
  const model = draft.model.trim();
  if (!name || !backend || !model) {
    return { valid: false, message: 'Name, backend, and model are required.' };
  }
  if (
    !Number.isFinite(draft.temperature) ||
    !Number.isInteger(draft.maxTokens) ||
    draft.maxTokens <= 0 ||
    !Number.isFinite(draft.topP)
  ) {
    return { valid: false, message: 'Enter valid numeric profile settings.' };
  }
  const engine = draft.engine.trim() || 'native';
  return {
    valid: true,
    args: {
      name,
      backend,
      model,
      temperature: draft.temperature,
      maxTokens: draft.maxTokens,
      topP: draft.topP,
      engine,
    },
  };
}
