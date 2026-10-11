import type { JarvisConfig } from '../../domain/types';
import type { Tone } from '../../design';

/** Text tone for a recorded run outcome word (always rendered as words). */
export function outcomeTone(outcome: string): string {
  switch (outcome) {
    case 'success':
      return 'text-ok';
    case 'partial':
    case 'timed_out':
      return 'text-warn';
    case 'failed':
      return 'text-err';
    case 'cancelled':
      return 'text-ink-3';
    default:
      return 'text-ink-2';
  }
}

export function outcomeBadgeTone(outcome: string): Tone {
  switch (outcome) {
    case 'success':
      return 'ok';
    case 'partial':
    case 'timed_out':
      return 'warn';
    case 'failed':
      return 'error';
    default:
      return 'muted';
  }
}

/**
 * Human label of the configured Inference backend and its model. Defensive
 * against a partial or malformed config payload: the Session surface must
 * render even when `jarvis_get_config` returns something unexpected.
 */
export function backendLabels(config: JarvisConfig | null): { backendLabel: string; modelLabel: string } {
  const backend = config?.active_backend;
  const backendLabel =
    backend === 'openrouter'
      ? 'OpenRouter'
      : backend === 'llama_cpp'
        ? 'Gemma 4 · llama.cpp'
        : backend === 'claude_cli'
          ? 'Claude CLI'
          : 'Ollama';
  if (!config) return { backendLabel, modelLabel: '' };
  const modelLabel =
    backend === 'ollama'
      ? config.ollama?.model
      : backend === 'llama_cpp'
        ? config.llama_cpp?.model
        : backend === 'claude_cli'
          ? (config.claude_cli?.model ?? '')
          : config.openrouter?.model;
  return { backendLabel, modelLabel: typeof modelLabel === 'string' ? modelLabel : '' };
}

/** "14:02" for a message timestamp; empty when the value is unparsable. */
export function clockTime(value: string | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "Sep 16" style short date for Session rows. */
export function shortDate(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
