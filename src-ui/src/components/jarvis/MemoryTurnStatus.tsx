// ═══════════════════════════════════════════════════════════════
// MemoryTurnStatus — actual turn application, capture receipts, continuity
// ═══════════════════════════════════════════════════════════════
//
// Phase 4.4. This is a strictly read-only projection of already-decoded native
// values plus explicit continuity operations. It never treats assistant prose
// as evidence and never substitutes a current preview/list for the historical
// turn snapshot.
//
// Discipline:
// - Prepared candidates (`diagnostic.prepared`) are what native *selected*;
//   only ids present in `diagnostic.appliedSelectedIds` may be labeled used.
// - A missing/malformed diagnostic, receipt, or continuity read is
//   pending/unavailable — never empty/saved/ready.
// - A capture is confirmed only by a decoded committed native receipt.
// - Transcript/prompt-suppression distinctions are preserved: the source
//   message link is navigation only.

import { useEffect, useId, useState } from 'react';
import { cn } from '../ui';
import type {
  MemoryTurnDiagnosticView,
  MemoryRevalidationView,
  PreparedMemorySelectionView,
} from './memory-turn-state';
import { isMemoryTurnTerminal, memoryRecallStatusLabel } from './memory-turn-state';
import {
  CLEAR_OBJECTIVE_DIRECTIVE,
  RESUME_OBJECTIVE_DIRECTIVE,
  type SessionContinuity,
} from './memory-control-state';
import type { CaptureReceipt } from './memory-capture-state';

export interface MemorySourceMessage {
  id: string;
  content: string;
}

export interface MemoryTurnStatusProps {
  session_id: string | null;
  turn_id: string | null;
  diagnostic: MemoryTurnDiagnosticView | null;
  receipt: CaptureReceipt | null;
  continuity: SessionContinuity | null;
  read_error: string | null;
  /** Persisted user messages available as an explicit objective source. */
  sourceMessages?: readonly MemorySourceMessage[];
  continuityPending?: boolean;
  continuityError?: string | null;
  disabled?: boolean;
  onSetObjective?: (input: { source_message_id: string; objective: string | null }) => void;
  onResumeObjective?: () => void;
}

const STATEMENT_KIND_LABELS: Record<string, string> = {
  normative_constraint: 'normative requirement',
  descriptive_fact: 'workspace description',
  unknown: 'unclassified',
};

const AUTHORITY_LABELS: Record<string, string> = {
  manual: 'manual',
  user_statement: 'user statement',
  verified_observation: 'verified observation',
  assistant_proposal: 'assistant proposal',
  legacy_unknown: 'legacy',
};

const REVALIDATION_LABELS: Record<MemoryRevalidationView['state'], string> = {
  not_required: 'not required',
  required: 'required (current source not yet read)',
  fresh_evidence: 'current source freshly read',
  unavailable: 'unavailable',
};

function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 8) : id;
}

function scopeLabel(kind: string, root: string | null): string {
  if (kind === 'project') return root ? `project · ${root}` : 'project';
  return kind.replace(/_/g, ' ');
}

function PreparedCandidate({
  selection,
  used,
}: {
  selection: PreparedMemorySelectionView;
  used: boolean;
}) {
  const provenance: string[] = [];
  if (selection.sourceSessionId) provenance.push(`session ${shortId(selection.sourceSessionId)}`);
  if (selection.sourceRunId) provenance.push(`run ${shortId(selection.sourceRunId)}`);
  if (selection.sourceMessageIds.length > 0) {
    provenance.push(`messages ${selection.sourceMessageIds.map(shortId).join(', ')}`);
  }
  if (selection.verifiedAt) provenance.push(`verified ${selection.verifiedAt}`);
  return (
    <li className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider',
            used
              ? 'bg-emerald-500/20 text-emerald-200'
              : 'bg-white/10 text-bone/60',
          )}
        >
          {used ? 'used' : 'prepared, not applied'}
        </span>
        <span className="font-mono text-[11px] text-bone">{shortId(selection.id)}</span>
        <span className="text-[10px] text-bone/50">rev {selection.revision}</span>
        <span className="text-[10px] text-bone/50">
          {STATEMENT_KIND_LABELS[selection.statementKind] ?? selection.statementKind}
        </span>
        <span className="text-[10px] text-bone/50">
          {AUTHORITY_LABELS[selection.authorityKind] ?? selection.authorityKind}
        </span>
        {selection.stale && <span className="text-[10px] text-amber-300/80">review due</span>}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] font-mono text-bone/40">
        <span>{scopeLabel(selection.scope.kind, selection.scope.projectRoot)}</span>
        {provenance.length > 0 && <span>{provenance.join(' · ')}</span>}
      </div>
    </li>
  );
}

