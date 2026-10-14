import { useId, useState } from 'react';
import { Select, StatusLine } from '../../design';
import MemoryScopeControls from '../memory/MemoryScopeControls';
import MemoryTurnStatus from '../memory/MemoryTurnStatus';
import type { SessionTurn } from './useSessionTurn';

/** Native memory identity, explicit Goal binding, and historical turn receipts. */
export function MemoryTurnControls({ turn }: { turn: SessionTurn }) {
  const goalId = useId();
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)} className="border-t border-line bg-sunken/40 px-8 py-2 text-xs"><summary className="cursor-pointer text-ink-3">Memory and Goal controls{turn.memoryStatusLabel ? ` · ${turn.memoryStatusLabel}` : ''}</summary>{open && <div className="mt-3 max-h-72 space-y-3 overflow-auto">
    <MemoryScopeControls selection={turn.sessionSelection} agents={turn.sessionAgents} disabled={turn.isStreaming} agentLocked={turn.pendingNativeSessionId !== null} onSelectAgent={turn.handleSelectAgent} onBindWorkspace={root => { void turn.handleBindWorkspace(root); }} onIncludeUserScope={turn.setIncludeUserScope} />
    <label htmlFor={goalId} className="flex items-center gap-3">Goal<Select id={goalId} value={turn.selectedGoalId ?? ''} disabled={turn.isStreaming} onChange={event => turn.setSelectedGoalId(event.target.value || null)}><option value="">No Goal (ordinary turn)</option>{turn.goalOptions.map(goal => <option key={goal.id} value={goal.id}>{goal.objective}</option>)}</Select></label>
    {turn.memoryHistoryWarning && <StatusLine label="Memory history warning" busy={false}>{turn.memoryHistoryWarning}</StatusLine>}
    {turn.memoryFinalizationNotice && <StatusLine label="Memory finalization status" busy={false}>{turn.memoryFinalizationNotice}</StatusLine>}
    {turn.memoryCaptureState && <StatusLine label="Memory capture status" busy={turn.memoryCaptureState.state === 'pending'}>{turn.memoryCaptureState.state === 'saved' ? `Saved (${turn.memoryCaptureState.savedCount})` : turn.memoryCaptureState.state === 'pending' ? 'Capture pending' : turn.memoryCaptureState.state === 'failed' ? 'Capture failed' : 'No new saved items'}</StatusLine>}
    <MemoryTurnStatus session_id={turn.sessionSelection.session_id} turn_id={turn.memoryTurnId} diagnostic={turn.memoryDiagnosticForSession} receipt={turn.memoryReceiptForSession} continuity={turn.memoryContinuityForSession} read_error={turn.memoryTurnReadError} sourceMessages={turn.persistedUserMessages} continuityPending={turn.memoryContinuityPending} continuityError={turn.memoryContinuityError} disabled={turn.isStreaming} onSetObjective={input => { void turn.handleSetObjective(input); }} onResumeObjective={turn.handleResumeObjective} />
  </div>}</details>;
}
