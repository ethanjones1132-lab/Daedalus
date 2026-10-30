import { useWorkflow } from '../workflows/WorkflowContext';
import { decodeCanonicalSessionRows, decodeGoalIdentity, normalizeHandoffRoot } from './steward-handoff';
import { AlertLine } from '../../design';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { JarvisConfig, JarvisSession } from '../../domain/types';
import {
  decideSessionRunTelemetry,
  singleFlightSessionRunRead,
  type RunRecordState,
  type SessionRunTelemetry,
} from '../../domain/session-run-telemetry';
import { reconcileSessionDeletions, sessionDeleteLocked, type SessionDeleteOperation } from '../../domain/session-delete-state';
import { useNavigation } from '../../shell/navigation';
import { ChatPanel } from './ChatPanel';
import { SessionIndex, type IndexTab } from './SessionIndex';
import { FeedTranscript, useFeedReader } from './SessionFeeds';
import { backendLabels } from '../../lib/backend-identity';

const INDEX_COLLAPSED_KEY = 'jarvis-session-index-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(INDEX_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Sessions — the workspace where the operator converses with Jarvis.
 *
 *   ┌────────────┬──────────────────────────────┬────────────┐
 *   │ Session    │ header · recent · scope      │ Inspector  │
 *   │ index      │ transcript (760px document)  │ Activity · │
 *   │ (ledger,   │                              │ Run ·      │
 *   │  feeds)    │ ── live wire ──── composer   │ Recorded   │
 *   └────────────┴──────────────────────────────┴────────────┘
 *
 * State ported from the legacy JarvisView: the Session list (request
 * identity, deletion reconciliation against the authoritative list, the
 * recorded-run outcome read decorating rows without holding them hostage),
 * the run record of the last turn, and the active Session.
 */
