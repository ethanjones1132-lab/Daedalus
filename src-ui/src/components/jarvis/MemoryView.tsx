// ═══════════════════════════════════════════════════════════════
// ── MemoryView — Scoped operator inspection and controls ────────
// ═══════════════════════════════════════════════════════════════
//
// Phase 4.1. When the view opens without an active Session the operator must
// explicitly choose an existing native Session before any scoped list/preview/
// mutation. Every mutation is confirmed only from a decoded native receipt,
// never assistant text. Legacy recovery is a separate, deliberate mode.

import { useState, useEffect, useCallback, useId, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ConfirmModal, GlassCard, LoadingState, ErrorState, EmptyState, SectionHeader } from '../ui';
import {
  getMemoryTier,
  type Tier,
} from './memory-recall-state';
import MemoryScopeControls, { type MemorySessionOption } from './MemoryScopeControls';
import {
  IDLE_MUTATION_STATE,
  decodeCorrectionResult,
  decodeForgetResult,
  decodeLegacyMemoryListings,
  decodeMutationResult,
  decodeRecallPreview,
  decodeScopedMemoryEntries,
  memoryControlTarget,
  safeJsonStringArray,
  type CorrectionResult,
  type ForgetResult,
  type LegacyMemoryEntry,
  type LegacyMemoryListing,
  type MemoryControlTarget,
  type MemoryDraft,
  type MemoryMutationState,
  type MemoryStatementKind,
  type MutationResult,
  type RecallPreview,
  type ScopeSelector,
  type ScopedMemoryEntry,
  type WritableScopeKind,
} from './memory-control-state';

function displayValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return 'Not supplied';
  }
  return String(value);
}

function fmtConfidence(c: number | undefined | null): string {
  return typeof c === 'number' && Number.isFinite(c) ? c.toFixed(2) : '—';
}

function fmtDate(value: string | undefined | null): string {
  if (!value) return '';
  const t = Date.parse(value);
  return Number.isNaN(t) ? '' : new Date(t).toLocaleDateString();
}

const SEMANTIC_CATEGORIES = ['general', 'user', 'feedback', 'project', 'reference'] as const;

function errMessage(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return 'Memory operation failed.';
}

