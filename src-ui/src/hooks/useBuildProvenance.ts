import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  bindFocusRecheck,
  sharedBuildProvenanceStore,
  type BuildProvenanceSnapshot,
  type BuildProvenanceStore,
} from '../components/jarvis/build-provenance';
import type { BuildInfo } from '../components/jarvis/types';

// One native read, one shared store: `BuildBadge` is mounted twice (sidebar
// footer and header) and both mounts must observe the same provenance, so the
// read function has to be a module-level identity rather than a fresh closure
// per component.
const readNativeBuildInfo = (): Promise<unknown> => invoke<BuildInfo>('get_build_info');

interface FocusBinding {
  count: number;
  dispose: () => void;
}

const focusBindings = new WeakMap<BuildProvenanceStore, FocusBinding>();

// Reference-counted so two mounted badges re-check once on focus, not twice,
// and the listener is detached once the last badge unmounts.
function retainFocusRecheck(store: BuildProvenanceStore): void {
  const existing = focusBindings.get(store);
  if (existing) {
    existing.count += 1;
    return;
  }
  focusBindings.set(store, {
    count: 1,
    dispose: bindFocusRecheck(window, () => store.refresh()),
  });
}

function releaseFocusRecheck(store: BuildProvenanceStore): void {
  const existing = focusBindings.get(store);
  if (!existing) return;
  existing.count -= 1;
  if (existing.count > 0) return;
  existing.dispose();
  focusBindings.delete(store);
}

export interface UseBuildProvenance {
  snapshot: BuildProvenanceSnapshot;
  /** Deliberate re-check of the running binary's provenance. */
  recheck: () => void;
}

/**
 * Subscribe to the shared build-provenance observation. The first subscriber
 * starts the check; window focus and the returned `recheck` re-read it, so a
 * source tree that moves after boot stops reading as a clean build.
 */
export function useBuildProvenance(): UseBuildProvenance {
  const store = sharedBuildProvenanceStore(readNativeBuildInfo);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    retainFocusRecheck(store);
    return () => releaseFocusRecheck(store);
  }, [store]);
  const recheck = useCallback(() => store.refresh(), [store]);
  return { snapshot, recheck };
}
