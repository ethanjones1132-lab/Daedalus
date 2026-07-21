// ═══════════════════════════════════════════════════════════════
// ── WorkspaceGrantsChip — shows/revokes this session's granted roots
// ═══════════════════════════════════════════════════════════════
//
// P5.3d: an absolute filesystem path named in a chat message becomes a
// session-scoped grant (tools.grant_session_roots, workspace-grants.ts on the
// Bun side) with no prior visibility into what got opened or a way to close
// it back down mid-conversation. Backed by two new endpoints
// (GET/POST /session/grants*, proxied via jarvis_get_session_grants /
// jarvis_revoke_session_grant) added specifically for this chip — nothing
// exposed this before.

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X } from 'lucide-react';

interface SessionGrantsResponse {
  session_id: string;
  grants: string[];
}

export default function WorkspaceGrantsChip({
  sessionId,
  isStreaming,
}: {
  sessionId: string;
  isStreaming: boolean;
}) {
  const [grants, setGrants] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    if (!sessionId) { setGrants([]); return; }
    try {
      const res = await invoke<SessionGrantsResponse>('jarvis_get_session_grants', { sessionId });
      setGrants(res.grants ?? []);
    } catch {
      // Best-effort — a missing/unreachable server should not disrupt chat.
      setGrants([]);
    }
  }, [sessionId]);

  // Refresh on session change, and again each time a turn finishes (a new
  // grant may have just been created from the message that was sent).
  useEffect(() => { void refresh(); }, [sessionId]);
  useEffect(() => { if (!isStreaming) void refresh(); }, [isStreaming, refresh]);

  const revoke = async (root: string) => {
    // Optimistic — the chip should feel instant; refresh() re-syncs after.
    setGrants((prev) => prev.filter((g) => g !== root));
    try {
      await invoke('jarvis_revoke_session_grant', { sessionId, root });
    } catch {
      void refresh();
    }
  };

  if (!sessionId || grants.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 rounded-lg border border-amber-400/20 bg-amber-400/5 text-[10px] font-mono text-amber-200"
      aria-label="Session-granted filesystem roots"
    >
      <span className="uppercase tracking-wider font-bold">workspace grants</span>
      {grants.map((root) => (
        <span
          key={root}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-amber-400/30 bg-amber-400/10"
        >
          {root}
          <button
            type="button"
            onClick={() => revoke(root)}
            aria-label={`Revoke grant for ${root}`}
            title="Revoke this grant"
            className="hover:text-red-300 transition-colors"
          >
            <X size={10} />
          </button>
        </span>
      ))}
    </div>
  );
}
