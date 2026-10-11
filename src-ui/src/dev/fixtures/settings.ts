/*
 * Fixtures for Settings (Jarvis config + raw settings table) and Inference
 * (model profiles + model discovery). Commands:
 *   jarvis_get_config · jarvis_save_config · get_all_settings · set_setting · get_setting
 *   list_model_profiles · create_profile · set_active_profile · delete_profile · jarvis_discover_models
 * State is held in module scope so saves, activations, and deletes read back.
 */
import { defineCommands, sleep } from '../registry';

const ago = (days: number, hours = 0) => new Date(Date.now() - (days * 24 + hours) * 3_600_000).toISOString();

// ── Jarvis config ───────────────────────────────────────────────
// Includes fields the TypeScript JarvisConfig type does not describe (mode,
// prizepicks_prompt, compaction, profiles, agents_root) so round-trip saves
// are visible in the mock.
let config: Record<string, unknown> = {
  version: '2.4.0',
  active_backend: 'llama_cpp',
  ollama: {
    base_url: 'http://127.0.0.1:11434',
    model: 'qwen2.5-coder:7b',
    auto_pull: false,
    health_check_interval_ms: 15000,
    options: { num_ctx: 8192, num_gpu: 99, num_thread: 8 },
  },
  openrouter: {
    base_url: 'https://openrouter.ai/api/v1',
    api_key: 'sk-or-v1-0000000000000000000000000000000000000000000000000000mock',
    model: 'openrouter/free',
    site_url: 'https://jarvis.local',
    site_name: 'Jarvis',
    fallbacks: ['qwen/qwen3-coder:free', 'meta-llama/llama-3.3-70b-instruct:free'],
    enable_fallbacks: true,
    enable_paid_fallbacks: false,
    max_retries: 2,
    timeout_ms: 60000,
  },
  llama_cpp: {
    base_url: 'http://127.0.0.1:8080/v1',
    model: 'gemma-4-26B-A4B-it-IQ2_M.gguf',
    server_path: '/opt/llama.cpp/build/bin/llama-server',
    model_path: '/models/gemma-4-26B-A4B-it-IQ2_M.gguf',
    mtp_path: '',
    port: 8080,
    context_window: 16384,
    reasoning_budget: 1536,
  },
  opencode_zen: { base_url: 'https://opencode.ai/zen/v1', api_key: '', first_token_timeout_ms: 45000 },
  opencode_go: { base_url: 'https://opencode.ai/go/v1', api_key: 'oc-go-mock-key-1234', first_token_timeout_ms: 30000 },
  claude_cli: {
    enabled: true,
    path: 'claude',
    args: [],
    timeout_ms: 300000,
    cwd: '',
    model: 'sonnet',
    auth_mode: 'proxy',
    delegate: { enabled: true, policy: 'escalation', permission_mode: 'acceptEdits', allowed_tools: ['Read', 'Grep'], model: 'sonnet', timeout_ms: 120000 },
  },
  tools: {
    enabled: true,
    require_approval: ['shell', 'write_file'],
    sandbox_mode: 'strict',
    allowlist: [],
    denylist: [],
    allowed_roots: ['/home/user/Daedalus'],
    grant_session_roots: true,
    bash_path: '',
    shell_timeout_max_ms: 120000,
  },
  reasoning: { enabled: true, show_trace_by_default: false, max_tokens: 4096 },
  web_search: { provider: 'duckduckgo', brave_api_key: '', tavily_api_key: '' },
  companion: { enabled: true, name: 'Dae', species: 'robot', rarity: 'rare' },
  orchestrator: { enabled: true, max_stages: 4, review_pass: true },
  system_prompt:
    'You are Jarvis, a careful engineering assistant. Prefer reading the code before proposing changes, cite file paths, and say plainly when you are unsure. Keep answers short unless asked to elaborate.',
  temperature: 0.6,
  max_tokens: 4096,
  top_p: 1,
  bridge_port: 19876,
  bridge_enabled: false,
  jarvis_path: '/home/user/Daedalus',
  active_profile: 'prof-gemma-local',
  api_sports_key: '',
  // Rust-only fields:
  mode: 'standard',
  prizepicks_prompt: '',
  compaction: { enabled: true, threshold: 0.82 },
  profiles: [],
  agents_root: '/home/user/.jarvis/agents',
};

