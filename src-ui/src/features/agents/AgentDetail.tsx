import { RotateCw, Waypoints } from 'lucide-react';
import type { Agent } from '../../domain/agent-operation-state';
import {
  AlertLine,
  Badge,
  Button,
  Chip,
  formatIsoAge,
  KeyValue,
  Panel,
  PanelHeader,
  StatusLine,
} from '../../design';
import { ChannelBindings } from './ChannelBindings';
import { Monogram } from './Monogram';
import type { Channel } from './types';

/** Detail for one native Agent: identity, system prompt, and Channel bindings. */
export function AgentDetail({
  agent,
  locked,
  channels,
  channelsLoading,
  channelsError,
  onRefreshChannels,
  onOpenChannels,
}: {
  agent: Agent;
  locked: boolean;
  channels: Channel[] | null;
  channelsLoading: boolean;
  channelsError: boolean;
  onRefreshChannels: () => void;
  onOpenChannels: () => void;
}) {
  const prompt = agent.system_prompt.trim();
  return (
    <div className="space-y-4">
      <Panel ticks aria-label={`${agent.name} detail`} className="d-rise">
        <div className="flex items-start gap-4">
          <Monogram name={agent.name} size="lg" muted={!agent.enabled} />
          <div className="min-w-0 flex-1">
            <div className="d-label">Agent</div>
            <div className="d-display mt-0.5 break-words text-[32px] leading-[1.1] text-ink">{agent.name}</div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Badge tone={agent.enabled ? 'ok' : 'warn'} dot>{agent.enabled ? 'enabled' : 'disabled'}</Badge>
              <Chip>{agent.model}</Chip>
              {agent.backend && agent.backend !== 'jarvis' && <Chip className="text-info">{agent.backend}</Chip>}
            </div>
          </div>
        </div>
        {agent.description && <p className="mt-4 max-w-2xl text-[13.5px] leading-relaxed text-ink-2">{agent.description}</p>}

        <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_260px]">
          <div className="min-w-0">
            <div className="d-label mb-1.5">System prompt</div>
            {prompt ? (
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-sunken p-3 font-mono text-[12px] leading-relaxed text-ink-2">
                {prompt}
              </pre>
            ) : (
              <p className="rounded-lg border border-dashed border-line-strong bg-sunken px-3 py-3 text-[12.5px] text-ink-3">
                No system prompt is set on this Agent.
              </p>
            )}
          </div>
          <KeyValue
            className="content-start"
            items={[
              ['Agent id', <span key="id" className="font-mono text-[11.5px]">{agent.id}</span>],
              ['Backend', agent.backend || 'jarvis'],
              ['Created', formatIsoAge(agent.created_at)],
              ['Updated', formatIsoAge(agent.updated_at)],
            ]}
          />
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          icon={<Waypoints aria-hidden="true" />}
          title="Channel bindings"
          description="Messages arriving on a bound Channel are routed to this Agent."
          actions={
            <>
              <Button size="xs" variant="ghost" onClick={onOpenChannels}>Open Channels</Button>
              <Button
                size="xs"
                variant="secondary"
                disabled={channelsLoading}
                onClick={onRefreshChannels}
                icon={<RotateCw aria-hidden="true" />}
              >
                {channelsError ? 'Retry channels' : 'Refresh channels'}
              </Button>
            </>
          }
        />
        <div className="space-y-3">
          {channelsLoading && <StatusLine label="Agent channels">Loading channels…</StatusLine>}
          {channelsError && (
            <AlertLine tone={channels !== null ? 'warn' : 'error'}>
              Channels are unavailable. {channels !== null && 'Showing previously loaded channels; they may be stale.'}
            </AlertLine>
          )}
          {!channelsLoading && !channelsError && channels?.length === 0 && (
            <p className="text-[12.5px] text-ink-3">No channels available.</p>
          )}
          <ChannelBindings
            key={agent.id}
            agent={agent}
            channels={channels ?? []}
            channelsReady={!channelsLoading && !channelsError && channels !== null}
            locked={locked}
          />
        </div>
      </Panel>
    </div>
  );
}
