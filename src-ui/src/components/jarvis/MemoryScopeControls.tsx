// ═══════════════════════════════════════════════════════════════
// MemoryScopeControls — explicit Session + scope selection
// ═══════════════════════════════════════════════════════════════
//
// Phase 4.1. The Memory view must never resolve an implicit Session/scope.
// This control exposes an explicit existing-Session chooser plus the
// project/Agent/user scope selector, an inactive-inspection toggle, and the
// user-wide recall opt-in (local, never a persisted global grant).

import { useId } from 'react';
import type { WritableScopeKind } from './memory-control-state';

export interface MemorySessionOption {
  id: string;
  name?: string;
  title?: string;
}

export interface MemoryScopeControlsProps {
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

function sessionLabel(session: MemorySessionOption): string {
  return session.name || session.title || session.id;
}

export default function MemoryScopeControls({
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
}: MemoryScopeControlsProps) {
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
