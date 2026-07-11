// ═══════════════════════════════════════════════════════════════
// ── ChannelsView — Manage channels: add, connect, remove
// ═══════════════════════════════════════════════════════════════
//
// Backed by the SQLite channel surface in src-tauri/src/commands/channels.rs:
//   list_channels() -> Channel[]
//   add_channel(name, channelType, config) -> Channel
//   remove_channel(id) -> bool
//   login_channel(id) / logout_channel(id) -> bool
//
// Connection state is persisted inside `config.connected` (login/logout flip it);
// the top-level `connected` field from list_channels is always false, so we read
// the flag out of config.

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  cn,
  ConfirmModal,
  GlassCard,
  Pill,
  SectionHeader,
  StatusDot,
  LoadingState,
  ErrorState,
  EmptyState,
  useToast,
} from '../ui';

// ── Types ──────────────────────────────────────────────────────

interface Channel {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown> | null;
  last_used: string | null;
  connected: boolean;
  created_at: string;
  updated_at: string;
}

interface DeliveryReceipt {
  message_id: string;
  channel: string;
  status: 'queued' | 'delivered' | 'failed';
  retry_count: number;
  error_code?: string;
  correlation_id: string;
  finished_at: string;
}

const CHANNEL_TYPES = [
  { value: 'webhook', label: 'Webhook' },
  { value: 'discord', label: 'Discord' },
  { value: 'slack', label: 'Slack' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'signal', label: 'Signal' },
  { value: 'email', label: 'Email' },
  { value: 'http', label: 'HTTP Endpoint' },
  { value: 'websocket', label: 'WebSocket' },
];
const BUN_URL = 'http://127.0.0.1:19877';

// ── Helpers ────────────────────────────────────────────────────

function isConnected(channel: Channel): boolean {
  if (channel.connected) return true;
  const c = channel.config;
  return !!(c && typeof c === 'object' && (c as Record<string, unknown>).connected === true);
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const diff = Date.now() - d.getTime();
  if (diff < 0) return 'just now';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Add form ───────────────────────────────────────────────────

function AddChannelForm({
  onCreate,
  onCancel,
}: {
  onCreate: (name: string, type: string, url: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState(CHANNEL_TYPES[0].value);
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);

  const inputCls =
    'w-full px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50';

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onCreate(name.trim(), type, url.trim());
    } finally {
      setSaving(false);
    }
  };

  return (
    <GlassCard className="p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <input
          className={inputCls}
          placeholder="Channel name *"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          className={inputCls}
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          {CHANNEL_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <input
        className={inputCls}
        placeholder="Endpoint URL / token (optional)"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-xs rounded-lg border border-white/10 text-bone/60 hover:text-bone transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={saving || !name.trim()}
          className="px-3 py-1.5 text-xs rounded-lg bg-accent text-bone hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Adding…' : 'Add channel'}
        </button>
      </div>
    </GlassCard>
  );
}

// ── Main view ──────────────────────────────────────────────────

export function ChannelsView() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Channel | null>(null);
  const [receipts, setReceipts] = useState<DeliveryReceipt[]>([]);
  const { success, error: toastError } = useToast();

  const fetchChannels = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const list = await invoke<Channel[]>('list_channels');
      setChannels(list);
      const receiptResponse = globalThis.fetch
        ? await globalThis.fetch(`${BUN_URL}/channels/discord/receipts`).catch(() => null)
        : null;
      if (receiptResponse?.ok) {
        const body = await receiptResponse.json() as { receipts?: DeliveryReceipt[] };
        setReceipts(body.receipts ?? []);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  const create = useCallback(
    async (name: string, type: string, url: string) => {
      const config: Record<string, unknown> = url ? { url } : {};
      try {
        await invoke<Channel>('add_channel', { name, channelType: type, config });
        success(`Added channel ${name}`);
        setAdding(false);
        await fetchChannels({ silent: true });
      } catch (e) {
        toastError(String(e), 'Add failed');
      }
    },
    [fetchChannels, success, toastError],
  );

  const toggleConnection = useCallback(
    async (channel: Channel) => {
      const connected = isConnected(channel);
      try {
        await invoke<boolean>(connected ? 'logout_channel' : 'login_channel', { id: channel.id });
        success(`${connected ? 'Disconnected' : 'Connected'} ${channel.name}`);
        await fetchChannels({ silent: true });
      } catch (e) {
        toastError(String(e), 'Connection toggle failed');
      }
    },
    [fetchChannels, success, toastError],
  );

  const remove = useCallback((channel: Channel) => { setPendingDelete(channel); }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const channel = pendingDelete;
    setPendingDelete(null);
    try {
      await invoke<boolean>('remove_channel', { id: channel.id });
      success(`Removed ${channel.name}`);
      await fetchChannels({ silent: true });
    } catch (e) {
      toastError(String(e), 'Remove failed');
    }
  }, [pendingDelete, fetchChannels, success, toastError]);

  const connectedCount = useMemo(() => channels.filter(isConnected).length, [channels]);

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <ConfirmModal
        open={pendingDelete !== null}
        message={`Remove channel "${pendingDelete?.name}"?`}
        confirmLabel="Remove"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
      <SectionHeader
        title="Channels"
        subtitle="Add, connect, and manage delivery channels"
        count={channels.length}
        action={
          <div className="flex items-center gap-2">
            <Pill variant={connectedCount > 0 ? 'success' : 'default'}>
              {connectedCount} connected
            </Pill>
            <button
              type="button"
              onClick={() => setAdding((a) => !a)}
              className="px-3 py-1.5 text-xs rounded-lg bg-accent text-bone hover:bg-accent/80 transition-colors"
            >
              {adding ? 'Close' : '+ New channel'}
            </button>
          </div>
        }
      />

      {adding && <AddChannelForm onCreate={create} onCancel={() => setAdding(false)} />}

      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <LoadingState message="Loading channels…" />
        ) : error ? (
          <ErrorState error={error} onRetry={fetchChannels} />
        ) : channels.length === 0 ? (
          <EmptyState message="No channels yet. Add one to get started." />
        ) : (
          <ul className="space-y-2">
            {channels.map((c) => {
              const connected = isConnected(c);
              const latestReceipt = c.type === 'discord' ? receipts[0] : undefined;
              return (
                <li key={c.id}>
                  <GlassCard className="p-3">
                    <div className="flex items-center gap-2">
                      <StatusDot ok={connected} warn={!connected} pulse={connected} />
                      <h3 className="text-sm font-medium text-bone truncate">{c.name}</h3>
                      <Pill variant="default">{c.type}</Pill>
                      {connected && <Pill variant="success">connected</Pill>}
                      <div className="ml-auto flex items-center gap-1 text-[11px]">
                        <button
                          type="button"
                          onClick={() => toggleConnection(c)}
                          className={cn(
                            'px-2 py-0.5 rounded-md border transition-colors',
                            connected
                              ? 'border-amber-500/30 text-amber-200 hover:bg-amber-500/10'
                              : 'border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10',
                          )}
                        >
                          {connected ? 'Disconnect' : 'Connect'}
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(c)}
                          className="px-2 py-0.5 rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-1.5 text-[10px] font-mono text-bone/30">
                      <span>last used {formatTimestamp(c.last_used)}</span>
                      {latestReceipt && <span className={latestReceipt.status === 'delivered' ? 'text-emerald-300/70' : 'text-amber-300/70'}>delivery {latestReceipt.status} · retries {latestReceipt.retry_count}</span>}
                      <span className="ml-auto">added {formatTimestamp(c.created_at)}</span>
                    </div>
                  </GlassCard>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default ChannelsView;