function ContinuityPanel({
  continuity,
  pending,
  error,
  sourceMessages,
  disabled,
  onSetObjective,
  onResumeObjective,
}: {
  continuity: SessionContinuity | null;
  pending: boolean;
  error: string | null;
  sourceMessages: readonly MemorySourceMessage[];
  disabled: boolean;
  onSetObjective?: (input: { source_message_id: string; objective: string | null }) => void;
  onResumeObjective?: () => void;
}) {
  const sourceLabel = useId();
  const objectiveLabel = useId();
  const [sourceId, setSourceId] = useState('');
  const [objectiveDraft, setObjectiveDraft] = useState('');

  const selectedSource = sourceMessages.find((message) => message.id === sourceId) ?? null;
  const sourceIsClearDirective =
    selectedSource !== null && selectedSource.content === CLEAR_OBJECTIVE_DIRECTIVE;

  useEffect(() => {
    // Prefill from the exact persisted source so an unedited objective is a
    // guaranteed exact substring; the operator may edit it deliberately.
    if (selectedSource) setObjectiveDraft(selectedSource.content);
    else setObjectiveDraft('');
  }, [sourceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const controlsDisabled = disabled || pending || continuity === null || !onSetObjective;

  return (
    <div className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-bone/50">Active objective</span>
        <span className="font-mono text-[10px] text-bone/40">
          {continuity ? `rev ${continuity.revision}` : 'revision unavailable'}
        </span>
      </div>
      {error ? (
        <p role="status" className="mt-1 text-[11px] text-amber-200/90">
          {error}
        </p>
      ) : pending ? (
        <p role="status" className="mt-1 text-[11px] text-bone/50">
          Reading confirmed objective…
        </p>
      ) : continuity === null ? (
        <p role="status" className="mt-1 text-[11px] text-bone/50">
          Objective state unavailable.
        </p>
      ) : continuity.active_objective ? (
        <div className="mt-1 space-y-0.5">
          <p className="text-[12px] text-bone">{continuity.active_objective.text}</p>
          <p className="font-mono text-[10px] text-bone/40">
            source message {shortId(continuity.active_objective.source_message_id)}
            {continuity.active_objective.depends_on_memory_ids.length > 0
              ? ` · depends on ${continuity.active_objective.depends_on_memory_ids.length} memory`
              : ''}
          </p>
        </div>
      ) : (
        <p role="status" className="mt-1 text-[11px] text-bone/50">
          No active objective confirmed.
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-0.5">
          <label htmlFor={sourceLabel} className="text-[9px] uppercase tracking-wider text-bone/40">
            Source user message
          </label>
          <select
            id={sourceLabel}
            aria-label="Objective source user message"
            value={sourceId}
            disabled={controlsDisabled}
            onChange={(event) => setSourceId(event.target.value)}
            className="max-w-[14rem] rounded border border-white/10 bg-white/5 px-1.5 py-1 text-[11px] text-bone disabled:opacity-40"
          >
            <option value="" disabled>
              Choose a saved user message…
            </option>
            {sourceMessages.map((message) => (
              <option key={message.id} value={message.id}>
                {message.content.length > 60 ? `${message.content.slice(0, 57)}…` : message.content}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-0.5">
          <label htmlFor={objectiveLabel} className="text-[9px] uppercase tracking-wider text-bone/40">
            Objective (exact source substring)
          </label>
          <input
            id={objectiveLabel}
            type="text"
            aria-label="Objective text"
            value={objectiveDraft}
            disabled={controlsDisabled}
            onChange={(event) => setObjectiveDraft(event.target.value)}
            className="min-w-[12rem] rounded border border-white/10 bg-white/5 px-1.5 py-1 text-[11px] text-bone disabled:opacity-40"
          />
        </div>
        <button
          type="button"
          disabled={controlsDisabled || !selectedSource || objectiveDraft.trim().length === 0}
          onClick={() => {
            if (!selectedSource) return;
            onSetObjective?.({ source_message_id: selectedSource.id, objective: objectiveDraft });
          }}
          className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-bone hover:bg-white/10 disabled:opacity-40"
        >
          Set objective
        </button>
        <button
          type="button"
          title={`Clear requires a saved user message whose exact content is "${CLEAR_OBJECTIVE_DIRECTIVE}"`}
          disabled={controlsDisabled || !sourceIsClearDirective}
          onClick={() => {
            if (!selectedSource) return;
            onSetObjective?.({ source_message_id: selectedSource.id, objective: null });
          }}
          className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-bone hover:bg-white/10 disabled:opacity-40"
        >
          Clear objective
        </button>
        <button
          type="button"
          title={`Sends "${RESUME_OBJECTIVE_DIRECTIVE}" through the normal turn path`}
          disabled={disabled || continuity === null || !continuity.active_objective || !onResumeObjective}
          onClick={() => onResumeObjective?.()}
          className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-bone hover:bg-white/10 disabled:opacity-40"
        >
          Resume objective
        </button>
      </div>
      {!sourceIsClearDirective && sourceId !== '' && (
        <p className="mt-1 text-[10px] text-bone/40">
          Clear needs a saved user message whose exact content is “{CLEAR_OBJECTIVE_DIRECTIVE}”.
        </p>
      )}
    </div>
  );
}

export default function MemoryTurnStatus({
  session_id,
  turn_id,
  diagnostic,
  receipt,
  continuity,
  read_error,
  sourceMessages = [],
  continuityPending = false,
  continuityError = null,
  disabled = false,
  onSetObjective,
  onResumeObjective,
}: MemoryTurnStatusProps) {
  const hasTurn = session_id !== null && turn_id !== null;
  const applied = new Set(diagnostic?.appliedSelectedIds ?? []);

  return (
    <section
      role="region"
      aria-label="Memory turn status"
      className="rounded-lg border border-white/10 bg-white/5 p-3 text-bone-muted"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-bone/50">Memory turn</span>
        <span className="font-mono text-[10px] text-bone/40">
          {hasTurn ? (
            <>
              session {shortId(session_id as string)} · turn {shortId(turn_id as string)}
              {diagnostic ? ` · ${memoryRecallStatusLabel(diagnostic.recallStatus)}` : ''}
            </>
          ) : (
            'no turn selected'
          )}
        </span>
      </div>

      {read_error ? (
        <p role="status" className="mt-2 text-[11px] text-amber-200/90">
          {read_error}
        </p>
      ) : diagnostic === null ? (
        <p role="status" className="mt-2 text-[11px] text-bone/50">
          {hasTurn ? 'Memory turn detail pending…' : 'Memory turn detail unavailable until a turn completes.'}
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-bone/40">
            <span>{scopeLabel(diagnostic.scope.kind, diagnostic.scope.projectRoot)}</span>
            <span>store rev {diagnostic.storeRevision}</span>
            <span>{isMemoryTurnTerminal(diagnostic.state) ? 'terminal' : diagnostic.state}</span>
            {diagnostic.terminalStatus && <span>{diagnostic.terminalStatus}</span>}
            {diagnostic.errorCode && <span className="text-amber-200/80">{diagnostic.errorCode}</span>}
          </div>

          <div>
            <p className="text-[10px] uppercase tracking-wider text-bone/50">
              Prepared candidates ({diagnostic.prepared.length})
            </p>
            {diagnostic.prepared.length === 0 ? (
              <p role="status" className="mt-0.5 text-[11px] text-bone/50">
                No memory was prepared for this turn.
              </p>
            ) : (
              <ul className="mt-1 space-y-1">
                {diagnostic.prepared.map((selection) => (
                  <PreparedCandidate
                    key={selection.id}
                    selection={selection}
                    used={applied.has(selection.id)}
                  />
                ))}
              </ul>
            )}
            <p role="status" className="mt-1 text-[11px]">
              {applied.size > 0 ? (
                <span className="text-bone">
                  Used in this turn: {diagnostic.appliedSelectedIds.map(shortId).join(', ')}
                </span>
              ) : (
                <span className="text-bone/50">No memory was used in this turn.</span>
              )}
            </p>
            <p className="mt-0.5 text-[10px] text-bone/40">
              Per-stage applied detail is not part of the persisted native diagnostic; counts above
              are the native applied union.
            </p>
          </div>

          <div>
            <p className="text-[10px] uppercase tracking-wider text-bone/50">
              Current-source evidence
            </p>
            {diagnostic.revalidation === null ? (
              <p role="status" className="mt-0.5 text-[11px] text-bone/50">
                Not reported for this turn.
              </p>
            ) : (
              <p role="status" className="mt-0.5 text-[11px] text-bone/60">
                {REVALIDATION_LABELS[diagnostic.revalidation.state]}
                {diagnostic.revalidation.memoryIds.length > 0
                  ? ` · memory ${diagnostic.revalidation.memoryIds.map(shortId).join(', ')}`
                  : ''}
                {diagnostic.revalidation.evidenceToolCallIds.length > 0
                  ? ` · evidence ${diagnostic.revalidation.evidenceToolCallIds.map(shortId).join(', ')}`
                  : ''}
                {diagnostic.revalidation.reasonCode ? ` · ${diagnostic.revalidation.reasonCode}` : ''}
                <span className="text-bone/40">
                  {' '}
                  (evidence availability only, not a truth verdict)
                </span>
              </p>
            )}
          </div>
        </div>
      )}

      <div className="mt-2">
        <p className="text-[10px] uppercase tracking-wider text-bone/50">Capture receipt</p>
        {receipt === null ? (
          <p role="status" className="mt-0.5 text-[11px] text-bone/50">
            Unavailable — no committed native receipt. Nothing is confirmed saved.
          </p>
        ) : (
          <div className="mt-0.5 space-y-1">
            <p className="font-mono text-[11px] text-bone/60">
              {receipt.terminal_status ?? 'status unavailable'} · saved {receipt.saved_count} ·
              pending {receipt.pending_count}
            </p>
            {receipt.operations.length > 0 && (
              <ul className="space-y-0.5">
                {receipt.operations.map((operation) => (
                  <li
                    key={operation.operation_id}
                    className="flex flex-wrap gap-x-2 font-mono text-[10px] text-bone/50"
                  >
                    <span>{operation.status}</span>
                    <span>{shortId(operation.operation_id)}</span>
                    {operation.memory_id && <span>memory {shortId(operation.memory_id)}</span>}
                    {operation.replacement_id && (
                      <span>replacement {shortId(operation.replacement_id)}</span>
                    )}
                    {operation.reason_code && <span>{operation.reason_code}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="mt-2">
        <ContinuityPanel
          continuity={continuity}
          pending={continuityPending}
          error={continuityError}
          sourceMessages={sourceMessages}
          disabled={disabled}
          onSetObjective={onSetObjective}
          onResumeObjective={onResumeObjective}
        />
      </div>
    </section>
  );
}

// Plan interface: consumers may decode receipts/continuity through this module.
export { decodeCaptureReceipt } from './memory-capture-state';
export { decodeSessionContinuity } from './memory-control-state';
export type { CaptureReceipt } from './memory-capture-state';
export type { SessionContinuity } from './memory-control-state';