export default function SessionsPage() {
  const flow = useWorkflow();
  const [chatHandoff, setChatHandoff] = useState<typeof flow.handoff>(null);
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  const handoffSeqRef = useRef(0);
  const handoffConsumedRef = useRef(flow.consumeHandoff);
  handoffConsumedRef.current = flow.consumeHandoff;
  const projectStewardHandoff = flow.handoff;
  const handleChatHandoffApplied = useCallback(() => { setChatHandoff(null); handoffConsumedRef.current(); }, []);
  const [sessions, setSessions] = useState<JarvisSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const sessionsRequest = useRef(0);
  // The recorded run outcome of a Session is durable Native state. A rejected
  // or undecodable read is `unavailable`, never an empty list.
  const [runTelemetry, setRunTelemetry] = useState<SessionRunTelemetry>({ state: 'pending' });
  // The run record of the turn that just ended, confirmed against Native's
  // read-back, so the index keeps marking an unconfirmed run.
  const [runRecord, setRunRecord] = useState<RunRecordState | null>(null);
  const sessionRunReader = useRef<ReturnType<typeof singleFlightSessionRunRead> | null>(null);
  const readSessionRuns =
    sessionRunReader.current ?? (sessionRunReader.current = singleFlightSessionRunRead(() => invoke<unknown>('get_all_session_runs')));
  const [sessionDeleteOperations, setSessionDeleteOperations] = useState<Record<string, SessionDeleteOperation<JarvisSession>>>({});
  const sessionDeleteOperationsRef = useRef<Record<string, SessionDeleteOperation<JarvisSession>>>({});
  const sessionDeleteReadPending = useRef(false);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [config, setConfig] = useState<JarvisConfig | null>(null);
  const configPending = useRef(false);

  const [indexTab, setIndexTab] = useState<IndexTab>('sessions');
  const [indexCollapsed, setIndexCollapsed] = useState(readCollapsed);
  const feeds = useFeedReader();
  const [streaming, setStreaming] = useState(false);

  const publishSessionDeleteOperations = useCallback((next: Record<string, SessionDeleteOperation<JarvisSession>>) => {
    sessionDeleteOperationsRef.current = next;
    setSessionDeleteOperations(next);
  }, []);

  const loadSessions = useCallback(
    async (options?: { deletionRead?: boolean }) => {
      if (options?.deletionRead && sessionDeleteReadPending.current) return;
      const request = ++sessionsRequest.current;
      if (options?.deletionRead) sessionDeleteReadPending.current = true;
      else sessionDeleteReadPending.current = false;
      setSessionsLoading(true);
      setSessionsError(null);
      try {
        const result = await invoke<JarvisSession[]>('jarvis_list_sessions');
        if (request !== sessionsRequest.current) return;
        const reconciled = reconcileSessionDeletions(result, sessionDeleteOperationsRef.current, request);
        publishSessionDeleteOperations(reconciled.operations);
        setSessions(reconciled.rows);
        setRunTelemetry({ state: 'pending' });
        const confirmed = new Set(reconciled.confirmed);
        if (confirmed.size > 0) {
          setActiveSession((current) => (current && confirmed.has(current) ? null : current));
        }
        // The recorded-run read is a second, independent native request,
        // deliberately not awaited with the list: the rows are authoritative
        // and a slow outcome read must never hold them hostage. The request
        // identity still applies, so a stale read cannot overwrite a newer one.
        const visibleIds = reconciled.rows.map((row) => row.id);
        void readSessionRuns().then((read) => {
          if (request !== sessionsRequest.current) return;
          setRunTelemetry(decideSessionRunTelemetry(read, visibleIds));
        });
      } catch {
        if (request !== sessionsRequest.current) return;
        const next = { ...sessionDeleteOperationsRef.current };
        let removalFailure = false;
        for (const [id, operation] of Object.entries(next)) {
          if (operation.phase === 'reconciling' || operation.phase === 'read-failed') {
            next[id] = { ...operation, phase: 'read-failed' };
            removalFailure = true;
          }
        }
        if (removalFailure) publishSessionDeleteOperations(next);
        else setSessionsError('Retry to read the Session list again.');
      } finally {
        if (request === sessionsRequest.current) {
          if (options?.deletionRead) sessionDeleteReadPending.current = false;
          setSessionsLoading(false);
        }
      }
    },
    [publishSessionDeleteOperations, readSessionRuns],
  );

  const deleteSession = useCallback(
    (session: JarvisSession) => {
      if (sessionDeleteLocked(sessionDeleteOperationsRef.current[session.id])) return;
      const operation: SessionDeleteOperation<JarvisSession> = {
        row: session,
        phase: 'writing',
        after: sessionsRequest.current,
      };
      publishSessionDeleteOperations({ ...sessionDeleteOperationsRef.current, [session.id]: operation });
      void (async () => {
        try {
          await invoke<void>('jarvis_delete_session', { sessionId: session.id });
          if (sessionDeleteOperationsRef.current[session.id] !== operation) return;
          publishSessionDeleteOperations({
            ...sessionDeleteOperationsRef.current,
            [session.id]: { ...operation, phase: 'reconciling', after: sessionsRequest.current },
          });
          await loadSessions({ deletionRead: true });
        } catch {
          if (sessionDeleteOperationsRef.current[session.id] !== operation) return;
          publishSessionDeleteOperations({
            ...sessionDeleteOperationsRef.current,
            [session.id]: { ...operation, phase: 'write-failed', after: sessionsRequest.current },
          });
        }
      })();
    },
    [loadSessions, publishSessionDeleteOperations],
  );

  const retrySessionDeleteRead = useCallback(
    (id: string) => {
      const current = sessionDeleteOperationsRef.current[id];
      if (!current || current.phase !== 'read-failed' || sessionDeleteReadPending.current) return;
      publishSessionDeleteOperations({
        ...sessionDeleteOperationsRef.current,
        [id]: { ...current, phase: 'reconciling', after: sessionsRequest.current },
      });
      void loadSessions({ deletionRead: true });
    },
    [loadSessions, publishSessionDeleteOperations],
  );

  // The configured Inference backend labels the route before any turn runs.
  // Native errors may contain configuration values; never display or log them.
  const loadConfig = useCallback(async () => {
    if (configPending.current) return;
    configPending.current = true;
    try {
      const result = await invoke<JarvisConfig>('jarvis_get_config');
      if (!result) throw new Error('Missing config');
      setConfig(result);
    } catch {
      /* the route falls back to the default backend label */
    } finally {
      configPending.current = false;
    }
  }, []);

  useEffect(() => {
    void loadSessions();
    void loadConfig();
  }, [loadSessions, loadConfig]);

  // One-shot intent from another surface: navigate('sessions', { sessionId }).
  const { params, nonce } = useNavigation();
  const intentSessionId = params.sessionId;
  useEffect(() => {
    if (intentSessionId) {
      setActiveSession(intentSessionId);
      setIndexTab('sessions');
      feeds.close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentSessionId, nonce]);

  // Project Steward one-shot handoff. Re-read the persisted Session and the
  // native Goal before consuming anything: require the Session to exist, be
  // non-archived, and match the Goal's Agent and canonical project root. Only
  // then select the Session/Goal and pre-fill the task; nothing is sent here.
  useEffect(() => {
    if (!projectStewardHandoff) return;
    const seq = ++handoffSeqRef.current;
    let cancelled = false;
    const consume = () => {
      if (cancelled || seq !== handoffSeqRef.current) return;
      handoffConsumedRef.current?.();
    };
    const reject = (message: string) => {
      if (cancelled || seq !== handoffSeqRef.current) return;
      setHandoffNotice(message);
      consume();
    };
    void (async () => {
      try {
        const [sessionRows, rawGoal] = await Promise.all([
          invoke<unknown>('list_sessions'),
          invoke<unknown>('goal_get', { id: projectStewardHandoff.goal_id }),
        ]);
        if (cancelled || seq !== handoffSeqRef.current) return;
        const decodedSessions = decodeCanonicalSessionRows(sessionRows);
        if (!decodedSessions.ok) {
          reject('Project Steward: the Session list could not be read. The task was not opened in Chat.');
          return;
        }
        const session = decodedSessions.rows.find(
          (row) => row.id === projectStewardHandoff.session_id,
        );
        const goal = decodeGoalIdentity(rawGoal);
        if (!session) {
          reject('Project Steward: the selected Session no longer exists. The task was not opened in Chat.');
          return;
        }
        if (session.archived) {
          reject('Project Steward: the selected Session is archived. The task was not opened in Chat.');
          return;
        }
        if (!goal || goal.id !== projectStewardHandoff.goal_id) {
          reject('Project Steward: the native Goal could not be re-read. The task was not opened in Chat.');
          return;
        }
        const sessionAgent = typeof session.agent_id === 'string' ? session.agent_id : '';
        const sessionRoot = normalizeHandoffRoot(session.project_root);
        const goalRoot = normalizeHandoffRoot(goal.project_root);
        if (!sessionAgent || sessionAgent !== goal.agent_id) {
          reject('Project Steward: the Session Agent no longer matches the Goal. The task was not opened in Chat.');
          return;
        }
        if (!sessionRoot || !goalRoot || sessionRoot !== goalRoot) {
          reject('Project Steward: the Session workspace no longer matches the Goal. The task was not opened in Chat.');
          return;
        }
        setHandoffNotice(null);
        setIndexTab('sessions');
        setActiveSession(projectStewardHandoff.session_id);
        setChatHandoff(projectStewardHandoff);
      } catch {
        reject('Project Steward: the Session/Goal readback failed. The task was not opened in Chat.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectStewardHandoff]);


  const toggleIndex = useCallback(() => {
    setIndexCollapsed((c) => {
      try {
        localStorage.setItem(INDEX_COLLAPSED_KEY, c ? '0' : '1');
      } catch {
        /* storage unavailable */
      }
      return !c;
    });
  }, []);

  const selectSession = useCallback(
    (id: string) => {
      setActiveSession(id);
      feeds.close();
    },
    [feeds],
  );

  const { backendLabel, modelLabel } = backendLabels(config);
  const active = sessions.find((s) => s.id === activeSession);
  const feedOpen = indexTab === 'feeds';

  return (
    <div className="flex h-full min-h-0 bg-canvas">
      <SessionIndex
        sessions={sessions}
        loading={sessionsLoading}
        error={sessionsError}
        runTelemetry={runTelemetry}
        runRecord={runRecord}
        activeSession={activeSession}
        deleteOperations={sessionDeleteOperations}
        onSelect={selectSession}
        onNew={() => {
          setActiveSession(null);
          feeds.close();
          if (indexTab === 'feeds') setIndexTab('sessions');
        }}
        onDelete={deleteSession}
        onRetryDeleteRead={retrySessionDeleteRead}
        onRefresh={() => {
          void loadSessions();
        }}
        tab={indexTab}
        onTabChange={setIndexTab}
        feeds={feeds}
        collapsed={indexCollapsed}
        onToggleCollapsed={toggleIndex}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {handoffNotice && <AlertLine className="absolute left-4 right-4 top-2 z-20">{handoffNotice}</AlertLine>}
        <ChatPanel
          sessions={sessions}
          onSessionsChanged={loadSessions}
          projectStewardHandoff={chatHandoff}
          onProjectStewardHandoffApplied={handleChatHandoffApplied}
          activeSession={activeSession}
          setActiveSession={setActiveSession}
          config={config}
          backendLabel={backendLabel}
          modelLabel={modelLabel}
          onSessionCreated={loadSessions}
          onRunRecordSettled={setRunRecord}
          onStreamingChange={setStreaming}
          recentSessions={sessions}
          title={active ? active.name || active.title || 'Untitled' : undefined}
        />
        {feedOpen && <FeedTranscript reader={feeds} onReturn={() => setIndexTab('sessions')} liveTurn={streaming} />}
      </div>
    </div>
  );
}
