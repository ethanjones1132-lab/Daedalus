export interface Channel {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown> | null;
  last_used: string | null;
  connected: boolean;
  created_at: string;
  updated_at: string;
}

type Connection = Pick<Channel, 'connected' | 'config'>;
export function isConnected(channel: Connection): boolean {
  return channel.connected || channel.config?.connected === true;
}

export interface ChannelOperation<T> {
  row: T;
  action: 'connect' | 'disconnect' | 'remove';
  phase: 'writing' | 'write-failed' | 'reconciling' | 'read-failed';
  // A read started before settlement cannot confirm this write.
  after: number;
}

export function channelLocked<T>(operation: ChannelOperation<T> | undefined): boolean {
  return !!operation && operation.phase !== 'write-failed';
}

export function reconcileChannels<T extends Connection & { id: string }>(
  snapshot: T[], operations: Record<string, ChannelOperation<T>>, request: number,
): { rows: T[]; operations: Record<string, ChannelOperation<T>> } {
  const rows = [...snapshot];
  const next = { ...operations };
  for (const [id, operation] of Object.entries(operations)) {
    const observed = snapshot.find(row => row.id === id);
    if (operation.phase !== 'writing' && request > operation.after) {
      if (operation.phase === 'write-failed'
        || (operation.action === 'remove' ? !observed
          : observed && isConnected(observed) === (operation.action === 'connect'))) {
        delete next[id];
        continue;
      }
      next[id] = { ...operation, phase: 'read-failed' };
    }
    // Keep the last confirmed row, disabled, until readback matches the write.
    const index = rows.findIndex(row => row.id === id);
    if (index < 0) rows.push(operation.row);
    else rows[index] = operation.row;
  }
  return { rows, operations: next };
}
