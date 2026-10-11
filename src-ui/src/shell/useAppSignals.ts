import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useToast } from '../design';
import { parseActionRegistryAlerts, type ActionRegistryAlert } from '../domain/action-registry-state';
import { useNavigation } from './navigation';

/**
 * App-level Tauri signals that must surface no matter which page is open:
 *
 *  - `action-registry://alerts` (plus the initial `get_action_registry_alerts`
 *    read) → a toast, `error` when the alert is high severity, else `warn`.
 *  - `cron://missed-jobs` with a non-empty payload → a warn toast pointing at
 *    the Cron page. An empty payload only means "refresh" and stays silent.
 *
 * Called once by the Shell. Handlers read toast/navigation through refs so the
 * listeners register exactly once and are never torn down by a re-render.
 */
export function useAppSignals() {
  const toast = useToast();
  const { navigate } = useNavigation();
  const toastRef = useRef(toast);
  const navigateRef = useRef(navigate);
  toastRef.current = toast;
  navigateRef.current = navigate;

  useEffect(() => {
    let disposed = false;
    const unsubs: Array<() => void> = [];

    const track = (pending: Promise<() => void>) => {
      void Promise.resolve(pending)
        .then((unlisten) => {
          // Guard the async-listen race: the effect may already be torn down.
          if (disposed) unlisten();
          else unsubs.push(unlisten);
        })
        .catch(() => undefined);
    };

    const showRegistryAlert = (alerts: ActionRegistryAlert[]) => {
      const lead = alerts.find((alert) => alert.severity === 'high') ?? alerts[0];
      if (!lead) return;
      const notify = lead.severity === 'high' ? toastRef.current.error : toastRef.current.warn;
      notify(lead.message, lead.title, undefined, {
        label: 'Open Actions',
        onClick: () => navigateRef.current('actions'),
      });
    };

    void invoke<unknown>('get_action_registry_alerts')
      .then((value) => {
        if (disposed) return;
        const alerts = parseActionRegistryAlerts(value);
        if (alerts.length > 0) showRegistryAlert(alerts);
      })
      .catch(() => undefined);

    track(
      listen<unknown>('action-registry://alerts', (event) => {
        if (disposed) return;
        try {
          showRegistryAlert(parseActionRegistryAlerts(event.payload));
        } catch {
          /* a malformed payload is not an alert */
        }
      }),
    );

    track(
      listen<unknown[]>('cron://missed-jobs', (event) => {
        if (disposed) return;
        const count = Array.isArray(event.payload) ? event.payload.length : 0;
        if (count === 0) return;
        toastRef.current.warn(
          `You have ${count} missed cron job${count > 1 ? 's' : ''} pending review in the Cron tab.`,
          'Missed Cron Jobs Detected',
          undefined,
          { label: 'Go to Cron View', onClick: () => navigateRef.current('cron') },
        );
      }),
    );

    return () => {
      disposed = true;
      unsubs.splice(0).forEach((unlisten) => unlisten());
    };
  }, []);
}
