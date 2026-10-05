import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { createReadGuard } from '../../lib/read-identity';

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

export interface LearningRunResult {
  topic: string;
  subtopic: string;
  started_at: string;
  finished_at: string;
  output_path: string;
  outcome: 'complete' | 'partial' | 'unavailable';
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
}

type ChoicesState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; sessions: LearningSessionChoice[] };

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'done'; result: LearningRunResult; sessionId: string; runId: string }
  | { kind: 'failed'; message: string };

export const LEARNING_CHOICES_LOADING_TEXT = 'Reading persisted Sessions and completed runs…';
export const LEARNING_CHOICES_ERROR_TEXT =
  'Could not read persisted Sessions and completed runs.';
export const LEARNING_CHOICES_EMPTY_TEXT =
  'No persisted Session has a completed Agent run to learn from.';

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

/**
 * Learning — select one persisted Session and one exact completed Agent run,
 * then run a source-grounded learning session.
 *
 * The Session/run IDs are selectors only: native re-reads and validates the
 * whole tuple (owner Agent, canonical workspace, enabled projection, unique
 * stage evidence) before any research is dispatched, and Bun resolves the
 * stored trajectory for the same tuple. Every failure surfaces as an explicit
 * unavailable result with no output file.
 */
export default function LearningView() {
  const guard = useRef(createReadGuard());
  // Monotonic request identity. Any selector/topic/seed change or new submission
  // bumps it, so a late completion from a superseded request is discarded and a
  // result can only ever be shown for the exact selectors that produced it.
  const requestSeq = useRef(0);
  const [choices, setChoices] = useState<ChoicesState>({ kind: 'loading' });
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [selectedRunId, setSelectedRunId] = useState('');
  const [topic, setTopic] = useState('');
  const [seedsText, setSeedsText] = useState('');
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' });

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

  // A stale selection (one not present in the currently loaded, non-superseded
  // list) or a superseded read can never submit.
  const canSubmit =
    choices.kind === 'ready' &&
    selectedSession !== null &&
    selectedRun !== null &&
    topic.trim().length > 0 &&
    submit.kind !== 'submitting';

  // Changing any selector/topic/seed discards the current result and invalidates
  // any in-flight request so a stale response can never land under new inputs.
  const invalidateSubmission = useCallback(() => {
    requestSeq.current += 1;
    setSubmit({ kind: 'idle' });
  }, []);

  const onSelectSession = useCallback(
    (value: string) => {
      setSelectedSessionId(value);
      setSelectedRunId('');
      invalidateSubmission();
    },
    [invalidateSubmission],
  );

  const onSelectRun = useCallback(
    (value: string) => {
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

  const onSubmit = useCallback(async () => {
    if (!canSubmit || !selectedSession || !selectedRun) return;
    const identity = requestSeq.current + 1;
    requestSeq.current = identity;
    const submittedSessionId = selectedSession.session_id;
    const submittedRunId = selectedRun.agent_run_id;
    setSubmit({ kind: 'submitting' });
    try {
      const result = await invoke<LearningRunResult>('run_learning_session', {
        topic: topic.trim(),
        sessionId: submittedSessionId,
        session_id: submittedSessionId,
        agentRunId: submittedRunId,
        agent_run_id: submittedRunId,
        seedUrls: seeds,
        seed_urls: seeds,
      });
      if (requestSeq.current !== identity) return;
      setSubmit({
        kind: 'done',
        result,
        sessionId: submittedSessionId,
        runId: submittedRunId,
      });
    } catch (error) {
      if (requestSeq.current !== identity) return;
      setSubmit({
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [canSubmit, selectedSession, selectedRun, topic, seeds]);

  return (
    <div
      data-testid="learning-view"
      className="h-full overflow-auto px-6 py-5 text-sm text-bone"
    >
      <h2 className="text-base font-semibold tracking-tight">Learning</h2>
      <p className="mt-1 text-xs text-bone-dim">
        Select one persisted Session and one exact completed Agent run. Both IDs
        are selectors; native revalidates the run, Session owner, Agent, and
        workspace before any research is dispatched.
      </p>

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
              disabled={submit.kind === 'submitting'}
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
            Completed Agent run
          </label>
          <select
            id="learning-run"
            value={selectedRunId}
            disabled={!selectedSession || submit.kind === 'submitting'}
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

        <div>
          <label htmlFor="learning-topic" className="block text-xs text-bone-dim">
            Topic
          </label>
          <input
            id="learning-topic"
            type="text"
            value={topic}
            disabled={submit.kind === 'submitting'}
            onChange={(event) => onTopicChange(event.target.value)}
            className="mt-1 w-full rounded border border-iron/40 bg-transparent px-2 py-1 text-xs disabled:opacity-40"
          />
        </div>

        <div>
          <label htmlFor="learning-seeds" className="block text-xs text-bone-dim">
            Seed URLs (one per line, optional)
          </label>
          <textarea
            id="learning-seeds"
            value={seedsText}
            disabled={submit.kind === 'submitting'}
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
          {submit.kind === 'submitting' ? 'Researching…' : 'Run learning session'}
        </button>

        {submit.kind === 'failed' && (
          <p role="alert" className="text-xs text-amber-200/90">
            Learning session failed: {submit.message}
          </p>
        )}

        {submit.kind === 'done' && (
          <LearningResultPanel
            result={submit.result}
            sessionId={submit.sessionId}
            runId={submit.runId}
          />
        )}
      </div>
    </div>
  );
}

function LearningResultPanel({
  result,
  sessionId,
  runId,
}: {
  result: LearningRunResult;
  sessionId: string;
  runId: string;
}) {
  return (
    <div
      data-testid="learning-result"
      className="rounded-md border border-iron/30 px-3 py-2 text-xs"
    >
      <p>
        <span className="font-semibold">{result.outcome}</span>
        {result.reason ? <> — {result.reason}</> : null}
      </p>
      <p className="mt-1 text-bone-dim">
        submitted session: {sessionId} · submitted run: {runId}
      </p>
      <p className="mt-1 text-bone-dim">
        bound run: {result.evidence_binding.agent_run_id ?? 'unavailable'} · digest:{' '}
        {result.evidence_binding.tool_sequence_digest ?? 'unavailable'}
      </p>
      {result.output_path ? (
        <p className="mt-1 text-bone-dim">output: {result.output_path}</p>
      ) : (
        <p className="mt-1 text-bone-dim">No session file was written.</p>
      )}
      {result.findings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {result.findings.map((finding) => (
            <li key={finding.source_url + finding.tool_call_id}>
              <span>{finding.source_host}</span>
              <span className="text-bone-faint">
                {' '}
                · {finding.source_url} · {finding.content_digest}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
