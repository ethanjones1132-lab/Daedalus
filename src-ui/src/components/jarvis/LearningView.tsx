import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { createReadGuard } from '../../lib/read-identity';
import type { WorkflowDestination, WorkflowNavigationSelector } from './types';
import WorkflowReadinessPanel, { type WorkflowReadinessItem } from './WorkflowReadinessPanel';
import {
  decodeMutationResult,
  decodeScopedMemoryEntries,
  decodeScopedMemoryEntry,
  safeJsonStringArray,
  type MemoryDraft,
  type MemoryStatementKind,
  type MutationResult,
  type ScopeSelector,
  type ScopedMemoryEntry,
  type WritableScopeKind,
} from './memory-control-state';

// ── Wire types ────────────────────────────────────────────────────────────────

export interface LearningRunChoice {
  agent_run_id: string;
  outcome: string;
  selected_model?: string | null;
  finished_at: string;
}

export interface LearningSessionChoice {
  session_id: string;
  agent_id: string;
  title: string;
  project_root?: string | null;
  runs: LearningRunChoice[];
}

export interface LearningFinding {
  subtopic: string;
  source_url: string;
  source_host: string;
  retrieved_at: string;
  content_digest: string;
  excerpt: string;
  reference: string;
  tool_name: string;
  tool_call_id: string;
  run_id: string;
  trajectory_digest: string;
  bun_instance_id: string;
}

export type LearningOutcome = 'complete' | 'partial' | 'blocked' | 'unavailable';

export interface LearningRejectedSource {
  url: string;
  reason: string;
}

/**
 * Direct native command response. It is never sufficient on its own for a
 * durable evidence claim; the durable receipt is loaded by exact record id and
 * identity-validated before any evidence is shown.
 */
export interface LearningRunResult {
  record_id: string;
  request_id: string;
  topic: string;
  subtopic: string;
  started_at: string;
  finished_at: string;
  outcome: LearningOutcome;
  reason?: string | null;
  findings: LearningFinding[];
  rejected_sources: Array<{ url: string; tier?: string; credibility_note?: string }>;
  evidence_binding: {
    status: 'bound' | 'unavailable';
    agent_run_id?: string | null;
    session_id?: string | null;
    tool_sequence_digest?: string | null;
    reason?: string | null;
  };
  receipt_hash?: string | null;
  receipt_path?: string | null;
}

/**
 * Native-authored, source-bound durable research receipt, keyed by the native
 * record id. Its findings, rejected sources, and identities are the display
 * authority.
 */
export interface LearningResearchReceipt {
  version: number;
  record_id: string;
  request_id: string;
  topic: string;
  subtopic: string;
  session_id: string;
  agent_run_id: string;
  agent_id: string;
  project_root: string;
  tool_sequence_digest: string;
  bun_instance_id: string;
  started_at: string;
  finished_at: string;
  outcome: LearningOutcome;
  reason?: string | null;
  findings: LearningFinding[];
  rejected_sources: LearningRejectedSource[];
  created_at: string;
  receipt_hash: string;
}

type ChoicesState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; sessions: LearningSessionChoice[] };

type ResearchState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'failed'; message: string }
  | { kind: 'receipt-error'; result: LearningRunResult; message: string }
  | { kind: 'ready'; result: LearningRunResult; receipt: LearningResearchReceipt };

export const LEARNING_CHOICES_LOADING_TEXT = 'Reading persisted Sessions and completed runs…';
export const LEARNING_CHOICES_ERROR_TEXT =
  'Could not read persisted Sessions and completed runs.';
export const LEARNING_CHOICES_EMPTY_TEXT =
  'No persisted Session has a completed Agent run to learn from.';

/**
 * Cross-workflow navigation notice (Roadmap Priority 4.4, Task 1). A researcher
 * selector that does not resolve to an exact persisted Session/Agent-run pair in
 * the freshly read source choices is rejected with no fallback; the destination
 * stays available for manual selection and never dispatches research.
 */
export const LEARNING_HANDOFF_STALE_TEXT =
  'The supplied Session/Agent-run selector did not match an exact persisted Session and completed run in the freshly read source choices. Nothing was preselected; choose a Session and run manually.';

// ── Native research contract constants (displayed, not inferred) ──────────────

/** Maximum sources the native/Bun contract requests (native `max_sources`). */
export const LEARNING_MAX_SOURCES = 8;
/** Whole-run time limit of the native/Bun contract (native `timeout_ms`). */
export const LEARNING_TIMEOUT_MS = 180_000;

export const LEARNING_SOURCE_SCOPE_TEXT =
  'Retrieval is limited to the existing Tier-1 allowlist (arxiv.org, github.com, ' +
  'gitlab.com, doi.org, pubmed.ncbi.nlm.nih.gov, ncbi.nlm.nih.gov, ieee.org, ' +
  'acm.org, wikipedia.org, and .edu/.gov hosts). Other hosts are rejected; there ' +
  'is no unrestricted web coverage. Optional seed URLs are validated against this ' +
  'same allowlist.';

export const LEARNING_COVERAGE_LABELS: Record<LearningOutcome, string> = {
  complete:
    'Complete — normal bounded completion with no rejected or failed source.',
  partial:
    'Partial — a source was rejected or the deadline was reached; only usable bound findings are shown.',
  blocked:
    'Blocked — a retrieval tool was stopped by the existing permission policy; no bypass was attempted.',
  unavailable:
    'Unavailable — the evidence or its identity could not be durably established.',
};

/**
 * Decode the native selector list. A structurally invalid payload is a read
 * failure (`null`), kept distinct from a genuinely empty list.
 */
export function decodeLearningChoices(raw: unknown): LearningSessionChoice[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const sessions = (raw as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return null;
  const decoded: LearningSessionChoice[] = [];
  for (const entry of sessions) {
    if (!entry || typeof entry !== 'object') return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.session_id !== 'string' || record.session_id.length === 0) return null;
    if (typeof record.agent_id !== 'string') return null;
    if (!Array.isArray(record.runs)) return null;
    const runs: LearningRunChoice[] = [];
    for (const run of record.runs) {
      if (!run || typeof run !== 'object') return null;
      const runRecord = run as Record<string, unknown>;
      if (typeof runRecord.agent_run_id !== 'string' || runRecord.agent_run_id.length === 0) {
        return null;
      }
      runs.push({
        agent_run_id: runRecord.agent_run_id,
        outcome: typeof runRecord.outcome === 'string' ? runRecord.outcome : '',
        selected_model:
          typeof runRecord.selected_model === 'string' ? runRecord.selected_model : null,
        finished_at: typeof runRecord.finished_at === 'string' ? runRecord.finished_at : '',
      });
    }
    decoded.push({
      session_id: record.session_id,
      agent_id: record.agent_id,
      title: typeof record.title === 'string' ? record.title : '',
      project_root: typeof record.project_root === 'string' ? record.project_root : null,
      runs,
    });
  }
  return decoded;
}

// ── Strict durable-receipt decoding ───────────────────────────────────────────

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function decodeFinding(raw: unknown): LearningFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const subtopic = nonEmptyString(record.subtopic);
  const sourceUrl = nonEmptyString(record.source_url);
  const sourceHost = nonEmptyString(record.source_host);
  const retrievedAt = nonEmptyString(record.retrieved_at);
  const contentDigest = nonEmptyString(record.content_digest);
  const excerpt = nonEmptyString(record.excerpt);
  const reference = nonEmptyString(record.reference);
  const toolName = nonEmptyString(record.tool_name);
  const toolCallId = nonEmptyString(record.tool_call_id);
  const runId = nonEmptyString(record.run_id);
  const trajectoryDigest = nonEmptyString(record.trajectory_digest);
  const bunInstanceId = nonEmptyString(record.bun_instance_id);
  if (
    !subtopic ||
    !sourceUrl ||
    !sourceHost ||
    !retrievedAt ||
    !contentDigest ||
    !excerpt ||
    !reference ||
    !toolName ||
    !toolCallId ||
    !runId ||
    !trajectoryDigest ||
    !bunInstanceId
  ) {
    return null;
  }
  return {
    subtopic,
    source_url: sourceUrl,
    source_host: sourceHost,
    retrieved_at: retrievedAt,
    content_digest: contentDigest,
    excerpt,
    reference,
    tool_name: toolName,
    tool_call_id: toolCallId,
    run_id: runId,
    trajectory_digest: trajectoryDigest,
    bun_instance_id: bunInstanceId,
  };
}

function decodeRejectedSource(raw: unknown): LearningRejectedSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.url !== 'string') return null;
  if (typeof record.reason !== 'string' || record.reason.length === 0) return null;
  return { url: record.url, reason: record.reason };
}

