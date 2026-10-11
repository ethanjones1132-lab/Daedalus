import type { JarvisConfig } from '../../domain/types';

/** Default OpenCode first-token timeout (ms) when the field is blank or invalid. */
export const OPENCODE_DEFAULT_TIMEOUT_MS = 45_000;
export const SHELL_DEFAULT_TIMEOUT_MS = 120_000;
export const MIN_TIMEOUT_MS = 1_000;
export const DEFAULT_BRIDGE_PORT = 19_876;

export type SectionId =
  | 'backend'
  | 'keys'
  | 'model'
  | 'orchestration'
  | 'endpoints'
  | 'prompt'
  | 'bridge'
  | 'search'
  | 'shell'
  | 'claude'
  | 'appearance'
  | 'advanced';

export interface SectionDef {
  id: SectionId;
  label: string;
  /** True when the section edits the Jarvis config (and so needs it loaded). */
  needsConfig: boolean;
}

/** Order of the sticky section index; also the order panels are rendered in. */
export const SECTIONS: SectionDef[] = [
  { id: 'backend', label: 'Inference backend', needsConfig: true },
  { id: 'keys', label: 'Provider keys', needsConfig: true },
  { id: 'model', label: 'Model', needsConfig: true },
  { id: 'orchestration', label: 'Orchestration', needsConfig: true },
  { id: 'endpoints', label: 'Endpoints', needsConfig: true },
  { id: 'prompt', label: 'System prompt', needsConfig: true },
  { id: 'bridge', label: 'Bridge', needsConfig: true },
  { id: 'search', label: 'Web search', needsConfig: true },
  { id: 'shell', label: 'Shell', needsConfig: true },
  { id: 'claude', label: 'Claude CLI auth', needsConfig: true },
  { id: 'appearance', label: 'Appearance', needsConfig: false },
  { id: 'advanced', label: 'Advanced', needsConfig: false },
];

export const sectionDomId = (id: SectionId) => `settings-${id}`;

/**
 * Whether the draft differs from the last saved/loaded config by value. A
 * draft that is a different object with identical content is not dirty.
 */
export function isConfigDirty(draft: JarvisConfig | null, baseline: JarvisConfig | null): boolean {
  if (!draft || !baseline) return false;
  if (draft === baseline) return false;
  return JSON.stringify(draft) !== JSON.stringify(baseline);
}

/** Clamp a millisecond timeout field: blank / non-numeric falls back, anything else is floored at 1000. */
export function clampTimeout(raw: string, fallback: number): number {
  return Math.max(MIN_TIMEOUT_MS, Number(raw) || fallback);
}
