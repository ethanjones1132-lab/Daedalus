// ═══════════════════════════════════════════════════════════════
// MemoryScopeControls — explicit Session + scope selection
// ═══════════════════════════════════════════════════════════════
//
// Phase 4.1 made the Memory view choose an explicit existing Session/scope and
// never resolve an implicit one. Phase 4.2 extends the same component with the
// chat Session identity selection: the Agent for a future Session, the
// canonical workspace binding for the current Session (native command), and
// the local user-wide recall opt-in.
//
// Both modes share one exported component. The 4.1 operator props are
// unchanged; a `selection` prop switches to the 4.2 identity controls.

import { useEffect, useId, useState } from 'react';
import type { WritableScopeKind } from './memory-control-state';
import type { AgentOption, SessionMemorySelection } from './types';

export interface MemorySessionOption {
  id: string;
  name?: string;
  title?: string;
}

/** Phase 4.1 Memory-view operator props. */
export interface MemoryScopeOperatorProps {
  sessions: readonly MemorySessionOption[];
  sessionId: string | null;
  selector: WritableScopeKind;
  includeInactive: boolean;
  includeUserScope: boolean;
  disabled?: boolean;
  onSelectSession: (id: string) => void;
  onSelectScope: (kind: WritableScopeKind) => void;
  onIncludeInactive: (value: boolean) => void;
  onIncludeUserScope: (value: boolean) => void;
}

/** Phase 4.2 chat Session identity props. */
export interface SessionMemoryIdentityProps {
  selection: SessionMemorySelection;
  agents: readonly AgentOption[];
  disabled?: boolean;
  /**
   * Lock only the Agent selector, leaving the workspace and user-scope controls
   * usable. Set while a created-but-unbound native Session is being retried, so
   * its Agent ownership cannot drift from the Session the retry would reuse.
   */
  agentLocked?: boolean;
  onSelectAgent: (agentId: string) => void;
  onBindWorkspace: (root: string | null) => void;
  onIncludeUserScope: (value: boolean) => void;
}

export type MemoryScopeControlsProps = MemoryScopeOperatorProps | SessionMemoryIdentityProps;

function sessionLabel(session: MemorySessionOption): string {
  return session.name || session.title || session.id;
}

function OperatorScopeControls({
  sessions,
  sessionId,
  selector,
  includeInactive,
  includeUserScope,
  disabled = false,
  onSelectSession,
  onSelectScope,
  onIncludeInactive,
  onIncludeUserScope,
}: MemoryScopeOperatorProps) {
  const sessionIdLabel = useId();
  const scopeLabel = useId();
  const inactiveLabel = useId();
  const userScopeLabel = useId();

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-white/5 p-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={sessionIdLabel} className="text-[10px] uppercase tracking-wider text-bone/50">
          Session
        </label>
        <select
          id={sessionIdLabel}
          aria-label="Memory Session"
          value={sessionId ?? ''}
          disabled={disabled}
          onChange={(event) => onSelectSession(event.target.value)}
          className="min-w-[12rem] rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-bone"
        >
          <option value="" disabled>
            Choose a Session…
          </option>
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {sessionLabel(session)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={scopeLabel} className="text-[10px] uppercase tracking-wider text-bone/50">
          Scope
        </label>
        <select
          id={scopeLabel}
          aria-label="Memory scope"
          value={selector}
          disabled={disabled || !sessionId}
          onChange={(event) => onSelectScope(event.target.value as WritableScopeKind)}
          className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-bone"
        >
          <option value="project">Project</option>
          <option value="agent">Agent</option>
          <option value="user">User-wide</option>
        </select>
      </div>

      <label
        htmlFor={inactiveLabel}
        className="flex items-center gap-2 text-xs text-bone/70"
      >
        <input
          id={inactiveLabel}
          type="checkbox"
          checked={includeInactive}
          disabled={disabled || !sessionId}
          onChange={(event) => onIncludeInactive(event.target.checked)}
          className="h-3.5 w-3.5"
        />
        Include inactive
      </label>

      <label
        htmlFor={userScopeLabel}
        className="flex items-center gap-2 text-xs text-bone/70"
        title="Include explicitly user-scoped memories in this hypothetical recall preview only"
      >
        <input
          id={userScopeLabel}
          type="checkbox"
          checked={includeUserScope}
          disabled={disabled}
          onChange={(event) => onIncludeUserScope(event.target.checked)}
          className="h-3.5 w-3.5"
        />
        Include user-wide in preview
      </label>
    </div>
  );
}

