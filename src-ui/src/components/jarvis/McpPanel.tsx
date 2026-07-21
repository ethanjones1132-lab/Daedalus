// ═══════════════════════════════════════════════════════════════
// ── McpPanel — list/add/remove MCP servers (.mcp.json)
// ═══════════════════════════════════════════════════════════════
//
// P5.3c: no UI-facing surface existed for `.mcp.json` before this — it was
// read only by the Bun orchestrator's own agent tool-calling runtime
// (mcp-client-bundle.ts), never exposed to the app. Backed by two new Tauri
// commands (list_mcp_servers / save_mcp_servers, src-tauri/src/commands/mcp.rs)
// that read/write the same file+shape the orchestrator already reads.

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  cn,
  ConfirmModal,
  GlassCard,
  LoadingState,
  ErrorState,
  EmptyState,
  useToast,
} from '../ui';
import { emptyMcpServerEntry, type McpServerEntry, type McpServerMap } from './types';

export default function McpPanel() {
  const [servers, setServers] = useState<McpServerMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const { success, error: toastError } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await invoke<McpServerMap>('list_mcp_servers');
      setServers(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const persist = async (next: McpServerMap) => {
    setSaving(true);
    try {
      await invoke('save_mcp_servers', { servers: next });
      setServers(next);
      success('MCP servers saved');
    } catch (e) {
      toastError(String(e), 'Failed to save .mcp.json');
    } finally {
      setSaving(false);
    }
  };

  const addServer = () => {
    const name = newName.trim();
    if (!name || !servers) return;
    if (servers[name]) {
      toastError(`"${name}" already exists`, 'Duplicate name');
      return;
    }
    void persist({ ...servers, [name]: emptyMcpServerEntry() });
    setNewName('');
  };

  const removeServer = (name: string) => {
    if (!servers) return;
    const next = { ...servers };
    delete next[name];
    void persist(next);
    setPendingDelete(null);
  };

  const updateServer = (name: string, patch: Partial<McpServerEntry>) => {
    if (!servers) return;
    setServers({ ...servers, [name]: { ...servers[name], ...patch } });
  };

  const saveAll = () => {
    if (!servers) return;
    void persist(servers);
  };

  if (loading) return <LoadingState message="Loading MCP servers…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!servers) return null;

  const names = Object.keys(servers).sort();

  return (
    <div className="space-y-3">
      <GlassCard className="p-4">
        <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40 mb-2">
          Add MCP server
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addServer(); }}
            placeholder="server name (e.g. filesystem)"
            className="flex-1 px-3 py-2 text-xs font-mono bg-white/5 border border-white/10 rounded-lg text-bone placeholder:text-bone/30 focus:outline-none focus:border-white/20 transition-colors"
          />
          <button
            type="button"
            onClick={addServer}
            disabled={!newName.trim() || saving}
            className="px-3 py-1.5 text-xs rounded-lg border border-cyan-neon/40 text-cyan-glow hover:bg-cyan-neon/10 disabled:opacity-40 transition-colors"
          >
            Add
          </button>
        </div>
      </GlassCard>

      {names.length === 0 ? (
        <EmptyState message='No MCP servers configured. Add one above, or create .mcp.json with an "mcpServers" object.' />
      ) : (
        <ul className="space-y-2">
          {names.map((name) => {
            const s = servers[name];
            return (
              <li key={name}>
                <GlassCard className={cn('p-3', s.disabled && 'opacity-50')}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-mono text-bone flex-1 truncate">{name}</span>
                    <button
                      type="button"
                      onClick={() => updateServer(name, { disabled: !s.disabled })}
                      className={cn(
                        'px-2 py-0.5 text-[10px] font-mono rounded border transition-colors',
                        s.disabled
                          ? 'border-iron/30 text-bone-dim hover:text-bone'
                          : 'border-cyan-neon/30 text-cyan-glow'
                      )}
                    >
                      {s.disabled ? 'Disabled' : 'Enabled'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDelete(name)}
                      className="px-2 py-0.5 text-[10px] font-mono rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
                    <div>
                      <label className="text-[10px] font-mono text-bone-dim block mb-1">Command</label>
                      <input
                        type="text"
                        value={s.command ?? ''}
                        onChange={(e) => updateServer(name, { command: e.target.value })}
                        placeholder="npx"
                        className="w-full px-2 py-1.5 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-mono text-bone-dim block mb-1">
                        Args <span className="text-bone-faint">(space-separated)</span>
                      </label>
                      <input
                        type="text"
                        value={s.args.join(' ')}
                        onChange={(e) => updateServer(name, { args: e.target.value.split(/\s+/).filter(Boolean) })}
                        placeholder="-y @modelcontextprotocol/server-filesystem"
                        className="w-full px-2 py-1.5 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
                      />
                    </div>
                  </div>
                  <div className="mb-2">
                    <label className="text-[10px] font-mono text-bone-dim block mb-1">
                      URL <span className="text-bone-faint">(for a remote/HTTP MCP server instead of a command)</span>
                    </label>
                    <input
                      type="text"
                      value={s.url ?? ''}
                      onChange={(e) => updateServer(name, { url: e.target.value })}
                      placeholder="https://example.com/mcp"
                      className="w-full px-2 py-1.5 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
                    />
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={saveAll}
                      disabled={saving}
                      className="px-3 py-1 text-[10px] font-mono rounded border border-amber-400/40 text-amber-300 hover:bg-amber-400/10 disabled:opacity-50 transition-colors"
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </GlassCard>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmModal
        open={pendingDelete !== null}
        message={`Remove MCP server "${pendingDelete}"?`}
        detail="This edits .mcp.json directly — the server config is deleted, not just disabled."
        confirmLabel="Remove"
        danger
        onConfirm={() => pendingDelete && removeServer(pendingDelete)}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
