import { defineCommands } from '../registry';

/* Fixtures for the Overview page and the companion dock (slice S4). */

const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

const sessions = [
  ['ses_9f3a1c', 'agent-atlas', 'Refactor the cron scheduler', 'ollama', 'qwen3:14b', 42, 18, false, 31],
  ['ses_71be40', 'agent-vesper', 'Draft release notes for 0.9', 'claude_cli', 'claude-sonnet', 12, 140, false, 22],
  ['ses_c20d85', 'agent-atlas', 'Why is the Bridge flapping?', 'ollama', 'qwen3:14b', 28, 410, false, 9],
  ['ses_44aa07', 'agent-quill', 'Summarise inbox, flag renewals', 'openrouter', 'deepseek/deepseek-chat', 17, 1720, false, 44],
  ['ses_0e6b92', 'agent-vesper', 'Pairing notes: soul.md rewrite', 'claude_cli', 'claude-sonnet', 63, 3300, false, 27],
  ['ses_b81f33', 'agent-quill', 'Quarterly spend review', 'openrouter', 'deepseek/deepseek-chat', 8, 5600, true, 51],
  ['ses_2d5c19', 'agent-atlas', '', 'ollama', 'qwen3:14b', 3, 7400, true, 4],
  ['ses_6a90e2', 'agent-vesper', 'Migrate hooks to the new registry', 'claude_cli', 'claude-sonnet', 36, 9800, false, 83],
] as const;

defineCommands({
  get_system_health: () => ({
    ollama: { running: true, model: 'qwen3:14b', url: 'http://127.0.0.1:11434' },
    bun_server: { running: true, url: 'http://127.0.0.1:19877' },
    bridge: { running: false, port: 19878 },
    disk: { total: '931G', used: '612G', available: '319G', use_percent: '66%' },
    memory: { total_mb: 32768, available_mb: 6410, used_mb: 26358, used_percent: 80.4 },
    timestamp: ago(0),
  }),
  list_agents: () => [
    { id: 'agent-atlas', name: 'Atlas', model: 'qwen3:14b', enabled: true },
    { id: 'agent-vesper', name: 'Vesper', model: 'claude-sonnet', enabled: true },
    { id: 'agent-quill', name: 'Quill', model: 'deepseek/deepseek-chat', enabled: true },
    { id: 'agent-lumen', name: 'Lumen', model: 'qwen3:14b', enabled: false },
  ],
  list_sessions: () =>
    sessions.map(([id, agent_id, title, backend, model, message_count, minsAgo, archived, mins]) => ({
      id, agent_id, title, backend, model, message_count, archived,
      context_tokens: 32768, total_tokens: message_count * 900,
      created_at: ago(minsAgo + mins), updated_at: ago(minsAgo),
    })),
  jarvis_get_companion: () => ({
    enabled: true,
    name: 'Ember',
    species: 'owl',
    rarity: 'epic',
    mood: 'thinking',
    happiness: 82,
    energy: 46,
    level: 7,
    xp: 640,
    xp_to_next: 900,
    interactions_total: 213,
    last_interaction: ago(95),
    current_message: 'Rereading the cron scheduler diff before the nightly run.',
    is_speaking: false,
    is_petting: false,
    hatched_at: ago(60 * 24 * 40),
  }),
  list_cron_jobs: () => [
    { id: 'cron-1', name: 'Nightly self-review', schedule: '0 3 * * *', agent_id: 'agent-atlas', session_id: null, prompt: 'Run a self-improvement review of yesterday’s Sessions.', enabled: true, last_run: ago(60 * 9), next_run: ago(-60 * 15), run_count: 38, metadata: null, created_at: ago(60 * 24 * 30), updated_at: ago(60 * 9) },
    { id: 'cron-2', name: 'Inbox digest', schedule: '0 8 * * 1-5', agent_id: 'agent-quill', session_id: null, prompt: 'Summarise the inbox.', enabled: true, last_run: ago(60 * 4), next_run: ago(-60 * 20), run_count: 112, metadata: null, created_at: ago(60 * 24 * 60), updated_at: ago(60 * 4) },
    { id: 'cron-3', name: 'Weekly spend', schedule: '0 9 * * 1', agent_id: 'agent-quill', session_id: null, prompt: 'Report spend.', enabled: false, last_run: null, next_run: null, run_count: 0, metadata: null, created_at: ago(60 * 24 * 7), updated_at: ago(60 * 24 * 7) },
  ],
  list_pending_missed_jobs: () => [],
});
