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
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { initialReceiptState, parseReceipts, reduceReceiptState } from './channel-receipt-state';
import { channelLocked, isConnected, reconcileChannels, type Channel, type ChannelOperation } from './channel-state';
import {
  cn,
  ConfirmModal,
  GlassCard,
  Pill,
  SectionHeader,
  StatusDot,
  LoadingState,
  EmptyState,
  useToast,
} from '../ui';

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
  saving,
  createError,
}: {
  onCreate: (name: string, type: string, url: string) => Promise<void>;
  onCancel: () => void;
  saving: boolean;
  createError: boolean;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState(CHANNEL_TYPES[0].value);
  const [url, setUrl] = useState('');


  const inputCls =
    'w-full px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50';

  const submit = () => {
    if (saving || !name.trim()) return;
    void onCreate(name.trim(), type, url.trim());
  };

  return (
    <GlassCard className="p-4 space-y-3">
      <fieldset disabled={saving} className="space-y-3 border-0 p-0 m-0 min-w-0">
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
      </fieldset>
      {saving && <p role="status" className="text-xs text-bone/60">Adding channel…</p>}
      {createError && (
        <div role="alert" className="text-xs text-red-200">
          Could not add channel. Your draft has been kept.{' '}
          <button type="button" onClick={submit} disabled={saving || !name.trim()} className="underline disabled:opacity-40">Retry</button>
        </div>
      )}
    </GlassCard>
  );
}

// ── Main view ──────────────────────────────────────────────────

