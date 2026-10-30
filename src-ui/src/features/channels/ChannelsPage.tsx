import { listRead, projectListTally } from '../../lib/list-tally';
import { channelProbePhase, projectChannelLiveness } from '../../domain/channel-liveness';
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ArrowUpRight, Hash, Plug, Plus, RefreshCw, Trash2, Unplug, X } from 'lucide-react';
import {
  AlertLine,
  Badge,
  Button,
  ConfirmModal,
  EmptyState,
  Field,
  formatIsoAge,
  IconButton,
  Input,
  Page,
  PageHeader,
  Panel,
  RowList,
  Select,
  Skeleton,
  StatusDot,
  StatusLine,
  cn,
  useToast,
} from '../../design';
import {
  initialReceiptState,
  parseDiscordSendResponse,
  parseReceipts,
  RECEIPT_FAILURE_COPY,
  reduceReceiptState,
  type DeliveryReceipt,
} from '../../domain/channel-receipt-state';
import {
  canVerifyChannel,
  channelId,
  channelLocked,
  isConfiguredChannel,
  isConnected,
  reconcileChannels,
  type Channel,
  type ChannelOperation,
} from '../../domain/channel-state';
import { useNavigation } from '../../shell/navigation';

/*
 * Channels — Discord delivery channels (Native surface, SQLite via
 * commands/channels.rs) plus the Bun server's adapter-wide delivery receipts.
 *
 * Connection state lives in `config.connected` (login/logout flip it); the
 * top-level `connected` from list_channels is always false, so isConnected()
 * reads both. "Verify & connect" first sends a real check message through the
 * Bun server and only persists the connected flag after a `delivered` receipt.
 */

const CHANNEL_TYPES = [{ value: 'discord', label: 'Discord' }];
const BUN_URL = 'http://127.0.0.1:19877';
const VERIFICATION_TEXT = 'Jarvis Discord connection check';

function receiptValue(value: string | undefined): string {
  return value ? value : 'Not supplied';
}

// ── Delivery receipts timeline ─────────────────────────────────

