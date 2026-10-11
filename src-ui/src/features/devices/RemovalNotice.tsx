import { AlertLine, StatusLine } from '../../design';
import type { RemovalOperation } from '../../domain/removal-state';

/** Per-row removal feedback shared by Devices and Nodes. */
export function RemovalNotice<T>({
  operation,
  noun,
  onRetryRemove,
  onRetryRead,
  reading,
}: {
  operation: RemovalOperation<T> | undefined;
  /** Singular noun, e.g. "device". */
  noun: string;
  onRetryRemove: () => void;
  onRetryRead: () => void;
  reading: boolean;
}) {
  if (!operation) return null;
  return (
    <div className="mt-2">
      {operation.phase === 'writing' && <StatusLine>Saving removal…</StatusLine>}
      {operation.phase === 'reconciling' && <StatusLine>Removal saved. Reconciling {noun}s…</StatusLine>}
      {operation.phase === 'write-failed' && (
        <AlertLine onRetry={onRetryRemove}>Could not remove the {noun}. Confirmed state was kept.</AlertLine>
      )}
      {operation.phase === 'read-failed' && (
        <AlertLine onRetry={onRetryRead} retryDisabled={reading}>
          Removal was saved, but the {noun} list could not be reconciled. Showing previous state. Retry reloads the list only.
        </AlertLine>
      )}
    </div>
  );
}
