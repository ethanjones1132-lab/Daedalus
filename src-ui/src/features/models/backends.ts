import type { JarvisBackend } from '../../domain/types';

/** Vocabulary for the four Inference backends (CONTEXT.md). */
export interface BackendInfo {
  id: JarvisBackend;
  /** Short product name. */
  label: string;
  /** One-line description for selector cards. */
  description: string;
  /** True when inference runs on this machine. */
  local: boolean;
}

export const BACKENDS: BackendInfo[] = [
  { id: 'llama_cpp', label: 'llama.cpp', description: 'Local GGUF models through an owned llama-server process. The default.', local: true },
  { id: 'ollama', label: 'Ollama', description: 'Local models served by an Ollama daemon.', local: true },
  { id: 'openrouter', label: 'OpenRouter', description: 'Cloud models, including a rotating free tier.', local: false },
  { id: 'claude_cli', label: 'Claude Code CLI', description: 'The local claude binary, through the proxy or your account.', local: true },
];

const BY_ID = new Map<string, BackendInfo>(BACKENDS.map((b) => [b.id, b]));

export function backendInfo(id: string | null | undefined): BackendInfo | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

/** Display name for a backend id; unknown ids pass through unchanged. */
export function backendLabel(id: string | null | undefined): string {
  return backendInfo(id)?.label ?? id ?? 'unknown';
}
