/*
 * Dev fixtures for the Connect group (Channels, Plugins, MCP, Devices, Nodes)
 * and the legacy Gateway / Hermes surfaces. In-memory and stateful, so adds,
 * removals, toggles and saves behave like the real thing for the session.
 */
import { defineCommands, defineHttp, emitEvent, json, sleep } from '../registry';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const MIN = 1;
const HOUR = 60;
const DAY = 24 * 60;

let seq = 100;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

// ── Channels ────────────────────────────────────────────────────────────────

interface ChannelFixture {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
  last_used: string | null;
  connected: boolean;
  created_at: string;
  updated_at: string;
}

let channels: ChannelFixture[] = [
  {
    id: 'ch-ops', name: 'ops-alerts', type: 'discord', enabled: true,
    config: { channel_id: '1184203957746012160', connected: true }, last_used: ago(14 * MIN),
    connected: false, created_at: ago(41 * DAY), updated_at: ago(2 * DAY),
  },
  {
    id: 'ch-digest', name: 'daily-digest', type: 'discord', enabled: true,
    config: { channel_id: '1190077351120887808', connected: true }, last_used: ago(9 * HOUR),
    connected: false, created_at: ago(33 * DAY), updated_at: ago(33 * DAY),
  },
  {
    id: 'ch-review', name: 'code-review', type: 'discord', enabled: true,
    config: { channel_id: '1201488630045982720', connected: false }, last_used: ago(3 * DAY),
    connected: false, created_at: ago(12 * DAY), updated_at: ago(3 * DAY),
  },
  {
    id: 'ch-draft', name: 'release-notes', type: 'discord', enabled: true,
    config: { connected: false }, last_used: null,
    connected: false, created_at: ago(2 * DAY), updated_at: ago(2 * DAY),
  },
  {
    id: 'ch-hook', name: 'legacy-webhook', type: 'webhook', enabled: false,
    config: { connected: false }, last_used: ago(60 * DAY),
    connected: false, created_at: ago(120 * DAY), updated_at: ago(60 * DAY),
  },
];

interface ReceiptFixture {
  message_id: string;
  channel: string;
  status: 'queued' | 'delivered' | 'failed';
  retry_count: number;
  error_code?: string;
  correlation_id: string;
  finished_at: string;
}

const receipts: ReceiptFixture[] = [
  { message_id: '1291044820331', channel: 'discord', status: 'delivered', retry_count: 0, correlation_id: 'verification-8f21c', finished_at: ago(14 * MIN) },
  { message_id: '1291012200174', channel: 'discord', status: 'delivered', retry_count: 1, correlation_id: 'digest-2026-10-10', finished_at: ago(9 * HOUR) },
  { message_id: '', channel: 'discord', status: 'failed', retry_count: 3, error_code: 'discord_http_403', correlation_id: 'review-ping-77ab0', finished_at: ago(1 * DAY + 3 * HOUR) },
  { message_id: '1290771905528', channel: 'discord', status: 'delivered', retry_count: 0, correlation_id: 'verification-31d9e', finished_at: ago(3 * DAY) },
  { message_id: '', channel: 'discord', status: 'failed', retry_count: 2, error_code: 'discord_http_429', correlation_id: 'digest-2026-10-07', finished_at: ago(4 * DAY) },
  { message_id: '1290201577820', channel: 'discord', status: 'delivered', retry_count: 0, correlation_id: 'verification-c0a44', finished_at: ago(9 * DAY) },
];

const setConnected = (id: string, connected: boolean) => {
  channels = channels.map((c) => (c.id === id ? { ...c, config: { ...c.config, connected }, updated_at: new Date().toISOString() } : c));
  return true;
};

