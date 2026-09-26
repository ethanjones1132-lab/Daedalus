// ═══════════════════════════════════════════════════════════════
// ── ActionRegistryAlertBanner — a dead alert channel, announced ──
//
// Self-hiding: it renders nothing at all while every channel is live or merely
// unanswered, so the app gains no permanent chrome for a channel that works.
// When a channel has been refused it announces one fixed headline and one
// fixed reason per refused channel, and offers the one Retry the shell's other
// read failures already use.
// ═══════════════════════════════════════════════════════════════

import { cn } from '../ui';
import type { AlertChannelView } from './registry-alert-channel';

interface ActionRegistryAlertBannerProps {
  view: AlertChannelView;
  onRetry: () => void;
}

export function ActionRegistryAlertBanner({ view, onRetry }: ActionRegistryAlertBannerProps) {
  if (view.status !== 'unavailable' || view.message === null) return null;
  return (
    <div
      role="alert"
      aria-label="Action registry alert channel"
      className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-1.5 text-xs text-amber-100"
    >
      <div className="flex items-center gap-2">
        <span>{view.message}</span>
        <button
          type="button"
          disabled={view.busy}
          onClick={onRetry}
          className={cn('rounded border px-2 py-0.5 disabled:opacity-50')}
        >
          {view.retryLabel}
        </button>
      </div>
      <ul className="mt-1 list-disc pl-4 opacity-90">
        {view.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </div>
  );
}

export default ActionRegistryAlertBanner;
