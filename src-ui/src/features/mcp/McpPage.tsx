import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Cable, Globe, Plus, RefreshCw, Terminal, Trash2 } from 'lucide-react';
import {
  AlertLine,
  Badge,
  Button,
  Chip,
  ConfirmModal,
  EmptyState,
  Field,
  Input,
  KeyValue,
  Page,
  PageHeader,
  Panel,
  Skeleton,
  StatusDot,
  StatusLine,
  Textarea,
  cn,
  useToast,
} from '../../design';
import { decodeMcpArguments, encodeMcpArguments } from '../../domain/mcp-argument-codec';
import { emptyMcpServerEntry, type McpServerEntry, type McpServerMap } from '../../domain/types';

/*
 * MCP — the `.mcp.json` `mcpServers` map, exposed by list_mcp_servers /
 * save_mcp_servers (src-tauri/src/commands/mcp.rs). The Bun server's Tool
 * runtime reads the same file; this page only edits configuration. Nothing
 * here connects to a server, so tool counts and liveness are "not measured".
 *
 * Drafts stay local until Save. Args are held as raw text (`argumentDrafts`)
 * so invalid JSON survives typing; invalid args block add/remove/save/retry.
 */

const LOAD_ERROR = 'Could not load MCP servers.';

function transportOf(entry: McpServerEntry): 'stdio' | 'http' | 'unset' {
  if (entry.url && entry.url.trim()) return 'http';
  if (entry.command && entry.command.trim()) return 'stdio';
  return 'unset';
}