export default function MemoryView() {
  const [sessions, setSessions] = useState<MemorySessionOption[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [selector, setSelector] = useState<WritableScopeKind>('project');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [includeUserScope, setIncludeUserScope] = useState(false);
  const [legacyMode, setLegacyMode] = useState(false);

  const [entries, setEntries] = useState<ScopedMemoryEntry[]>([]);
  const [preview, setPreview] = useState<RecallPreview | null>(null);
  const [legacyEntries, setLegacyEntries] = useState<LegacyMemoryListing[]>([]);
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [tier, setTier] = useState<Tier | 'all'>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftCategory, setDraftCategory] = useState<string>('project');
  const [draftKind, setDraftKind] = useState<MemoryStatementKind>('unknown');
  const [editContent, setEditContent] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editCategory, setEditCategory] = useState<string>('project');
  const [editKind, setEditKind] = useState<MemoryStatementKind>('unknown');
  const [forgetReason, setForgetReason] = useState('');

  const [mutation, setMutation] = useState<MemoryMutationState>(IDLE_MUTATION_STATE);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [forgetConfirming, setForgetConfirming] = useState(false);
  const [adoptConfirming, setAdoptConfirming] = useState<LegacyMemoryEntry | null>(null);
  const [restoreConfirming, setRestoreConfirming] = useState<ScopedMemoryEntry | null>(null);

  const detailId = useId();
  const inspectionButtons = useRef(new Map<string, HTMLButtonElement>());
  const searchInput = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const scopeGeneration = useRef(0);
  const operationRef = useRef<{ targetKey: string; operationId: string } | null>(null);

  const selectorValue: ScopeSelector = { kind: selector };
  const pending = mutation.state === 'pending';

  // Load the explicit native Session chooser once. No scope is implicit.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await invoke<MemorySessionOption[]>('jarvis_list_sessions');
        if (!active) return;
        setSessions(Array.isArray(list) ? list : []);
      } catch {
        if (!active) return;
        setSessions([]);
      } finally {
        if (active) setSessionsLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const loadScoped = useCallback(
    async (requestedQuery: string) => {
      if (!sessionId) return;
      const id = ++requestId.current;
      const capturedSession = sessionId;
      const capturedSelector = selectorValue.kind;
      const recallQuery = requestedQuery.trim();
      setSubmittedQuery(recallQuery);
      setLoading(true);
      setError(null);
      setEntries([]);
      setPreview(null);
      try {
        if (recallQuery) {
          const preview = await invoke<unknown>('memory_scoped_recall_preview', {
            request: {
              session_id: capturedSession,
              query: recallQuery,
              options: { limit: 5, include_user_scope: includeUserScope },
            },
          });
          if (id !== requestId.current) return;
          const decoded = decodeRecallPreview(preview);
          // Preserve native preview evidence (score, matched terms, stale and
          // the effective scope/store revision) instead of flattening it away.
          setPreview(decoded);
          setEntries(decoded.entries.map((recall) => recall.memory));
        } else {
          const list = await invoke<unknown>('memory_scoped_list', {
            request: {
              session_id: capturedSession,
              selector: { kind: capturedSelector },
              include_inactive: includeInactive,
            },
          });
          if (id !== requestId.current) return;
          setPreview(null);
          setEntries(decodeScopedMemoryEntries(list));
        }
      } catch (err) {
        if (id !== requestId.current) return;
        setError(
          recallQuery
            ? `Memory recall failed for "${recallQuery}".`
            : errMessage(err),
        );
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [sessionId, selectorValue.kind, includeInactive, includeUserScope],
  );

  const loadLegacy = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    setLegacyEntries([]);
    try {
      const list = await invoke<unknown>('memory_list');
      if (id !== requestId.current) return;
      setLegacyEntries(decodeLegacyMemoryListings(list));
    } catch (err) {
      if (id !== requestId.current) return;
      setError(errMessage(err));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // A Session/scope change invalidates any pending mutation display so a late
    // result can never render under a different Session or scope.
    scopeGeneration.current += 1;
    setSelectedId(null);
    setMutation(IDLE_MUTATION_STATE);
    setMutationError(null);
    if (legacyMode) {
      void loadLegacy();
    } else if (sessionId) {
      void loadScoped('');
    } else {
      setEntries([]);
    }
    return () => {
      requestId.current += 1;
    };
  }, [sessionId, selector, includeInactive, includeUserScope, legacyMode, loadScoped, loadLegacy]);

  // Close the current scope generation synchronously the moment the operator
  // changes Session/scope, so an in-flight read or mutation cannot publish an
  // old scope's result under the newly selected scope.
  const markScopeChange = () => {
    scopeGeneration.current += 1;
    requestId.current += 1;
  };

  const selectSession = (id: string) => {
    markScopeChange();
    setSessionId(id || null);
    setIncludeInactive(false);
    setIncludeUserScope(false);
  };

  const selectScope = (kind: WritableScopeKind) => {
    markScopeChange();
    setSelector(kind);
  };

  const changeIncludeInactive = (value: boolean) => {
    markScopeChange();
    setIncludeInactive(value);
  };

  const changeIncludeUserScope = (value: boolean) => {
    markScopeChange();
    setIncludeUserScope(value);
  };

  const changeLegacyMode = (value: boolean) => {
    markScopeChange();
    setLegacyMode(value);
    setAdoptConfirming(null);
    setForgetConfirming(false);
    setRestoreConfirming(null);
  };

  const refresh = () => {
    if (legacyMode) void loadLegacy();
    else void loadScoped(submittedQuery);
  };

  const clearMutation = () => {
    setMutation(IDLE_MUTATION_STATE);
    setMutationError(null);
  };

  const selected = selectedId
    ? entries.find((entry) => entry.entry.id === selectedId) ?? null
    : null;

  // Native preview evidence indexed by memory id. Only populated for an active
  // hypothetical recall query; a normal scoped list clears it.
  const previewById = new Map(
    (preview?.entries ?? []).map((recall) => [recall.memory.entry.id, recall] as const),
  );

  useEffect(() => {
    if (!selected) return;
    setEditTitle(selected.entry.title);
    setEditContent(selected.entry.content);
    setEditCategory(selected.entry.category);
    setEditKind(selected.statement_kind);
    setForgetReason('');
    setForgetConfirming(false);
    setRestoreConfirming(null);
  }, [selected]);

  // Cancelling a confirmation issues no command and preserves the reason and
  // the open inspection. The shared ConfirmModal owns focus/Escape return.
  const cancelForget = () => setForgetConfirming(false);
  const cancelAdopt = () => setAdoptConfirming(null);
  const cancelRestore = () => setRestoreConfirming(null);
  useEffect(() => {
    if (!selectedId || selected) return;
    const opener = inspectionButtons.current.get(selectedId);
    setSelectedId(null);
    if (opener && !opener.isConnected) searchInput.current?.focus();
  }, [selected, selectedId]);

  const closeInspection = () => {
    const opener = selectedId ? inspectionButtons.current.get(selectedId) : null;
    setSelectedId(null);
    if (opener?.isConnected) opener.focus();
    else searchInput.current?.focus();
  };

  // Confirm a mutation only from a decoded native receipt. Errors surface as
  // unavailable; the draft is retained for deliberate resubmission.
  const runMutation = async (
    target: MemoryControlTarget | null,
    operationId: string | null,
    invokeMutation: () => Promise<unknown>,
    decode: (value: unknown) => MutationResult | CorrectionResult | ForgetResult,
  ) => {
    const generation = scopeGeneration.current;
    setMutationError(null);
    setMutation({ state: 'pending', target, operation_id: operationId });
    try {
      const raw = await invokeMutation();
      if (generation !== scopeGeneration.current) return;
      setMutation({ state: 'confirmed', result: decode(raw) });
      refresh();
    } catch (err) {
      if (generation !== scopeGeneration.current) return;
      setMutation({ state: 'unavailable', message: errMessage(err) });
      setMutationError(errMessage(err));
      refresh();
    }
  };

  // ── Confirmed native operations (no command until ConfirmModal confirms) ──

  const confirmAdopt = () => {
    const entry = adoptConfirming;
    const targetSession = sessionId;
    const targetSelector = selectorValue;
    setAdoptConfirming(null);
    if (!entry || !targetSession) return;
    void runMutation(
      {
        session_id: targetSession,
        selector: targetSelector,
        id: entry.entry.id,
        expected_revision: entry.revision,
      },
      null,
      () =>
        invoke('memory_adopt_legacy', {
          request: {
            session_id: targetSession,
            selector: targetSelector,
            id: entry.entry.id,
            expected_revision: entry.revision,
          },
        }),
      decodeMutationResult,
    );
  };

  const confirmForget = () => {
    const entry = selected;
    const reason = forgetReason;
    setForgetConfirming(false);
    if (!entry || !reason.trim()) return;
    const target = memoryControlTarget(sessionId ?? '', selectorValue, entry);
    // Stable UUID bound to the exact target + reason; unchanged retry keeps it.
    const targetKey = `forget|${target.session_id}|${target.selector.kind}|${target.id}|${target.expected_revision}|${reason}`;
    const operationId =
      operationRef.current?.targetKey === targetKey
        ? operationRef.current.operationId
        : crypto.randomUUID();
    operationRef.current = { targetKey, operationId };
    void runMutation(
      target,
      operationId,
      () =>
        invoke('memory_scoped_forget', {
          request: {
            session_id: sessionId,
            selector: selectorValue,
            id: entry.entry.id,
            expected_revision: entry.revision,
            reason,
            operation_id: operationId,
          },
        }),
      decodeForgetResult,
    );
  };

  const confirmRestore = () => {
    const entry = restoreConfirming;
    setRestoreConfirming(null);
    if (!entry) return;
    void runMutation(
      memoryControlTarget(sessionId ?? '', selectorValue, entry),
      null,
      () =>
        invoke('memory_scoped_restore', {
          request: {
            session_id: sessionId,
            selector: selectorValue,
            id: entry.entry.id,
            expected_revision: entry.revision,
          },
        }),
      decodeMutationResult,
    );
  };

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      {/* Shared accessible confirmation: owns focus, Escape cancellation and
          opener focus return. No native command is issued until confirm. */}
      <ConfirmModal
        open={adoptConfirming !== null}
        message={`Adopt "${adoptConfirming?.entry.title || adoptConfirming?.entry.id || ''}" into an explicit scope?`}
        detail={`Target Session: ${sessionId ?? 'none selected'} · Target scope: ${selectorValue.kind} · Revision: ${adoptConfirming?.revision ?? 'unavailable'}. A native revision mismatch is reported, never silently adopted.`}
        confirmLabel={pending ? 'Adopting…' : 'Adopt'}
        onConfirm={confirmAdopt}
        onCancel={cancelAdopt}
      />
      <ConfirmModal
        open={forgetConfirming}
        message={`Forget "${selected?.entry.title || selected?.entry.id || ''}"?`}
        detail={`Reason: ${forgetReason}. This tombstones the record and suppresses its source from future prompt context. It is confirmed only by a native receipt.`}
        confirmLabel={pending ? 'Forgetting…' : 'Forget'}
        danger
        onConfirm={confirmForget}
        onCancel={cancelForget}
      />
      <ConfirmModal
        open={restoreConfirming !== null}
        message={`Restore "${restoreConfirming?.entry.title || restoreConfirming?.entry.id || ''}"?`}
        detail={`Scope: ${restoreConfirming?.scope.kind ?? 'unknown'}${restoreConfirming?.scope.project_root ? ` (${restoreConfirming.scope.project_root})` : ''} · Revision: ${restoreConfirming?.revision ?? 'unknown'}. Restore re-activates the record; it does not remove existing source suppression.`}
        confirmLabel={pending ? 'Restoring…' : 'Restore'}
        onConfirm={confirmRestore}
        onCancel={cancelRestore}
      />
      <SectionHeader
        title="Memory"
        subtitle="Scoped inspection and operator controls"
        count={legacyMode ? legacyEntries.length : entries.length}
        action={
          <label className="flex items-center gap-2 text-xs text-bone/70">
            <input
              type="checkbox"
              checked={legacyMode}
              onChange={(event) => changeLegacyMode(event.target.checked)}
              className="h-3.5 w-3.5"
            />
            Legacy recovery
          </label>
        }
      />

      {!legacyMode && (
        <MemoryScopeControls
          sessions={sessions}
          sessionId={sessionId}
          selector={selector}
          includeInactive={includeInactive}
          includeUserScope={includeUserScope}
          disabled={pending}
          onSelectSession={selectSession}
          onSelectScope={selectScope}
          onIncludeInactive={changeIncludeInactive}
          onIncludeUserScope={changeIncludeUserScope}
        />
      )}

      {!legacyMode && sessionsLoaded && sessions.length === 0 && (
        <EmptyState message="No native Sessions exist yet. Create a Session before using scoped memory." />
      )}

      {!legacyMode && !sessionId && sessions.length > 0 && (
        <EmptyState message="Choose an existing Session to inspect its scoped memory." />
      )}

      {(legacyMode || sessionId) && (
        <>
          <div className="flex gap-2">
            <input
              ref={searchInput}
              type="text"
              aria-label="Recall query"
              value={query}
              disabled={legacyMode}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !legacyMode && search()}
              placeholder={legacyMode ? 'Legacy recovery shows all unscoped records' : 'Recall within the selected scope…'}
              className="flex-1 px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50 disabled:opacity-50"
            />
            <select
              aria-label="Memory tier"
              value={tier}
              onChange={(e) => setTier(e.target.value as Tier | 'all')}
              className="px-2 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone"
            >
              <option value="all">All tiers</option>
              <option value="hot">Hot</option>
              <option value="warm">Warm</option>
              <option value="cold">Cold</option>
            </select>
            <button
              type="button"
              onClick={search}
              disabled={legacyMode}
              className="px-4 py-2 text-sm rounded-lg bg-accent text-bone hover:bg-accent/80 transition-colors disabled:opacity-50"
            >
              Search
            </button>
          </div>

          {/* Hypothetical preview diagnostics. This is never actual turn
              selection and no memory here is claimed as applied/used. */}
          {!legacyMode && preview && submittedQuery && (
            <div
              role="note"
              aria-label="Recall preview status"
              className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-100/80"
            >
              Hypothetical recall preview — not applied to any turn. Effective scope:{' '}
              <span className="font-mono">{preview.scope.kind}</span>
              {preview.scope.project_root ? ` (${preview.scope.project_root})` : ''}; store revision{' '}
              <span className="font-mono">{preview.store_revision}</span>.
            </div>
          )}

          {/* Create control for the selected explicit scope. */}
          {!legacyMode && sessionId && (
            <GlassCard className="p-3">
              <h3 className="text-xs font-medium text-bone/80 mb-2">Create memory in selected scope</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  aria-label="New memory title"
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  placeholder="Title"
                  className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-bone"
                />
                <select
                  aria-label="New memory category"
                  value={draftCategory}
                  onChange={(e) => setDraftCategory(e.target.value)}
                  className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-bone"
                >
                  {SEMANTIC_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="New memory statement kind"
                  value={draftKind}
                  onChange={(e) => setDraftKind(e.target.value as MemoryStatementKind)}
                  className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-bone"
                >
                  <option value="unknown">Unknown</option>
                  <option value="normative_constraint">Normative constraint</option>
                  <option value="descriptive_fact">Descriptive fact</option>
                </select>
                <button
                  type="button"
                  disabled={pending || !draftContent.trim()}
                  onClick={() => {
                    const draft: MemoryDraft = {
                      title: draftTitle.trim() || draftContent.trim().slice(0, 80),
                      content: draftContent,
                      tags: [],
                      category: draftCategory,
                      expires_at: null,
                      review_after: null,
                    };
                    void runMutation(
                      null,
                      null,
                      () =>
                        invoke('memory_scoped_save', {
                          request: {
                            session_id: sessionId,
                            selector: selectorValue,
                            draft,
                            statement_kind: draftKind,
                          },
                        }),
                      decodeMutationResult,
                    );
                  }}
                  className="rounded-lg bg-accent px-3 py-1.5 text-sm text-bone hover:bg-accent/80 disabled:opacity-50"
                >
                  Create
                </button>
                <textarea
                  aria-label="New memory content"
                  value={draftContent}
                  onChange={(e) => setDraftContent(e.target.value)}
                  placeholder="Content"
                  rows={2}
                  className="sm:col-span-2 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-bone"
                />
              </div>
            </GlassCard>
          )}

          {mutation.state !== 'idle' && (
            <div role="status" aria-label="Memory mutation status" className="text-xs">
              {mutation.state === 'pending' && <span className="text-bone/60">Pending native confirmation…</span>}
              {mutation.state === 'confirmed' && (
                <span className="text-emerald-300">
                  Confirmed by native receipt{mutation.result.changed ? '' : ' (no change)'}
                </span>
              )}
              {mutation.state === 'unavailable' && (
                <span className="text-red-300">Unavailable: {mutation.message}</span>
              )}
              <button type="button" onClick={clearMutation} className="ml-2 underline text-bone/50">
                Dismiss
              </button>
            </div>
          )}
          {mutationError && <div role="alert" className="text-xs text-red-300">{mutationError}</div>}

          <div className="flex-1 overflow-y-auto min-h-0">
            {loading ? (
              <div role="status">
                <LoadingState message={submittedQuery ? `Recalling memories for "${submittedQuery}"…` : 'Loading memories…'} />
              </div>
            ) : error ? (
              <div role="alert">
                <ErrorState error={error} onRetry={refresh} />
              </div>
            ) : legacyMode ? (
              legacyEntries.length === 0 ? (
                <EmptyState message="No legacy unscoped memories." />
              ) : (
                <ul className="space-y-2">
                  {legacyEntries.map((m) => (
                    <li key={m.id}>
                      <GlassCard className="p-3">
                        <h3 className="text-sm font-medium text-bone">{m.entry?.title || m.id}</h3>
                        <p className="text-xs text-bone/60 line-clamp-2">{m.entry?.content}</p>
                        {m.status === 'available' ? (
                          <button
                            type="button"
                            disabled={pending || !sessionId}
                            onClick={() => setAdoptConfirming({ entry: m.entry, revision: m.revision })}
                            className="mt-2 rounded-lg border border-white/10 px-2.5 py-1 text-xs text-bone/70 hover:text-bone disabled:opacity-50"
                          >
                            Adopt into scope…
                          </button>
                        ) : (
                          <p role="status" className="mt-2 text-xs text-amber-100/70">
                            Adoption unavailable: {m.reason}
                          </p>
                        )}
                      </GlassCard>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              (() => {
                const filtered = filterScopedByTier(entries, tier);
                if (filtered.length === 0) return <EmptyState message="No memories match the current query." />;
                return (
                  <ul className="space-y-2">
                    {filtered.map((record) => {
                      const m = record.entry;
                      const isSelected = selectedId === m.id;
                      const regionId = `${detailId}-${m.id}`;
                      return (
                        <li key={m.id}>
                          <GlassCard onClick={() => setSelectedId(m.id)} className="p-3 hover:border-white/20 transition-colors">
                            <div className="flex items-baseline justify-between gap-2 mb-1">
                              <h3 className="text-sm font-medium text-bone min-w-0">
                                <button
                                  ref={(node) => {
                                    if (node) inspectionButtons.current.set(m.id, node);
                                    else inspectionButtons.current.delete(m.id);
                                  }}
                                  type="button"
                                  aria-label={`Inspect memory: ${m.title || m.id}`}
                                  aria-expanded={isSelected}
                                  aria-pressed={isSelected}
                                  aria-controls={regionId}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setSelectedId(m.id);
                                  }}
                                  className="max-w-full truncate text-left rounded cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-neon focus-visible:outline-offset-2"
                                >
                                  {m.title || 'Untitled memory'}
                                </button>
                              </h3>
                              <span className="text-[10px] font-mono text-bone/40 shrink-0">
                                rev {record.revision}
                              </span>
                            </div>
                            <p className="text-xs text-bone/60 line-clamp-2 mb-1.5">{m.content}</p>
                            <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                              <span className="rounded-full bg-white/5 border border-white/10 px-1.5 py-0.5 text-bone/60">{m.category}</span>
                              <span className="rounded-full bg-white/5 border border-white/10 px-1.5 py-0.5 text-bone/60">{record.statement_kind}</span>
                              <span className="rounded-full bg-white/5 border border-white/10 px-1.5 py-0.5 text-bone/60">{record.scope.kind}</span>
                              <span className="ml-auto text-bone/30 font-mono">{fmtDate(m.updated_at)}</span>
                            </div>
                            {(() => {
                              const recall = previewById.get(m.id);
                              if (!recall) return null;
                              return (
                                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-amber-100/70">
                                  <span className="rounded-full border border-amber-500/30 px-1.5 py-0.5">
                                    score {recall.score.toFixed(2)}
                                  </span>
                                  <span className="rounded-full border border-amber-500/30 px-1.5 py-0.5">
                                    matched {recall.matched_terms.join(', ') || 'none'}
                                  </span>
                                  <span
                                    className={
                                      recall.stale
                                        ? 'rounded-full border border-amber-500/30 px-1.5 py-0.5 text-amber-100'
                                        : 'rounded-full border border-white/20 px-1.5 py-0.5 text-bone/60'
                                    }
                                  >
                                    {recall.stale ? 'review due' : 'review not due'}
                                  </span>
                                </div>
                              );
                            })()}
                          </GlassCard>
                        </li>
                      );
                    })}
                  </ul>
                );
              })()
            )}

            {!legacyMode && selected && (
              <section
                id={`${detailId}-${selected.entry.id}`}
                role="region"
                aria-label={`Memory details: ${selected.entry.title || selected.entry.id}`}
                className="mt-4"
              >
                <GlassCard className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-medium text-bone">Scoped record</h3>
                      <p className="text-xs text-bone/50 break-words">{selected.entry.title || selected.entry.id}</p>
                    </div>
                    <button
                      type="button"
                      onClick={closeInspection}
                      className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-xs text-bone/70 hover:text-bone"
                    >
                      Close
                    </button>
                  </div>

                  <p aria-label="Full memory content" className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-black/20 p-3 text-sm leading-6 text-bone/80">
                    {displayValue(selected.entry.content)}
                  </p>

                  <h4 className="mt-4 text-xs font-medium text-bone/70">Provenance and scope</h4>
                  <dl aria-label="Memory provenance" className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    <div><dt className="text-bone/40">ID</dt><dd className="text-bone/75 break-words">{displayValue(selected.entry.id)}</dd></div>
                    <div><dt className="text-bone/40">Scope</dt><dd className="text-bone/75 break-words">{selected.scope.kind}</dd></div>
                    <div><dt className="text-bone/40">Agent</dt><dd className="text-bone/75 break-words">{displayValue(selected.scope.agent_id)}</dd></div>
                    <div><dt className="text-bone/40">Project root</dt><dd className="text-bone/75 break-words">{displayValue(selected.scope.project_root)}</dd></div>
                    <div><dt className="text-bone/40">Authority</dt><dd className="text-bone/75 break-words">{displayValue(selected.authority_kind)}</dd></div>
                    <div><dt className="text-bone/40">Statement kind</dt><dd className="text-bone/75 break-words">{selected.statement_kind}</dd></div>
                    <div><dt className="text-bone/40">Source Session</dt><dd className="text-bone/75 break-words">{displayValue(selected.entry.source_session_id)}</dd></div>
                    <div><dt className="text-bone/40">Source message IDs</dt><dd className="text-bone/75 break-words">{safeJsonStringArray(selected.entry.source_message_ids).join(', ') || 'Not supplied'}</dd></div>
                    <div><dt className="text-bone/40">Source run</dt><dd className="text-bone/75 break-words">{displayValue(selected.source_run_id)}</dd></div>
                    <div><dt className="text-bone/40">Verified at</dt><dd className="text-bone/75 break-words">{displayValue(selected.verified_at)}</dd></div>
                    <div><dt className="text-bone/40">Revision</dt><dd className="text-bone/75">{selected.revision}</dd></div>
                    <div><dt className="text-bone/40">Status</dt><dd className="text-bone/75 break-words">{displayValue(selected.entry.status)}</dd></div>
                    <div><dt className="text-bone/40">Supersedes</dt><dd className="text-bone/75 break-words">{displayValue(selected.entry.supersedes_id)}</dd></div>
                    <div><dt className="text-bone/40">Expires</dt><dd className="text-bone/75 break-words">{displayValue(selected.entry.expires_at)}</dd></div>
                    <div><dt className="text-bone/40">Review after</dt><dd className="text-bone/75 break-words">{displayValue(selected.entry.review_after)}</dd></div>
                    <div><dt className="text-bone/40">Confidence</dt><dd className="text-bone/75">{fmtConfidence(selected.entry.confidence)}</dd></div>
                  </dl>

                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input aria-label="Edit title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-bone" />
                    <select aria-label="Edit category" value={editCategory} onChange={(e) => setEditCategory(e.target.value)} className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-bone">
                      {SEMANTIC_CATEGORIES.map((category) => (
                        <option key={category} value={category}>{category}</option>
                      ))}
                    </select>
                    <select aria-label="Edit statement kind" value={editKind} onChange={(e) => setEditKind(e.target.value as MemoryStatementKind)} className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-bone">
                      <option value="unknown">Unknown</option>
                      <option value="normative_constraint">Normative constraint</option>
                      <option value="descriptive_fact">Descriptive fact</option>
                    </select>
                    <textarea aria-label="Edit content" value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={2} className="sm:col-span-2 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-bone" />
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        const draft: MemoryDraft = {
                          title: editTitle,
                          content: editContent,
                          tags: safeJsonStringArray(selected.entry.tags),
                          category: editCategory,
                          expires_at: selected.entry.expires_at ?? null,
                          review_after: selected.entry.review_after ?? null,
                        };
                        void runMutation(
                          memoryControlTarget(sessionId ?? '', selectorValue, selected),
                          null,
                          () =>
                            invoke('memory_scoped_update', {
                              request: {
                                session_id: sessionId,
                                selector: selectorValue,
                                id: selected.entry.id,
                                expected_revision: selected.revision,
                                draft,
                                statement_kind: editKind,
                              },
                            }),
                          decodeMutationResult,
                        );
                      }}
                      className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-bone/80 hover:text-bone disabled:opacity-50"
                    >
                      Save edit
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        const draft: MemoryDraft = {
                          title: editTitle,
                          content: editContent,
                          tags: safeJsonStringArray(selected.entry.tags),
                          category: editCategory,
                          expires_at: selected.entry.expires_at ?? null,
                          review_after: selected.entry.review_after ?? null,
                        };
                        const target = memoryControlTarget(sessionId ?? '', selectorValue, selected);
                        // Bind the stable operation UUID to the exact submitted
                        // payload. Editing the draft or kind mints a new UUID;
                        // an unchanged target + payload retry keeps it.
                        const payloadKey = JSON.stringify([
                          draft.title,
                          draft.content,
                          draft.tags,
                          draft.category,
                          draft.expires_at,
                          draft.review_after,
                          editKind,
                        ]);
                        const targetKey = `${target.session_id}|${target.selector.kind}|${target.id}|${target.expected_revision}|correct|${payloadKey}`;
                        const operationId =
                          operationRef.current?.targetKey === targetKey
                            ? operationRef.current.operationId
                            : crypto.randomUUID();
                        operationRef.current = { targetKey, operationId };
                        void runMutation(
                          target,
                          operationId,
                          () =>
                            invoke('memory_scoped_correct', {
                              request: {
                                session_id: sessionId,
                                selector: selectorValue,
                                id: selected.entry.id,
                                expected_revision: selected.revision,
                                draft,
                                operation_id: operationId,
                                statement_kind: editKind,
                              },
                            }),
                          decodeCorrectionResult,
                        );
                      }}
                      className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-bone/80 hover:text-bone disabled:opacity-50"
                    >
                      Correct (supersede)
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        void runMutation(
                          memoryControlTarget(sessionId ?? '', selectorValue, selected),
                          null,
                          () =>
                            invoke('memory_scoped_classify', {
                              request: {
                                session_id: sessionId,
                                selector: selectorValue,
                                id: selected.entry.id,
                                expected_revision: selected.revision,
                                statement_kind: editKind,
                              },
                            }),
                          decodeMutationResult,
                        )
                      }
                      className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-bone/80 hover:text-bone disabled:opacity-50"
                    >
                      Classify only
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => setRestoreConfirming(selected)}
                      className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-bone/80 hover:text-bone disabled:opacity-50"
                    >
                      Restore…
                    </button>
                  </div>

                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <input
                      aria-label="Forget reason"
                      value={forgetReason}
                      onChange={(e) => setForgetReason(e.target.value)}
                      placeholder="Reason for forgetting"
                      className="flex-1 min-w-[10rem] rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-bone"
                    />
                    <button
                      type="button"
                      disabled={pending || !forgetReason.trim()}
                      onClick={() => setForgetConfirming(true)}
                      className="rounded-lg border border-red-400/40 px-3 py-1.5 text-xs text-red-200 hover:text-red-100 disabled:opacity-50"
                    >
                      Forget…
                    </button>
                  </div>
                </GlassCard>
              </section>
            )}
          </div>
        </>
      )}
    </div>
  );

  function search() {
    void loadScoped(query);
  }
}

function filterScopedByTier(entries: readonly ScopedMemoryEntry[], tier: Tier | 'all'): ScopedMemoryEntry[] {
  if (tier === 'all') return [...entries];
  return entries.filter((record) => getMemoryTier(record.entry) === tier);
}

// Re-exported for callers that only need the draft shape.
export type { ScopedMemoryEntry, MemoryStatementKind, MemoryDraft, MemoryMutationState };
