import { invoke } from '@tauri-apps/api/core';
import { useCallback, useReducer, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  AlertLine,
  Badge,
  Button,
  formatIsoAge,
  Page,
  PageHeader,
  Panel,
  Skeleton,
  Stat,
  StatusDot,
  StatusLine,
} from '../../design';
import { initialRegistryState, reduceRegistryState } from '../../domain/action-registry-state';
import { usePolling } from '../../hooks/usePolling';

/*
 * Gateway (legacy) — read-only probe of the legacy gateway port.
 *
 * Backend reality (verified in Rust, commands/system.rs): `running` is a
 * listening-port probe on 19876; `active_connections` and `uptime_seconds`
 * are placeholder fields. They are shown as "Not measured" until Native
 * supplies a measured-field contract. A failed read never infers "stopped": the last observation is
 * kept and labelled stale.
 */

interface GatewayStatus {
  running: boolean;
  port: number;
  active_connections: number;
  uptime_seconds: number;
  version: string;
  timestamp: string;
}



export default function GatewayPage() {
  const [{ snapshot: status, loading, error }, dispatch] = useReducer(
    reduceRegistryState<GatewayStatus>,
    initialRegistryState<GatewayStatus>(),
  );
  const requestId = useRef(0);

  const fetchStatus = useCallback(async () => {
    const id = ++requestId.current;
    dispatch({ type: 'pending', requestId: id });
    try {
      const snapshot = await invoke<GatewayStatus>('get_gateway_status');
      dispatch({ type: 'success', requestId: id, snapshot });
    } catch {
      dispatch({ type: 'failure', requestId: id });
    }
  }, []);

  usePolling(fetchStatus, 10000, [fetchStatus]);

  return (
    <Page>
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-2">
            System
            <Badge tone="muted" size="xs">
              legacy
            </Badge>
          </span>
        }
        title="Gateway"
        description="Legacy status probe: is the old gateway port (19876) listening? It is not the Bun server, and Session turns do not pass through it."
        actions={
          <Button variant="secondary" icon={<RefreshCw />} onClick={fetchStatus} disabled={loading}>
            Refresh
          </Button>
        }
      />

      <div className="space-y-4">
        {loading && (
          <StatusLine label="Gateway observation">{status === null ? 'Checking gateway…' : 'Refreshing gateway status…'}</StatusLine>
        )}
        {error && (
          <AlertLine onRetry={fetchStatus} retryDisabled={loading}>
            <p>
              {status === null
                ? 'Could not load gateway status.'
                : 'Could not refresh gateway status. Showing previously observed gateway status; it may be stale.'}
            </p>
          </AlertLine>
        )}

        {status ? (
          <>
            <Panel ticks className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <StatusDot tone={status.running ? 'ok' : 'error'} size="md" live={status.running && !error} />
              <p className="d-display min-w-0 flex-1 text-[30px] leading-tight text-ink">
                Gateway is {status.running ? 'running' : 'stopped'}
              </p>
              <Badge tone={status.running ? 'ok' : 'error'}>{status.running ? 'online' : 'offline'}</Badge>
              <p className="basis-full text-[12px] text-ink-3">
                Observed {formatIsoAge(status.timestamp)}
                {error && ' · stale'}
              </p>
            </Panel>

            <Panel>
              <div className="grid grid-cols-2 gap-x-6 gap-y-6 md:grid-cols-4">
                <Stat label="Port" value={status.port} sub="listening probe" />
                <Stat label="Version" value={<span className="text-[26px]">{status.version}</span>} />
                <Stat
                  label="Connections"
                  value="Not measured"
                  sub="native placeholder field"
                />
                <Stat
                  label="Uptime"
                  value="Not measured"
                  sub="native placeholder field"
                />
              </div>
            </Panel>
          </>
        ) : (
          loading && (
            <Panel className="space-y-3">
              <Skeleton className="h-6 w-1/3" />
              <Skeleton className="h-3 w-2/3" />
            </Panel>
          )
        )}
      </div>
    </Page>
  );
}