function SessionIdentityControls({
  selection,
  agents,
  disabled = false,
  agentLocked = false,
  onSelectAgent,
  onBindWorkspace,
  onIncludeUserScope,
}: SessionMemoryIdentityProps) {
  const agentLabel = useId();
  const workspaceLabel = useId();
  const userScopeLabel = useId();
  const existingSession = selection.session_id !== null;
  const [workspaceDraft, setWorkspaceDraft] = useState(selection.project_root ?? '');

  useEffect(() => {
    setWorkspaceDraft(selection.project_root ?? '');
  }, [selection.project_root, selection.session_id]);

  const agentChoices = agents.filter((agent) => agent.enabled);
  const trimmedDraft = workspaceDraft.trim();

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-white/5 p-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={agentLabel} className="text-[10px] uppercase tracking-wider text-bone/50">
          Agent {existingSession ? '(fixed)' : '(new Session)'}
        </label>
        <select
          id={agentLabel}
          aria-label="Session Agent"
          value={selection.agent_id}
          disabled={disabled || existingSession || agentLocked}
          onChange={(event) => onSelectAgent(event.target.value)}
          className="min-w-[10rem] rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-bone"
        >
          {!agentChoices.some((agent) => agent.id === selection.agent_id) && (
            <option value={selection.agent_id}>{selection.agent_id}</option>
          )}
          {agentChoices.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name || agent.id}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={workspaceLabel} className="text-[10px] uppercase tracking-wider text-bone/50">
          Project workspace
        </label>
        <div className="flex items-center gap-1.5">
          <input
            id={workspaceLabel}
            type="text"
            aria-label="Project workspace path"
            value={workspaceDraft}
            disabled={disabled}
            placeholder="/absolute/path (optional)"
            onChange={(event) => setWorkspaceDraft(event.target.value)}
            className="min-w-[16rem] rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-bone"
          />
          <button
            type="button"
            aria-label="Bind workspace"
            disabled={disabled || trimmedDraft.length === 0}
            onClick={() => onBindWorkspace(trimmedDraft)}
            className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-bone hover:bg-white/10 disabled:opacity-40"
          >
            Apply
          </button>
          <button
            type="button"
            aria-label="Unbind workspace"
            disabled={disabled || selection.project_root === null}
            onClick={() => { setWorkspaceDraft(''); onBindWorkspace(null); }}
            className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-bone hover:bg-white/10 disabled:opacity-40"
          >
            Unbind
          </button>
        </div>
        <span className="text-[10px] font-mono text-bone/50">
          {selection.project_root === null
            ? 'Unbound · Agent scope'
            : `Bound · ${selection.project_root}`}
        </span>
      </div>

      <label
        htmlFor={userScopeLabel}
        className="flex items-center gap-2 text-xs text-bone/70"
        title="Include explicitly user-scoped memories in this turn's recall"
      >
        <input
          id={userScopeLabel}
          type="checkbox"
          checked={selection.include_user_scope}
          disabled={disabled}
          onChange={(event) => onIncludeUserScope(event.target.checked)}
          className="h-3.5 w-3.5"
        />
        Include user-wide memory
      </label>
    </div>
  );
}

export default function MemoryScopeControls(props: MemoryScopeControlsProps) {
  if ('selection' in props) {
    return <SessionIdentityControls {...props} />;
  }
  return <OperatorScopeControls {...props} />;
}
