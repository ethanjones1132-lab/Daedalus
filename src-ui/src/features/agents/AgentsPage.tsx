import { sectionCount } from '../../lib/list-tally';
import { AGENT_RECORD_SCOPE } from '../../domain/agent-routing-scope';
import { type DiscoveryRootVerdict } from '../../domain/agent-discovery-state';
import { Plus, RotateCw } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { agentOperationLocked } from '../../domain/agent-operation-state';
import {
  AlertLine,
  Button,
  ConfirmModal,
  EmptyState,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  Skeleton,
  StatusLine,
} from '../../design';
import { useNavigation } from '../../shell/navigation';
import { AgentDetail } from './AgentDetail';
import { AgentEditorDialog } from './AgentEditorDialog';
import { AgentRow } from './AgentRow';
import { DirectoryDetail } from './DirectoryDetail';
import { DirectoryRow } from './DirectoryRow';
import { aggregateStations } from './lifecycle-stations';
import { LifecycleTrack } from './LifecycleTrack';
import { EMPTY_DRAFT } from './types';
import { useAgentLifecycle } from './useAgentLifecycle';
import { useAgentRecords } from './useAgentRecords';
import { useChannelList } from './useChannelList';

type Selection = { kind: 'agent' | 'directory'; id: string } | null;

/** Fixed empty-root copy per verdict; "no agents" is only said after a read. */
function emptyRootCopy(rootVerdict: DiscoveryRootVerdict | null): string {
  switch (rootVerdict) {
    case 'missing': return 'The configured Agents root does not exist.';
    case 'unreadable': return 'The Agents root cannot be read.';
    case 'unconfigured': return 'No Agents root is configured. Set agents_root under Advanced settings to discover Agent directories.';
    default: return 'No agents discovered in agents root.';
  }
}

/**
 * The honest empty state. The resolved root is never part of the statement;
 * it appears only after the operator clicks "Show resolved path".
 */
function EmptyRootStatement({ rootVerdict, rootResolvedPath }: { rootVerdict: DiscoveryRootVerdict | null; rootResolvedPath: string | null }) {
  const [pathShown, setPathShown] = useState(false);
  const needsContext = rootVerdict !== null && rootVerdict !== 'ok';
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-4 text-[12.5px] text-ink-3">
      <p>{emptyRootCopy(rootVerdict)}</p>
      {needsContext && rootResolvedPath && (
        pathShown
          ? <code className="font-mono text-[11px]">{rootResolvedPath}</code>
          : <Button size="xs" variant="ghost" onClick={() => setPathShown(true)}>Show resolved path</Button>
      )}
    </div>
  );
}

function SectionHeader({ title, count, children }: { title: string; count?: number; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-line bg-sunken/60 px-4 py-2">
      <div className="flex items-baseline gap-2 whitespace-nowrap">
        <h2 className="d-label text-ink-2">{title}</h2>
        {count !== undefined && <span className="font-mono text-[11px] text-ink-3 tabular">{count}</span>}
      </div>
      <div className="-mr-1.5 flex items-center gap-0.5">{children}</div>
    </div>
  );
}

