import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Play, RotateCw, Square } from 'lucide-react';
import {
  AlertLine,
  Badge,
  Button,
  Chip,
  IconButton,
  KeyValue,
  Panel,
  PanelHeader,
  RowList,
  Skeleton,
  StatusDot,
  StatusLine,
  type Tone,
} from '../../design';
import { buildProvenanceView } from '../../domain/build-provenance';
import { projectHealthSubsystems, type HealthSubsystemState } from '../../domain/health-banner-subsystems';
import type { JarvisStatus } from '../../domain/types';
import { useBuildProvenance } from '../../hooks/useBuildProvenance';

const DOT_TONE: Record<HealthSubsystemState, Tone> = { up: 'ok', down: 'error', unknown: 'warn', unprobed: 'muted' };
const STATE_TEXT: Record<HealthSubsystemState, string> = {
  up: 'text-ok',
  down: 'text-err',
  unknown: 'text-warn',
  unprobed: 'text-ink-3',
};

/**
 * The persisted Inference backend as `jarvis_check_status` sees it: which
 * backend is active, the model, and the two requirements the gauges cannot
 * show (the local model, the OpenRouter key). Each row says what was measured
 * and whether the active backend needs it at all.
 */
export function BackendPanel({
  status,
  statusLoading,
  onRefresh,
}: {
  status: JarvisStatus | null;
  statusLoading: boolean;
  onRefresh: () => void;
}) {
  const subsystems = projectHealthSubsystems(status);
  const rows = subsystems.rows.filter((row) => row.key === 'model' || row.key === 'openrouter_key');
  return (
    <Panel>
      <PanelHeader
        title="Inference backend"
        description="What the active backend needs, as last reported by the native shell."
        actions={
          <IconButton aria-label="Refresh status" title="Refresh status" disabled={statusLoading} onClick={onRefresh}>
            <RotateCw aria-hidden="true" />
          </IconButton>
        }
      />
      {status ? (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge tone="accent">{status.active_backend}</Badge>
            {status.model && <Chip>{status.model}</Chip>}
          </div>
          <RowList className="-mx-1">
            {rows.map((row) => (
              <li key={row.key} aria-label={row.announcement} className="flex items-center gap-2.5 px-1 py-2 text-[12.5px]">
                <StatusDot tone={DOT_TONE[row.state]} />
                <span className="text-ink">{row.name}</span>
                <span className={STATE_TEXT[row.state]}>{row.stateWord}</span>
                <span className="text-ink-4">· {row.requirementLabel}</span>
                {/* The model row's detail is the model id, already shown as the chip above. */}
                {row.detail && row.key !== 'model' && (
                  <span className="ml-auto truncate font-mono text-[11px] text-ink-3">{row.detail}</span>
                )}
              </li>
            ))}
          </RowList>
        </>
      ) : (
        <div className="space-y-2.5" aria-hidden="true">
          <Skeleton className="w-40" />
          <Skeleton className="w-full" />
          <Skeleton className="w-3/4" />
        </div>
      )}
    </Panel>
  );
}

const PROVENANCE_BADGE: Record<'clean' | 'stale' | 'unverifiable', { tone: Tone; label: string }> = {
  clean: { tone: 'ok', label: 'Matches source' },
  stale: { tone: 'warn', label: 'Rebuild needed' },
  unverifiable: { tone: 'accent', label: 'Not checked' },
};

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 9) : '—';
}

/**
 * Build provenance on the Health page. Reads the same shared store as the
 * titlebar `BuildBadge`, so the two show one observation: one native read at
 * boot, one re-check per window focus, one deliberate re-check on demand.
 */
export function ProvenancePanel() {
  const { snapshot, recheck } = useBuildProvenance();
  const view = buildProvenanceView(snapshot);
  const info = snapshot.info;
  const badge = PROVENANCE_BADGE[view.state];
  return (
    <Panel>
      <PanelHeader
        title="Build provenance"
        description="Whether the running binary matches the source tree it was built from."
        actions={
          <Button size="xs" variant="secondary" icon={<RotateCw aria-hidden="true" />} busy={view.checking} onClick={recheck} aria-label="Recheck build provenance">
            Recheck
          </Button>
        }
      />
      <div className="mb-3 flex items-start gap-2.5">
        <Badge tone={view.checking ? 'neutral' : badge.tone} dot>
          {view.checking ? 'Checking' : badge.label}
        </Badge>
        <p className="min-w-0 text-[12.5px] leading-snug text-ink-2">{view.sentence}</p>
      </div>
      <KeyValue
        items={[
          ['Version', info ? view.versionLabel : '—'],
          ['Commit', info ? `${info.git_short || shortSha(info.git_sha)}${info.dirty ? ' (dirty build)' : ''}` : '—'],
          ['Source', info ? shortSha(info.source_sha) : '—'],
          ['Built', info?.build_time || '—'],
        ]}
      />
    </Panel>
  );
}

type BridgePhase = { phase: 'idle' } | { phase: 'working'; action: 'start' | 'stop' } | { phase: 'failed'; action: 'start' | 'stop' };

/** Bridge lifecycle without restarting anything else. */
export function BridgeActionsPanel({ onChanged }: { onChanged: () => void }) {
  const [state, setState] = useState<BridgePhase>({ phase: 'idle' });
  const run = async (action: 'start' | 'stop') => {
    if (state.phase === 'working') return;
    setState({ phase: 'working', action });
    try {
      await invoke(action === 'start' ? 'jarvis_start_bridge' : 'jarvis_stop_bridge');
      setState({ phase: 'idle' });
      onChanged();
    } catch (e) {
      console.error(`Failed to ${action} bridge:`, e);
      setState({ phase: 'failed', action });
    }
  };
  const working = state.phase === 'working';
  return (
    <Panel>
      <PanelHeader title="Quick actions" description="Start or stop the bridge listener without restarting the Bun server." />
      {state.phase === 'working' && (
        <StatusLine label="Bridge operation" className="mb-3">
          {state.action === 'start' ? 'Starting bridge…' : 'Stopping bridge…'}
        </StatusLine>
      )}
      {state.phase === 'failed' && (
        <AlertLine
          label="Bridge operation"
          tone="warn"
          className="mb-3"
          retryText="Retry"
          retryLabel={`Retry ${state.action} bridge`}
          onRetry={() => void run(state.action)}
        >
          Could not {state.action} the bridge.
        </AlertLine>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" icon={<Play aria-hidden="true" />} disabled={working} onClick={() => void run('start')}>
          Start Bridge
        </Button>
        <Button variant="secondary" icon={<Square aria-hidden="true" />} disabled={working} onClick={() => void run('stop')}>
          Stop Bridge
        </Button>
      </div>
    </Panel>
  );
}
