import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface SessionRunRecord { run_id: string; outcome: string; }

export default function SessionRunsView({ sessionId }: { sessionId: string }) {
  const [runs, setRuns] = useState<SessionRunRecord[]>([]);
  useEffect(() => {
    invoke<SessionRunRecord[]>('get_session_runs', { session_id: sessionId })
      .then(setRuns)
      .catch(() => setRuns([]));
  }, [sessionId]);
  return (
    <div data-testid="session-runs-view">
      <h3>Session {sessionId}</h3>
      <ul>
        {runs.map(r => <li key={r.run_id}>{r.run_id} — {r.outcome}</li>)}
      </ul>
    </div>
  );
}