export default function AgentsPage() {
  const records = useAgentRecords();
  const lifecycle = useAgentLifecycle();
  const channels = useChannelList();
  const { params, nonce, navigate } = useNavigation();
  const [selection, setSelection] = useState<Selection>(null);

  // One-shot intent from another surface: open a specific Agent or Agent directory.
  useEffect(() => {
    if (params.agentId) setSelection({ kind: 'agent', id: params.agentId });
    else if (params.slug) setSelection({ kind: 'directory', id: params.slug });
  }, [nonce, params.agentId, params.slug]);

  const { agents, operations, loaded, loading, listError } = records;
  const { discovery, projections, operations: lifecycleOps } = lifecycle;
  const directories = discovery.agents;

  const selectedDirectory = selection?.kind === 'directory' ? directories?.find((d) => d.slug === selection.id) : undefined;
  const selectedAgent = selectedDirectory
    ? undefined
    : (selection?.kind === 'agent' ? agents.find((a) => a.id === selection.id) : undefined) ?? agents[0];

  const stations = useMemo(
    () => aggregateStations(directories, projections, { loading: discovery.loading, error: discovery.error, rootVerdict: discovery.rootVerdict }),
    [directories, projections, discovery.loading, discovery.error, discovery.rootVerdict],
  );

  const editingAgent = records.editingId ? agents.find((a) => a.id === records.editingId) : undefined;
  const deleteAgent = records.pendingDelete ? agents.find((a) => a.id === records.pendingDelete) : undefined;
  const deleteOperation = records.pendingDelete ? operations[records.pendingDelete] : undefined;
  const deleting = deleteOperation?.action === 'delete' && deleteOperation.phase === 'writing';

  const refreshAll = () => {
    if (!records.reading.current) void records.refresh();
    void lifecycle.fetchLifecycle();
    void lifecycle.fetchProjections();
    void channels.refresh();
  };

  return (
    <Page wide>
      <PageHeader
        eyebrow="Build"
        title="Agents"
        description="An Agent is defined by its soul.md in an Agent directory, projected into the runtime, and activated at the Activation boundary."
        actions={
          <>
            <Button variant="ghost" icon={<RotateCw aria-hidden="true" />} onClick={refreshAll}>Refresh all</Button>
            <Button variant="primary" icon={<Plus aria-hidden="true" />} onClick={records.openCreate} disabled={records.createLocked}>New agent</Button>
          </>
        }
      />

      <Panel ticks className="mb-5">
        <PanelHeader
          title="Agent lifecycle"
          description="Discover, validate, project, activate: where every Agent directory in the Agents root stands."
        />
        <LifecycleTrack stations={stations} compact label="Agents root lifecycle" />
      </Panel>

      <p className="mb-4 text-xs text-ink-3">{AGENT_RECORD_SCOPE}</p>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(340px,400px)_minmax(0,1fr)]">
        <Panel flush className="overflow-hidden">
          <SectionHeader title="Agents" count={sectionCount(agents, { loading, failed: listError !== null })} />
          <div className="max-h-[372px] overflow-y-auto">
            {listError && (
              <div className="p-3">
                <AlertLine tone={loaded ? 'warn' : 'error'} onRetry={records.retryRead} retryDisabled={loading}>
                  {listError} {loaded && 'Previously loaded agents may be stale.'}
                </AlertLine>
              </div>
            )}
            {loaded && loading && (
              <div className="px-4 py-2"><StatusLine>Refreshing agents…</StatusLine></div>
            )}
            {!loaded && !listError && (
              <div className="space-y-3 px-4 py-4">
                <StatusLine>Loading agents…</StatusLine>
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
              </div>
            )}
            {loaded && agents.length === 0 && !listError && (
              <EmptyState compact title="No agents yet. Create one to get started." />
            )}
            {loaded && agents.length > 0 && (
              <ul className="divide-y divide-line">
                {agents.map((a) => (
                  <AgentRow
                    key={a.id}
                    agent={a}
                    operation={operations[a.id]}
                    selected={selectedAgent?.id === a.id && !selectedDirectory}
                    listLoading={loading}
                    onSelect={() => setSelection({ kind: 'agent', id: a.id })}
                    onToggle={() => records.toggleEnabled(a)}
                    onEdit={() => records.beginEdit(a.id)}
                    onDelete={() => records.remove(a)}
                    onRetryMutation={(action) => records.retryMutation(a, action)}
                    onRetryRead={records.retryRead}
                  />
                ))}
              </ul>
            )}
          </div>

          <SectionHeader title="Agent directories" count={directories?.length}>
            <Button size="xs" variant="ghost" onClick={() => void lifecycle.fetchLifecycle()} disabled={discovery.loading}>
              {discovery.error ? 'Retry discovery' : 'Refresh discovery'}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => void lifecycle.fetchProjections()} disabled={lifecycle.projectionsLoading}>
              {lifecycle.projectionsError ? 'Retry projections' : 'Refresh projections'}
            </Button>
          </SectionHeader>
          <div className="max-h-[440px] overflow-y-auto">
            {(discovery.loading || (lifecycle.projectionsLoading && projections === null) || discovery.error || lifecycle.projectionsError) && (
              <div className="space-y-2 px-4 py-3">
                {discovery.loading && (
                  <StatusLine label="Agent discovery">
                    {directories === null ? 'Loading agent discovery…' : 'Refreshing agent discovery… Showing previous results.'}
                  </StatusLine>
                )}
                {lifecycle.projectionsLoading && projections === null && (
                  <StatusLine label="Agent projections">Loading Agent projections…</StatusLine>
                )}
                {discovery.error && (
                  <AlertLine label="Agent discovery" tone={directories !== null ? 'warn' : 'error'}>
                    Agent discovery is unavailable. {directories !== null && 'Showing previously discovered agents; they may be stale.'}
                  </AlertLine>
                )}
                {lifecycle.projectionsError && (
                  <AlertLine label="Agent projections" tone={projections !== null ? 'warn' : 'error'}>
                    Agent projections are unavailable. {projections !== null && 'Showing previously observed projections; they may be stale.'}
                  </AlertLine>
                )}
              </div>
            )}
            {!discovery.loading && !discovery.error && directories?.length === 0 && (
              <EmptyRootStatement rootVerdict={discovery.rootVerdict} rootResolvedPath={discovery.rootResolvedPath} />
            )}
            {directories !== null && directories.length > 0 && (
              <ul className="divide-y divide-line">
                {directories.map((d) => {
                  const projection = projections?.find((candidate) => candidate.slug === d.slug);
                  return (
                    <DirectoryRow
                      key={d.slug}
                      agent={d}
                      projection={projection}
                      operation={lifecycleOps[d.slug]}
                      projectionsError={lifecycle.projectionsError}
                      selected={selectedDirectory?.slug === d.slug}
                      onSelect={() => setSelection({ kind: 'directory', id: d.slug })}
                      onActivate={() => void lifecycle.activate(d)}
                      onDeactivate={() => void lifecycle.deactivate(d)}
                      onRetry={() => lifecycle.retry(d)}
                    />
                  );
                })}
              </ul>
            )}
          </div>
        </Panel>

        <div className="min-w-0 lg:sticky lg:top-0" key={selectedDirectory ? `dir:${selectedDirectory.slug}` : `agent:${selectedAgent?.id ?? 'none'}`}>
          {selectedDirectory ? (
            <DirectoryDetail
              agent={selectedDirectory}
              projection={projections?.find((p) => p.slug === selectedDirectory.slug)}
              operation={lifecycleOps[selectedDirectory.slug]}
            />
          ) : selectedAgent ? (
            <AgentDetail
              agent={selectedAgent}
              locked={operations[selectedAgent.id] !== undefined}
              channels={channels.channels}
              channelsLoading={channels.loading}
              channelsError={channels.error}
              onRefreshChannels={() => void channels.refresh()}
              onOpenChannels={() => navigate('channels')}
            />
          ) : (
            <Panel>
              <EmptyState
                compact
                title="Nothing selected"
                description="Select an Agent or an Agent directory to see its details, bindings and lifecycle."
              />
            </Panel>
          )}
        </div>
      </div>

      {records.creating && (
        <AgentEditorDialog
          key="create"
          title="New Agent"
          description="Creates the Agent identity. Bind it to Channels afterwards."
          initial={EMPTY_DRAFT}
          onSave={records.create}
          onClose={records.cancelCreate}
          locked={records.createLocked}
          phase={records.createPhase}
          failureMessage="Could not create the agent. Your draft was kept."
          onRetryRead={records.retryRead}
        />
      )}
      {editingAgent && (
        <AgentEditorDialog
          key={`edit:${editingAgent.id}`}
          title="Edit Agent"
          description="Changes this Agent's identity fields."
          initial={{
            name: editingAgent.name,
            model: editingAgent.model,
            description: editingAgent.description,
            system_prompt: editingAgent.system_prompt,
          }}
          onSave={(draft) => records.saveEdit(editingAgent.id, draft)}
          onClose={records.cancelEdit}
          locked={agentOperationLocked(operations[editingAgent.id])}
          phase={operations[editingAgent.id]?.phase ?? null}
          failureMessage="Could not update the agent. Your draft was kept."
          onRetryRead={records.retryRead}
        />
      )}

      <ConfirmModal
        open={records.pendingDelete !== null && deleteAgent !== undefined}
        message={`Delete agent "${deleteAgent?.name ?? ''}"?`}
        detail={
          deleting
            ? 'Saving deletion. Repeated confirmation will not submit another write.'
            : deleteOperation && agentOperationLocked(deleteOperation)
              ? 'Another change is pending. Removal is unavailable until reconciliation.'
              : 'This cannot be undone.'
        }
        confirmLabel={deleting ? 'Deleting…' : 'Delete'}
        danger
        onConfirm={records.confirmDelete}
        onCancel={() => {
          if (!deleting) records.cancelDelete();
        }}
      />
    </Page>
  );
}
