import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Network, RefreshCw, Trash2 } from 'lucide-react';
import {
  AlertLine,
  Badge,
  Button,
  Chip,
  ConfirmModal,
  EmptyState,
  IconButton,
  Input,
  Page,
  PageHeader,
  Panel,
  RowList,
  Skeleton,
  StatusDot,
  StatusLine,
  type Tone,
} from '../../design';
import { removalLocked } from '../../domain/removal-state';
import { RemovalNotice } from '../devices/RemovalNotice';
import { useRemovableList } from '../devices/useRemovableList';

/*
 * Nodes — registered distributed compute nodes (get_nodes / add_node /
 * remove_node).
 *
 * Backend reality (verified in Rust): new nodes are stored with
 * status "unknown", latency null, and no capabilities, and nothing pings them.
 * "unknown" is therefore rendered as "not pinged" and a null latency as "not
 * measured" — never as a number or a green dot.
 */

interface ComputeNode {
  id: string;
  name: string;
  address: string;
  status: string;
  latency_ms: number | null;
  last_ping: string;
  capabilities: string[];
}

function statusTone(status: string): Tone {
  const v = status.toLowerCase();
  if (v === 'online' || v === 'connected' || v === 'ok') return 'ok';
  if (v === 'unknown') return 'muted';
  return 'neutral';
}

const COLUMNS = 'grid grid-cols-[minmax(0,1.3fr)_minmax(0,1.2fr)_130px_100px_minmax(0,1fr)_32px] items-center gap-4';

export default function NodesPage() {
  const list = useRemovableList<ComputeNode>({ listCommand: 'get_nodes', removeCommand: 'remove_node' });
  const { rows: nodes, loading, loaded, error, operations } = list;
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const canAdd = Boolean(name.trim() && address.trim());

  const add = () => {
    if (!canAdd) return;
    const trimmedName = name.trim();
    const trimmedAddress = address.trim();
    void list.create(
      () => invoke<ComputeNode>('add_node', { name: trimmedName, address: trimmedAddress }),
      `Added node ${trimmedName}`,
      () => {
        setName('');
        setAddress('');
      },
    );
  };

  return (
    <Page>
      <ConfirmModal
        open={list.pendingDelete !== null}
        message={`Remove node "${list.pendingDelete?.name}"?`}
        detail={list.deleting ? 'Saving removal. Repeated confirmation will not submit another write.' : undefined}
        confirmLabel={list.deleting ? 'Removing…' : 'Remove'}
        danger
        onConfirm={list.confirmDelete}
        onCancel={list.cancelDelete}
      />

      <PageHeader
        eyebrow="Connect"
        title="Nodes"
        description="Distributed compute nodes registered with this Jarvis. Nodes are not pinged today, so reachability and latency are shown as not measured."
        actions={
          <Button variant="ghost" icon={<RefreshCw />} onClick={list.retryRead} disabled={loading} aria-label="Refresh nodes">
            Refresh
          </Button>
        }
      />

      <div className="space-y-4">
        {list.createError && (
          <AlertLine onRetry={add} retryDisabled={list.creating || !canAdd}>
            Could not add the node. Your draft was kept.
          </AlertLine>
        )}

        <Panel>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="min-w-[180px] flex-1"
              aria-label="Node name"
              placeholder="Node name"
              disabled={list.creating}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              mono
              className="min-w-[200px] flex-1"
              aria-label="Node address"
              placeholder="Address (host:port)"
              disabled={list.creating}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add();
              }}
            />
            <Button variant="primary" size="md" onClick={add} disabled={list.creating || !canAdd} busy={list.creating}>
              {list.creating ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </Panel>

        <Panel flush>
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <h2 className="text-[13px] font-semibold text-ink">Registered nodes</h2>
            <span className="font-mono text-[11px] tabular text-ink-3">{nodes.length}</span>
          </div>

          {!loaded && loading ? (
            <div className="space-y-3 px-4 py-5">
              <StatusLine>Loading nodes…</StatusLine>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !loaded && error ? (
            <div className="p-4">
              <AlertLine onRetry={list.retryRead}>{error}</AlertLine>
            </div>
          ) : !loaded ? null : (
            <>
              {(error || loading) && (
                <div className="space-y-2 px-4 pt-3">
                  {error && (
                    <AlertLine onRetry={list.retryRead} retryDisabled={loading}>
                      <span>{error}</span> Previously loaded nodes may be stale.
                    </AlertLine>
                  )}
                  {loading && <StatusLine>Refreshing nodes…</StatusLine>}
                </div>
              )}
              {nodes.length === 0 ? (
                !error &&
                !loading && (
                  <EmptyState icon={<Network />} title="No nodes registered yet." description="Register a node by host and port above." />
                )
              ) : (
                <>
                  <div aria-hidden="true" className={`${COLUMNS} d-label border-b border-line px-4 py-2`}>
                    <span>Node</span>
                    <span>Address</span>
                    <span>Recorded status</span>
                    <span>Latency</span>
                    <span>Capabilities</span>
                    <span />
                  </div>
                  <RowList>
                    {nodes.map((n) => {
                      const operation = operations[n.id];
                      const locked = removalLocked(operation);
                      const tone = statusTone(n.status);
                      const unknown = n.status.toLowerCase() === 'unknown';
                      return (
                        <li key={n.id} className="px-4 py-3">
                          <div className={COLUMNS}>
                            <div className="flex min-w-0 items-center gap-2.5">
                              <StatusDot tone={tone} />
                              <span className="truncate text-[13.5px] font-medium text-ink">{n.name}</span>
                            </div>
                            <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-2">{n.address}</span>
                            <div>
                              <Badge tone={tone}>{unknown ? 'not pinged' : n.status}</Badge>
                            </div>
                            <span className="font-mono text-[11.5px] tabular text-ink-3">
                              {n.latency_ms != null ? `${n.latency_ms}ms` : 'not measured'}
                            </span>
                            <div className="flex min-w-0 flex-wrap gap-1">
                              {n.capabilities.length === 0 ? (
                                <span className="text-[11.5px] text-ink-4">none declared</span>
                              ) : (
                                n.capabilities.map((c) => <Chip key={c}>{c}</Chip>)
                              )}
                            </div>
                            <IconButton
                              variant="danger"
                              size="xs"
                              aria-label="Remove"
                              title="Remove node"
                              onClick={() => list.remove(n)}
                              disabled={locked}
                            >
                              <Trash2 />
                            </IconButton>
                          </div>
                          <RemovalNotice
                            operation={operation}
                            noun="node"
                            onRetryRemove={() => list.remove(n)}
                            onRetryRead={list.retryRead}
                            reading={loading}
                          />
                        </li>
                      );
                    })}
                  </RowList>
                </>
              )}
            </>
          )}
        </Panel>
      </div>
    </Page>
  );
}
