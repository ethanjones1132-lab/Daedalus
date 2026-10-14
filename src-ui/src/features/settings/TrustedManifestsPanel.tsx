import { useState, useRef, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { GlassCard, Pill, EmptyState, cn } from '../workflows/primitives';
interface TrustedManifestRecord {
  manifest_id: string;
  registry_version: number;
  schema_version: number;
  content_hash: string;
  content: unknown;
  agent_id: string;
  project_root: string;
  action_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ActiveActionRow {
  id: string;
  status: string;
}

interface TrustedManifestAgentRow {
  id: string;
  name: string;
  enabled: boolean;
}

const TRUSTED_MANIFEST_EXAMPLE = `{
  "schema_version": 1,
  "execution": [
    { "tool": "write_file", "arguments": { "path": "notes/result.md", "content": "Hello from Jarvis\\n" } }
  ],
  "acceptance": {
    "<goal-criterion-uuid>": [
      { "tool": "read_file", "arguments": { "path": "notes/result.md" }, "expect_sha256": "<64-char-lowercase-sha256>" }
    ]
  }
}`;

// ── Trusted manifest operations (native-persisted execution receipts) ──
//
// A fresh "Run manifest" click generates exactly one operation UUID, freezes the
// exact dispatch tuple locally, and never derives a dispatch from Goal/model or
// action-description text. "Retry / reconcile" reuses that exact frozen tuple;
// it never mints a replacement id. Every outcome shown comes from an exact
// native `get_trusted_execution` readback validated against the frozen tuple.

interface TrustedExecutionReceipt {
  execution_id: string;
  action_id: string;
  manifest_id: string;
  manifest_registry_version: number;
  manifest_content_hash: string;
  status: string;
  terminal_reason: string | null;
  cancel_requested_at: string | null;
  run_id: string | null;
  bun_run_id: string | null;
  runtime_started_at: string | null;
  runtime_finished_at: string | null;
  evidence: unknown;
}

interface FrozenOperation {
  operationId: string;
  actionId: string;
  manifestId: string;
  expectedManifestVersion: number;
  expectedManifestHash: string;
}

const UNRESOLVED_OPERATION_STATUSES = ['claimed', 'dispatched', 'ambiguous', 'pending_acceptance'];
const CANCELLABLE_OPERATION_STATUSES = ['claimed', 'dispatched'];
const KNOWN_EXECUTION_STATUSES = new Set([
  'claimed',
  'dispatched',
  'pending_acceptance',
  'waiting_for_user',
  'blocked',
  'failed',
  'cancelled',
  'partial',
  'ambiguous',
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64_PATTERN.test(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function operationStorageKey(actionId: string): string {
  return `jarvis.trusted.operation.${actionId}`;
}

/** Persist the exact frozen tuple locally. Returns false when it could not be
 *  stored, so a fresh dispatch can refuse to run without a durable local tuple. */
function storeOperation(op: FrozenOperation): boolean {
  try {
    localStorage.setItem(operationStorageKey(op.actionId), JSON.stringify(op));
    return true;
  } catch {
    return false;
  }
}

function readStoredOperation(actionId: string): FrozenOperation | null {
  try {
    const raw = localStorage.getItem(operationStorageKey(actionId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Record<string, unknown>;
    const operationId = value.operationId;
    const a = value.actionId;
    const manifestId = value.manifestId;
    const version = value.expectedManifestVersion;
    const hash = value.expectedManifestHash;
    if (!isUuid(operationId)) return null;
    if (typeof a !== 'string' || a !== actionId) return null;
    if (typeof manifestId !== 'string' || manifestId.length === 0) return null;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;
    if (!isHex64(hash)) return null;
    return {
      operationId,
      actionId: a,
      manifestId,
      expectedManifestVersion: version,
      expectedManifestHash: hash,
    };
  } catch {
    return null;
  }
}

function newOperationId(): string {
  const cryptoObj = (
    globalThis as {
      crypto?: {
        randomUUID?: () => string;
        getRandomValues?: (array: Uint8Array) => Uint8Array;
      };
    }
  ).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return '';
}

function isTrustedExecutionReceipt(value: unknown): value is TrustedExecutionReceipt {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    isUuid(row.execution_id) &&
    typeof row.action_id === 'string' &&
    row.action_id.length > 0 &&
    typeof row.manifest_id === 'string' &&
    row.manifest_id.length > 0 &&
    typeof row.manifest_registry_version === 'number' &&
    Number.isInteger(row.manifest_registry_version) &&
    row.manifest_registry_version >= 1 &&
    isHex64(row.manifest_content_hash) &&
    typeof row.status === 'string' &&
    KNOWN_EXECUTION_STATUSES.has(row.status) &&
    isNullableString(row.terminal_reason) &&
    isNullableString(row.cancel_requested_at) &&
    isNullableString(row.run_id) &&
    isNullableString(row.bun_run_id) &&
    isNullableString(row.runtime_started_at) &&
    isNullableString(row.runtime_finished_at)
  );
}

function reconstructFrozen(receipt: TrustedExecutionReceipt): FrozenOperation {
  return {
    operationId: receipt.execution_id,
    actionId: receipt.action_id,
    manifestId: receipt.manifest_id,
    expectedManifestVersion: receipt.manifest_registry_version,
    expectedManifestHash: receipt.manifest_content_hash,
  };
}

function receiptMatchesFrozen(receipt: TrustedExecutionReceipt, op: FrozenOperation): boolean {
  return (
    receipt.execution_id === op.operationId &&
    receipt.action_id === op.actionId &&
    receipt.manifest_id === op.manifestId &&
    receipt.manifest_registry_version === op.expectedManifestVersion &&
    receipt.manifest_content_hash === op.expectedManifestHash
  );
}

function operationStatusVariant(
  status: string,
): 'success' | 'warn' | 'error' | 'info' | 'default' {
  if (status === 'blocked' || status === 'failed') return 'error';
  if (
    status === 'ambiguous' ||
    status === 'waiting_for_user' ||
    status === 'partial' ||
    status === 'pending_acceptance'
  ) {
    return 'warn';
  }
  if (status === 'claimed' || status === 'dispatched') return 'info';
  if (status === 'completed') return 'success';
  return 'default';
}

/** Bounded, metadata-only evidence summary. Raw tool output is never rendered. */
function evidenceSummary(evidence: unknown): string | null {
  if (!Array.isArray(evidence) || evidence.length === 0) return null;
  const parts = evidence.slice(0, 5).map((item) => {
    const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const tool = typeof row.tool === 'string' ? row.tool : '?';
    const status = typeof row.status === 'string' ? row.status : '?';
    const hash = typeof row.output_sha256 === 'string' ? row.output_sha256.slice(0, 8) : '';
    const bytes = typeof row.output_bytes === 'number' ? `${row.output_bytes}B` : '';
    const suffix = [hash ? `${hash}…` : '', bytes].filter((v) => v.length > 0).join(' ');
    return `${tool}:${status}${suffix ? ` (${suffix})` : ''}`;
  });
  return `${evidence.length} call(s): ${parts.join(', ')}`;
}

function TrustedManifestOperations({ record }: { record: TrustedManifestRecord }) {
  const actionId = record.action_id ?? '';
  const [history, setHistory] = useState<TrustedExecutionReceipt[] | null>(null);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<FrozenOperation | null>(null);
  const [receipt, setReceipt] = useState<TrustedExecutionReceipt | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  const fetchHistory = useCallback(async (): Promise<TrustedExecutionReceipt[]> => {
    const raw = await invoke<unknown>('list_trusted_executions', { actionId });
    if (!Array.isArray(raw)) throw new Error('unreadable');
    const receipts: TrustedExecutionReceipt[] = [];
    for (const row of raw) {
      if (!isTrustedExecutionReceipt(row) || row.action_id !== actionId) {
        throw new Error('malformed');
      }
      receipts.push(row);
    }
    return receipts;
  }, [actionId]);

  const loadHistory = useCallback(async (): Promise<boolean> => {
    try {
      const receipts = await fetchHistory();
      setHistory(receipts);
      setHistoryUnavailable(false);
      setHistoryError(null);
      return true;
    } catch {
      setHistoryUnavailable(true);
      setHistoryError('Could not read native operation history; new operations are disabled.');
      return false;
    }
  }, [fetchHistory]);

  useEffect(() => {
    setFrozen(readStoredOperation(actionId));
    setReceipt(null);
    setReadError(null);
    setMessage(null);
    void loadHistory();
  }, [actionId, record.manifest_id, record.registry_version, loadHistory]);

  const latestUnresolved =
    history?.find((row) => UNRESOLVED_OPERATION_STATUSES.includes(row.status)) ?? null;
  const displayReceipt = receipt ?? history?.[0] ?? null;
  const cancellable =
    displayReceipt !== null && CANCELLABLE_OPERATION_STATUSES.includes(displayReceipt.status);
  // Retry is available whenever native history holds an unresolved receipt, even
  // without a local frozen tuple (it reconstructs from the native receipt), or
  // when a frozen operation's exact readback failed.
  const canRetry =
    latestUnresolved !== null || (frozen !== null && readError !== null);

  const readback = useCallback(
    async (op: FrozenOperation): Promise<void> => {
      try {
        const raw = await invoke<unknown>('get_trusted_execution', {
          executionId: op.operationId,
        });
        if (!isTrustedExecutionReceipt(raw) || !receiptMatchesFrozen(raw, op)) {
          throw new Error('identity');
        }
        setReceipt(raw);
        setReadError(null);
        setMessage(null);
        await loadHistory();
      } catch {
        setReadError(
          'The operation receipt could not be read back from native. The frozen operation is kept for retry; no outcome is claimed.',
        );
      }
    },
    [loadHistory],
  );

  const dispatch = useCallback(
    async (op: FrozenOperation): Promise<void> => {
      setMessage(null);
      try {
        await invoke('execute_trusted_manifest_action', {
          actionId: op.actionId,
          manifestId: op.manifestId,
          operationId: op.operationId,
          expectedManifestVersion: op.expectedManifestVersion,
          expectedManifestHash: op.expectedManifestHash,
        });
      } catch (e) {
        setMessage(
          `Dispatch returned an error (${typeof e === 'string' ? e : 'unknown'}). Reading back the exact receipt…`,
        );
      }
      await readback(op);
    },
    [readback],
  );

  const runNew = useCallback(async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      let receipts: TrustedExecutionReceipt[];
      try {
        receipts = await fetchHistory();
      } catch {
        setHistoryUnavailable(true);
        setHistoryError('Could not read native operation history; new operations are disabled.');
        setMessage('Cannot read native operation history; a new operation is disabled.');
        return;
      }
      setHistory(receipts);
      setHistoryUnavailable(false);
      setHistoryError(null);
      const unresolved = receipts.find((row) =>
        UNRESOLVED_OPERATION_STATUSES.includes(row.status),
      );
      if (unresolved) {
        // Never keep a stale local tuple over the currently unresolved native
        // operation: align to the exact native tuple and direct reconciliation.
        const op =
          frozen && receiptMatchesFrozen(unresolved, frozen)
            ? frozen
            : reconstructFrozen(unresolved);
        storeOperation(op);
        setFrozen(op);
        setMessage(
          `An unresolved operation (${unresolved.status}) already exists for this action. Use “Retry / reconcile this operation”.`,
        );
        return;
      }
      const operationId = newOperationId();
      if (!operationId) {
        setMessage('This environment cannot generate an operation id; no operation was started.');
        return;
      }
      // Freeze the exact tuple locally BEFORE invoking native; refuse to invoke
      // if the durable local tuple could not be persisted.
      const op: FrozenOperation = {
        operationId,
        actionId,
        manifestId: record.manifest_id,
        expectedManifestVersion: record.registry_version,
        expectedManifestHash: record.content_hash,
      };
      if (!storeOperation(op)) {
        setMessage(
          'The exact operation tuple could not be persisted locally, so no operation was started.',
        );
        return;
      }
      setFrozen(op);
      await dispatch(op);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [actionId, record.manifest_id, record.registry_version, frozen, fetchHistory, dispatch]);

  const retry = useCallback(async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      let target: TrustedExecutionReceipt | null = null;
      try {
        const receipts = await fetchHistory();
        setHistory(receipts);
        setHistoryUnavailable(false);
        setHistoryError(null);
        target =
          receipts.find((row) => UNRESOLVED_OPERATION_STATUSES.includes(row.status)) ?? null;
      } catch {
        setHistoryUnavailable(true);
        setHistoryError('Could not read native operation history; retry is unavailable.');
      }
      let op: FrozenOperation | null;
      if (target) {
        // Always prefer the exact current native target over a stale local tuple.
        op =
          frozen && receiptMatchesFrozen(target, frozen) ? frozen : reconstructFrozen(target);
        storeOperation(op);
        setFrozen(op);
      } else {
        op = frozen;
      }
      if (!op) {
        setMessage('No local operation tuple and no unresolved native operation to reconcile.');
        return;
      }
      await dispatch(op);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [frozen, fetchHistory, dispatch]);

  const cancelOperation = useCallback(async (): Promise<void> => {
    if (pending.current) return;
    // Prefer the exact displayed native cancellable receipt over a stale local
    // tuple; if they differ, use the native receipt's exact identity.
    let op: FrozenOperation | null;
    if (displayReceipt && CANCELLABLE_OPERATION_STATUSES.includes(displayReceipt.status)) {
      op =
        frozen && receiptMatchesFrozen(displayReceipt, frozen)
          ? frozen
          : reconstructFrozen(displayReceipt);
    } else {
      op = frozen;
    }
    if (!op) {
      setMessage('No operation identity is available to cancel.');
      return;
    }
    if (
      !confirm(
        'Cancel this exact operation? Native will abort the in-flight run and return durable cancellation state.',
      )
    ) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      try {
        await invoke('cancel_trusted_execution', { executionId: op.operationId });
      } catch (e) {
        setMessage(
          `Cancel request failed (${typeof e === 'string' ? e : 'unknown'}). No terminal state is claimed.`,
        );
      }
      await readback(op);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [frozen, displayReceipt, readback]);

  return (
    <div className="mt-2 rounded-md border border-line/30 p-2 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[10px] font-mono uppercase tracking-wider text-ink/40">Operations</span>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => void runNew()}
            disabled={busy || historyUnavailable || latestUnresolved !== null}
            className="px-2 py-0.5 text-[10px] font-mono rounded border border-accent/40 text-accent-hot hover:bg-accent/10 disabled:opacity-50 transition-colors"
          >
            {busy ? 'Working…' : 'Run manifest'}
          </button>
          {canRetry && (
            <button
              type="button"
              onClick={() => void retry()}
              disabled={busy}
              className="px-2 py-0.5 text-[10px] font-mono rounded border border-accent/40 text-accent-hot hover:bg-accent/10 disabled:opacity-50 transition-colors"
            >
              Retry / reconcile this operation
            </button>
          )}
          {cancellable && (
            <button
              type="button"
              onClick={() => void cancelOperation()}
              disabled={busy}
              className="px-2 py-0.5 text-[10px] font-mono rounded border border-err/40 text-err hover:bg-err/10 disabled:opacity-50 transition-colors"
            >
              Cancel operation
            </button>
          )}
        </div>
      </div>

      {historyUnavailable && (
        <div role="alert" className="text-[11px] text-red-200">
          {historyError ?? 'Native operation history is unavailable.'}
        </div>
      )}
      {readError && (
        <div role="alert" className="text-[11px] text-red-200">
          {readError}
        </div>
      )}
      {message && (
        <div role="status" className="text-[11px] text-ink/50">
          {message}
        </div>
      )}

      {displayReceipt && (
        <div className="text-[11px] font-mono text-ink/70">
          <div className="flex items-center gap-2 flex-wrap">
            <Pill variant={operationStatusVariant(displayReceipt.status)}>
              {displayReceipt.status}
            </Pill>
            <span className="break-all">op {displayReceipt.execution_id}</span>
          </div>
          {displayReceipt.terminal_reason && (
            <div className="text-ink/50">reason: {displayReceipt.terminal_reason}</div>
          )}
          <div className="text-ink/40">
            runtime {displayReceipt.runtime_started_at ?? '—'} → {displayReceipt.runtime_finished_at ?? '—'}
            {displayReceipt.cancel_requested_at
              ? ` · cancel requested ${displayReceipt.cancel_requested_at}`
              : ''}
          </div>
        </div>
      )}

      {history && history.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-mono uppercase tracking-wider text-ink/40">History</div>
          {history.slice(0, 8).map((row) => (
            <div key={row.execution_id} className="text-[11px] font-mono text-ink/70">
              <div className="flex items-center gap-2 flex-wrap">
                <Pill variant={operationStatusVariant(row.status)}>{row.status}</Pill>
                <span className="break-all">op {row.execution_id}</span>
              </div>
              {row.terminal_reason && (
                <div className="text-ink/50">reason: {row.terminal_reason}</div>
              )}
              <div className="text-ink/40">
                runtime {row.runtime_started_at ?? '—'} → {row.runtime_finished_at ?? '—'}
                {row.cancel_requested_at ? ` · cancel requested ${row.cancel_requested_at}` : ''}
              </div>
              {evidenceSummary(row.evidence) && (
                <div className="text-ink/40">evidence: {evidenceSummary(row.evidence)}</div>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="text-[10px] font-mono text-ink-4">
        pending_acceptance is not completion: this panel never runs acceptance or completes a Goal. A
        successful tool run alone is not acceptance.
      </p>
    </div>
  );
}

export default function TrustedManifestsPanel() {
  const [manifests, setManifests] = useState<TrustedManifestRecord[]>([]);
  const [agents, setAgents] = useState<TrustedManifestAgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);
  const pending = useRef(false);

  const [contentJson, setContentJson] = useState('');
  const [agentId, setAgentId] = useState('');
  const [projectRoot, setProjectRoot] = useState('');
  const [actionId, setActionId] = useState('');
  const [activeActions, setActiveActions] = useState<ActiveActionRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expectedVersion, setExpectedVersion] = useState('');

  // Authoritative readback. Returns true only when the registry list was read;
  // a failure keeps the previously displayed list and marks it unavailable so
  // the UI never updates optimistically or claims success without evidence.
  const load = useCallback(async (): Promise<boolean> => {
    const request = ++requestId.current;
    setLoading(true);
    try {
      const rows = await invoke<unknown>('list_trusted_acceptance_manifests');
      if (request !== requestId.current) return false;
      if (!Array.isArray(rows)) {
        setUnavailable(true);
        setReadError('The native trusted-manifest registry returned an unreadable response. Showing nothing as trusted.');
        return false;
      }
      setManifests(rows as TrustedManifestRecord[]);
      setUnavailable(false);
      setReadError(null);
      return true;
    } catch {
      if (request !== requestId.current) return false;
      setUnavailable(true);
      setReadError('Could not read the native trusted-manifest registry. No trust is inferred from this failure.');
      return false;
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, []);

  const loadAgents = useCallback(async () => {
    try {
      const rows = await invoke<unknown>('list_agents');
      if (Array.isArray(rows)) {
        const enabled = (rows as TrustedManifestAgentRow[]).filter((a) => a?.enabled);
        setAgents(enabled);
        setAgentId((current) => current || enabled[0]?.id || '');
      }
    } catch {
      // The Agent picker is a convenience; native still validates the id.
    }
  }, []);

  // Active Action Registry ids are a convenience suggestion list; native still
  // resolves and verifies the exact id, status, and approval before binding.
  const loadActiveActions = useCallback(async () => {
    try {
      const bucket = await invoke<unknown>('get_action_registry_bucket', { bucket: 'active' });
      const actions = (bucket as { actions?: unknown } | null)?.actions;
      if (Array.isArray(actions)) {
        setActiveActions(
          (actions as ActiveActionRow[]).filter(
            (a) => a && (a.status === 'open' || a.status === 'in_progress'),
          ),
        );
      }
    } catch {
      // Suggestion-only; binding still fails closed natively.
    }
  }, []);

  useEffect(() => {
    void load();
    void loadAgents();
    void loadActiveActions();
  }, [load, loadAgents, loadActiveActions]);

  const runAction = useCallback(
    async (label: string, run: () => Promise<unknown>) => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      setActionError(null);
      try {
        await run();
      } catch (e) {
        setActionError(typeof e === 'string' ? e : `${label} failed.`);
        pending.current = false;
        setBusy(false);
        return;
      }
      const confirmed = await load();
      if (!confirmed) {
        setActionError(`${label} was submitted, but the registry could not be re-read. Showing the previous list; it may be stale.`);
      }
      pending.current = false;
      setBusy(false);
    },
    [load],
  );

  const handleCreate = () => {
    if (!contentJson.trim() || !agentId.trim() || !projectRoot.trim() || !actionId.trim()) {
      setActionError(
        'Manifest content, an enabled Agent, an existing workspace root, and an exact Action Registry id are required.',
      );
      return;
    }
    void runAction('Add manifest', () =>
      invoke('create_trusted_acceptance_manifest', {
        contentJson,
        agentId: agentId.trim(),
        projectRoot: projectRoot.trim(),
        actionId: actionId.trim(),
      }),
    );
  };

  const handleSelectForReplace = (record: TrustedManifestRecord) => {
    setSelectedId(record.manifest_id);
    setExpectedVersion(String(record.registry_version));
    setAgentId(record.agent_id);
    setProjectRoot(record.project_root);
    setActionId(record.action_id ?? '');
    setContentJson(JSON.stringify(record.content, null, 2));
    setActionError(null);
  };

  const handleReplace = () => {
    if (!selectedId) {
      setActionError('Select a registered manifest to replace.');
      return;
    }
    const version = Number(expectedVersion);
    if (!Number.isInteger(version) || version < 1) {
      setActionError('Enter the current registry version you are replacing.');
      return;
    }
    if (!contentJson.trim() || !agentId.trim() || !projectRoot.trim() || !actionId.trim()) {
      setActionError(
        'Manifest content, an enabled Agent, an existing workspace root, and an exact Action Registry id are required.',
      );
      return;
    }
    void runAction('Replace manifest', () =>
      invoke('replace_trusted_acceptance_manifest', {
        manifestId: selectedId,
        expectedVersion: version,
        contentJson,
        agentId: agentId.trim(),
        projectRoot: projectRoot.trim(),
        actionId: actionId.trim(),
      }),
    );
  };

  const handleRemove = (record: TrustedManifestRecord) => {
    void runAction('Remove manifest', () =>
      invoke('remove_trusted_acceptance_manifest', {
        manifestId: record.manifest_id,
        expectedVersion: record.registry_version,
      }),
    );
  };

  const inputCls =
    'w-full px-3 py-2 text-xs font-mono bg-sunken/60 border border-line/40 rounded-lg text-ink placeholder:text-ink-4 focus:outline-none focus:border-accent/50 transition-colors';

  return (
    <GlassCard hoverable={false}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Trusted acceptance manifests</h3>
          <p className="text-[10px] font-mono text-ink-4 mt-0.5">
            Native registry in the app-owned jarvis.db. Each manifest binds exactly one Action Registry
            id and the manifest content comes only from the JSON you enter here. Action Registry files,
            model output, and Goal or task text cannot create or edit manifest content. Registering here
            grants no tool permission and runs nothing.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || busy}
          className="px-3 py-1.5 text-[10px] font-mono rounded-lg border border-line/40 text-ink-3 hover:text-ink hover:border-line/60 disabled:opacity-50 transition-colors shrink-0"
        >
          {loading ? 'Loading…' : 'Reload'}
        </button>
      </div>

      {readError && (
        <div role="alert" className="mb-3 text-[11px] font-mono text-err">
          {readError}
        </div>
      )}
      {unavailable && manifests.length > 0 && (
        <div role="alert" className="mb-3 text-[11px] font-mono text-amber-300">
          Showing previously loaded manifests; they may be stale.
        </div>
      )}
      {actionError && (
        <div role="alert" className="mb-3 text-[11px] font-mono text-err">
          {actionError}
        </div>
      )}

      {manifests.length === 0 && !unavailable ? (
        <EmptyState message="No trusted acceptance manifests are registered. Nothing is trusted until you explicitly add one." />
      ) : manifests.length > 0 ? (
        <ul className="space-y-2 mb-4">
          {manifests.map((record) => (
            <li
              key={record.manifest_id}
              className={cn(
                'rounded-lg border p-3',
                record.manifest_id === selectedId ? 'border-accent/50 bg-accent/5' : 'border-line/30',
              )}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono text-ink-3">
                <span>registry v{record.registry_version}</span>
                <span>schema v{record.schema_version}</span>
              </div>
              <div className="mt-1 text-[10px] font-mono text-ink break-all">
                id {record.manifest_id}
              </div>
              <div className="mt-1 text-[10px] font-mono text-ink-3 break-all">
                content-sha256 {record.content_hash}
              </div>
              <div className="mt-1 text-[10px] font-mono break-all">
                {record.action_id ? (
                  <span className="text-ink">action {record.action_id}</span>
                ) : (
                  <span className="text-amber-300">action unbound (legacy) — replace to bind</span>
                )}
              </div>
              <div className="mt-1 text-[10px] font-mono text-ink-4 break-all">
                agent {record.agent_id} · root {record.project_root}
              </div>
              <div className="mt-1 text-[10px] font-mono text-ink-4">
                updated {record.updated_at}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleSelectForReplace(record)}
                  disabled={busy}
                  className="px-2 py-0.5 text-[10px] font-mono rounded border border-accent/40 text-accent-hot hover:bg-accent/10 disabled:opacity-50 transition-colors"
                >
                  Use for replace
                </button>
                <button
                  type="button"
                  onClick={() => handleRemove(record)}
                  disabled={busy}
                  className="px-2 py-0.5 text-[10px] font-mono rounded border border-err/40 text-err hover:bg-err/10 disabled:opacity-50 transition-colors"
                >
                  Remove
                </button>
              </div>
              {record.action_id && (
                <TrustedManifestOperations
                  key={`${record.manifest_id}:${record.registry_version}`}
                  record={record}
                />
              )}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="space-y-2 border-t border-line/20 pt-3">
        <p className="text-[10px] font-mono text-ink-4">
          {selectedId ? 'Editing a replace for the selected manifest.' : 'Adding a new manifest.'}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] font-mono text-ink-3 block mb-1">Enabled Agent</label>
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              disabled={busy}
              className={inputCls}
            >
              <option value="">Select an enabled Agent…</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} ({agent.id})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-mono text-ink-3 block mb-1">Existing workspace root</label>
            <input
              type="text"
              value={projectRoot}
              onChange={(e) => setProjectRoot(e.target.value)}
              disabled={busy}
              placeholder="/absolute/path/to/project"
              className={inputCls}
            />
          </div>
        </div>
        <div>
          <label className="text-[10px] font-mono text-ink-3 block mb-1">
            Action Registry action id (exact; required)
          </label>
          <input
            type="text"
            list="trusted-manifest-action-ids"
            value={actionId}
            onChange={(e) => setActionId(e.target.value)}
            disabled={busy}
            placeholder="exact id from the active Action Registry bucket"
            className={inputCls}
          />
          <datalist id="trusted-manifest-action-ids">
            {activeActions.map((action) => (
              <option key={action.id} value={action.id} />
            ))}
          </datalist>
          <p className="text-[10px] font-mono text-ink-4 mt-1">
            Native resolves this id to exactly one active open/in_progress action with its existing
            approval condition satisfied, or rejects the binding. Only the id is identity — action
            title/description/Goal/model text is never trusted.
          </p>
        </div>
        {selectedId && (
          <div>
            <label className="text-[10px] font-mono text-ink-3 block mb-1">
              Expected current registry version
            </label>
            <input
              type="number"
              min={1}
              value={expectedVersion}
              onChange={(e) => setExpectedVersion(e.target.value)}
              disabled={busy}
              className={cn(inputCls, 'w-32')}
            />
          </div>
        )}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] font-mono text-ink-3">v1 manifest content (strict JSON)</label>
            <button
              type="button"
              onClick={() => setContentJson(TRUSTED_MANIFEST_EXAMPLE)}
              disabled={busy}
              className="text-[10px] font-mono text-ink-4 hover:text-ink-3 disabled:opacity-50"
            >
              Load example shape
            </button>
          </div>
          <textarea
            value={contentJson}
            onChange={(e) => setContentJson(e.target.value)}
            disabled={busy}
            rows={10}
            spellCheck={false}
            placeholder={TRUSTED_MANIFEST_EXAMPLE}
            className={cn(inputCls, 'resize-y')}
          />
          <p className="text-[10px] font-mono text-ink-4 mt-1">
            Execution calls may use read tools plus the bounded writers write_file/edit_file (bounded
            UTF-8 payloads, workspace-relative paths). Acceptance checks stay read-only. Unknown keys,
            shell tools/commands, apply_patch/multi_edit, web tools, scripts, templates, and unbounded
            values are rejected by native validation. Later execution still runs through the canonical
            ToolRuntime under current Agent/Permission policy; if policy denies or requires approval it
            becomes a blocked/waiting state and is never bypassed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCreate}
            disabled={busy}
            className="px-3 py-1.5 text-[10px] font-mono rounded-lg border border-accent/40 text-accent-hot hover:bg-accent/10 disabled:opacity-50 transition-colors"
          >
            {busy ? 'Submitting…' : 'Add manifest'}
          </button>
          <button
            type="button"
            onClick={handleReplace}
            disabled={busy || !selectedId}
            className="px-3 py-1.5 text-[10px] font-mono rounded-lg border border-accent/40 text-accent-hot hover:bg-accent/10 disabled:opacity-50 transition-colors"
          >
            Replace selected
          </button>
          {selectedId && (
            <button
              type="button"
              onClick={() => {
                setSelectedId(null);
                setExpectedVersion('');
              }}
              disabled={busy}
              className="text-[10px] font-mono text-ink-4 hover:text-ink-3 disabled:opacity-50"
            >
              Clear selection
            </button>
          )}
        </div>
      </div>
    </GlassCard>
  );
}

// ═══════════════════════════════════════════════════════════════
// ── Config Panel ──
// ═══════════════════════════════════════════════════════════════

