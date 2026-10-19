/*
 * Dev mock fixtures for the System slice: HealthBanner, SystemStatusBar,
 * BuildBadge and the Health page.
 *
 * Default scenario ("degraded"): the Bun server is down and its supervisor has
 * given up, so the banner, the strip and the Health page all have something to
 * say. Restarting the Bun server (Health → Bun server → Restart) recovers it
 * and brings the Bun HTTP telemetry back. Load with `?mock&scenario=healthy`
 * for the all-green variant.
 */
import { commands, defineCommands, defineHttp, json, sleep } from '../registry';

const scenario = new URLSearchParams(window.location.search).get('scenario');

const state = {
  bunUp: scenario === 'healthy',
  bunGiveUp: scenario !== 'healthy',
  bridgeUp: true,
  proxyUp: false,
  ollamaUp: false,
};

const BUN_URL = 'http://127.0.0.1:19877';
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

function status() {
  return {
    ollama_running: state.ollamaUp,
    llama_cpp_running: true,
    model_available: true,
    bun_server_running: state.bunUp,
    bun_server_url: BUN_URL,
    claude_proxy_running: state.proxyUp,
    bridge_active: state.bridgeUp,
    bridge_port: 19876,
    bun_available: true,
    active_backend: 'llama_cpp',
    model: 'gemma-4-26B-A4B-it-IQ2_M.gguf',
    openrouter_key_set: true,
  };
}

function systemHealth() {
  return {
    ollama: { running: state.ollamaUp, model: null, url: 'http://127.0.0.1:11434' },
    llama_cpp: { running: true, model: 'gemma-4-26B-A4B-it-IQ2_M.gguf', url: 'http://127.0.0.1:8080' },
    bun_server: { running: state.bunUp, url: BUN_URL },
    bridge: { running: state.bridgeUp, port: 19876 },
    claude_proxy: { running: state.proxyUp, port: 19878 },
    disk: { total: '931G', used: '588G', available: '343G', use_percent: '63%' },
    memory: { total_mb: 32768, available_mb: 9420, used_mb: 23348, used_percent: 71 },
    supervisor: {
      bun_give_up: state.bunGiveUp,
      proxy_give_up: false,
      ollama_give_up: false,
      llama_cpp_give_up: false,
    },
    timestamp: new Date().toISOString(),
  };
}

const doctorReport = {
  checks: [
    { name: 'Bun runtime', status: 'ok', detail: 'bun 1.2.19 at ~/.bun/bin/bun' },
    { name: 'soul.md', status: 'ok', detail: 'found · 4.2 KB · edited 3d ago' },
    { name: 'Agent directory', status: 'ok', detail: '11 Agents discovered, 0 invalid' },
    { name: 'llama.cpp server binary', status: 'ok', detail: '~/llama.cpp/build/bin/llama-server' },
    { name: 'llama.cpp model file', status: 'ok', detail: 'gemma-4-26B-A4B-it-IQ2_M.gguf · 9.1 GB' },
    { name: 'Workspace grants', status: 'warn', detail: '2 grants have not been used in 30 days' },
    { name: 'Disk headroom', status: 'ok', detail: '343G available' },
    { name: 'Claude CLI', status: 'error', detail: 'claude not found on PATH (delegate escalation unavailable)' },
  ],
  summary: { total: 8, ok: 6, warn: 1, error: 1, overall: 'error' },
  timestamp: iso(2),
};

const buildInfo = {
  version: '0.9.2',
  git_sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  git_short: 'a1b2c3d4e',
  dirty: false,
  build_time: '2026-10-08T21:14:09Z',
  source_sha: '7fe0d1c2b3a49586776655443322110099887766',
  stale: true,
};

defineCommands({
  jarvis_check_status: () => status(),
  get_system_health: () => systemHealth(),
  get_doctor_report: () => doctorReport,
  get_build_info: () => buildInfo,
  jarvis_start_bridge: () => {
    state.bridgeUp = true;
    return null;
  },
  jarvis_stop_bridge: () => {
    state.bridgeUp = false;
    return null;
  },
  restart_bridge: async () => {
    await sleep(500);
    state.bridgeUp = true;
    return true;
  },
  jarvis_restart_server: async () => {
    await sleep(900);
    state.bunUp = true;
    state.bunGiveUp = false;
    return true;
  },
  jarvis_restart_ollama: async () => {
    await sleep(900);
    state.ollamaUp = true;
    return true;
  },
  // Claude CLI is disabled in this install: Native answers "not required".
  jarvis_restart_proxy: () => false,
});