export default function McpPage() {
  const [servers, setServers] = useState<McpServerMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [argumentDrafts, setArgumentDrafts] = useState<Record<string, string>>({});
  const [argumentErrors, setArgumentErrors] = useState<Record<string, boolean>>({});
  const [newName, setNewName] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
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
      setArgumentDrafts(
        Object.fromEntries(Object.entries(s).map(([name, server]) => [name, encodeMcpArguments(server.args)])),
      );
      setArgumentErrors({});
    } catch {
      // Native errors may embed configuration values; show a fixed message.
      setError(LOAD_ERROR);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
    setSelected(name);
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
    setSelected(null);
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

  const header = (
    <PageHeader
      eyebrow="Connect"
      title="MCP"
      description="Model Context Protocol servers declared in .mcp.json. The Bun server's Tool runtime reads this file; edits here are drafts until you save."
      actions={
        <Button variant="ghost" icon={<RefreshCw />} onClick={load} disabled={loading || saving} aria-label="Reload MCP servers">
          Reload
        </Button>
      }
    />
  );

  if (loading) {
    return (
      <Page>
        {header}
        <div className="space-y-3">
          <StatusLine>Loading MCP servers…</StatusLine>
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      </Page>
    );
  }
  if (error) {
    return (
      <Page>
        {header}
        <AlertLine onRetry={load}>{error}</AlertLine>
      </Page>
    );
  }
  if (!servers) return <Page>{header}</Page>;

  const names = Object.keys(servers).sort();
  const activeName = selected !== null && servers[selected] ? selected : (names[0] ?? null);
  const active = activeName !== null ? servers[activeName] : null;
  const enabledCount = names.filter((n) => !servers[n].disabled).length;

  const argumentInputBase = activeName !== null ? `mcp-args-${encodeURIComponent(activeName)}` : '';
  const argumentInvalid = activeName !== null && argumentErrors[activeName] === true;
  const argumentValue = activeName !== null && active ? (argumentDrafts[activeName] ?? encodeMcpArguments(active.args)) : '';

  return (
    <Page wide>
      {header}

      <div className="mb-4 space-y-2 empty:hidden">
        {saving && <StatusLine>Saving MCP draft… Changes are not yet saved.</StatusLine>}
        {saveError && (
          <AlertLine onRetry={saveAll} retryDisabled={saving || hasArgumentErrors}>
            Could not save .mcp.json. Your draft is kept; changes are not yet saved.
          </AlertLine>
        )}
      </div>

      <fieldset disabled={saving} className="m-0 min-w-0 border-0 p-0">
        <div className="grid items-start gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
          {/* ── Servers ─────────────────────────────────────────── */}
          <Panel flush>
            <div className="border-b border-line p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="d-label">Add MCP server</span>
                <span className="font-mono text-[11px] tabular text-ink-3">
                  {enabledCount}/{names.length} enabled
                </span>
              </div>
              <div className="flex gap-2">
                <Input
                  mono
                  type="text"
                  aria-label="Server name"
                  value={newName}
                  onChange={(e) => {
                    if (!savePendingRef.current) setNewName(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addServer();
                  }}
                  placeholder="server name (e.g. filesystem)"
                />
                <Button variant="secondary" icon={<Plus />} onClick={addServer} disabled={!newName.trim() || saving || hasArgumentErrors}>
                  Add
                </Button>
              </div>
            </div>

            {names.length === 0 ? (
              <EmptyState
                compact
                icon={<Cable />}
                title='No MCP servers configured. Add one above, or create .mcp.json with an "mcpServers" object.'
              />
            ) : (
              <ul className="divide-y divide-line">
                {names.map((name) => {
                  const s = servers[name];
                  const transport = transportOf(s);
                  const isActive = name === activeName;
                  return (
                    <li key={name}>
                      <button
                        type="button"
                        aria-current={isActive ? 'true' : undefined}
                        onClick={() => setSelected(name)}
                        className={cn(
                          'relative flex w-full items-center gap-3 px-4 py-3 text-left transition-colors',
                          isActive ? 'bg-raised' : 'hover:bg-hover',
                          s.disabled && 'opacity-60',
                        )}
                      >
                        {isActive && <span aria-hidden="true" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" />}
                        <span
                          aria-hidden="true"
                          className="flex size-8 shrink-0 items-center justify-center rounded-[7px] border border-line-strong bg-sunken text-ink-3"
                        >
                          {transport === 'http' ? <Globe className="size-4" /> : <Terminal className="size-4" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-[12.5px] text-ink">{name}</span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-3">
                            <StatusDot tone={s.disabled ? 'muted' : 'ok'} />
                            {s.disabled ? 'disabled' : 'on'} · {transport}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          {/* ── Detail ──────────────────────────────────────────── */}
          {active && activeName !== null ? (
            <Panel flush ticks className={cn(active.disabled && 'opacity-90')}>
              <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
                <div className="min-w-0 flex-1">
                  <h2 className="d-label text-accent">Server configuration</h2>
                  <p className="mt-1 truncate font-mono text-[14px] text-ink">{`mcpServers.${activeName}`}</p>
                  <p className="mt-0.5 text-[12px] text-ink-3">Save writes the whole mcpServers map to .mcp.json.</p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => updateServer(activeName, { disabled: !active.disabled })}
                  icon={<StatusDot tone={active.disabled ? 'muted' : 'ok'} />}
                >
                  {active.disabled ? 'Disabled' : 'Enabled'}
                </Button>
                <Button
                  variant="danger"
                  icon={<Trash2 />}
                  onClick={() => {
                    if (!savePendingRef.current && !hasArgumentErrors) setPendingDelete(activeName);
                  }}
                  disabled={hasArgumentErrors}
                >
                  Remove
                </Button>
                <Button variant="primary" onClick={saveAll} disabled={saving || hasArgumentErrors} busy={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </div>

              <div className="grid gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_240px]">
                <div className="space-y-4">
                  <Field label="Command">
                    {(id) => (
                      <Input
                        id={id}
                        mono
                        type="text"
                        value={active.command ?? ''}
                        onChange={(e) => updateServer(activeName, { command: e.target.value })}
                        placeholder="npx"
                      />
                    )}
                  </Field>

                  <Field label="Args (JSON array)">
                    {(id) => (
                      <>
                        <Textarea
                          id={id}
                          mono
                          rows={3}
                          value={argumentValue}
                          onChange={(e) => updateArguments(activeName, e.target.value)}
                          placeholder='["-y","@modelcontextprotocol/server-filesystem"]'
                          aria-invalid={argumentInvalid}
                          aria-describedby={`${argumentInputBase}-help${argumentInvalid ? ` ${argumentInputBase}-error` : ''}`}
                          spellCheck={false}
                        />
                        <p id={`${argumentInputBase}-help`} className="text-[11.5px] leading-snug text-ink-3">
                          Each JSON string is one exact argument; spaces and escapes are preserved.
                        </p>
                        {argumentInvalid && (
                          <p id={`${argumentInputBase}-error`} role="alert" className="text-[12px] text-err">
                            Enter args as a JSON array of strings.
                          </p>
                        )}
                      </>
                    )}
                  </Field>

                  <Field label="URL" hint="For a remote/HTTP MCP server instead of a command.">
                    {(id) => (
                      <Input
                        id={id}
                        mono
                        type="text"
                        value={active.url ?? ''}
                        onChange={(e) => updateServer(activeName, { url: e.target.value })}
                        placeholder="https://example.com/mcp"
                      />
                    )}
                  </Field>
                </div>

                <aside className="space-y-3 rounded-lg border border-line bg-sunken p-4">
                  <span className="d-label block pb-1">Readout</span>
                  <KeyValue
                    items={[
                      ['transport', <Chip key="t">{transportOf(active)}</Chip>],
                      ['state', active.disabled ? <Badge key="s" tone="muted">disabled</Badge> : <Badge key="s" tone="ok">enabled</Badge>],
                      ['tools', <span key="tools" className="text-ink-3">not measured</span>],
                      ['env', `${Object.keys(active.env ?? {}).length} kept`],
                      ...(active.cwd ? ([['cwd', <span key="cwd" className="font-mono text-[11.5px]">{active.cwd}</span>]] as Array<[string, React.ReactNode]>) : []),
                    ]}
                  />
                  <p className="text-[11.5px] leading-relaxed text-ink-3">
                    Jarvis does not connect to this server from here, so tool counts and liveness are not measured. Environment
                    variables are preserved untouched on save.
                  </p>
                </aside>
              </div>
            </Panel>
          ) : (
            <Panel>
              <EmptyState compact title="Select or add a server to edit its configuration." />
            </Panel>
          )}
        </div>
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
    </Page>
  );
}