function decodeOutcome(value: unknown): LearningOutcome | null {
  return value === 'complete' || value === 'partial' || value === 'blocked' || value === 'unavailable'
    ? value
    : null;
}

/**
 * Strictly decode one durable native receipt. A malformed payload is `null`
 * (readback failure), never an empty evidence set.
 */
export function decodeLearningReceipt(raw: unknown): LearningResearchReceipt | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.version !== 'number') return null;

  const recordId = nonEmptyString(record.record_id);
  const requestId = nonEmptyString(record.request_id);
  const topic = nonEmptyString(record.topic);
  const subtopic = nonEmptyString(record.subtopic);
  const sessionId = nonEmptyString(record.session_id);
  const agentRunId = nonEmptyString(record.agent_run_id);
  const agentId = nonEmptyString(record.agent_id);
  const projectRoot = nonEmptyString(record.project_root);
  const toolSequenceDigest = nonEmptyString(record.tool_sequence_digest);
  const bunInstanceId = nonEmptyString(record.bun_instance_id);
  const startedAt = nonEmptyString(record.started_at);
  const finishedAt = nonEmptyString(record.finished_at);
  const createdAt = nonEmptyString(record.created_at);
  const receiptHash = nonEmptyString(record.receipt_hash);
  const outcome = decodeOutcome(record.outcome);

  if (
    !recordId ||
    !requestId ||
    !topic ||
    !subtopic ||
    !sessionId ||
    !agentRunId ||
    !agentId ||
    !projectRoot ||
    !toolSequenceDigest ||
    !bunInstanceId ||
    !startedAt ||
    !finishedAt ||
    !createdAt ||
    !receiptHash ||
    !outcome
  ) {
    return null;
  }

  if (record.reason !== undefined && record.reason !== null && typeof record.reason !== 'string') {
    return null;
  }
  if (!Array.isArray(record.findings)) return null;
  const findings: LearningFinding[] = [];
  for (const finding of record.findings) {
    const decoded = decodeFinding(finding);
    if (!decoded) return null;
    findings.push(decoded);
  }
  if (!Array.isArray(record.rejected_sources)) return null;
  const rejectedSources: LearningRejectedSource[] = [];
  for (const rejected of record.rejected_sources) {
    const decoded = decodeRejectedSource(rejected);
    if (!decoded) return null;
    rejectedSources.push(decoded);
  }

  return {
    version: record.version,
    record_id: recordId,
    request_id: requestId,
    topic,
    subtopic,
    session_id: sessionId,
    agent_run_id: agentRunId,
    agent_id: agentId,
    project_root: projectRoot,
    tool_sequence_digest: toolSequenceDigest,
    bun_instance_id: bunInstanceId,
    started_at: startedAt,
    finished_at: finishedAt,
    outcome,
    reason: typeof record.reason === 'string' ? record.reason : null,
    findings,
    rejected_sources: rejectedSources,
    created_at: createdAt,
    receipt_hash: receiptHash,
  };
}

/**
 * The durable receipt must match the submitted tuple, the direct response, and
 * the direct response's evidence binding before any evidence is rendered.
 */
export function receiptMatchesSelection(
  receipt: LearningResearchReceipt,
  result: LearningRunResult,
  session: LearningSessionChoice,
  run: LearningRunChoice,
): boolean {
  if (receipt.record_id !== result.record_id) return false;
  if (receipt.request_id !== result.request_id) return false;
  if (result.receipt_hash && receipt.receipt_hash !== result.receipt_hash) return false;

  // The selected canonical workspace must be present and match exactly.
  const selectedProjectRoot = session.project_root;
  if (typeof selectedProjectRoot !== 'string' || selectedProjectRoot.length === 0) return false;
  if (receipt.project_root !== selectedProjectRoot) return false;

  if (receipt.session_id !== session.session_id) return false;
  if (receipt.agent_run_id !== run.agent_run_id) return false;
  if (receipt.agent_id !== session.agent_id) return false;

  // The native response binding must be bound and carry every required value.
  const binding = result.evidence_binding;
  if (binding.status !== 'bound') return false;
  const bindingRunId = binding.agent_run_id;
  const bindingSessionId = binding.session_id;
  const bindingDigest = binding.tool_sequence_digest;
  if (typeof bindingRunId !== 'string' || bindingRunId.length === 0) return false;
  if (typeof bindingSessionId !== 'string' || bindingSessionId.length === 0) return false;
  if (typeof bindingDigest !== 'string' || bindingDigest.length === 0) return false;

  // The durable receipt must match every required response binding value exactly.
  if (receipt.agent_run_id !== bindingRunId) return false;
  if (receipt.session_id !== bindingSessionId) return false;
  if (receipt.tool_sequence_digest !== bindingDigest) return false;

  return true;
}

/**
 * Every receipt finding must bind exactly to the receipt-level run, trajectory,
 * and Bun instance identity. An empty or mismatched field rejects the whole
 * receipt; invalid findings are never filtered out or silently hidden.
 */
export function receiptFindingsMatchBinding(receipt: LearningResearchReceipt): boolean {
  for (const finding of receipt.findings) {
    if (finding.run_id.length === 0) return false;
    if (finding.trajectory_digest.length === 0) return false;
    if (finding.bun_instance_id.length === 0) return false;
    if (finding.run_id !== receipt.agent_run_id) return false;
    if (finding.trajectory_digest !== receipt.tool_sequence_digest) return false;
    if (finding.bun_instance_id !== receipt.bun_instance_id) return false;
  }
  return true;
}

// ── Task 3: explicit user-accepted scoped-memory save ────────────────────────
//
// The stored artifact is a user-authored MANUAL memory with a marked citation
// appendix. It is not a research-verified memory, automatic learning, Goal
// acceptance, or Goal completion. The synthesis and the evidence appendix are
// separately labeled in the stored content, and a stable unique report marker
// enables safe reconciliation without a blind second write.

/** Native durable-memory content size limit (mirrors `MAX_MEMORY_CONTENT_BYTES`). */
export const MEMORY_CONTENT_MAX_BYTES = 4096;
/** Native allowed category used for a research report. */
export const RESEARCH_REPORT_CATEGORY = 'reference';
/** Conservative statement classification sent with and verified on the save. */
export const RESEARCH_STATEMENT_KIND: MemoryStatementKind = 'unknown';

/** Stable, unique per-report marker used for exact reconciliation. */
export function researchReportMarker(recordId: string): string {
  return `research-report:${recordId}`;
}

export function memoryContentBytes(content: string): number {
  return new TextEncoder().encode(content).length;
}

/**
 * Deterministic stored content: the user-authored synthesis and a separately
 * labeled evidence appendix. It is built only from the durable receipt, the
 * user's synthesis, and the direct response's destination path; nothing is
 * inferred or generated.
 */
export function buildResearchMemoryDraft(
  receipt: LearningResearchReceipt,
  synthesis: string,
  result: LearningRunResult,
): MemoryDraft {
  const marker = researchReportMarker(receipt.record_id);
  const lines: string[] = [];
  lines.push('[User-authored synthesis]');
  lines.push(synthesis);
  lines.push('');
  lines.push('[Retrieved evidence appendix — not verified fact]');
  lines.push(`Research report marker: ${marker}`);
  lines.push(`Report id: ${receipt.record_id}`);
  lines.push(`Request id: ${receipt.request_id}`);
  lines.push(`Receipt hash: ${receipt.receipt_hash}`);
  lines.push(`Session: ${receipt.session_id}`);
  lines.push(`Agent run: ${receipt.agent_run_id}`);
  lines.push(`Agent: ${receipt.agent_id}`);
  lines.push(`Workspace: ${receipt.project_root}`);
  lines.push(`Trajectory digest: ${receipt.tool_sequence_digest}`);
  lines.push(`Execution coverage: ${receipt.outcome}`);
  if (receipt.reason) lines.push(`Coverage reason: ${receipt.reason}`);
  lines.push(`Destination: ${result.receipt_path ?? 'app-owned Research history'}`);
  lines.push(`Sources (${receipt.findings.length}):`);
  for (const finding of receipt.findings) {
    lines.push(`- url: ${finding.source_url}`);
    lines.push(`  host: ${finding.source_host}`);
    lines.push(`  retrieved_at: ${finding.retrieved_at}`);
    lines.push(`  content_sha256: ${finding.content_digest}`);
    lines.push(`  reference: ${finding.reference}`);
    lines.push(`  web_fetch_call: ${finding.tool_call_id}`);
  }
  if (receipt.rejected_sources.length > 0) {
    lines.push(`Rejected/unavailable sources (${receipt.rejected_sources.length}):`);
    for (const rejected of receipt.rejected_sources) {
      lines.push(`- ${rejected.url || '(no url)'}: ${rejected.reason}`);
    }
  }
  return {
    title: `Research: ${receipt.topic}`,
    content: lines.join('\n'),
    tags: ['research-report', marker],
    category: RESEARCH_REPORT_CATEGORY,
    expires_at: null,
    review_after: null,
  };
}

