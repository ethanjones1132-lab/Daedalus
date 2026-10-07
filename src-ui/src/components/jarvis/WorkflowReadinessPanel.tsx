// ── WorkflowReadinessPanel — shared, presentation-only readiness/recovery index ──
//    (Roadmap Priority #4, Phase 4.4, Task 2)
//
// This component renders ONE consistent readiness/recovery surface for the three
// workflows. It is strictly display-only: every value it receives was already
// decoded and owned by the workflow view from persisted native authority. It
// performs no invoke/native/network/settings/credential/runtime probe, holds no
// lifecycle/acceptance/permission state, and never becomes a second reader or
// authority. A next step only POINTS AT an existing control/settings surface
// (optionally surfacing an existing recovery/navigation callback the owning view
// already exposes); it never grants a Permission, connector, or credential.
//
// The state vocabulary is closed and is a display label — not a persisted
// lifecycle. Unknown or missing input defaults to `unavailable` so a malformed
// or failed authority read can never appear as ready or empty.

import type { WorkflowDestination } from './types';
import { cn, GlassCard, Pill, StatusDot, type StatusVariant } from '../ui';

/**
 * Closed presentation vocabulary. `ready_for_explicit_action` means no observed
 * blocker and no recovery is required; the workflow is ready for the user's own
 * explicit next action. It never means a run, tool, source, or check passed, and
 * never means acceptance.
 */
export const WORKFLOW_READINESS_STATES = [
  'ready_for_explicit_action',
  'needs_user_input',
  'waiting',
  'blocked',
  'partial',
  'stale',
  'unavailable',
] as const;

export type WorkflowReadinessState = (typeof WORKFLOW_READINESS_STATES)[number];

export type WorkflowReadinessKind = 'project-steward' | 'researcher' | 'recurring-operator';

/**
 * One already-decoded readiness item. `id` is a local render key. `detail` must
 * describe what the authoritative read actually shows, or that the condition has
 * not been observed — never an inferred cause or an inferred "ready".
 */
export interface WorkflowReadinessItem {
  id: string;
  /** Short label for the surface this item is about. */
  label: string;
  state: WorkflowReadinessState;
  detail: string;
  /** Text describing the next step / existing control/settings surface. */
  nextStep?: string;
  /** Optional existing cross-workflow destination for this recovery step. */
  destination?: WorkflowDestination;
  /** Optional existing read-only recovery control (label + callback). */
  recoveryLabel?: string;
  onRecover?: () => void;
}

export interface WorkflowReadinessPanelProps {
  workflow: WorkflowReadinessKind;
  heading: string;
  items: WorkflowReadinessItem[];
  /**
   * Optional fixed boundary note, e.g. that a successful run or source check is
   * not acceptance. Rendered verbatim; the owning view supplies the wording.
   */
  boundaryNote?: string;
  /** Existing cross-workflow navigation callback, if the view exposes one. */
  onNavigateWorkflow?: (
    destination: WorkflowDestination,
    selector: null,
  ) => void;
}

const STATE_META: Record<
  WorkflowReadinessState,
  { label: string; variant: StatusVariant }
> = {
  ready_for_explicit_action: { label: 'Ready for explicit action', variant: 'success' },
  needs_user_input: { label: 'Needs your input', variant: 'info' },
  waiting: { label: 'Waiting', variant: 'info' },
  blocked: { label: 'Blocked', variant: 'error' },
  partial: { label: 'Partial', variant: 'warn' },
  stale: { label: 'Stale', variant: 'warn' },
  unavailable: { label: 'Unavailable', variant: 'error' },
};

/** Unknown or missing state can never render as ready/empty. */
export function normalizeReadinessState(value: unknown): WorkflowReadinessState {
  return WORKFLOW_READINESS_STATES.includes(value as WorkflowReadinessState)
    ? (value as WorkflowReadinessState)
    : 'unavailable';
}

function stateMeta(value: unknown): { label: string; variant: StatusVariant } {
  return STATE_META[normalizeReadinessState(value)];
}

const FALLBACK_ITEM: WorkflowReadinessItem = {
  id: 'unavailable',
  label: 'Readiness',
  state: 'unavailable',
  detail:
    'No decoded readiness state was supplied by this workflow. Nothing can be claimed as ready or empty.',
};

export default function WorkflowReadinessPanel({
  workflow,
  heading,
  items,
  boundaryNote,
  onNavigateWorkflow,
}: WorkflowReadinessPanelProps) {
  const safeItems = items.length > 0 ? items : [FALLBACK_ITEM];

  return (
    <GlassCard className="p-3">
      <div
        data-testid={`workflow-readiness-${workflow}`}
        className="flex items-center gap-2 mb-1"
      >
        <span className="text-xs font-mono uppercase tracking-[0.18em] text-bone/40">
          Readiness &amp; recovery
        </span>
      </div>
      <p className="text-[11px] text-bone-faint mb-2">{heading}</p>
      <p className="text-[10px] text-bone/30 mb-3">
        Presentation only. These labels mirror state this workflow already decoded from persisted
        native authority. This surface runs no command, settings, credential, connector, or runtime
        probe and stores no lifecycle, acceptance, or permission authority.
      </p>

      <ul className="flex flex-col gap-2">
        {safeItems.map((item) => {
          const meta = stateMeta(item.state);
          return (
            <li
              key={item.id}
              className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <StatusDot variant={meta.variant} size="sm" />
                <span className="text-xs text-bone truncate">{item.label}</span>
                <Pill variant={meta.variant}>{meta.label}</Pill>
              </div>
              <p className="mt-1 text-[11px] text-bone-dim">{item.detail}</p>
              {item.nextStep && (
                <p className="mt-1 text-[11px] text-bone-faint">Next: {item.nextStep}</p>
              )}
              {(item.onRecover || (item.destination && onNavigateWorkflow)) && (
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {item.onRecover && item.recoveryLabel && (
                    <button
                      type="button"
                      onClick={item.onRecover}
                      className={cn('btn-ghost text-xs')}
                    >
                      {item.recoveryLabel}
                    </button>
                  )}
                  {item.destination && onNavigateWorkflow && (
                    <button
                      type="button"
                      onClick={() => onNavigateWorkflow(item.destination!, null)}
                      className={cn('btn-ghost text-xs')}
                    >
                      Open workflow
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {boundaryNote && (
        <p className="mt-3 text-[11px] text-bone-faint border-t border-iron/20 pt-2">
          {boundaryNote}
        </p>
      )}
    </GlassCard>
  );
}
