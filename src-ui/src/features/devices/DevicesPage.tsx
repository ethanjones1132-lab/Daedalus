import { useState } from 'react';
import { Laptop, Monitor, RefreshCw, Server, Smartphone, Tablet, Trash2, Cpu, type LucideIcon } from 'lucide-react';
import {
  AlertLine,
  Badge,
  Button,
  Chip,
  ConfirmModal,
  EmptyState,
  formatIsoAge,
  IconButton,
  Input,
  Page,
  PageHeader,
  Panel,
  RowList,
  Select,
  Skeleton,
  StatusLine,
} from '../../design';
import { removalLocked } from '../../domain/removal-state';
import { RemovalNotice } from './RemovalNotice';
import { useRemovableList } from './useRemovableList';
import { invoke } from '@tauri-apps/api/core';

/*
 * Devices — paired devices (get_devices / add_device / remove_device).
 *
 * Backend reality (verified in Rust): the store is a thin JSON list. New
 * devices are always recorded as "online" and nothing ever updates `status` or
 * `last_seen`, so those columns are shown as *recorded at pairing*, never as a
 * live signal.
 */

interface Device {
  id: string;
  name: string;
  device_type: string;
  status: string;
  last_seen: string;
}

const DEVICE_TYPES = ['desktop', 'laptop', 'phone', 'tablet', 'server', 'iot'];

const TYPE_ICONS: Record<string, LucideIcon> = {
  desktop: Monitor,
  laptop: Laptop,
  phone: Smartphone,
  tablet: Tablet,
  server: Server,
  iot: Cpu,
};

function recordedAt(ts: string): { absolute: string; relative: string } | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return { absolute: ts, relative: '' };
  return { absolute: d.toLocaleString(), relative: formatIsoAge(ts) };
}

const COLUMNS = 'grid grid-cols-[minmax(0,1.6fr)_96px_minmax(0,1fr)_minmax(0,1.2fr)_32px] items-center gap-4';

export default function DevicesPage() {
  const list = useRemovableList<Device>({ listCommand: 'get_devices', removeCommand: 'remove_device' });
  const { rows: devices, loading, loaded, error, operations } = list;
  const [name, setName] = useState('');
  const [type, setType] = useState(DEVICE_TYPES[0]);

  const add = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void list.create(
      () => invoke<Device>('add_device', { name: trimmed, deviceType: type }),
      (confirmed) => `Added device ${confirmed.name}`,
      () => setName(''),
    );
  };

  return (
    <Page>
      <ConfirmModal
        open={list.pendingDelete !== null}
        message={`Remove device "${list.pendingDelete?.name}"?`}
        detail={list.deleting ? 'Saving removal. Repeated confirmation will not submit another write.' : undefined}
        confirmLabel={list.deleting ? 'Removing…' : 'Remove'}
        danger
        onConfirm={list.confirmDelete}
        onCancel={list.cancelDelete}
      />

      <PageHeader
        eyebrow="Connect"
        title="Devices"
        description="Devices paired with this Jarvis. Status and last-seen are recorded at pairing; Jarvis does not probe devices, so they are not live signals."
        actions={
          <Button variant="ghost" icon={<RefreshCw />} onClick={list.retryRead} disabled={loading} aria-label="Refresh devices">
            Refresh
          </Button>
        }
      />

      <div className="space-y-4">
        {list.createError && (
          <AlertLine onRetry={list.createCanRetry ? add : undefined} retryDisabled={list.creating || !name.trim()}>
            {list.createMessage}
          </AlertLine>
        )}

        <Panel>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="min-w-[200px] flex-1"
              aria-label="Device name"
              placeholder="Device name"
              disabled={list.creating}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add();
              }}
            />
            <Select aria-label="Device type" className="w-[130px]" disabled={list.creating} value={type} onChange={(e) => setType(e.target.value)}>
              {DEVICE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
            <Button variant="primary" size="md" onClick={add} disabled={list.creating || !name.trim()} busy={list.creating}>
              {list.creating ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </Panel>

        <Panel flush>
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <h2 className="text-[13px] font-semibold text-ink">Paired devices</h2>
            <span className="font-mono text-[11px] tabular text-ink-3">{devices.length}</span>
          </div>

          {!loaded && loading ? (
            <div className="space-y-3 px-4 py-5">
              <StatusLine>Loading devices…</StatusLine>
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
                      <span>{error}</span> Previously loaded devices may be stale.
                    </AlertLine>
                  )}
                  {loading && <StatusLine>Refreshing devices…</StatusLine>}
                </div>
              )}
              {devices.length === 0 ? (
                !error &&
                !loading && (
                  <EmptyState icon={<Monitor />} title="No devices paired yet." description="Add a device above to record it here." />
                )
              ) : (
                <>
                  <div aria-hidden="true" className={`${COLUMNS} d-label border-b border-line px-4 py-2`}>
                    <span>Device</span>
                    <span>Type</span>
                    <span>Recorded status</span>
                    <span>Last seen (recorded)</span>
                    <span />
                  </div>
                  <RowList>
                    {devices.map((d) => {
                      const operation = operations[d.id];
                      const locked = removalLocked(operation);
                      const Icon = TYPE_ICONS[d.device_type] ?? Monitor;
                      const seen = recordedAt(d.last_seen);
                      return (
                        <li key={d.id} className="px-4 py-3">
                          <div className={COLUMNS}>
                            <div className="flex min-w-0 items-center gap-2.5">
                              <Icon aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
                              <span className="truncate text-[13.5px] font-medium text-ink">{d.name}</span>
                            </div>
                            <div>
                              <Chip>{d.device_type}</Chip>
                            </div>
                            <div>
                              <Badge tone="muted">{d.status}</Badge>
                            </div>
                            <div className="min-w-0 truncate font-mono text-[11.5px] text-ink-3">
                              {seen ? (
                                <span title={seen.absolute}>
                                  {seen.relative && <span className="mr-2 text-ink-2">{seen.relative}</span>}
                                  <span className="text-ink-4">{seen.absolute}</span>
                                </span>
                              ) : (
                                'not recorded'
                              )}
                            </div>
                            <IconButton
                              variant="danger"
                              size="xs"
                              aria-label="Remove"
                              title="Remove device"
                              onClick={() => list.remove(d)}
                              disabled={locked}
                            >
                              <Trash2 />
                            </IconButton>
                          </div>
                          <RemovalNotice
                            operation={operation}
                            noun="device"
                            onRetryRemove={() => list.remove(d)}
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