function entryHasMarker(entry: ScopedMemoryEntry, marker: string): boolean {
  if (entry.entry.content.includes(marker)) return true;
  return safeJsonStringArray(entry.entry.tags).includes(marker);
}

export interface CapturedSave {
  sessionId: string;
  selector: ScopeSelector;
  marker: string;
  draft: MemoryDraft;
  receipt: LearningResearchReceipt;
}

/**
 * A synthesis authored for one report, parked keyed to that report's identity
 * when the report changes. It is never silently attached to another report.
 */
export interface ParkedSynthesis {
  receiptId: string;
  text: string;
}

/**
 * Exact readback verification. The requested and persisted scope, manual
 * provenance, statement kind, revision, title, and content must all agree; any
 * disagreement is unavailable, never a silent success.
 */
export function verifySavedEntry(
  entry: ScopedMemoryEntry,
  captured: CapturedSave,
  expectedRevision: number | null,
): { ok: true } | { ok: false; reason: string } {
  if (entry.entry.title !== captured.draft.title) {
    return { ok: false, reason: 'title mismatch' };
  }
  if (entry.entry.content !== captured.draft.content) {
    return { ok: false, reason: 'content mismatch' };
  }
  if (entry.scope.kind !== captured.selector.kind) {
    return { ok: false, reason: 'persisted scope kind does not match the requested scope' };
  }
  if (entry.authority_kind !== 'manual') {
    return { ok: false, reason: 'authority kind is not manual' };
  }
  if (entry.statement_kind !== RESEARCH_STATEMENT_KIND) {
    return { ok: false, reason: 'statement kind mismatch' };
  }
  if (!entryHasMarker(entry, captured.marker)) {
    return { ok: false, reason: 'research report marker missing' };
  }
  if (expectedRevision !== null && entry.revision !== expectedRevision) {
    return { ok: false, reason: 'revision mismatch' };
  }
  if (captured.selector.kind === 'project') {
    if (entry.scope.project_root !== captured.receipt.project_root) {
      return { ok: false, reason: 'persisted project root does not match the Session workspace' };
    }
    if (entry.scope.agent_id !== captured.receipt.agent_id) {
      return { ok: false, reason: 'persisted agent does not match the Session agent' };
    }
  } else if (captured.selector.kind === 'agent') {
    if (entry.scope.project_root !== null) {
      return { ok: false, reason: 'persisted agent scope unexpectedly carries a project root' };
    }
    if (entry.scope.agent_id !== captured.receipt.agent_id) {
      return { ok: false, reason: 'persisted agent does not match the Session agent' };
    }
  } else {
    if (entry.scope.project_root !== null) {
      return { ok: false, reason: 'persisted user scope unexpectedly carries a project root' };
    }
    if (entry.scope.agent_id !== '') {
      return { ok: false, reason: 'persisted user scope agent is not empty' };
    }
  }
  return { ok: true };
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'reconciling' }
  | { kind: 'saved'; entry: ScopedMemoryEntry }
  | { kind: 'unresolved'; message: string }
  | { kind: 'ambiguous'; message: string }
  | { kind: 'unavailable'; message: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Learning — run one explicit, bounded, source-grounded research task against a
 * persisted Session and one exact completed Agent run, then display the durable
 * native receipt (retrieved evidence) separately from a user-authored synthesis.
 *
 * Session/run IDs and the topic/seed inputs are selectors and content only.
 * Native revalidates the whole tuple before dispatch; the UI never auto-runs and
 * never auto-synthesizes.
 */
export default function LearningView({
  navigationSelector = null,
  onNavigationSelectorConsumed,
  onNavigateWorkflow,
}: {
  /**
   * App-retained cross-workflow navigation selector. Destination-addressed and
   * selector-only: on arrival this view re-reads its native source choices and
   * selects only an exact persisted Session/Agent-run pair. A missing,
   * malformed, stale, or conflicting selector is rejected with no fallback and
   * never dispatches research.
   */
  navigationSelector?: Extract<WorkflowNavigationSelector, { workflow: 'researcher' }> | null;
  /** Reports the exact selector consumed, so App clears only that one. */
  onNavigationSelectorConsumed?: (selector: WorkflowNavigationSelector) => void;
  /** Requests navigation to another workflow, optionally with an exact selector. */
  onNavigateWorkflow?: (
    destination: WorkflowDestination,
    selector: WorkflowNavigationSelector | null,
  ) => void;
}) {
  const guard = useRef(createReadGuard());
  // Monotonic request identity. Any selector/topic/seed change or new submission
  // bumps it, so a late completion (or its receipt readback) from a superseded
  // request is discarded and a result can only be shown for the exact submitted
  // tuple.
  const requestSeq = useRef(0);
  // Monotonic save-operation generation. Any relevant Session/run/report/scope/
  // synthesis change invalidates it so an in-flight save/readback or reconcile
  // that completes later can never publish saved status under the new context.
  const saveOperationSeq = useRef(0);
  const [choices, setChoices] = useState<ChoicesState>({ kind: 'loading' });
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [selectedRunId, setSelectedRunId] = useState('');
  const [topic, setTopic] = useState('');
  const [seedsText, setSeedsText] = useState('');
  const [synthesis, setSynthesis] = useState('');
  const [research, setResearch] = useState<ResearchState>({ kind: 'idle' });
  const [saveScope, setSaveScope] = useState<WritableScopeKind | ''>('');
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  // Syntheses authored for earlier reports, parked keyed to their original
  // receipt id. Each text is preserved independently; parking a new draft never
  // overwrites another report's parked draft. Never silently attached.
  const [parkedSyntheses, setParkedSyntheses] = useState<ParkedSynthesis[]>([]);
  // A save whose outcome is uncertain retains its exact captured tuple (session,
  // selector/scope, marker, exact content, receipt) until an explicit reconcile
  // reads back exactly one verified row. Edits and selector changes never clear
  // it and never permit a second memory_scoped_save.
  const [uncertainSave, setUncertainSave] = useState<CapturedSave | null>(null);
  // Component-level confirmed-report lock keyed by receipt record id. It
  // survives synthesis/scope/selector changes so an already confirmed report can
  // never be saved again, even after its saved confirmation is hidden by a
  // context change.
  const [confirmedReportIds, setConfirmedReportIds] = useState<string[]>([]);
  // Stale cross-workflow selector notice. A selector that cannot be reconciled
  // with the freshly read source choices is shown here; it is never a fallback
  // selection and never dispatches research. A newer selector or manual
  // selection increments the generation so a delayed read cannot select.
  const [navigationNotice, setNavigationNotice] = useState<string | null>(null);
  const navigationSeqRef = useRef(0);

  const loadChoices = useCallback(() => {
    const identity = guard.current.issue();
    setChoices({ kind: 'loading' });
    invoke<unknown>('get_learning_source_choices')
      .then((raw) => {
        const decoded = decodeLearningChoices(raw);
        guard.current.publish(identity.id, () => {
          if (decoded === null) setChoices({ kind: 'error' });
          else setChoices({ kind: 'ready', sessions: decoded });
        });
      })
      .catch(() => {
        guard.current.publish(identity.id, () => setChoices({ kind: 'error' }));
      });
  }, []);

  useEffect(() => {
    loadChoices();
  }, [loadChoices]);

  // Consume an App-retained cross-workflow navigation selector exactly once. The
  // native source choices (`get_learning_source_choices`) are the owning
  // readback; the exact persisted Session and its exact completed Agent run are
  // preselected only on an exact, non-duplicate match. A read failure or a
  // missing/conflicting identity is rejected with no fallback and no dispatch,
  // and the selector is reported consumed only after the read settles.
  useEffect(() => {
    if (!navigationSelector) return;
    const selector = navigationSelector;
    const seq = ++navigationSeqRef.current;
    if (choices.kind === 'loading') return;
    if (choices.kind === 'error') {
      setNavigationNotice(LEARNING_HANDOFF_STALE_TEXT);
      onNavigationSelectorConsumed?.(selector);
      return;
    }
    if (seq !== navigationSeqRef.current) return;
    const sessionMatches = choices.sessions.filter(
      (session) => session.session_id === selector.session_id,
    );
    const runMatches =
      sessionMatches.length === 1
        ? sessionMatches[0].runs.filter((run) => run.agent_run_id === selector.agent_run_id)
        : [];
    if (sessionMatches.length !== 1 || runMatches.length !== 1) {
      setNavigationNotice(LEARNING_HANDOFF_STALE_TEXT);
      onNavigationSelectorConsumed?.(selector);
      return;
    }
    setSelectedSessionId(selector.session_id);
    setSelectedRunId(selector.agent_run_id);
    setNavigationNotice(null);
    onNavigationSelectorConsumed?.(selector);
  }, [navigationSelector, choices, onNavigationSelectorConsumed]);

  const sessions = choices.kind === 'ready' ? choices.sessions : [];
  const selectedSession = useMemo(
    () => sessions.find((session) => session.session_id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );
  const selectedRun = useMemo(
    () =>
      selectedSession?.runs.find((run) => run.agent_run_id === selectedRunId) ?? null,
    [selectedSession, selectedRunId],
  );

  const seeds = useMemo(
    () =>
      seedsText
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    [seedsText],
  );

  const canSubmit =
    choices.kind === 'ready' &&
    selectedSession !== null &&
    selectedRun !== null &&
    topic.trim().length > 0 &&
    research.kind !== 'running';

  // A synthesis authored for the current ready receipt is parked keyed to that
  // report's identity instead of being erased. Parking a different report's draft
  // never overwrites an existing parked draft.
  const parkCurrentDraft = useCallback(() => {
    if (research.kind === 'ready' && synthesis.trim().length > 0) {
      const receiptId = research.receipt.record_id;
      const text = synthesis;
      setParkedSyntheses((prev) => {
        const existing = prev.findIndex((item) => item.receiptId === receiptId);
        if (existing === -1) return [...prev, { receiptId, text }];
        const next = prev.slice();
        next[existing] = { receiptId, text };
        return next;
      });
    }
  }, [research, synthesis]);

  // Any Session/run/receipt/scope/synthesis change invalidates a confirmed save
  // so a stale confirmation can never render under changed inputs. It also bumps
  // the save-operation generation so an in-flight save/readback or reconcile can
  // never publish saved status under the new context. It never clears an
  // uncertain save (which only an explicit reconcile can resolve) and never
  // re-enables a second save.
  const invalidateSaveConfirmation = useCallback(() => {
    saveOperationSeq.current += 1;
    setSaveState((prev) => (prev.kind === 'saved' ? { kind: 'idle' } : prev));
  }, []);

  const markReportConfirmed = useCallback((recordId: string) => {
    setConfirmedReportIds((prev) => (prev.includes(recordId) ? prev : [...prev, recordId]));
  }, []);

  const invalidateSubmission = useCallback(() => {
    requestSeq.current += 1;
    invalidateSaveConfirmation();
    parkCurrentDraft();
    setResearch({ kind: 'idle' });
    setSynthesis('');
  }, [invalidateSaveConfirmation, parkCurrentDraft]);

  const onSelectSession = useCallback(
    (value: string) => {
      navigationSeqRef.current += 1;
      setNavigationNotice(null);
      setSelectedSessionId(value);
      setSelectedRunId('');
      invalidateSubmission();
    },
    [invalidateSubmission],
  );

  const onSelectRun = useCallback(
    (value: string) => {
      navigationSeqRef.current += 1;
      setNavigationNotice(null);
      setSelectedRunId(value);
      invalidateSubmission();
    },
    [invalidateSubmission],
  );

  const onTopicChange = useCallback(
    (value: string) => {
      setTopic(value);
      invalidateSubmission();
    },
    [invalidateSubmission],
  );

  const onSeedsChange = useCallback(
    (value: string) => {
      setSeedsText(value);
      invalidateSubmission();
    },
    [invalidateSubmission],
  );

  const onScopeChange = useCallback(
    (value: WritableScopeKind | '') => {
      setSaveScope(value);
      invalidateSaveConfirmation();
    },
    [invalidateSaveConfirmation],
  );

  const onSynthesisChange = useCallback(
    (value: string) => {
      setSynthesis(value);
      invalidateSaveConfirmation();
    },
    [invalidateSaveConfirmation],
  );

  // ── Task 3 derived save inputs and explicit save flow ──────────────────────

  const researchDraft = useMemo(() => {
    if (research.kind !== 'ready') return null;
    return buildResearchMemoryDraft(research.receipt, synthesis, research.result);
  }, [research, synthesis]);

  const researchContentBytes = researchDraft ? memoryContentBytes(researchDraft.content) : 0;
  const projectScopeAvailable =
    research.kind === 'ready' && research.receipt.project_root.length > 0;
  const currentReportConfirmed =
    research.kind === 'ready' && confirmedReportIds.includes(research.receipt.record_id);
  const canSave =
    research.kind === 'ready' &&
    !currentReportConfirmed &&
    researchDraft !== null &&
    synthesis.trim().length > 0 &&
    saveScope !== '' &&
    (saveScope !== 'project' || projectScopeAvailable) &&
    researchContentBytes <= MEMORY_CONTENT_MAX_BYTES &&
    // A save is actionable only when no save outcome is pending or uncertain.
    // An uncertain save can only be resolved by an explicit reconcile; user
    // edits or selector changes never clear it and never permit a second save.
    uncertainSave === null &&
    saveState.kind === 'idle';

  // Retain the exact captured tuple for an uncertain outcome. Save stays
  // disabled until an explicit reconcile reads back exactly one verified row.
  const retainUncertain = useCallback((captured: CapturedSave, message: string) => {
    setUncertainSave(captured);
    setSaveState({ kind: 'unresolved', message });
  }, []);

  const onSave = useCallback(async () => {
    if (research.kind !== 'ready' || researchDraft === null || saveScope === '') return;
    if (!canSave) return;
    const receipt = research.receipt;
    const selector: ScopeSelector = { kind: saveScope };
    const marker = researchReportMarker(receipt.record_id);
    const captured: CapturedSave = {
      sessionId: receipt.session_id,
      selector,
      marker,
      draft: researchDraft,
      receipt,
    };
    // Capture the save-operation generation. If any relevant context change
    // invalidates it before this operation completes, the result is never
    // published as saved; the original captured save is retained as uncertain.
    const operation = saveOperationSeq.current;
    const superseded = (): boolean => saveOperationSeq.current !== operation;
    const retainSuperseded = (): void =>
      retainUncertain(
        captured,
        'The selection, scope, or synthesis changed while the save was in flight; reconcile the original captured save.',
      );
    setSaveState({ kind: 'saving' });

    try {
      const raw = await invoke<unknown>('memory_scoped_save', {
        request: {
          session_id: receipt.session_id,
          selector,
          draft: researchDraft,
          statement_kind: RESEARCH_STATEMENT_KIND,
        },
      });
      if (superseded()) {
        retainSuperseded();
        return;
      }
      let mutation: MutationResult;
      try {
        mutation = decodeMutationResult(raw);
      } catch (error) {
        retainUncertain(captured, `The save response could not be decoded (${errorText(error)}).`);
        return;
      }
      const memoryId = mutation.memory.entry.id;
      let readRaw: unknown;
      try {
        readRaw = await invoke<unknown>('memory_scoped_read', {
          request: { session_id: captured.sessionId, selector, id: memoryId },
        });
      } catch (error) {
        retainUncertain(captured, `The saved memory could not be read back (${errorText(error)}).`);
        return;
      }
      if (superseded()) {
        retainSuperseded();
        return;
      }
      let read: ScopedMemoryEntry;
      try {
        read = decodeScopedMemoryEntry(readRaw);
      } catch (error) {
        retainUncertain(
          captured,
          `The saved memory readback could not be decoded (${errorText(error)}).`,
        );
        return;
      }
      if (read.entry.id !== memoryId) {
        retainUncertain(captured, 'The saved memory readback returned a different memory id.');
        return;
      }
      const verdict = verifySavedEntry(read, captured, mutation.memory.revision);
      if (!verdict.ok) {
        retainUncertain(captured, `The saved memory did not match exactly: ${verdict.reason}.`);
        return;
      }
      if (superseded()) {
        retainSuperseded();
        return;
      }
      setUncertainSave(null);
      setSaveState({ kind: 'saved', entry: read });
      markReportConfirmed(captured.receipt.record_id);
    } catch (error) {
      retainUncertain(captured, `The save request failed (${errorText(error)}).`);
    }
  }, [research, researchDraft, canSave, saveScope, retainUncertain, markReportConfirmed]);

  // Explicit reconcile of the retained uncertain save. It uses the captured
  // original session/scope/marker/content, lists that exact scope, and accepts
  // only exactly one marker match after exact row readback and verifySavedEntry.
  // Zero stays unresolved; multiple stays ambiguous. It never calls save again.
  const onReconcile = useCallback(async () => {
    const captured = uncertainSave;
    if (!captured) return;
    // Capture the save-operation generation. A reconcile that completes after a
    // relevant change must leave uncertainty locked and must not clear it.
    const operation = saveOperationSeq.current;
    const stale = (): boolean => saveOperationSeq.current !== operation;
    const lockStale = (): void => {
      setSaveState({
        kind: 'unresolved',
        message:
          'Reconcile was superseded by a context change; the uncertain save remains locked and was not cleared.',
      });
    };
    setSaveState({ kind: 'reconciling' });
    try {
      const listRaw = await invoke<unknown>('memory_scoped_list', {
        request: {
          session_id: captured.sessionId,
          selector: captured.selector,
          include_inactive: false,
        },
      });
      if (stale()) {
        lockStale();
        return;
      }
      let entries: ScopedMemoryEntry[];
      try {
        entries = decodeScopedMemoryEntries(listRaw);
      } catch (error) {
        setSaveState({
          kind: 'unavailable',
          message: `Reconciliation list could not be decoded: ${errorText(error)}`,
        });
        return;
      }
      const matches = entries.filter((entry) => entryHasMarker(entry, captured.marker));
      if (matches.length === 0) {
        setSaveState({
          kind: 'unresolved',
          message:
            'No matching saved row was found in the captured scope. The write outcome remains unresolved.',
        });
        return;
      }
      if (matches.length > 1) {
        setSaveState({
          kind: 'ambiguous',
          message: `${matches.length} matching rows exist in the captured scope. The write outcome remains ambiguous.`,
        });
        return;
      }
      const match = matches[0];
      let readRaw: unknown;
      try {
        readRaw = await invoke<unknown>('memory_scoped_read', {
          request: {
            session_id: captured.sessionId,
            selector: captured.selector,
            id: match.entry.id,
          },
        });
      } catch (error) {
        setSaveState({
          kind: 'unavailable',
          message: `The matching row could not be read back: ${errorText(error)}`,
        });
        return;
      }
      if (stale()) {
        lockStale();
        return;
      }
      let read: ScopedMemoryEntry;
      try {
        read = decodeScopedMemoryEntry(readRaw);
      } catch (error) {
        setSaveState({
          kind: 'unavailable',
          message: `The matching row readback could not be decoded: ${errorText(error)}`,
        });
        return;
      }
      if (read.entry.id !== match.entry.id) {
        setSaveState({
          kind: 'unavailable',
          message: 'The readback returned a different memory id.',
        });
        return;
      }
      const verdict = verifySavedEntry(read, captured, null);
      if (!verdict.ok) {
        setSaveState({
          kind: 'unavailable',
          message: `The single matching row did not match exactly: ${verdict.reason}.`,
        });
        return;
      }
      if (stale()) {
        lockStale();
        return;
      }
      setUncertainSave(null);
      setSaveState({ kind: 'saved', entry: read });
      markReportConfirmed(captured.receipt.record_id);
    } catch (error) {
      setSaveState({ kind: 'unavailable', message: `Reconciliation failed: ${errorText(error)}` });
    }
  }, [uncertainSave, markReportConfirmed]);

  const applyParkedSynthesis = useCallback(
    (receiptId: string) => {
      if (research.kind !== 'ready') return;
      const parked = parkedSyntheses.find((item) => item.receiptId === receiptId);
      if (!parked) return;
      setSynthesis(parked.text);
      setParkedSyntheses((prev) => prev.filter((item) => item.receiptId !== receiptId));
      invalidateSaveConfirmation();
    },
    [parkedSyntheses, research, invalidateSaveConfirmation],
  );

  const discardParkedSynthesis = useCallback((receiptId: string) => {
    setParkedSyntheses((prev) => prev.filter((item) => item.receiptId !== receiptId));
  }, []);

  const onSubmit = useCallback(async () => {
    if (!canSubmit || !selectedSession || !selectedRun) return;
    const identity = requestSeq.current + 1;
    requestSeq.current = identity;
    const submittedSession = selectedSession;
    const submittedRun = selectedRun;
    const submittedTopic = topic.trim();
    // Park any draft authored for the previous report (keyed to its identity)
    // before starting a new report; it is never silently carried over.
    parkCurrentDraft();
    invalidateSaveConfirmation();
    setSynthesis('');
    setResearch({ kind: 'running' });
    try {
      const result = await invoke<LearningRunResult>('run_learning_session', {
        topic: submittedTopic,
        sessionId: submittedSession.session_id,
        session_id: submittedSession.session_id,
        agentRunId: submittedRun.agent_run_id,
        agent_run_id: submittedRun.agent_run_id,
        seedUrls: seeds,
        seed_urls: seeds,
      });
      if (requestSeq.current !== identity) return;
      if (!result || typeof result.record_id !== 'string' || result.record_id.length === 0) {
        setResearch({
          kind: 'failed',
          message: 'Native returned no record identity for this research attempt.',
        });
        return;
      }

      // A direct command response is not a durable claim: load the exact
      // persisted receipt by record id before rendering any evidence.
      let raw: unknown;
      try {
        raw = await invoke<unknown>('get_learning_research_receipt', {
          recordId: result.record_id,
          record_id: result.record_id,
        });
      } catch (error) {
        if (requestSeq.current !== identity) return;
        setResearch({
          kind: 'receipt-error',
          result,
          message: `Could not read the durable receipt: ${errorText(error)}`,
        });
        return;
      }
      if (requestSeq.current !== identity) return;

      const receipt = decodeLearningReceipt(raw);
      if (receipt === null) {
        setResearch({
          kind: 'receipt-error',
          result,
          message:
            'No durable native receipt was found for this run, or it could not be strictly decoded.',
        });
        return;
      }
      if (!receiptMatchesSelection(receipt, result, submittedSession, submittedRun)) {
        setResearch({
          kind: 'receipt-error',
          result,
          message:
            'The durable receipt identity does not match the submitted Session, run, Agent, workspace, or trajectory binding.',
        });
        return;
      }
      if (!receiptFindingsMatchBinding(receipt)) {
        setResearch({
          kind: 'receipt-error',
          result,
          message:
            'One or more durable receipt findings do not bind to the receipt run, trajectory, or Bun instance identity.',
        });
        return;
      }

      setResearch({ kind: 'ready', result, receipt });
    } catch (error) {
      if (requestSeq.current !== identity) return;
      setResearch({ kind: 'failed', message: errorText(error) });
    }
  }, [
    canSubmit,
    selectedSession,
    selectedRun,
    topic,
    seeds,
    invalidateSaveConfirmation,
    parkCurrentDraft,
  ]);

  const running = research.kind === 'running';

  // ── Task 2: presentation-only readiness/recovery items ──────────────────────
  //
  // Every item mirrors state this view already decoded from native authority.
  // The panel performs no read and never treats a completed run or source check
  // as verified fact, acceptance, or automatic learning.
  const learningReadinessItems: WorkflowReadinessItem[] = [];
  if (choices.kind === 'loading') {
    learningReadinessItems.push({
      id: 'sources',
      label: 'Persisted Sessions and completed runs',
      state: 'waiting',
      detail: LEARNING_CHOICES_LOADING_TEXT,
    });
  } else if (choices.kind === 'error') {
    learningReadinessItems.push({
      id: 'sources',
      label: 'Persisted Sessions and completed runs',
      state: 'unavailable',
      detail: `${LEARNING_CHOICES_ERROR_TEXT} The read failed or was malformed; this is not an empty source list.`,
      recoveryLabel: 'Retry',
      onRecover: loadChoices,
      nextStep: 'Retry the source read.',
    });
  } else if (sessions.length === 0) {
    learningReadinessItems.push({
      id: 'sources',
      label: 'Eligible research source',
      state: 'needs_user_input',
      detail: LEARNING_CHOICES_EMPTY_TEXT,
      nextStep: 'Complete an Agent run in a persisted Session first.',
    });
  } else if (!selectedSession) {
    learningReadinessItems.push({
      id: 'sources',
      label: 'Persisted Session',
      state: 'needs_user_input',
      detail: 'Source choices are available; no Session is selected.',
      nextStep: 'Select a persisted Session.',
    });
  } else if (!selectedRun) {
    learningReadinessItems.push({
      id: 'sources',
      label: 'Completed Agent run',
      state: 'needs_user_input',
      detail: 'A Session is selected; no exact completed Agent run is selected.',
      nextStep: 'Select one completed Agent run.',
    });
  } else {
    learningReadinessItems.push({
      id: 'sources',
      label: 'Research source tuple',
      state: 'ready_for_explicit_action',
      detail:
        'An exact persisted Session and completed Agent run are selected. Running research remains an explicit action; this panel dispatches nothing.',
      nextStep: 'Enter a research question and run bounded research explicitly.',
    });
  }

  switch (research.kind) {
    case 'idle':
      if (topic.trim().length === 0) {
        learningReadinessItems.push({
          id: 'research',
          label: 'Research request',
          state: 'needs_user_input',
          detail: 'A concrete research question/topic is required.',
          nextStep: 'Enter a research question/topic.',
        });
      } else if (canSubmit) {
        learningReadinessItems.push({
          id: 'research',
          label: 'Research request',
          state: 'ready_for_explicit_action',
          detail:
            'The source tuple and a concrete question are present. Bounded research runs only when you explicitly submit.',
          nextStep: 'Press Run research; native revalidates the whole tuple before dispatch.',
        });
      } else {
        learningReadinessItems.push({
          id: 'research',
          label: 'Research request',
          state: 'needs_user_input',
          detail: 'The research request is not ready to submit.',
          nextStep: 'Select an exact Session and completed run and enter a question.',
        });
      }
      break;
    case 'running':
      learningReadinessItems.push({
        id: 'research',
        label: 'Research request',
        state: 'waiting',
        detail: 'Bounded research is running and the durable receipt is being loaded.',
      });
      break;
    case 'failed':
      learningReadinessItems.push({
        id: 'research',
        label: 'Research request',
        state: 'unavailable',
        detail: `The research request failed: ${research.message}`,
        nextStep:
          'Review the existing Permission/setup surface. This panel does not diagnose the cause and grants nothing.',
      });
      break;
    case 'receipt-error':
      learningReadinessItems.push({
        id: 'research',
        label: 'Durable research receipt',
        state: 'unavailable',
        detail: research.message,
        nextStep:
          'The direct response is not a durable claim; retry or inspect the existing Research history.',
      });
      break;
    case 'ready': {
      const coverageState: Record<LearningOutcome, WorkflowReadinessItem['state']> = {
        complete: 'ready_for_explicit_action',
        partial: 'partial',
        blocked: 'blocked',
        unavailable: 'unavailable',
      };
      learningReadinessItems.push({
        id: 'research',
        label: `Source coverage: ${research.receipt.outcome}`,
        state: coverageState[research.receipt.outcome],
        detail: LEARNING_COVERAGE_LABELS[research.receipt.outcome],
        nextStep:
          research.receipt.outcome === 'blocked'
            ? 'The existing Permission policy stopped a retrieval tool; ask/deny is unchanged and no bypass is added.'
            : undefined,
      });
      break;
    }
  }

  if (saveState.kind === 'saved') {
    learningReadinessItems.push({
      id: 'save',
      label: 'Manual memory saved',
      state: 'ready_for_explicit_action',
      detail:
        'Saved as a user-authored manual memory with cited research — not verified fact, automatic learning, Goal acceptance, or completion. No recovery is required; the confirmed-report lock prevents another save for this report.',
    });
  } else if (saveState.kind === 'saving' || saveState.kind === 'reconciling') {
    learningReadinessItems.push({
      id: 'save',
      label: 'Manual memory save',
      state: 'waiting',
      detail:
        saveState.kind === 'saving'
          ? 'The save request is in flight and its readback is pending.'
          : 'Reconciling a retained uncertain save.',
    });
  } else if (uncertainSave !== null) {
    const uncertainState: WorkflowReadinessItem['state'] =
      saveState.kind === 'ambiguous'
        ? 'partial'
        : saveState.kind === 'unavailable'
          ? 'unavailable'
          : 'stale';
    const uncertainMessage =
      saveState.kind === 'unresolved' ||
      saveState.kind === 'ambiguous' ||
      saveState.kind === 'unavailable'
        ? saveState.message
        : 'A save outcome is uncertain and locked until an explicit reconcile reads back exactly one verified row.';
    learningReadinessItems.push({
      id: 'save',
      label: 'Manual memory save',
      state: uncertainState,
      detail: uncertainMessage,
      nextStep: 'Reconcile the retained uncertain save; the write is never repeated automatically.',
      recoveryLabel: 'Reconcile status',
      onRecover: () => {
        void onReconcile();
      },
    });
  } else if (research.kind === 'ready') {
    if (canSave) {
      learningReadinessItems.push({
        id: 'save',
        label: 'Manual memory save',
        state: 'ready_for_explicit_action',
        detail: 'A synthesis and explicit scope are chosen; saving is an explicit action.',
        nextStep: 'Save user-authored memory; it is not verification or acceptance.',
      });
    } else {
      learningReadinessItems.push({
        id: 'save',
        label: 'Manual memory save',
        state: 'needs_user_input',
        detail: currentReportConfirmed
          ? 'This report is already saved; another save is not permitted.'
          : 'A synthesis, an explicit scope, or content within the native size limit is still required.',
        nextStep: 'Write your synthesis and choose a writable scope explicitly.',
      });
    }
  }

  const learningReadinessBoundary =
    'A successful retrieval or completed Agent run is not verified fact, Goal acceptance, automatic learning, or completion. Saved content is user-authored manual memory. This panel performs no credential, connector, or source-availability check and does not imply unrestricted web coverage.';

  return (
    <div
      data-testid="learning-view"
      className="h-full overflow-auto px-6 py-5 text-sm text-bone"
    >
      <h2 className="text-base font-semibold tracking-tight">Learning</h2>
      <p className="mt-1 text-xs text-bone-dim">
        Select one persisted Session and one exact completed Agent run, enter a
        concrete question, then explicitly run bounded research. Session and run
        IDs are selectors; native revalidates the run, Session owner, Agent, and
        workspace before any research is dispatched.
      </p>

      {onNavigateWorkflow && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-bone-dim">
          <span className="uppercase tracking-[0.18em]">Open</span>
          <button
            type="button"
            onClick={() => onNavigateWorkflow('project-steward', null)}
            className="underline"
          >
            Project Steward
          </button>
          <button
            type="button"
            onClick={() => onNavigateWorkflow('recurring-operator', null)}
            className="underline"
          >
            Recurring Operator
          </button>
        </div>
      )}

      {navigationNotice && (
        <p role="alert" data-testid="learning-navigation-stale" className="mt-2 text-xs text-amber-200/90">
          {navigationNotice}
        </p>
      )}

      <div className="mt-3">
        <WorkflowReadinessPanel
          workflow="researcher"
          heading="Derived from the source choices, bounded research receipt, and manual-memory save state below."
          items={learningReadinessItems}
          boundaryNote={learningReadinessBoundary}
          onNavigateWorkflow={
            onNavigateWorkflow ? (destination) => onNavigateWorkflow(destination, null) : undefined
          }
        />
      </div>

      <div className="mt-4 max-w-2xl space-y-4">
        <div>
          <label htmlFor="learning-session" className="block text-xs text-bone-dim">
            Persisted Session
          </label>
          {choices.kind === 'loading' && (
            <p role="status" className="mt-1 text-xs text-bone-dim">
              {LEARNING_CHOICES_LOADING_TEXT}
            </p>
          )}
          {choices.kind === 'error' && (
            <p role="alert" className="mt-1 text-xs text-amber-200/90">
              {LEARNING_CHOICES_ERROR_TEXT}{' '}
              <button type="button" onClick={loadChoices} className="underline">
                Retry
              </button>
            </p>
          )}
          {choices.kind === 'ready' && sessions.length === 0 && (
            <p className="mt-1 text-xs text-bone-dim">{LEARNING_CHOICES_EMPTY_TEXT}</p>
          )}
          {choices.kind === 'ready' && sessions.length > 0 && (
            <select
              id="learning-session"
              value={selectedSessionId}
              disabled={running}
              onChange={(event) => onSelectSession(event.target.value)}
              className="mt-1 w-full rounded border border-iron/40 bg-transparent px-2 py-1 text-xs disabled:opacity-40"
            >
              <option value="">Select a Session…</option>
              {sessions.map((session) => (
                <option key={session.session_id} value={session.session_id}>
                  {session.title || session.session_id} · {session.agent_id}
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label htmlFor="learning-run" className="block text-xs text-bone-dim">
            Exact completed Agent run
          </label>
          <select
            id="learning-run"
            value={selectedRunId}
            disabled={!selectedSession || running}
            onChange={(event) => onSelectRun(event.target.value)}
            className="mt-1 w-full rounded border border-iron/40 bg-transparent px-2 py-1 text-xs disabled:opacity-40"
          >
            <option value="">Select a completed run…</option>
            {(selectedSession?.runs ?? []).map((run) => (
              <option key={run.agent_run_id} value={run.agent_run_id}>
                {run.outcome || 'run'} · {run.agent_run_id}
              </option>
            ))}
          </select>
          {selectedSession && selectedSession.runs.length === 0 && (
            <p className="mt-1 text-xs text-bone-dim">
              This Session has no completed Agent run.
            </p>
          )}
        </div>

        <dl
          data-testid="learning-context"
          className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 rounded border border-iron/20 px-2 py-1 text-xs text-bone-dim"
        >
          <dt>Agent</dt>
          <dd className="font-mono break-all">{selectedSession?.agent_id ?? '—'}</dd>
          <dt>Workspace</dt>
          <dd className="font-mono break-all">{selectedSession?.project_root ?? '—'}</dd>
          <dt>Research history</dt>
          <dd>
            App-owned local research-history destination (the exact receipt path is
            shown after a durable run).
          </dd>
        </dl>

        <div>
          <label htmlFor="learning-topic" className="block text-xs text-bone-dim">
            Research question / topic (required)
          </label>
          <input
            id="learning-topic"
            type="text"
            value={topic}
            disabled={running}
            onChange={(event) => onTopicChange(event.target.value)}
            className="mt-1 w-full rounded border border-iron/40 bg-transparent px-2 py-1 text-xs disabled:opacity-40"
          />
        </div>

        <div>
          <p className="text-xs text-bone-dim">{LEARNING_SOURCE_SCOPE_TEXT}</p>
          <p className="mt-1 text-xs text-bone-dim">
            Maximum {LEARNING_MAX_SOURCES} sources · up to {LEARNING_TIMEOUT_MS / 1000} seconds.
          </p>
        </div>

        <div>
          <label htmlFor="learning-seeds" className="block text-xs text-bone-dim">
            Seed URLs (one per line, optional)
          </label>
          <textarea
            id="learning-seeds"
            value={seedsText}
            disabled={running}
            onChange={(event) => onSeedsChange(event.target.value)}
            rows={4}
            className="mt-1 w-full rounded border border-iron/40 bg-transparent px-2 py-1 font-mono text-xs disabled:opacity-40"
          />
        </div>

        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          className="rounded border border-iron/40 px-3 py-1.5 text-xs disabled:opacity-40"
        >
          {running ? 'Running bounded research…' : 'Run research'}
        </button>

        {parkedSyntheses.map((parked) => (
          <ParkedSynthesisPanel
            key={parked.receiptId}
            parked={parked}
            canApply={research.kind === 'ready'}
            onApply={() => applyParkedSynthesis(parked.receiptId)}
            onDiscard={() => discardParkedSynthesis(parked.receiptId)}
          />
        ))}

        {(uncertainSave !== null || saveState.kind === 'saved') && (
          <SaveStatusPanel
            uncertain={uncertainSave}
            state={saveState}
            onReconcile={onReconcile}
          />
        )}

        {research.kind === 'running' && (
          <p role="status" className="text-xs text-bone-dim">
            Running bounded research and loading the durable receipt…
          </p>
        )}

        {research.kind === 'failed' && (
          <p role="alert" className="text-xs text-amber-200/90">
            Research request failed: {research.message}
          </p>
        )}

        {research.kind === 'receipt-error' && (
          <ReceiptErrorPanel result={research.result} message={research.message} />
        )}

        {research.kind === 'ready' && (
          <ResearchReceiptPanel
            result={research.result}
            receipt={research.receipt}
            synthesis={synthesis}
            onSynthesisChange={onSynthesisChange}
            researchDraft={researchDraft}
            researchContentBytes={researchContentBytes}
            projectScopeAvailable={projectScopeAvailable}
            reportConfirmed={currentReportConfirmed}
            saveScope={saveScope}
            onScopeChange={onScopeChange}
            saveState={saveState}
            canSave={canSave}
            onSave={onSave}
          />
        )}
      </div>
    </div>
  );
}

function CoverageLine({
  outcome,
  reason,
}: {
  outcome: LearningOutcome;
  reason?: string | null;
}) {
  return (
    <div data-testid="learning-coverage">
      <p className="text-xs">
        <span className="font-semibold uppercase tracking-wide">
          Execution coverage: {outcome}
        </span>
        {reason ? <> — {reason}</> : null}
      </p>
      <p className="mt-0.5 text-bone-dim">{LEARNING_COVERAGE_LABELS[outcome]}</p>
    </div>
  );
}

function ReceiptErrorPanel({
  result,
  message,
}: {
  result: LearningRunResult;
  message: string;
}) {
  return (
    <div
      data-testid="learning-readback-error"
      role="alert"
      className="rounded-md border border-amber-300/40 px-3 py-2 text-xs"
    >
      <p className="font-semibold text-amber-200/90">Durable receipt readback failed.</p>
      <p className="mt-1">{message}</p>
      <p className="mt-1 text-bone-dim">
        Direct response outcome: <span className="font-semibold">{result.outcome}</span>
        {result.reason ? <> — {result.reason}</> : null}
      </p>
      <p className="mt-1 text-bone-dim">
        The direct command response is not a durable evidence claim, so no evidence
        is shown until an identity-validated durable receipt is loaded.
      </p>
    </div>
  );
}

function ResearchReceiptPanel({
  result,
  receipt,
  synthesis,
  onSynthesisChange,
  researchDraft,
  researchContentBytes,
  projectScopeAvailable,
  reportConfirmed,
  saveScope,
  onScopeChange,
  saveState,
  canSave,
  onSave,
}: {
  result: LearningRunResult;
  receipt: LearningResearchReceipt;
  synthesis: string;
  onSynthesisChange: (value: string) => void;
  researchDraft: MemoryDraft | null;
  researchContentBytes: number;
  projectScopeAvailable: boolean;
  reportConfirmed: boolean;
  saveScope: WritableScopeKind | '';
  onScopeChange: (value: WritableScopeKind | '') => void;
  saveState: SaveState;
  canSave: boolean;
  onSave: () => void;
}) {
  return (
    <div
      data-testid="learning-receipt"
      className="space-y-3 rounded-md border border-iron/30 px-3 py-3 text-xs"
    >
      <CoverageLine outcome={receipt.outcome} reason={receipt.reason} />

      <p className="text-bone-dim">
        Durable native receipt loaded by exact record id and identity-validated
        against the submitted Session, run, Agent, workspace, and trajectory
        binding.
      </p>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-bone-dim">
        <dt>record id</dt>
        <dd className="font-mono break-all">{receipt.record_id}</dd>
        <dt>request id</dt>
        <dd className="font-mono break-all">{receipt.request_id}</dd>
        <dt>receipt hash</dt>
        <dd className="font-mono break-all">{receipt.receipt_hash}</dd>
        <dt>Session</dt>
        <dd className="font-mono break-all">{receipt.session_id}</dd>
        <dt>Agent run</dt>
        <dd className="font-mono break-all">{receipt.agent_run_id}</dd>
        <dt>Agent</dt>
        <dd className="font-mono break-all">{receipt.agent_id}</dd>
        <dt>workspace</dt>
        <dd className="font-mono break-all">{receipt.project_root}</dd>
        <dt>trajectory digest</dt>
        <dd className="font-mono break-all">{receipt.tool_sequence_digest}</dd>
        <dt>Bun instance</dt>
        <dd className="font-mono break-all">{receipt.bun_instance_id}</dd>
        <dt>started</dt>
        <dd>{receipt.started_at}</dd>
        <dt>finished</dt>
        <dd>{receipt.finished_at}</dd>
        <dt>recorded</dt>
        <dd>{receipt.created_at}</dd>
        <dt>destination</dt>
        <dd className="font-mono break-all">
          {result.receipt_path ?? 'app-owned Research history'}
        </dd>
      </dl>

      <section>
        <h3 className="font-semibold">
          Retrieved excerpt / evidence — not verified fact
        </h3>
        <p className="mt-0.5 text-bone-dim">
          Each item is bound to the durable receipt. A content digest proves byte
          identity of the retrieved body only; it does not prove the source is true
          or reputable.
        </p>
        {receipt.findings.length === 0 ? (
          <p className="mt-1 text-bone-dim">No usable bound findings were recorded.</p>
        ) : (
          <ul className="mt-1 space-y-2">
            {receipt.findings.map((finding, index) => (
              <li
                key={`${finding.tool_call_id}-${index}`}
                className="rounded border border-iron/20 px-2 py-1"
              >
                <p>
                  <span className="font-semibold">{finding.source_host}</span> —{' '}
                  <span className="font-mono break-all">{finding.source_url}</span>
                </p>
                <p className="mt-0.5 text-bone-dim">retrieved: {finding.retrieved_at}</p>
                <p className="mt-0.5 text-bone-dim">
                  content sha256:{' '}
                  <span className="font-mono break-all">{finding.content_digest}</span>
                </p>
                <p className="mt-0.5 text-bone-dim">
                  reference: <span className="font-mono break-all">{finding.reference}</span>
                </p>
                <p className="mt-0.5 text-bone-dim">
                  web_fetch call:{' '}
                  <span className="font-mono break-all">{finding.tool_call_id}</span>
                </p>
                <p className="mt-0.5 text-bone-dim">
                  run: <span className="font-mono break-all">{finding.run_id}</span>
                </p>
                <p className="mt-0.5 text-bone-dim">
                  trajectory:{' '}
                  <span className="font-mono break-all">{finding.trajectory_digest}</span>
                </p>
                <p className="mt-0.5 text-bone-dim">
                  Bun instance:{' '}
                  <span className="font-mono break-all">{finding.bun_instance_id}</span>
                </p>
                <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-black/10 p-2 font-mono text-[11px]">
                  {finding.excerpt}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="font-semibold">Rejected / failed sources</h3>
        {receipt.rejected_sources.length === 0 ? (
          <p className="mt-0.5 text-bone-dim">No sources were rejected.</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {receipt.rejected_sources.map((rejected, index) => (
              <li key={`${rejected.url}-${index}`} className="text-bone-dim">
                <span className="font-mono break-all">{rejected.url || '(no url)'}</span> —{' '}
                {rejected.reason}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <label htmlFor="learning-synthesis" className="block font-semibold">
          User-authored synthesis
        </label>
        <p className="mt-0.5 text-bone-dim">
          This is your own prose. It is not retrieved content and is never generated
          or inferred from the evidence above.
        </p>
        <textarea
          id="learning-synthesis"
          value={synthesis}
          onChange={(event) => onSynthesisChange(event.target.value)}
          rows={5}
          placeholder="Write your own conclusion…"
          className="mt-1 w-full rounded border border-iron/40 bg-transparent px-2 py-1 text-xs"
        />
      </section>

      <section className="rounded border border-iron/30 px-2 py-2">
        <h3 className="font-semibold">Save as user-authored memory</h3>
        <p className="mt-0.5 text-bone-dim">
          Saving stores your synthesis plus a marked citation/evidence appendix as a
          manual memory. It does not verify facts, accept a Goal, complete a Goal, or
          grant provenance.
        </p>

        <label htmlFor="learning-save-scope" className="mt-2 block text-xs text-bone-dim">
          Writable scope (explicit)
        </label>
        <select
          id="learning-save-scope"
          value={saveScope}
          disabled={saveState.kind === 'saving'}
          onChange={(event) => onScopeChange(event.target.value as WritableScopeKind | '')}
          className="mt-1 rounded border border-iron/40 bg-transparent px-2 py-1 text-xs disabled:opacity-40"
        >
          <option value="">Select scope…</option>
          <option value="project">Project</option>
          <option value="agent">Agent</option>
          <option value="user">User-wide</option>
        </select>

        {saveScope === 'project' && !projectScopeAvailable && (
          <p role="alert" className="mt-1 text-xs text-amber-200/90">
            This Session has no canonical project workspace binding, so project scope is
            unavailable. Bind a workspace to this Session (Memory view → Project
            workspace → Apply) before saving with project scope. Agent or user scope is
            a separate explicit choice and is never applied as a silent fallback.
          </p>
        )}

        {researchDraft && (
          <>
            <label
              htmlFor="learning-save-preview"
              className="mt-2 block text-xs text-bone-dim"
            >
              Exact content to be stored ({researchContentBytes} / {MEMORY_CONTENT_MAX_BYTES}{' '}
              bytes)
            </label>
            <pre
              id="learning-save-preview"
              className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-black/10 p-2 font-mono text-[11px]"
            >
              {researchDraft.content}
            </pre>
          </>
        )}

        {researchContentBytes > MEMORY_CONTENT_MAX_BYTES && (
          <p role="alert" className="mt-1 text-xs text-amber-200/90">
            The stored content exceeds the native durable-memory size limit; shorten your
            synthesis before saving.
          </p>
        )}

        {reportConfirmed && (
          <p role="status" className="mt-1 text-xs text-emerald-300">
            This report has already been saved as a user-authored manual memory. Another save
            for the same report is not permitted; the confirmed-report lock survives synthesis
            edits, scope changes, and selector changes.
          </p>
        )}

        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          className="mt-2 rounded border border-iron/40 px-3 py-1.5 text-xs disabled:opacity-40"
        >
          {saveState.kind === 'saving'
            ? 'Saving…'
            : reportConfirmed
              ? 'Already saved for this report'
              : 'Save user-authored memory'}
        </button>
      </section>
    </div>
  );
}

function ParkedSynthesisPanel({
  parked,
  canApply,
  onApply,
  onDiscard,
}: {
  parked: ParkedSynthesis;
  canApply: boolean;
  onApply: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      data-testid="learning-parked-synthesis"
      className="rounded-md border border-iron/30 px-3 py-2 text-xs"
    >
      <p className="font-semibold">Parked synthesis draft</p>
      <p className="mt-1 text-bone-dim">
        A synthesis you authored for report{' '}
        <span className="font-mono break-all">{parked.receiptId}</span> is parked and is not
        attached to any other report. Apply it only if it still belongs with a newly
        selected durable receipt.
      </p>
      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-black/10 p-2 font-mono text-[11px]">
        {parked.text}
      </pre>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onApply}
          disabled={!canApply}
          className="rounded border border-iron/40 px-3 py-1.5 text-xs disabled:opacity-40"
        >
          Apply parked synthesis to the selected receipt
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="rounded border border-iron/40 px-3 py-1.5 text-xs"
        >
          Discard parked synthesis
        </button>
      </div>
      {!canApply && (
        <p className="mt-1 text-bone-dim">
          Run research for the report you want this text attached to before applying it.
        </p>
      )}
    </div>
  );
}

function SaveStatusPanel({
  uncertain,
  state,
  onReconcile,
}: {
  uncertain: CapturedSave | null;
  state: SaveState;
  onReconcile: () => void;
}) {
  if (uncertain) {
    return (
      <div
        data-testid="learning-save-uncertain"
        role="alert"
        className="rounded-md border border-amber-300/40 px-3 py-2 text-xs"
      >
        <p className="font-semibold text-amber-200/90">
          Save outcome uncertain — reconcile before any further save.
        </p>
        <p className="mt-1 text-bone-dim">
          Captured report: <span className="font-mono break-all">{uncertain.marker}</span> ·
          captured scope: <span className="font-semibold">{uncertain.selector.kind}</span> ·
          captured Session:{' '}
          <span className="font-mono break-all">{uncertain.sessionId}</span>
        </p>
        {(state.kind === 'unresolved' ||
          state.kind === 'ambiguous' ||
          state.kind === 'unavailable') && <p className="mt-1">{state.message}</p>}
        <p className="mt-1 text-bone-dim">
          The captured scope is listed and read back only by explicit action. Zero matches
          stays unresolved; multiple stays ambiguous. Edits and selector changes do not
          clear this or permit another save.
        </p>
        <button
          type="button"
          onClick={onReconcile}
          disabled={state.kind === 'reconciling'}
          className="mt-2 rounded border border-iron/40 px-3 py-1.5 text-xs disabled:opacity-40"
        >
          {state.kind === 'reconciling' ? 'Reconciling…' : 'Reconcile status'}
        </button>
      </div>
    );
  }
  if (state.kind === 'saved') {
    return (
      <p
        data-testid="learning-save-saved"
        role="status"
        className="rounded-md border border-iron/30 px-3 py-2 text-xs text-emerald-300"
      >
        Saved as manual memory {state.entry.entry.id} (revision {state.entry.revision}) in{' '}
        {state.entry.scope.kind} scope; authority {state.entry.authority_kind}; statement
        kind {state.entry.statement_kind}. This is a user-authored manual memory with cited
        research — not verified fact, automatic learning, Goal acceptance, or Goal
        completion.
      </p>
    );
  }
  return null;
}