// Other slices (Settings, Models) own the full config; only fill the gap when
// nobody else has, so this fixture never clobbers a richer one.
if (!commands.has('jarvis_get_config')) {
  defineCommands({ jarvis_get_config: () => ({ version: '1.0.0', active_backend: 'llama_cpp' }) });
}

const inferenceMetrics = () => ({
  window_size: 48,
  generated_at: Date.now(),
  backends: [
    { backend: 'llama_cpp', requests: 37, errors: 0, error_rate: 0, p50_ms: 1420, p95_ms: 4810, total_tokens_in: 61240, total_tokens_out: 18432, last_model: 'gemma-4-26B-A4B-it-IQ2_M.gguf' },
    { backend: 'openrouter/free', requests: 7, errors: 1, error_rate: 0.14, p50_ms: 2210, p95_ms: 6900, total_tokens_in: 9120, total_tokens_out: 3011, last_model: 'meta-llama/llama-3.3-70b:free', last_error: 'upstream 429 rate limited' },
    { backend: 'opencode_go', requests: 4, errors: 0, error_rate: 0, p50_ms: 880, p95_ms: 1900, total_tokens_in: 2210, total_tokens_out: 1204, last_model: 'deepseek-v4-flash' },
  ],
  recent_attempts: [
    { ts: Date.now() - 600_000, stage: 'planner', provider: 'llama_cpp', model: 'gemma-4-26B', outcome: 'ok', latency_ms: 1380, first_token_ms: 410, fallback_attempt: 0 },
    { ts: Date.now() - 480_000, stage: 'executor', provider: 'llama_cpp', model: 'gemma-4-26B', outcome: 'ok', latency_ms: 4120, first_token_ms: 620, fallback_attempt: 0 },
    { ts: Date.now() - 300_000, stage: 'synthesizer', provider: 'openrouter', model: 'llama-3.3-70b:free', outcome: 'rate_limited', latency_ms: 2210, fallback_attempt: 0 },
    { ts: Date.now() - 296_000, stage: 'synthesizer', provider: 'opencode_go', model: 'deepseek-v4-flash', outcome: 'ok', latency_ms: 910, first_token_ms: 330, fallback_attempt: 1 },
    { ts: Date.now() - 120_000, stage: 'planner', provider: 'llama_cpp', model: 'gemma-4-26B', outcome: 'ok', latency_ms: 1290, first_token_ms: 380, fallback_attempt: 0 },
  ],
  runtime: { event_loop_delay_ms: { p95: 6, p99: 19 }, event_loop_utilization: 0.27, rss_bytes: 318 * 1024 * 1024 },
  conductor_cache: {
    window_size: 24,
    cache_hit_rate: 0.84,
    avg_prefix_recomputed: 364,
    records: Array.from({ length: 24 }, (_, i) => ({
      ts: Date.now() - (24 - i) * 90_000,
      conductor_cache_hit: i % 6 !== 0,
      prefix_tokens_recomputed: i % 6 === 0 ? 1400 - i * 12 : 90 + ((i * 37) % 160),
    })),
    generated_at: Date.now(),
  },
});

const bun = (build: () => unknown) => () => (state.bunUp ? json(build()) : json({ error: 'Bun server is not running' }, 503));

defineHttp({
  'GET /health/inference': bun(inferenceMetrics),
  'GET /health': bun(() => ({
    version: '1.0.0',
    model: 'gemma-4-26B-A4B-it-IQ2_M.gguf',
    model_resolved: true,
    git_sha: '7fe0d1c2b3a49586776655443322110099887766',
    built_at: '2026-10-09T08:02:44Z',
  })),
  'GET /health/readiness': bun(() => ({
    conductor: { enabled: true, state: 'ready', model: 'qwen3:4b', started_at: Date.now() - 3_600_000, completed_at: Date.now() - 3_598_200, latency_ms: 1800, error: null },
  })),
  'GET /health/conductor-directives': bun(() => ({
    window_size: 19,
    by_type: { continue: 14, reorder: 3, abort_stage: 2 },
    records: [],
    generated_at: Date.now(),
  })),
});
