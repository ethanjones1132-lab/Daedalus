import { AlertLine, StatusLine } from '../../design';

/** The slice of a native resource an observation line needs. */
export interface ObservedResource {
  loading: boolean;
  error: boolean;
  snapshot: unknown;
  load: () => Promise<unknown>;
}

export interface ObservationCopy {
  loading: string;
  refreshing: string;
  failed: string;
  failedWithSnapshot: string;
}

/** Default honest-state copy for a named resource. */
export function defaultCopy(noun: string): ObservationCopy {
  return {
    loading: `Loading ${noun}…`,
    refreshing: `Refreshing ${noun}…`,
    failed: `Could not load ${noun}.`,
    failedWithSnapshot: `Could not load ${noun}. Showing previously observed data; it may be stale.`,
  };
}

/**
 * Pending / failed / stale feedback for one native resource, placed directly
 * under the masthead. Pending is not empty and failed is not empty: a failed
 * refresh keeps the last snapshot on screen, says so, and offers a Retry that
 * re-reads only this resource.
 */
export function Observation({
  name,
  resource,
  copy,
  retryLabel,
}: {
  /** Accessible name stem: the live regions are named "<name> observation". */
  name: string;
  resource: ObservedResource;
  copy: ObservationCopy;
  retryLabel: string;
}) {
  const hasSnapshot = resource.snapshot !== null;
  return (
    <>
      {resource.loading && (
        <StatusLine label={`${name} observation`}>{hasSnapshot ? copy.refreshing : copy.loading}</StatusLine>
      )}
      {resource.error && (
        <AlertLine
          label={`${name} observation`}
          tone="warn"
          retryText="Retry"
          retryLabel={retryLabel}
          retryDisabled={resource.loading}
          onRetry={() => void resource.load()}
        >
          {hasSnapshot ? copy.failedWithSnapshot : copy.failed}
        </AlertLine>
      )}
    </>
  );
}