defineCommands({
  list_channels: () => channels.map((c) => ({ ...c })),
  add_channel: ({ name, channelType, config }) => {
    const created: ChannelFixture = {
      id: nextId('ch'), name: String(name), type: String(channelType), enabled: true,
      config: { ...(config as Record<string, unknown>), connected: false }, last_used: null,
      connected: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    channels = [...channels, created];
    return created;
  },
  remove_channel: ({ id }) => {
    channels = channels.filter((c) => c.id !== id);
    return true;
  },
  login_channel: ({ id }) => setConnected(String(id), true),
  logout_channel: ({ id }) => setConnected(String(id), false),
});

defineHttp({
  'GET /channels/discord/receipts': () => json({ receipts }),
  'POST /channels/discord/send': async ({ body }) => {
    await sleep(700);
    const receipt: ReceiptFixture = {
      message_id: String(Date.now()), channel: 'discord', status: 'delivered', retry_count: 0,
      correlation_id: `verification-${Math.random().toString(16).slice(2, 7)}`, finished_at: new Date().toISOString(),
    };
    receipts.unshift(receipt);
    void body;
    return json({ ok: true, receipt });
  },
});

// ── Plugins ─────────────────────────────────────────────────────────────────

interface PluginFixture {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  description: string;
  source: string;
}

let plugins: PluginFixture[] = [
  { id: 'p-git', name: 'Git Workspace', version: '1.4.2', enabled: true, description: 'Read-only repository awareness for Agents: status, diff and blame surfaced as Tool runtime calls.', source: '~/.jarvis/plugins/git-workspace' },
  { id: 'p-browser', name: 'Browser Bridge', version: '0.9.0', enabled: true, description: 'Drives a sandboxed browser for page capture and form-fill tasks under the Permission policy.', source: '~/.jarvis/plugins/browser-bridge' },
  { id: 'p-notes', name: 'Obsidian Notes', version: '2.1.0', enabled: false, description: 'Indexes an Obsidian vault into Memory so Agents can recall notes by title and tag.', source: '~/.jarvis/plugins/obsidian-notes' },
  { id: 'p-cal', name: 'Calendar Sync', version: '0.3.7', enabled: false, description: 'Two-way sync with CalDAV calendars. Powers Commitments with real due dates.', source: '~/.jarvis/plugins/calendar-sync' },
  { id: 'p-metrics', name: 'Prometheus Exporter', version: '1.0.1', enabled: true, description: 'Exposes Bun server and Inference backend counters on a local /metrics endpoint.', source: 'builtin' },
  { id: 'p-voice', name: 'Voice Console', version: '0.1.0-beta', enabled: false, description: '', source: '~/.jarvis/plugins/voice-console' },
];

const setPlugin = (id: string, enabled: boolean) => {
  plugins = plugins.map((p) => (p.id === id ? { ...p, enabled } : p));
  return true;
};

defineCommands({
  get_plugins: () => plugins.map((p) => ({ ...p })),
  enable_plugin: async ({ id }) => {
    await sleep(350);
    return setPlugin(String(id), true);
  },
  disable_plugin: async ({ id }) => {
    await sleep(350);
    return setPlugin(String(id), false);
  },
});

// ── MCP (.mcp.json) ─────────────────────────────────────────────────────────

interface McpEntryFixture {
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  disabled: boolean;
  type?: string;
}

let mcpServers: Record<string, McpEntryFixture> = {
  filesystem: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/ethan/Projects'],
    env: {}, disabled: false, type: 'stdio',
  },
  github: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '(set)' }, disabled: false, type: 'stdio',
  },
  postgres: {
    command: 'uvx',
    args: ['mcp-server-postgres', '--connection-string', 'postgresql://localhost/jarvis_dev'],
    env: {}, cwd: '/Users/ethan/Projects/home-base', disabled: true, type: 'stdio',
  },
  'docs-search': {
    args: [], env: {}, url: 'https://docs.example.dev/mcp', disabled: false, type: 'http',
  },
};

defineCommands({
  list_mcp_servers: () => JSON.parse(JSON.stringify(mcpServers)),
  save_mcp_servers: async ({ servers }) => {
    await sleep(500);
    mcpServers = JSON.parse(JSON.stringify(servers));
    return null;
  },
});

// ── Devices ─────────────────────────────────────────────────────────────────

interface DeviceFixture {
  id: string;
  name: string;
  device_type: string;
  status: string;
  last_seen: string;
}