// ── Raw settings table ──────────────────────────────────────────
const settings = new Map<string, string>([
  // Mirrors the browser's choice so ?mock never fights the theme picked in this tab.
  ['theme', (() => { try { return localStorage.getItem('jarvis-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } })()],
  ['active_backend', 'llama_cpp'],
  ['bridge_port', '19876'],
  ['bridge_enabled', 'false'],
  ['active_profile', 'prof-gemma-local'],
  ['agents_root', '/home/user/.jarvis/agents'],
  ['system_prompt', 'You are Jarvis, a careful engineering assistant. Prefer reading the code before proposing changes, cite file paths, and say plainly when you are unsure.'],
  ['max_tokens', '4096'],
  ['temperature', '0.6'],
]);

// ── Model profiles ──────────────────────────────────────────────
interface Profile {
  id: string;
  name: string;
  provider: string;
  model: string;
  api_base: string;
  max_tokens: number;
  temperature: number;
  top_p: number;
  system_prompt: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  engine: string;
}

const profiles: Profile[] = [
  {
    id: 'prof-gemma-local', name: 'Gemma local', provider: 'llama_cpp', model: 'gemma-4-26B-A4B-it-IQ2_M.gguf',
    api_base: 'http://127.0.0.1:8080/v1', max_tokens: 4096, temperature: 0.6, top_p: 0.95, system_prompt: '', is_active: true,
    created_at: ago(21), updated_at: ago(0, 3), engine: 'native',
  },
  {
    id: 'prof-qwen-coder', name: 'Qwen coder', provider: 'ollama', model: 'qwen2.5-coder:7b',
    api_base: 'http://127.0.0.1:11434', max_tokens: 8192, temperature: 0.2, top_p: 0.9, system_prompt: '', is_active: false,
    created_at: ago(34), updated_at: ago(9), engine: 'native',
  },
  {
    id: 'prof-free-router', name: 'Free router', provider: 'openrouter', model: 'openrouter/free',
    api_base: 'https://openrouter.ai/api/v1', max_tokens: 4096, temperature: 0.7, top_p: 1, system_prompt: '', is_active: false,
    created_at: ago(12), updated_at: ago(12), engine: 'native',
  },
  {
    id: 'prof-nemotron', name: 'Deep reasoning', provider: 'openrouter', model: 'nvidia/llama-3.1-nemotron-ultra-253b-v1:free',
    api_base: 'https://openrouter.ai/api/v1', max_tokens: 16384, temperature: 0.4, top_p: 0.9, system_prompt: '', is_active: false,
    created_at: ago(5), updated_at: ago(2), engine: 'native',
  },
  {
    id: 'prof-claude-cli', name: 'Claude CLI review', provider: 'claude_cli', model: 'sonnet',
    api_base: '', max_tokens: 8192, temperature: 0.3, top_p: 1, system_prompt: '', is_active: false,
    created_at: ago(2, 4), updated_at: ago(2, 4), engine: 'claude_cli',
  },
];

const DISCOVERED = [
  { id: 'gemma-4-26B-A4B-it-IQ2_M.gguf', name: 'Gemma 4 26B-A4B IQ2_M', provider: 'llama_cpp', context_length: 16384 },
  { id: 'qwen2.5-coder:7b', name: 'Qwen2.5 Coder 7B', provider: 'ollama', context_length: 131072 },
  { id: 'llama3.2:3b', name: 'Llama 3.2 3B', provider: 'ollama', context_length: 131072 },
  { id: 'deepseek-coder:6.7b', name: 'DeepSeek Coder 6.7B', provider: 'ollama', context_length: 16384 },
  { id: 'mistral:7b', name: 'Mistral 7B', provider: 'ollama', context_length: 32768 },
  { id: 'openrouter/free', name: 'Free Models Router', provider: 'openrouter', context_length: 200000 },
  { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder 480B', provider: 'openrouter', context_length: 1048576 },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B Instruct', provider: 'openrouter', context_length: 131072 },
  { id: 'openai/gpt-oss-120b:free', name: 'GPT OSS 120B', provider: 'openrouter', context_length: 131072 },
  { id: 'deepseek/deepseek-v3', name: 'DeepSeek V3', provider: 'openrouter', context_length: 65536 },
];

let nextProfile = 1;

defineCommands({
  jarvis_get_config: () => structuredClone(config),
  jarvis_save_config: async ({ config: next }) => {
    await sleep(500);
    config = structuredClone(next as Record<string, unknown>);
    return null;
  },

  get_all_settings: () => Object.fromEntries(settings),
  get_setting: ({ key }) => settings.get(String(key)) ?? null,
  set_setting: ({ key, value }) => {
    settings.set(String(key), String(value));
    return null;
  },

  list_model_profiles: () => structuredClone(profiles),
  create_profile: async ({ name, backend, model, temperature, maxTokens, topP, engine }) => {
    await sleep(350);
    const created: Profile = {
      id: `prof-new-${nextProfile++}`,
      name: String(name),
      provider: String(backend),
      model: String(model),
      api_base: backend === 'openrouter' ? 'https://openrouter.ai/api/v1' : '',
      max_tokens: Number(maxTokens),
      temperature: Number(temperature),
      top_p: Number(topP),
      system_prompt: '',
      is_active: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      engine: String(engine),
    };
    profiles.push(created);
    return created;
  },
  set_active_profile: async ({ id }) => {
    await sleep(300);
    const target = profiles.find((p) => p.id === id);
    if (!target) throw new Error('profile not found');
    for (const p of profiles) p.is_active = p.id === id;
    return { provider: target.provider, model: target.model, source: 'profile', applied_at: new Date().toISOString(), restart_required: false };
  },
  delete_profile: async ({ id }) => {
    await sleep(250);
    const i = profiles.findIndex((p) => p.id === id);
    if (i < 0) return false;
    profiles.splice(i, 1);
    return true;
  },
  jarvis_discover_models: async () => {
    await sleep(700);
    return DISCOVERED;
  },
});
