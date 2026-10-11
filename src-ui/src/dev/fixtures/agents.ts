/*
 * Fixtures for the Agents surface: native Agent rows (SQLite), Channel
 * bindings, Runtime projections, and the Bun server's Agent lifecycle routes.
 * State is held in memory so create / edit / enable / delete / activate all
 * behave across a session. Two paths fail on purpose: activating `courier`
 * is rejected by the Bun server, and `scribe` has an invalid soul.md.
 */
import { defineCommands, defineHttp, json, sleep } from '../registry';

const NOW = Date.now();
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const hex = (c: string) => c.repeat(64);

interface AgentRow {
  id: string;
  name: string;
  description: string;
  model: string;
  backend: string;
  system_prompt: string;
  enabled: boolean;
  config: string | null;
  created_at: string;
  updated_at: string;
}

let agents: AgentRow[] = [
  {
    id: 'agent-atlas', name: 'Atlas', description: 'General-purpose Agent. Plans, delegates to the Tool runtime, and answers in plain prose.',
    model: 'gemma-3-12b-it-q4', backend: 'jarvis', enabled: true, config: null, created_at: ago(24 * 41), updated_at: ago(5),
    system_prompt: 'You are Atlas, the default Agent of this workshop.\nPrefer reading the workspace before answering.\nWhen a task needs a tool, say which one and why in a single sentence, then call it.\nNever invent file paths; search first.\nKeep answers short unless asked to elaborate.',
  },
  {
    id: 'agent-cartographer', name: 'Cartographer', description: 'Maps unfamiliar codebases: entry points, module boundaries, and ownership.',
    model: 'qwen2.5-coder:14b', backend: 'ollama', enabled: true, config: null, created_at: ago(24 * 33), updated_at: ago(24 * 6),
    system_prompt: 'You map codebases. Start with the build files, then the entry points. Report boundaries as a short outline, never as prose paragraphs.',
  },
  {
    id: 'agent-dispatch', name: 'Dispatch', description: 'Triage for inbound Channel messages. Routes, summarises, and escalates.',
    model: 'anthropic/claude-sonnet-4.5', backend: 'openrouter', enabled: true, config: null, created_at: ago(24 * 27), updated_at: ago(24 * 2),
    system_prompt: 'You triage inbound messages from bound Channels. Classify as: question, task, incident, noise. Escalate incidents to the on-call Channel immediately.',
  },
  {
    id: 'agent-foreman', name: 'Foreman', description: 'Runs the nightly cron routines and reports exceptions only.',
    model: 'gemma-3-12b-it-q4', backend: 'jarvis', enabled: true, config: null, created_at: ago(24 * 19), updated_at: ago(24 * 1),
    system_prompt: 'You supervise scheduled work. Report only exceptions. If everything succeeded, reply with the single word: quiet.',
  },
  {
    id: 'agent-archivist', name: 'Archivist', description: 'Curates Memory: dedupes, summarises, and expires stale entries.',
    model: 'llama3.1:8b', backend: 'ollama', enabled: true, config: null, created_at: ago(24 * 12), updated_at: ago(30),
    system_prompt: '',
  },
  {
    id: 'agent-sentinel', name: 'Sentinel', description: 'Watches build provenance and flags stale binaries. Paused while the eval harness is rebuilt.',
    model: 'gemma-3-4b-it-q8', backend: 'jarvis', enabled: false, config: null, created_at: ago(24 * 8), updated_at: ago(24 * 3),
    system_prompt: 'You compare the running binary with the checked-out source and flag any divergence.',
  },
];

const channels = [
  { id: 'ch-newsroom', name: 'Newsroom', type: 'discord', enabled: true, config: {}, last_used: ago(1), connected: true, created_at: ago(24 * 40), updated_at: ago(1) },
  { id: 'ch-ops', name: 'Ops', type: 'slack', enabled: true, config: {}, last_used: ago(3), connected: true, created_at: ago(24 * 35), updated_at: ago(3) },
  { id: 'ch-field', name: 'Field notes', type: 'telegram', enabled: true, config: {}, last_used: ago(26), connected: false, created_at: ago(24 * 20), updated_at: ago(26) },
  { id: 'ch-digest', name: 'Morning digest', type: 'email', enabled: false, config: {}, last_used: null, connected: false, created_at: ago(24 * 9), updated_at: ago(24 * 9) },
];

