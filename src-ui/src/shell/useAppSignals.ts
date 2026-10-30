import { initialAlertChannelState, projectAlertChannel, reduceAlertChannel, type AlertChannelId } from '../domain/registry-alert-channel';
import { useEffect, useRef, useReducer, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useToast } from '../design';
import { alertIsActive, parseActionRegistryAlerts, type ActionRegistryAlert } from '../domain/action-registry-state';
import { useWorkflow } from '../features/workflows/WorkflowContext';
import type { GoalNotificationSelector } from '../domain/types';
import { useNavigation } from './navigation';

/** Poll interval: at least 30 s, so a refused subscription never starves delivery. */
export const SIGNAL_POLL_INTERVAL_MS = 60_000;

/**
 * A read path that delivered earlier keeps its channel proven across an
 * isolated failed poll — a single hiccup is not an outage. After this many
 * consecutive failures, the proof is withdrawn and the failure is dispatched,
 * so a read that dies after a successful boot can still raise the banner once
 * the event path is also proven dead.
 */
export const PROVEN_READ_FAILURE_THRESHOLD = 3;

/**
 * App-level Tauri signals that must surface no matter which page is open:
 *
 *  - `action-registry://alerts` (plus periodic `get_action_registry_alerts`
 *    reads) → a toast, `error` when the alert is high severity, else `warn`.
 *  - `cron://missed-jobs` (plus a pending-missed-jobs read) with unseen jobs →
 *    a warn toast pointing at the Cron page.
 *
 * Delivery does not depend on events: a refused subscription cannot produce a
 * "cannot reach you" banner while reads still work, and an event that arrives
 * is treated as delivery evidence the same way a successful read is. Toasts
 * are de-duplicated by the alert's or job's own id, so the poll interval
 * cannot re-announce the same record every minute.
 *
 * Handlers read toast/navigation through refs so the listeners register
 * exactly once and are never torn down by a re-render.
 */