function ReceiptTimeline({ receipts, stale }: { receipts: DeliveryReceipt[]; stale: boolean }) {
  return (
    <section role="region" aria-label="Discord adapter delivery receipts" className="border-t border-line">
      <div className="flex items-start justify-between gap-3 px-4 pb-1 pt-3">
        <div>
          <h3 className="text-[12.5px] font-semibold text-ink">Receipts</h3>
          <p className="mt-0.5 text-[11.5px] leading-snug text-ink-3">
            Adapter-wide history; receipts are not mapped to configured channel rows.
          </p>
        </div>
        {stale && (
          <Badge tone="warn" size="xs">
            stale
          </Badge>
        )}
      </div>
      <ul className="relative px-4 pb-4 pt-2">
        <span aria-hidden="true" className="absolute bottom-6 left-[23px] top-4 w-px bg-line-strong" />
        {receipts.map((receipt, index) => {
          const tone = receipt.status === 'delivered' ? 'ok' : receipt.status === 'failed' ? 'error' : 'warn';
          return (
            <li key={`${receipt.correlation_id}-${index}`} className="relative flex gap-3 pb-4 last:pb-0">
              <span className="relative z-10 mt-1 flex size-[15px] shrink-0 items-center justify-center rounded-full bg-surface ring-4 ring-surface">
                <StatusDot tone={tone} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Badge tone={tone}>{receipt.status}</Badge>
                  <span className="d-label">outbound</span>
                  <span className="text-[11.5px] text-ink-3">{formatIsoAge(receipt.finished_at)}</span>
                </div>
                <div className="mt-1.5 space-y-0.5 font-mono text-[11px] leading-relaxed text-ink-3">
                  <div>
                    <span>
                      status: {receipt.status}
                      {stale && ' (stale)'}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-3">
                    <span>retry_count: {receipt.retry_count}</span>
                    <span>finished_at: {receiptValue(receipt.finished_at)}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-3">
                    <span>message_id: {receiptValue(receipt.message_id)}</span>
                    <span>correlation_id: {receiptValue(receipt.correlation_id)}</span>
                  </div>
                  <div className={cn(receipt.error_code && 'text-err')}>error_code: {receiptValue(receipt.error_code)}</div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── Add form ───────────────────────────────────────────────────

function AddChannelForm({
  onCreate,
  onCancel,
  saving,
  createError,
}: {
  onCreate: (name: string, destination: string) => Promise<void>;
  onCancel: () => void;
  saving: boolean;
  createError: boolean;
}) {
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const valid = Boolean(name.trim() && destination.trim());

  const submit = () => {
    if (saving || !valid) return;
    void onCreate(name.trim(), destination.trim());
  };

  return (
    <Panel className="d-rise space-y-3">
      <div>
        <h2 className="text-[13px] font-semibold text-ink">New channel</h2>
        <p className="mt-0.5 text-[12px] leading-snug text-ink-3">Bind a Discord channel by its ID. No token is stored here.</p>
      </div>
      <fieldset disabled={saving} className="m-0 min-w-0 space-y-3 border-0 p-0">
        <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
          <Field label="Channel name">
            {(id) => <Input id={id} placeholder="Channel name *" value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Adapter">
            {(id) => (
              <Select id={id} defaultValue={CHANNEL_TYPES[0].value}>
                {CHANNEL_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Discord channel ID" hint="Copy it from Discord with Developer Mode on.">
          {(id) => (
            <Input
              id={id}
              mono
              placeholder="Discord channel ID *"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
            />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving || !valid} busy={saving}>
            {saving ? 'Adding…' : 'Add channel'}
          </Button>
        </div>
      </fieldset>
      {saving && <StatusLine>Adding channel…</StatusLine>}
      {createError && (
        <AlertLine onRetry={submit} retryDisabled={saving || !valid}>
          Could not add channel. Your draft has been kept.
        </AlertLine>
      )}
    </Panel>
  );
}

// ── Page ───────────────────────────────────────────────────────

export default function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState(false);
  const createPending = useRef(false);
  const [pendingDelete, setPendingDelete] = useState<Channel | null>(null);
  const [receiptState, dispatchReceipts] = useReducer(reduceReceiptState, initialReceiptState);
  const [verifiedChannels, setVerifiedChannels] = useState<Set<string>>(() => new Set());
  const receiptPending = useRef(false);
  const { success } = useToast();
  const { navigate } = useNavigation();
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
      if (!response.ok) {
        // Refusal with a status: fixed code, fixed copy — the raw status is a
        // server fact, not the operator's failure message.
        dispatchReceipts({ type: 'failure', reason: 'http_status' });
        return;
      }
      try {
        dispatchReceipts({ type: 'success', receipts: parseReceipts(await response.json()) });
      } catch {
        dispatchReceipts({ type: 'failure', reason: 'malformed' });
      }
    } catch {
      dispatchReceipts({ type: 'failure', reason: 'bun_unreachable' });
    } finally {
      receiptPending.current = false;
    }
  }, []);

  const fetchChannels = useCallback(
    async (opts?: { silent?: boolean; failureMessage?: string }) => {
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
    },
    [publishOperations],
  );

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
    async (name: string, destination: string) => {
      if (createPending.current || !name.trim() || !destination.trim()) return;
      createPending.current = true;
      setSaving(true);
      setCreateError(false);
      try {
        await invoke<Channel>('add_channel', {
          name,
          channelType: 'discord',
          config: { channel_id: destination.trim() },
        });
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

  const verifyDelivery = useCallback(async (channel: Channel): Promise<boolean> => {
    if (!canVerifyChannel(channel)) return false;
    try {
      const response = await globalThis.fetch(`${BUN_URL}/channels/discord/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_id: channelId(channel), text: VERIFICATION_TEXT }),
      });
      const result = parseDiscordSendResponse(await response.json().catch(() => null));
      return response.ok && result.ok && result.receipt?.status === 'delivered';
    } catch {
      return false;
    }
  }, []);

  const mutate = useCallback(
    async (channel: Channel, action: ChannelOperation<Channel>['action']) => {
      if (channelLocked(operationsRef.current[channel.id])) return;
      const operation: ChannelOperation<Channel> = { row: channel, action, phase: 'writing', after: requestId.current };
      publishOperations({ ...operationsRef.current, [channel.id]: operation });
      if (action === 'connect') {
        if (!(await verifyDelivery(channel))) {
          publishOperations({
            ...operationsRef.current,
            [channel.id]: { ...operation, phase: 'verification-failed', after: requestId.current },
          });
          return;
        }
        setVerifiedChannels((current) => new Set(current).add(channel.id));
      }
      try {
        const saved = await invoke<boolean>(
          action === 'remove' ? 'remove_channel' : action === 'connect' ? 'login_channel' : 'logout_channel',
          { id: channel.id },
        );
        if (saved !== true) throw new Error('Write not confirmed');
      } catch {
        publishOperations({
          ...operationsRef.current,
          [channel.id]: { ...operation, phase: 'write-failed', after: requestId.current },
        });
        if (action === 'remove') setPendingDelete((current) => (current?.id === channel.id ? null : current));
        return;
      }
      if (action === 'disconnect' || action === 'remove') {
        setVerifiedChannels((current) => {
          const next = new Set(current);
          next.delete(channel.id);
          return next;
        });
      }
      publishOperations({
        ...operationsRef.current,
        [channel.id]: { ...operation, phase: 'reconciling', after: requestId.current },
      });
      if (action === 'remove') setPendingDelete((current) => (current?.id === channel.id ? null : current));
      await fetchChannels({ silent: true });
    },
    [fetchChannels, publishOperations, verifyDelivery],
  );

  const toggleConnection = (channel: Channel) => {
    if (isConnected(channel)) void mutate(channel, 'disconnect');
    else if (canVerifyChannel(channel)) void mutate(channel, 'connect');
  };
  const remove = (channel: Channel) => {
    if (!channelLocked(operationsRef.current[channel.id])) setPendingDelete(channel);
  };
  const confirmDelete = () => {
    if (!pendingDelete) return;
    // Resolve the current confirmed row, not an obsolete dialog snapshot.
    const channel = channels.find((c) => c.id === pendingDelete.id);
    if (channel) void mutate(channel, 'remove');
    else setPendingDelete(null);
  };
  const deleteOperation = pendingDelete ? operations[pendingDelete.id] : undefined;
  const deleting = deleteOperation?.action === 'remove' && deleteOperation.phase === 'writing';

  const headerTally = projectListTally(channels, listRead(channels, { loading, failed: error !== null }));
  const connectedCount = useMemo(() => channels.filter(isConnected).length, [channels]);
  const verifiedCount = useMemo(
    () => channels.filter((channel) => verifiedChannels.has(channel.id)).length,
    [channels, verifiedChannels],
  );

  return (
    <Page wide>
      <ConfirmModal
        open={pendingDelete !== null}
        message={`Remove channel "${pendingDelete?.name}"?`}
        confirmLabel={deleting ? 'Removing…' : 'Remove'}
        detail={
          deleting
            ? 'Saving removal. Repeated confirmation will not submit another write.'
            : channelLocked(deleteOperation)
              ? 'Another change is pending. Removal is unavailable until reconciliation.'
              : undefined
        }
        danger
        onConfirm={confirmDelete}
        onCancel={() => {
          if (!deleting) setPendingDelete(null);
        }}
      />

      <PageHeader
        eyebrow="Connect"
        title="Channels"
        description="Delivery channels that carry Agent output to Discord. A channel is only marked connected after a real check message is delivered."
        actions={
          <>
            <Button variant="ghost" icon={<RefreshCw />} onClick={retryRead} disabled={loading} aria-label="Refresh channels">
              Refresh
            </Button>
            <Button
              variant={adding ? 'secondary' : 'primary'}
              icon={adding ? <X aria-hidden="true" /> : <Plus aria-hidden="true" />}
              onClick={() => changeAdding(!adding)}
              disabled={saving}
            >
              {adding ? 'Close' : 'New channel'}
            </Button>
          </>
        }
      />

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-4">
          {adding && <AddChannelForm onCreate={create} onCancel={() => changeAdding(false)} saving={saving} createError={createError} />}

          <Panel flush>
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
              <h2 className="text-[13px] font-semibold text-ink">Configured channels</h2>
              <span className="font-mono text-[11px] tabular text-ink-3">{headerTally.count ?? '—'}</span>
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                {headerTally.count !== null && <Badge tone={connectedCount > 0 ? 'ok' : 'muted'}>{connectedCount} stored login flags</Badge>}
                {headerTally.count !== null && <Badge tone={verifiedCount > 0 ? 'ok' : 'muted'}>{verifiedCount} delivery verified</Badge>}
              </div>
            </div>

            {(error || (loaded && loading)) && (
              <div className="space-y-2 px-4 pt-3">
                {error && (
                  <AlertLine onRetry={retryRead} retryDisabled={loading}>
                    <span>{error}</span> {loaded && 'Previously loaded channels may be stale.'}
                  </AlertLine>
                )}
                {loaded && loading && <StatusLine>Refreshing channels…</StatusLine>}
              </div>
            )}

            {!loaded && loading ? (
              <div className="space-y-3 px-4 py-5">
                <StatusLine>Loading channels…</StatusLine>
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : !loaded ? null : channels.length === 0 ? (
              !error &&
              !loading && (
                <EmptyState
                  icon={<Hash />}
                  title="No channels yet. Add one to get started."
                  description="A channel binds Jarvis to a Discord channel ID. Bind it to an Agent from the Agents page."
                />
              )
            ) : (
              <RowList>
                {channels.map((c) => {
                  const connected = isConnected(c);
                  const configured = isConfiguredChannel(c);
                  const supported = c.type === 'discord';
                  const verified = verifiedChannels.has(c.id);
                  const operation = operations[c.id];
                  const locked = channelLocked(operation);
                  const liveness = projectChannelLiveness(c, { verified, probe: channelProbePhase(operation) });
                  return (
                    <li key={c.id} aria-label={liveness.announcement} className="px-4 py-3">
                      <div className="flex items-start gap-3">
                        <span
                          aria-hidden="true"
                          className={cn(
                            'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[7px] border',
                            liveness.confirmed ? 'border-ok/30 bg-ok-wash text-ok' : 'border-line-strong bg-sunken text-ink-3',
                          )}
                        >
                          <Hash className="size-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <h3 className="truncate text-[13.5px] font-medium text-ink">{c.name}</h3>
                            <Badge tone="neutral">{c.type}</Badge>
                            {configured && <Badge tone="muted">configured</Badge>}
                            <Badge tone={liveness.confirmed ? 'ok' : 'warn'} dot>{liveness.claimLabel}{liveness.stale ? ' (stale)' : ''}</Badge>
                            {verified && <Badge tone="ok">delivery verified</Badge>}
                            {!supported && <Badge tone="warn">unsupported adapter</Badge>}
                            {supported && !configured && <Badge tone="warn">needs channel ID</Badge>}
                          </div>
                          <p className="mt-1 text-xs text-ink-3">{liveness.basis}</p>
                          <p className="mt-1 font-mono text-[11px] text-ink-3">
                            {channelId(c) ? `#${channelId(c)}` : 'no destination'}
                            <span className="mx-1.5 text-ink-4">·</span>
                            last used {c.last_used ? formatIsoAge(c.last_used) : 'never'}
                            <span className="mx-1.5 text-ink-4">·</span>
                            added {formatIsoAge(c.created_at)}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {connected && (
                            <Button size="xs" variant="secondary" icon={<Unplug />} onClick={() => toggleConnection(c)} disabled={locked}>
                              Disconnect
                            </Button>
                          )}
                          {!connected && canVerifyChannel(c) && (
                            <Button size="xs" variant="secondary" icon={<Plug />} onClick={() => toggleConnection(c)} disabled={locked}>
                              {operation?.phase === 'writing' ? 'Verifying…' : 'Verify & connect'}
                            </Button>
                          )}
                          <IconButton variant="danger" size="xs" aria-label="Remove" title="Remove channel" onClick={() => remove(c)} disabled={locked}>
                            <Trash2 />
                          </IconButton>
                        </div>
                      </div>
                      {operation && (
                        <div className="mt-2 pl-11">
                          {operation.phase === 'writing' && (
                            <StatusLine>{operation.action === 'connect' ? 'Verifying delivery…' : 'Saving channel change…'}</StatusLine>
                          )}
                          {operation.phase === 'reconciling' && <StatusLine>Change saved. Reconciling channels…</StatusLine>}
                          {operation.phase === 'verification-failed' && (
                            <AlertLine onRetry={() => void mutate(c, operation.action)}>
                              Delivery could not be verified. The channel was not connected.
                            </AlertLine>
                          )}
                          {operation.phase === 'write-failed' && (
                            <AlertLine onRetry={() => (operation.action === 'remove' ? remove(c) : void mutate(c, operation.action))}>
                              Could not {operation.action} channel. Confirmed state was kept.
                            </AlertLine>
                          )}
                          {operation.phase === 'read-failed' && (
                            <AlertLine onRetry={retryRead} retryDisabled={loading}>
                              Change was saved, but the channel list could not be reconciled. Showing previous state. Retry reloads the list only.
                            </AlertLine>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </RowList>
            )}
            <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5">
              <p className="text-[11.5px] text-ink-3">Which Agent speaks through a channel is set per Agent.</p>
              <Button size="xs" variant="quiet" trailing={<ArrowUpRight />} onClick={() => navigate('agents')}>
                Agent bindings
              </Button>
            </div>
          </Panel>
        </div>

        <Panel flush ticks className="min-w-0">
          <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-4">
            <div className="min-w-0">
              <h2 className="text-[13px] font-semibold text-ink">Discord delivery telemetry</h2>
              <p className="mt-0.5 text-[12px] leading-snug text-ink-3">Reported by the Bun server&apos;s Discord adapter.</p>
            </div>
            <Button size="xs" variant="secondary" onClick={fetchReceipts} disabled={receiptState.phase === 'loading'}>
              {receiptState.phase === 'failed' ? 'Retry delivery telemetry' : 'Refresh delivery telemetry'}
            </Button>
          </div>
          {(receiptState.phase !== 'ready' || receiptState.receipts?.length === 0) && (
            <div className="space-y-2 px-4 pb-4 text-[12px] text-ink-3">
              {receiptState.phase === 'loading' && (
                <StatusLine>
                  Loading delivery telemetry…{receiptState.receipts !== null && ' Previously loaded telemetry may be stale.'}
                </StatusLine>
              )}
              {receiptState.phase === 'failed' && (
                <AlertLine tone="warn">
                  {receiptState.receipts !== null
                    ? 'Delivery telemetry is stale. Showing previously loaded receipts.'
                    : `Delivery telemetry is unavailable. ${RECEIPT_FAILURE_COPY[receiptState.reason ?? 'bun_unreachable']}`}
                  {' This is a telemetry-read state, not a delivery verdict: it says nothing about what was delivered, and native channel rows are unaffected.'}
                </AlertLine>
              )}
              {receiptState.phase === 'ready' && receiptState.receipts?.length === 0 && <p>No delivery receipts yet.</p>}
            </div>
          )}
          {receiptState.receipts !== null && receiptState.receipts.length > 0 && (
            <ReceiptTimeline receipts={receiptState.receipts} stale={receiptState.phase !== 'ready'} />
          )}
        </Panel>
      </div>
    </Page>
  );
}
