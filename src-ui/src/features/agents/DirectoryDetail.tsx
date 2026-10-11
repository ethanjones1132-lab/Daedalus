import type { LifecycleAgent } from '../../domain/agent-discovery-state';
import { effectiveLifecycleState, type AgentProjection } from '../../domain/agent-lifecycle-state';
import { Badge, Chip, formatIsoAge, KeyValue, Panel, PanelHeader } from '../../design';
import { directoryStations, shortHash } from './lifecycle-stations';
import { LifecycleTrack } from './LifecycleTrack';
import { Monogram } from './Monogram';
import type { LifecycleOperation } from './types';

const bytes = (n: number | undefined | null) => (n === undefined || n === null ? 'unknown' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/** Detail for one Agent directory: soul.md provenance, its lifecycle track, and the Runtime projection. */
export function DirectoryDetail({
  agent,
  projection,
  operation,
}: {
  agent: LifecycleAgent;
  projection: AgentProjection | undefined;
  operation: LifecycleOperation | undefined;
}) {
  const title = agent.name ?? agent.slug;
  const state = effectiveLifecycleState(agent, projection);
  const stations = directoryStations(agent, projection, operation);
  const description = agent.description ?? projection?.description;
  return (
    <div className="space-y-4">
      <Panel ticks aria-label={`${title} lifecycle`} className="d-rise">
        <div className="flex items-start gap-4">
          <Monogram name={title} size="lg" muted={state !== 'active'} />
          <div className="min-w-0 flex-1">
            <div className="d-label">Agent directory</div>
            <div className="d-display mt-0.5 break-words text-[32px] leading-[1.1] text-ink">{title}</div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Chip>agents/{agent.slug}</Chip>
              <Badge tone={state === 'active' ? 'accent' : state === 'invalid' ? 'error' : state === 'stale' ? 'warn' : 'muted'} dot>
                {state === 'active' ? 'live' : state === 'stale' ? 'behind its source' : state === 'invalid' ? 'blocked' : 'not live'}
              </Badge>
            </div>
          </div>
        </div>

        <div className="mt-5 rounded-lg border border-line bg-sunken p-3 font-mono text-[12px] leading-relaxed text-ink-2">
          <div className="d-label mb-1.5 text-ink-3">soul.md</div>
          <div className="break-all">{agent.source_path ?? 'Source path not reported.'}</div>
          <div className="mt-1 break-all text-ink-3">
            sha256 {agent.source_hash ? agent.source_hash : 'not observed'} · {bytes(agent.source_size_bytes)}
          </div>
          {description && <div className="mt-2.5 border-t border-line pt-2.5 font-sans text-[12.5px] text-ink-2">{description}</div>}
        </div>

        <div className="mt-6">
          <LifecycleTrack stations={stations} label={`Agent lifecycle for ${agent.slug}`} />
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          title="Runtime projection"
          description="Operational state derived from soul.md, with provenance back to the file. It is not a second source of truth."
        />
        {projection ? (
          <KeyValue
            items={[
              ['Projection', `v${projection.projection_version}`],
              ['Status', projection.status],
              ['Source hash', <span key="h" className="font-mono text-[11.5px]">{shortHash(projection.source_hash)}</span>],
              ['Version tag', projection.version_tag ?? 'none'],
              [
                'Tools',
                projection.tools && projection.tools.length > 0 ? (
                  <span key="t" className="flex flex-wrap gap-1">
                    {projection.tools.map((t) => <Chip key={t}>{t}</Chip>)}
                  </span>
                ) : 'none declared',
              ],
              ['Size', bytes(projection.source_size_bytes)],
              ['Activated', projection.activated_at ? formatIsoAge(projection.activated_at) : 'never'],
              ['Deactivated', projection.deactivated_at ? formatIsoAge(projection.deactivated_at) : 'never'],
              ['Updated', formatIsoAge(projection.updated_at)],
            ]}
          />
        ) : (
          <p className="text-[12.5px] text-ink-3">This directory has no Runtime projection yet. Activating it creates one.</p>
        )}
        <p className="mt-4 border-t border-line pt-3 text-[11.5px] leading-snug text-ink-3">
          Activation applies to new work at the Activation boundary. Runs already in flight are not changed.
        </p>
      </Panel>
    </div>
  );
}