let devices: DeviceFixture[] = [
  { id: 'd-studio', name: 'Studio Mac', device_type: 'desktop', status: 'online', last_seen: ago(41 * DAY) },
  { id: 'd-mbp', name: 'Ethan’s MacBook Pro', device_type: 'laptop', status: 'online', last_seen: ago(38 * DAY) },
  { id: 'd-pixel', name: 'Pixel 9', device_type: 'phone', status: 'online', last_seen: ago(20 * DAY) },
  { id: 'd-ipad', name: 'Kitchen iPad', device_type: 'tablet', status: 'online', last_seen: ago(11 * DAY) },
  { id: 'd-nas', name: 'Basement NAS', device_type: 'server', status: 'online', last_seen: ago(7 * DAY) },
  { id: 'd-sensor', name: 'Garage sensor', device_type: 'iot', status: 'online', last_seen: ago(2 * DAY) },
];

defineCommands({
  get_devices: () => devices.map((d) => ({ ...d })),
  add_device: ({ name, deviceType }) => {
    const created: DeviceFixture = {
      id: nextId('d'), name: String(name), device_type: String(deviceType), status: 'online', last_seen: new Date().toISOString(),
    };
    devices = [...devices, created];
    return created;
  },
  remove_device: ({ id }) => {
    devices = devices.filter((d) => d.id !== id);
    return true;
  },
});

// ── Nodes ───────────────────────────────────────────────────────────────────

interface NodeFixture {
  id: string;
  name: string;
  address: string;
  status: string;
  latency_ms: number | null;
  last_ping: string;
  capabilities: string[];
}

let nodes: NodeFixture[] = [
  { id: 'n-gpu', name: 'gpu-box', address: '192.168.1.40:8080', status: 'unknown', latency_ms: null, last_ping: '', capabilities: [] },
  { id: 'n-mini', name: 'mac-mini-lab', address: 'mini.local:7000', status: 'unknown', latency_ms: null, last_ping: '', capabilities: [] },
  { id: 'n-vps', name: 'hetzner-edge', address: '5.78.121.9:7000', status: 'unknown', latency_ms: null, last_ping: '', capabilities: [] },
  { id: 'n-old', name: 'raspi-hall', address: '192.168.1.77:7000', status: 'offline', latency_ms: null, last_ping: ago(18 * DAY), capabilities: ['sensors'] },
];

defineCommands({
  get_nodes: () => nodes.map((n) => ({ ...n })),
  add_node: ({ name, address }) => {
    const created: NodeFixture = {
      id: nextId('n'), name: String(name), address: String(address), status: 'unknown', latency_ms: null, last_ping: '', capabilities: [],
    };
    nodes = [...nodes, created];
    return created;
  },
  remove_node: ({ id }) => {
    nodes = nodes.filter((n) => n.id !== id);
    return true;
  },
});

// ── Gateway (legacy) ────────────────────────────────────────────────────────

defineCommands({
  get_gateway_status: () => ({
    running: true,
    port: 19876,
    // Mirrors the real backend: connections and uptime are hard-coded zeros.
    active_connections: 0,
    uptime_seconds: 0,
    version: '0.11.4',
    timestamp: new Date().toISOString(),
  }),
});

// ── Hermes bridge (legacy) ──────────────────────────────────────────────────

let hermesState: 'cold' | 'ready' = 'ready';

const HERMES_REPLY =
  'The Hermes bridge is the legacy subprocess path. Session turns now run through the Bun server, ' +
  'so this pane only exists to exercise the bridge itself. Everything you type here is relayed ' +
  'to the subprocess and streamed back token by token.';

defineCommands({
  hermes_status: () => ({ state: hermesState, reason: null }),
  hermes_spawn: async () => {
    await sleep(600);
    hermesState = 'ready';
    return { state: 'ready', reason: null };
  },
  hermes_interrupt: () => ({ state: 'ready', reason: null }),
  hermes_invoke: ({ args }) => {
    const params = ((args as { params?: Record<string, unknown> }).params ?? {}) as { session_id?: string };
    const sessionId = params.session_id ?? null;
    void (async () => {
      for (const word of HERMES_REPLY.split(' ')) {
        await sleep(55);
        emitEvent('hermes-event', { type: 'stream.token', session_id: sessionId, params: { text: `${word} ` } });
      }
      emitEvent('hermes-event', { type: 'stream.done', session_id: sessionId, params: {} });
    })();
    return {};
  },
});