export function ChannelsView() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState(false);
  const createPending = useRef(false);
  const [pendingDelete, setPendingDelete] = useState<Channel | null>(null);
  const [receiptState, dispatchReceipts] = useReducer(reduceReceiptState, initialReceiptState);
  const receiptPending = useRef(false);
  const { success } = useToast();
  const [operations, setOperations] = useState<Record<string, ChannelOperation<Channel>>>({});
  const operationsRef = useRef(operations);
  const requestId = useRef(0);
  const reading = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const publishOperations = useCallback((next: Record<string, ChannelOperation<Channel>>) => {
    operationsRef.current = next;
    setOperations(next);
  }, []);

  const fetchReceipts = useCallback(async () => {
    if (receiptPending.current) return;
    receiptPending.current = true;
    dispatchReceipts({ type: 'pending' });
    try {
      const response = await globalThis.fetch(`${BUN_URL}/channels/discord/receipts`);
      if (!response.ok) throw new Error('Delivery telemetry unavailable');
      dispatchReceipts({ type: 'success', receipts: parseReceipts(await response.json()) });
    } catch {
      dispatchReceipts({ type: 'failure' });
    } finally {
      receiptPending.current = false;
    }
  }, []);

  const fetchChannels = useCallback(async (opts?: { silent?: boolean; failureMessage?: string }) => {
    const request = ++requestId.current;
    reading.current = true;
    setLoading(true);
    try {
      const list = await invoke<Channel[]>('list_channels');
      if (request !== requestId.current) return;
      const result = reconcileChannels(list, operationsRef.current, request);
      publishOperations(result.operations);
      setChannels(result.rows);
      setLoaded(true);
      setError(null);
    } catch {
      if (request !== requestId.current) return;
      const next = { ...operationsRef.current };
      let rowFailure = false;
      for (const [id, operation] of Object.entries(next)) {
        if (operation.phase === 'reconciling' || operation.phase === 'read-failed') {
          next[id] = { ...operation, phase: 'read-failed' };
          rowFailure = true;
        }
      }
      publishOperations(next);
      if (opts?.failureMessage || !rowFailure) {
        setError(opts?.failureMessage ?? 'Could not refresh channels. Retry reloads the list only.');
      }
    } finally {
      if (request === requestId.current) {
        reading.current = false;
        setLoading(false);
      }
    }
  }, [publishOperations]);

  const retryRead = useCallback(() => {
    if (reading.current) return;
    void fetchChannels({ silent: true });
  }, [fetchChannels]);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  useEffect(() => {
    fetchReceipts();
  }, [fetchReceipts]);

  const create = useCallback(
    async (name: string, type: string, url: string) => {
      if (createPending.current || !name.trim()) return;
      createPending.current = true;
      setSaving(true);
      setCreateError(false);
      const config: Record<string, unknown> = url ? { url } : {};
      try {
        await invoke<Channel>('add_channel', { name, channelType: type, config });
        success(`Added channel ${name}`);
        setAdding(false);
        await fetchChannels({
          silent: true,
          failureMessage: 'Channel was added, but the channel list could not be refreshed. Retry reloads the list only.',
        });
      } catch {
        setCreateError(true);
      } finally {
        createPending.current = false;
        setSaving(false);
      }
    },
    [fetchChannels, success],
  );

  const changeAdding = (open: boolean) => {
    if (createPending.current) return;
    setCreateError(false);
    setAdding(open);
  };

  const mutate = useCallback(async (channel: Channel, action: ChannelOperation<Channel>['action']) => {
    if (channelLocked(operationsRef.current[channel.id])) return;
    const operation: ChannelOperation<Channel> = { row: channel, action, phase: 'writing', after: requestId.current };
    publishOperations({ ...operationsRef.current, [channel.id]: operation });
    try {
      const saved = await invoke<boolean>(action === 'remove' ? 'remove_channel' : action === 'connect' ? 'login_channel' : 'logout_channel', { id: channel.id });
      if (saved !== true) throw new Error('Write not confirmed');
    } catch {
      publishOperations({ ...operationsRef.current, [channel.id]: { ...operation, phase: 'write-failed', after: requestId.current } });
      if (action === 'remove') setPendingDelete(current => current?.id === channel.id ? null : current);
      return;
    }
    publishOperations({ ...operationsRef.current, [channel.id]: { ...operation, phase: 'reconciling', after: requestId.current } });
    if (action === 'remove') setPendingDelete(current => current?.id === channel.id ? null : current);
    await fetchChannels({ silent: true });
  }, [fetchChannels, publishOperations]);

  const toggleConnection = (channel: Channel) => void mutate(channel, isConnected(channel) ? 'disconnect' : 'connect');
  const remove = (channel: Channel) => {
    if (!channelLocked(operationsRef.current[channel.id])) setPendingDelete(channel);
  };
  const confirmDelete = () => {
    if (!pendingDelete) return;
    // Resolve the current confirmed row, not an obsolete dialog snapshot.
    const channel = channels.find(c => c.id === pendingDelete.id);
    if (channel) void mutate(channel, 'remove');
    else setPendingDelete(null);
  };
  const deleteOperation = pendingDelete ? operations[pendingDelete.id] : undefined;
  const deleting = deleteOperation?.action === 'remove' && deleteOperation.phase === 'writing';

  const connectedCount = useMemo(() => channels.filter(isConnected).length, [channels]);

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <ConfirmModal
        open={pendingDelete !== null}
        message={`Remove channel "${pendingDelete?.name}"?`}
        confirmLabel={deleting ? 'Removing…' : 'Remove'}
        detail={deleting ? 'Saving removal. Repeated confirmation will not submit another write.' : channelLocked(deleteOperation) ? 'Another change is pending. Removal is unavailable until reconciliation.' : undefined}
        danger
        onConfirm={confirmDelete}
        onCancel={() => { if (!deleting) setPendingDelete(null); }}
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
              onClick={() => changeAdding(!adding)}
              disabled={saving}
              className="px-3 py-1.5 text-xs rounded-lg bg-accent text-bone hover:bg-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {adding ? 'Close' : '+ New channel'}
            </button>
          </div>
        }
      />

      {adding && <AddChannelForm onCreate={create} onCancel={() => changeAdding(false)} saving={saving} createError={createError} />}

      <div className="text-xs text-bone/60 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span>Discord delivery telemetry</span>
          <button
            type="button"
            onClick={fetchReceipts}
            disabled={receiptState.phase === 'loading'}
            className="px-3 py-1 rounded-md bg-white/5 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {receiptState.phase === 'failed' ? 'Retry delivery telemetry' : 'Refresh delivery telemetry'}
          </button>
        </div>
        {receiptState.phase === 'loading' && (
          <p role="status">Loading delivery telemetry…{receiptState.receipts !== null && ' Previously loaded telemetry may be stale.'}</p>
        )}
        {receiptState.phase === 'failed' && (
          <p role="alert">
            {receiptState.receipts !== null
              ? 'Delivery telemetry is stale. Showing previously loaded receipts.'
              : 'Delivery telemetry is unavailable.'}
            {' This does not affect native channel loading.'}
          </p>
        )}
        {receiptState.phase === 'ready' && receiptState.receipts?.length === 0 && <p>No delivery receipts yet.</p>}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {error && (
          <div role="alert" className="text-sm text-red-200">
            <span>{error}</span> {loaded && 'Previously loaded channels may be stale.'}{' '}
            <button type="button" onClick={retryRead} disabled={loading} className="underline disabled:opacity-40">Retry</button>
          </div>
        )}
        {loaded && loading && <div role="status">Refreshing channels…</div>}
        {!loaded && loading ? (
          <LoadingState message="Loading channels…" />
        ) : !loaded ? null : channels.length === 0 ? (
          !error && !loading && <EmptyState message="No channels yet. Add one to get started." />
        ) : (
          <ul className="space-y-2">
            {channels.map((c) => {
              const connected = isConnected(c);
              const operation = operations[c.id];
              const locked = channelLocked(operation);
              const latestReceipt = c.type === 'discord' ? receiptState.receipts?.[0] : undefined;
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
                          disabled={locked}
                          className={cn(
                            'px-2 py-0.5 rounded-md border transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
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
                          disabled={locked}
                          className="px-2 py-0.5 rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                    {operation?.phase === 'writing' && <div role="status">Saving channel change…</div>}
                    {operation?.phase === 'reconciling' && <div role="status">Change saved. Reconciling channels…</div>}
                    {operation?.phase === 'write-failed' && (
                      <div role="alert" className="text-xs text-red-200">
                        Could not {operation.action} channel. Confirmed state was kept.{' '}
                        <button type="button" className="underline" onClick={() => operation.action === 'remove' ? remove(c) : void mutate(c, operation.action)}>Retry</button>
                      </div>
                    )}
                    {operation?.phase === 'read-failed' && (
                      <div role="alert" className="text-xs text-red-200">
                        Change was saved, but the channel list could not be reconciled. Showing previous state. Retry reloads the list only.{' '}
                        <button type="button" className="underline disabled:opacity-40" disabled={loading} onClick={retryRead}>Retry</button>
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-1.5 text-[10px] font-mono text-bone/30">
                      <span>last used {formatTimestamp(c.last_used)}</span>
                      {latestReceipt && <span className={latestReceipt.status === 'delivered' ? 'text-emerald-300/70' : 'text-amber-300/70'}>delivery {latestReceipt.status} · retries {latestReceipt.retry_count}{receiptState.phase !== 'ready' && ' (stale)'}</span>}
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
