// ═══════════════════════════════════════════════════════════════
// ── McpPanel — list/add/remove MCP servers (.mcp.json)
// ═══════════════════════════════════════════════════════════════
//
// P5.3c: no UI-facing surface existed for `.mcp.json` before this — it was
// read only by the Bun orchestrator's own agent tool-calling runtime
// (mcp-client-bundle.ts), never exposed to the app. Backed by two new Tauri
// commands (list_mcp_servers / save_mcp_servers, src-tauri/src/commands/mcp.rs)
// that read/write the same file+shape the orchestrator already reads.

import { useCallback, useEffect, useRef, useState } from 'react';
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
import { decodeMcpArguments, encodeMcpArguments } from './mcp-argument-codec';

export default function McpPanel() {
  const [servers, setServers] = useState<McpServerMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [argumentDrafts, setArgumentDrafts] = useState<Record<string, string>>({});
  const [argumentErrors, setArgumentErrors] = useState<Record<string, boolean>>({});
  const [newName, setNewName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const savePendingRef = useRef(false);
  const { success, error: toastError } = useToast();
  const hasArgumentErrors = Object.values(argumentErrors).some(Boolean);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await invoke<McpServerMap>('list_mcp_servers');
      setServers(s);
      setArgumentDrafts(Object.fromEntries(
        Object.entries(s).map(([name, server]) => [name, encodeMcpArguments(server.args)]),
      ));
      setArgumentErrors({});
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const persist = async (next: McpServerMap) => {
    if (savePendingRef.current) return;
    savePendingRef.current = true;
    setSaving(true);
    // Add and removal are retained drafts, not evidence of successful persistence.
    // All editing is frozen until this exact snapshot settles.
    setServers(next);
    try {
      await invoke('save_mcp_servers', { servers: next });
      setSaveError(false);
      success('MCP servers saved');
    } catch {
      setSaveError(true); // Native errors may embed configuration values.
    } finally {
      savePendingRef.current = false;
      setSaving(false);
    }
  };

  const addServer = () => {
    if (savePendingRef.current) return;
    const name = newName.trim();
    if (!name || !servers || hasArgumentErrors) return;
    if (servers[name]) {
      toastError(`"${name}" already exists`, 'Duplicate name');
      return;
    }
    const entry = emptyMcpServerEntry();
    setArgumentDrafts((current) => ({ ...current, [name]: encodeMcpArguments(entry.args) }));
    setArgumentErrors((current) => ({ ...current, [name]: false }));
    void persist({ ...servers, [name]: entry });
    setNewName(''); // The name now lives in the retained server draft.
  };

  const removeServer = (name: string) => {
    if (!servers || savePendingRef.current || hasArgumentErrors) return;
    const next = { ...servers };
    delete next[name];
    setArgumentDrafts((current) => {
      const remaining = { ...current };
      delete remaining[name];
      return remaining;
    });
    setArgumentErrors((current) => {
      const remaining = { ...current };
      delete remaining[name];
      return remaining;
    });
    void persist(next);
    setPendingDelete(null);
  };

  const updateServer = (name: string, patch: Partial<McpServerEntry>) => {
    if (!servers || savePendingRef.current) return;
    setServers({ ...servers, [name]: { ...servers[name], ...patch } });
  };

  const updateArguments = (name: string, value: string) => {
    if (!servers || !servers[name] || savePendingRef.current) return;
    setArgumentDrafts((current) => ({ ...current, [name]: value }));
    try {
      const args = decodeMcpArguments(value);
      setArgumentErrors((current) => ({ ...current, [name]: false }));
      updateServer(name, { args });
    } catch {
      setArgumentErrors((current) => ({ ...current, [name]: true }));
    }
  };

  const saveAll = () => {
    if (!servers || hasArgumentErrors) return;
    void persist(servers);
  };

  if (loading) return <LoadingState message="Loading MCP servers…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!servers) return null;

  const names = Object.keys(servers).sort();

  return (
    <div className="space-y-3">
      {saving && <div role="status" className="text-xs text-bone/60">Saving MCP draft… Changes are not yet saved.</div>}
      {saveError && (
        <div role="alert" className="text-xs text-red-200">
          Could not save .mcp.json. Your draft is kept; changes are not yet saved.
          <button type="button" onClick={saveAll} disabled={saving || hasArgumentErrors} className="ml-2 underline disabled:opacity-40">
            Retry
          </button>
        </div>
      )}
      <fieldset disabled={saving} className="space-y-3 border-0 p-0 m-0 min-w-0">
      <GlassCard className="p-4">
        <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40 mb-2">
          Add MCP server
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => { if (!savePendingRef.current) setNewName(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') addServer(); }}
            placeholder="server name (e.g. filesystem)"
            className="flex-1 px-3 py-2 text-xs font-mono bg-white/5 border border-white/10 rounded-lg text-bone placeholder:text-bone/30 focus:outline-none focus:border-white/20 transition-colors"
          />
          <button
            type="button"
            onClick={addServer}
            disabled={!newName.trim() || saving || hasArgumentErrors}
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
            const argumentInputId = `mcp-args-${encodeURIComponent(name)}`;
            const argumentHelpId = `${argumentInputId}-help`;
            const argumentErrorId = `${argumentInputId}-error`;
            const argumentValue = argumentDrafts[name] ?? encodeMcpArguments(s.args);
            const argumentInvalid = argumentErrors[name] === true;
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
                      onClick={() => { if (!savePendingRef.current && !hasArgumentErrors) setPendingDelete(name); }}
                      disabled={hasArgumentErrors}
                      className="px-2 py-0.5 text-[10px] font-mono rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
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
                      <label htmlFor={argumentInputId} className="text-[10px] font-mono text-bone-dim block mb-1">
                        Args (JSON array)
                      </label>
                      <textarea
                        id={argumentInputId}
                        rows={2}
                        value={argumentValue}
                        onChange={(e) => updateArguments(name, e.target.value)}
                        placeholder='["-y","@modelcontextprotocol/server-filesystem"]'
                        aria-invalid={argumentInvalid}
                        aria-describedby={`${argumentHelpId}${argumentInvalid ? ` ${argumentErrorId}` : ''}`}
                        spellCheck={false}
                        className="w-full px-2 py-1.5 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors resize-y"
                      />
                      <div id={argumentHelpId} className="mt-1 text-[9px] text-bone-faint">
                        Each JSON string is one exact argument; spaces and escapes are preserved.
                      </div>
                      {argumentInvalid && (
                        <div id={argumentErrorId} role="alert" className="mt-1 text-[10px] text-red-200">
                          Enter args as a JSON array of strings.
                        </div>
                      )}
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
                      disabled={saving || hasArgumentErrors}
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

      </fieldset>
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