const bindings = new Map<string, Set<string>>([
  ['agent-atlas', new Set(['ch-newsroom', 'ch-field'])],
  ['agent-dispatch', new Set(['ch-ops', 'ch-newsroom'])],
  ['agent-foreman', new Set(['ch-ops'])],
]);

interface Projection {
  slug: string;
  source_path: string;
  source_hash: string;
  projection_version: number;
  status: string;
  validation_errors?: string;
  name?: string;
  description?: string;
  tools?: string[];
  version_tag?: string;
  source_size_bytes?: number;
  active: boolean;
  activated_at: string | null;
  deactivated_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Directory {
  id: string;
  slug: string;
  status: 'valid' | 'invalid';
  source_path: string;
  name?: string;
  description?: string;
  version?: string;
  source_hash?: string;
  source_size_bytes?: number;
}

const root = '/home/ethan/.openclaw/jarvis/agents';
const directories: Directory[] = [
  { id: 'coder', slug: 'coder', status: 'valid', name: 'Coder', description: 'Reads, edits, and tests code in a bounded workspace.', version: '1.4.0', source_path: `${root}/coder/soul.md`, source_hash: hex('a'), source_size_bytes: 3120 },
  { id: 'researcher', slug: 'researcher', status: 'valid', name: 'Researcher', description: 'Cites sources. Says so when it cannot find one.', version: '0.9.2', source_path: `${root}/researcher/soul.md`, source_hash: hex('c'), source_size_bytes: 2488 },
  { id: 'operator', slug: 'operator', status: 'valid', name: 'Operator', description: 'Runs approved shell and service tasks under a Permission policy.', version: '1.0.0', source_path: `${root}/operator/soul.md`, source_hash: hex('d'), source_size_bytes: 1904 },
  { id: 'ledger', slug: 'ledger', status: 'valid', name: 'Ledger', description: 'Reconciles commitments against the cron history.', version: '0.3.0', source_path: `${root}/ledger/soul.md`, source_hash: hex('e'), source_size_bytes: 1377 },
  { id: 'courier', slug: 'courier', status: 'valid', name: 'Courier', description: 'Carries summaries between Channels.', version: '0.1.0', source_path: `${root}/courier/soul.md`, source_hash: hex('f'), source_size_bytes: 988 },
  { id: 'scribe', slug: 'scribe', status: 'invalid', source_path: `${root}/scribe/soul.md`, source_size_bytes: 412 },
];

let projections: Projection[] = [
  {
    slug: 'coder', source_path: `${root}/coder/soul.md`, source_hash: hex('a'), projection_version: 4, status: 'valid', name: 'Coder',
    description: 'Reads, edits, and tests code in a bounded workspace.', tools: ['fs.read', 'fs.search', 'fs.edit', 'shell.run'], version_tag: '1.4.0',
    source_size_bytes: 3120, active: true, activated_at: ago(30), deactivated_at: null, created_at: ago(24 * 20), updated_at: ago(30),
  },
  {
    // Source on disk has since changed (hash c vs b): the projection is behind.
    slug: 'researcher', source_path: `${root}/researcher/soul.md`, source_hash: hex('b'), projection_version: 2, status: 'valid', name: 'Researcher',
    description: 'Cites sources.', tools: ['web.search', 'web.fetch'], version_tag: '0.9.0',
    source_size_bytes: 2310, active: true, activated_at: ago(24 * 5), deactivated_at: null, created_at: ago(24 * 12), updated_at: ago(24 * 5),
  },
  {
    slug: 'operator', source_path: `${root}/operator/soul.md`, source_hash: hex('d'), projection_version: 1, status: 'valid', name: 'Operator',
    description: 'Runs approved shell and service tasks.', tools: ['shell.run', 'service.restart'], version_tag: '1.0.0',
    source_size_bytes: 1904, active: false, activated_at: ago(24 * 9), deactivated_at: ago(24 * 2), created_at: ago(24 * 9), updated_at: ago(24 * 2),
  },
  {
    slug: 'scribe', source_path: `${root}/scribe/soul.md`, source_hash: hex('9'), projection_version: 1, status: 'invalid',
    validation_errors: 'soul.md line 7: unknown tool "fs.write_all"; frontmatter is missing "model".', source_size_bytes: 412,
    active: false, activated_at: null, deactivated_at: null, created_at: ago(24 * 4), updated_at: ago(24 * 4),
  },
];

const stamp = () => new Date().toISOString();
const find = (id: unknown) => agents.find((a) => a.id === id);

defineCommands({
  list_agents: () => agents.map((a) => ({ ...a })),
  add_agent: ({ name, model, description, systemPrompt }) => {
    const row: AgentRow = {
      id: `agent-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 6)}`,
      name: String(name), model: String(model), description: (description as string | null) ?? '', backend: 'jarvis',
      system_prompt: (systemPrompt as string | null) ?? '', enabled: true, config: null, created_at: stamp(), updated_at: stamp(),
    };
    agents = [row, ...agents];
    return row;
  },
  set_agent_identity: ({ id, name, description, systemPrompt, model }) => {
    const row = find(id);
    if (row) Object.assign(row, { name, description, system_prompt: systemPrompt, model, updated_at: stamp() });
    return null;
  },
  set_agent_enabled: ({ id, enabled }) => {
    const row = find(id);
    if (row) Object.assign(row, { enabled: Boolean(enabled), updated_at: stamp() });
    return null;
  },
  delete_agent: ({ id }) => {
    agents = agents.filter((a) => a.id !== id);
    bindings.delete(String(id));
    return null;
  },

  list_channels: () => channels,
  list_agent_channel_bindings: ({ agentId }) => [...(bindings.get(String(agentId)) ?? [])].sort(),
  bind_agent_channel: ({ agentId, channelId }) => {
    const set = bindings.get(String(agentId)) ?? new Set<string>();
    set.add(String(channelId));
    bindings.set(String(agentId), set);
    return null;
  },
  unbind_agent_channel: ({ agentId, channelId }) => {
    bindings.get(String(agentId))?.delete(String(channelId));
    return null;
  },

  list_agent_projections: () => projections.map((p) => ({ ...p })),
  activate_agent_projection: ({ projection }) => {
    const input = projection as Partial<Projection> & { slug: string; source_hash: string; source_path: string };
    const previous = projections.find((p) => p.slug === input.slug);
    const next: Projection = {
      ...(previous ?? { created_at: stamp(), deactivated_at: null }),
      ...input,
      status: 'valid',
      projection_version: previous && previous.active && previous.source_hash === input.source_hash ? previous.projection_version : (previous?.projection_version ?? 0) + 1,
      active: true,
      activated_at: stamp(),
      deactivated_at: null,
      updated_at: stamp(),
    } as Projection;
    projections = [...projections.filter((p) => p.slug !== input.slug), next];
    return next;
  },
  deactivate_agent_projection: ({ slug }) => {
    const previous = projections.find((p) => p.slug === slug);
    if (!previous) return null;
    const next = { ...previous, active: false, deactivated_at: stamp(), updated_at: stamp() };
    projections = projections.map((p) => (p.slug === slug ? next : p));
    return next;
  },
});

const routes: Parameters<typeof defineHttp>[0] = {
  'GET /agents': () =>
    json(
      directories.map((d) => {
        const p = projections.find((candidate) => candidate.slug === d.slug);
        return { ...d, active: p?.active ?? false, projection_version: p?.projection_version, activated_at: p?.activated_at, deactivated_at: p?.deactivated_at };
      }),
    ),
};

for (const d of directories) {
  routes[`POST /agents/${d.slug}/activate`] = async () => {
    await sleep(500);
    if (d.slug === 'courier') return json({ success: false, code: 'boundary_rejected' }, 409);
    if (d.status !== 'valid') return json({ success: false, code: 'invalid_source' }, 422);
    return json({
      success: true,
      projection: {
        slug: d.slug, source_path: d.source_path, source_hash: d.source_hash, status: 'valid', name: d.name, description: d.description,
        version_tag: d.version, source_size_bytes: d.source_size_bytes, tools: ['fs.read', 'fs.search'],
      },
    });
  };
  routes[`POST /agents/${d.slug}/deactivate`] = async () => {
    await sleep(300);
    return json({ success: true });
  };
}
defineHttp(routes);
