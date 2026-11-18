// ═══════════════════════════════════════════════════════════════
// ── BackendSetupNotice — first-run setup state for the backend
// ═══════════════════════════════════════════════════════════════
//
// DD-060: with no usable inference backend the shell used to render as if one
// existed — boot wrote an `eprintln!` and the first chat produced an empty
// transcript. This band mounts before the routed page, reads the Native
// derivation (`get_backend_readiness`) and names the exact blank setting plus
// where it is edited. It hides itself the moment the config is filled in.
//
// It renders nothing when the read fails or the payload is unreadable: a
// fabricated setup state is as dishonest as the silent empty chat it replaces.

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Settings2 } from 'lucide-react';
import { AlertLine, Button } from '../../design';
import { backendDisplayName } from '../../lib/backend-identity';
import {
  hasOwnSentence,
  joinMissingSettings,
  needsBackendSetup,
  parseBackendReadiness,
  type BackendReadiness,
} from '../../lib/backend-readiness';
import { useNavigation } from '../../shell/navigation';

export const BACKEND_SETUP_NOTICE_LABEL = 'Inference backend setup';

/**
 * Native readiness of the active Inference backend. `refreshKey` re-reads it —
 * the shell passes the navigation nonce, so returning from Settings after
 * filling the field clears the notice. A failed read keeps the last known
 * state (or none at all on a cold read); it never invents "ready".
 */
export function useBackendReadiness(refreshKey?: number | string): BackendReadiness | null {
  const [readiness, setReadiness] = useState<BackendReadiness | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const parsed = parseBackendReadiness(await invoke<unknown>('get_backend_readiness'));
        if (live) setReadiness(parsed);
      } catch {
        /* no evidence either way — see the comment above */
      }
    })();
    return () => {
      live = false;
    };
  }, [refreshKey]);
  return readiness;
}

export interface BackendSetupNoticeProps {
  /** Bumped after navigation so a filled-in config dismisses the notice. */
  refreshKey?: number | string;
}

export default function BackendSetupNotice({ refreshKey }: BackendSetupNoticeProps) {
  const { navigate } = useNavigation();
  const readiness = useBackendReadiness(refreshKey);
  if (!needsBackendSetup(readiness)) return null;

  const backend = backendDisplayName(readiness.backend);

  return (
    <div className="shrink-0 border-b border-line bg-canvas px-4 py-2" data-testid="backend-setup-notice">
      <AlertLine
        label={BACKEND_SETUP_NOTICE_LABEL}
        tone="warn"
        actions={
          <Button
            variant="ghost"
            size="xs"
            icon={<Settings2 aria-hidden="true" />}
            onClick={() => navigate('settings')}
          >
            Open Settings
          </Button>
        }
      >
        <span className="font-medium text-ink">Set up the inference backend to start chatting.</span>{' '}
        <span className="text-ink-2">
          {hasOwnSentence(readiness.missing) ? (
            <>{joinMissingSettings(readiness.missing)}. Set it in Settings; chat stays blocked until then.</>
          ) : (
            <>{backend} is not configured — missing {joinMissingSettings(readiness.missing)}. Set it in Settings; chat stays blocked until then.</>
          )}
        </span>
      </AlertLine>
    </div>
  );
}
