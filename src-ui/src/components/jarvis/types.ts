// ═══════════════════════════════════════════════════════════════
// ── Jarvis View Types ──
// ═══════════════════════════════════════════════════════════════

export type JarvisBackend = 'ollama' | 'openrouter';

export interface JarvisConfig {
  backend: JarvisBackend;
  ollama_base_url: string;
  openrouter_base_url: string;
  model: string;
  api_key: string;
  system_prompt: string;
  bridge_port: number;
  bridge_enabled: boolean;
  jarvis_path: string;
}

export interface JarvisSession {
  id: string;
  name: string;
  created_at: string;
  model: string;
  message_count: number;
}

export interface JarvisMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: string;
  tool_name?: string;
  isStreaming?: boolean;
}

export interface JarvisStatus {
  ollama_running: boolean;
  model_available: boolean;
  bridge_active: boolean;
  bridge_port: number;
  bun_available: boolean;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing: string;
  description?: string;
}

// Popular OpenRouter models for the dropdown
export const OPENROUTER_MODELS: OpenRouterModel[] = [
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', context_length: 200000, pricing: '$$', description: 'Best coding model' },
  { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4', context_length: 200000, pricing: '$$$', description: 'Most capable' },
  { id: 'openai/gpt-4o', name: 'GPT-4o', context_length: 128000, pricing: '$$', description: 'OpenAI flagship' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', context_length: 128000, pricing: '$', description: 'Fast & cheap' },
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', context_length: 1000000, pricing: '$$', description: 'Google flagship' },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', context_length: 1000000, pricing: '$', description: 'Fast Google' },
  { id: 'deepseek/deepseek-v3', name: 'DeepSeek V3', context_length: 65536, pricing: '$', description: 'Best value' },
  { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', context_length: 65536, pricing: '$', description: 'Reasoning model' },
  { id: 'qwen/qwen-2.5-coder-32b-instruct', name: 'Qwen 2.5 Coder 32B', context_length: 131072, pricing: '$', description: 'Best open coder' },
  { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick', context_length: 1000000, pricing: '$', description: 'Meta flagship' },
  { id: 'mistralai/mistral-large-3', name: 'Mistral Large 3', context_length: 131072, pricing: '$$', description: 'European model' },
  { id: 'x-ai/grok-3', name: 'Grok 3', context_length: 131072, pricing: '$$', description: 'xAI latest' },
];