export function useAppSignals() {
  const [attempt, setAttempt] = useState(0);
  const [channel, dispatchChannel] = useReducer(reduceAlertChannel, undefined, initialAlertChannelState);
  const flow = useWorkflow();
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const toast = useToast();
  const { navigate } = useNavigation();
  const toastRef = useRef(toast);
  const navigateRef = useRef(navigate);
  toastRef.current = toast;
  navigateRef.current = navigate;
  // Content identity, not attempt identity: one toast per alert (id + creation)
  // or job per session, so a later record with the same id can be announced.
  const notifiedAlertKeys = useRef(new Set<string>());
  const notifiedMissedIds = useRef(new Set<string>());
  const attemptRef = useRef(attempt);
  attemptRef.current = attempt;

  useEffect(() => {
    let disposed = false;
    attemptRef.current = attempt;
    dispatchChannel({ type: 'begin', attempt });
    const unsubs: Array<() => void> = [];
    // Within one attempt, a read that has delivered keeps its channel proven; a
    // single later failed poll can announce nothing new. Proven-ness is
    // withdrawn after PROVEN_READ_FAILURE_THRESHOLD consecutive failures, and a
    // Retry re-arms every channel.
    const provenReads = { alerts: false, missed: false };
    const readFailures = { alerts: 0, missed: 0 };

    const track = (pending: Promise<() => void>, channelId?: AlertChannelId) => {
      void Promise.resolve(pending)
        .then((unlisten) => {
          // Guard the async-listen race: the effect may already be torn down.
          if (disposed) unlisten();
          else {
            unsubs.push(unlisten);
            // Subscription success is a potential path, not delivery evidence:
            // `live` is reserved for an event that actually arrives.
            if (channelId) dispatchChannel({ type: 'subscribed', attempt, channel: channelId });
          }
        })
        .catch(() => { if (!disposed && channelId) dispatchChannel({ type: 'failed', attempt, channel: channelId }); });
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

    /** Announce only registry alerts never announced this session. */
    const alertKey = (alert: ActionRegistryAlert) => `${alert.id}:${alert.created_at}`;
    const deliverAlerts = (alerts: ActionRegistryAlert[]) => {
      // A superseded record no longer names a pending approval. Forget its
      // announcements so a later re-open of the same action can be toasted,
      // even if the adapter reuses the alert id.
      for (const alert of alerts) {
        if (alert.superseded !== true) continue;
        for (const key of Array.from(notifiedAlertKeys.current)) {
          if (key.startsWith(`${alert.id}:`)) notifiedAlertKeys.current.delete(key);
        }
      }
      // Superseded alerts are history, not something to act on: the native read
      // proved their approval no longer pends, so they are never toasted. An
      // unknown verdict (no flag) stays active — absence is not clearance.
      const fresh = alerts.filter(
        (alert) => alertIsActive(alert) && !notifiedAlertKeys.current.has(alertKey(alert)),
      );
      for (const alert of fresh) notifiedAlertKeys.current.add(alertKey(alert));
      if (fresh.length > 0) showRegistryAlert(fresh);
    };

    /** Announce only pending missed-cron jobs never announced this session. */
    const deliverMissedJobs = (jobs: unknown) => {
      if (!Array.isArray(jobs)) return;
      const fresh = jobs.filter((job) =>
        job && typeof job === 'object' && typeof (job as Record<string, unknown>).id === 'string'
        && !notifiedMissedIds.current.has((job as Record<string, string>).id),
      );
      for (const job of fresh) notifiedMissedIds.current.add((job as Record<string, string>).id);
      const count = fresh.length;
      if (count === 0) return;
      toastRef.current.warn(
        `You have ${count} missed cron job${count > 1 ? 's' : ''} pending review in the Cron tab.`,
        'Missed Cron Jobs Detected',
        undefined,
        { label: 'Go to Cron View', onClick: () => navigateRef.current('cron') },
      );
    };

    const readAlerts = async () => {
      try {
        const value = await invoke<unknown>('get_action_registry_alerts');
        if (disposed) return;
        provenReads.alerts = true;
        readFailures.alerts = 0;
        dispatchChannel({ type: 'live', attempt, channel: 'alerts-read' });
        const alerts = parseActionRegistryAlerts(value);
        if (alerts.length > 0) deliverAlerts(alerts);
      } catch {
        if (disposed) return;
        readFailures.alerts += 1;
        if (!provenReads.alerts || readFailures.alerts >= PROVEN_READ_FAILURE_THRESHOLD) {
          // The proof is withdrawn: from here a failure is a failure, and the
          // channel only clears on the next successful read.
          provenReads.alerts = false;
          dispatchChannel({ type: 'failed', attempt, channel: 'alerts-read' });
        }
      }
    };

    const readMissedJobs = async () => {
      try {
        const value = await invoke<unknown>('list_pending_missed_jobs');
        if (disposed) return;
        provenReads.missed = true;
        readFailures.missed = 0;
        dispatchChannel({ type: 'live', attempt, channel: 'missed-read' });
        deliverMissedJobs(value);
      } catch {
        if (disposed) return;
        readFailures.missed += 1;
        if (!provenReads.missed || readFailures.missed >= PROVEN_READ_FAILURE_THRESHOLD) {
          provenReads.missed = false;
          dispatchChannel({ type: 'failed', attempt, channel: 'missed-read' });
        }
      }
    };

    let alertsInFlight = false;
    let missedInFlight = false;
    const poll = () => {
      // One read per command per poll: a slow Bun server never stacks reads.
      if (!alertsInFlight) {
        alertsInFlight = true;
        void readAlerts().finally(() => { alertsInFlight = false; });
      }
      if (!missedInFlight) {
        missedInFlight = true;
        void readMissedJobs().finally(() => { missedInFlight = false; });
      }
    };

    // The boot read is the first poll's sibling, not a separate path.
    void readAlerts();
    void readMissedJobs();
    const timer = setInterval(() => { if (!disposed) poll(); }, SIGNAL_POLL_INTERVAL_MS);

    track(
      listen<unknown>('action-registry://alerts', (event) => {
        if (disposed) return;
        // An event actually arriving is delivery evidence; subscription success
        // alone never is.
        dispatchChannel({ type: 'live', attempt, channel: 'alerts-events' });
        try {
          deliverAlerts(parseActionRegistryAlerts(event.payload));
        } catch {
          /* a malformed payload is not an alert */
        }
      }) as unknown as Promise<() => void>,
      'alerts-events',
    );

    track(
      listen<unknown>('cron://missed-jobs', (event) => {
        if (disposed) return;
        dispatchChannel({ type: 'live', attempt, channel: 'missed-events' });
        deliverMissedJobs(event.payload);
      }) as unknown as Promise<() => void>,
      'missed-events',
    );

    track(listen<unknown>('goal://notifications', event => {
      if (disposed || typeof event.payload !== 'object' || event.payload === null) return;
      const n = event.payload as Record<string, unknown>;
      if (typeof n.message !== 'string' || !n.message) return;
      const selector: GoalNotificationSelector | null = typeof n.goal_id === 'string' && n.goal_id.trim() ? {
        goal_id: n.goal_id,
        ...(typeof n.activation_id === 'string' && n.activation_id ? { activation_id: n.activation_id } : {}),
        ...(typeof n.cron_job_id === 'string' && n.cron_job_id ? { cron_job_id: n.cron_job_id } : {}),
        ...(typeof n.run_id === 'string' && n.run_id ? { run_id: n.run_id } : {}),
      } : null;
      const action = selector ? { label: 'Open Goals', onClick: () => flowRef.current.openGoalNotification(selector) } : undefined;
      const notify = n.kind === 'scheduled_run_blocked' || n.kind === 'scheduled_run_failed' ? toastRef.current.error : n.kind === 'scheduled_run_waiting_for_user' || n.kind === 'scheduled_run_cancelled' ? toastRef.current.warn : n.kind === 'scheduled_run_verified_completed' ? toastRef.current.success : toastRef.current.info;
      notify(n.message, typeof n.title === 'string' ? n.title : undefined, undefined, action);
    }));

    return () => {
      disposed = true;
      clearInterval(timer);
      unsubs.splice(0).forEach((unlisten) => unlisten());
    };
  }, [attempt]);
  return { alertChannelView: projectAlertChannel(channel), alertChannelState: channel, retrySignals: () => setAttempt(current => current + 1) };
}
