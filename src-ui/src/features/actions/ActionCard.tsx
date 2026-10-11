import { Check, Play, Ban } from 'lucide-react';
import { Badge, Button, Chip, StatusDot, formatIsoAge, toneText, type Tone } from '../../design';

export interface RegistryAction {
  id: string;
  project: string;
  source_system: string;
  source_area: string;
  priority: string;
  risk_level: string;
  category: string;
  action_type: string;
  title: string;
  description: string;
  status: string;
  owner: string;
  approval_required: boolean;
  approval_status?: string;
  next_due?: string;
  escalated?: boolean;
  escalation_note?: string;
  updated_at: string;
}

export type RegistryBucketId = 'active' | 'blocked';

const priorityTone = (priority: string): Tone => {
  switch (priority) {
    case 'P0': return 'error';
    case 'P1': return 'warn';
    case 'P2': return 'info';
    default: return 'neutral';
  }
};

const riskTone = (risk: string): Tone => {
  switch (risk) {
    case 'critical':
    case 'high': return 'error';
    case 'medium': return 'warn';
    default: return 'ok';
  }
};

const statusTone = (status: string): Tone => {
  if (status === 'open') return 'ok';
  if (status === 'in_progress') return 'accent';
  if (status === 'blocked') return 'warn';
  return 'muted';
};

/** Relative age for a registry timestamp; falls back to the raw value when unparseable. */
function ageOf(value: string): string {
  const age = formatIsoAge(value);
  return age === 'unknown' ? value : age;
}

export function ActionCard({
  action,
  bucket,
  disabled,
  onApprove,
  onWaive,
  onDispatch,
}: {
  action: RegistryAction;
  bucket: RegistryBucketId;
  disabled: boolean;
  onApprove: (id: string) => void;
  onWaive: (id: string) => void;
  onDispatch: (id: string) => void;
}) {
  const approvalOpen =
    action.approval_required && action.approval_status !== 'approved' && action.approval_status !== 'waived';
  const canDispatch =
    bucket === 'active' &&
    (action.status === 'open' || action.status === 'in_progress') &&
    (!action.approval_required || action.approval_status === 'approved' || action.approval_status === 'waived');

  return (
    <li>
      <article className="group rounded-[10px] border border-line bg-surface p-3.5 shadow-card transition-colors duration-150 hover:border-line-strong">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={priorityTone(action.priority)}>{action.priority}</Badge>
          {action.escalated && <Badge tone="error" dot>escalated</Badge>}
          {action.approval_required && (
            <Badge tone={action.approval_status === 'approved' ? 'ok' : action.approval_status === 'waived' ? 'muted' : 'warn'}>
              {action.approval_status === 'approved' ? 'approved' : action.approval_status === 'waived' ? 'waived' : 'needs approval'}
            </Badge>
          )}
          <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
            <StatusDot tone={statusTone(action.status)} live={action.status === 'in_progress'} />
            {action.status.replace('_', ' ')}
          </span>
        </div>

        <h4 className="mt-2.5 text-[13.5px] font-medium leading-snug text-ink">{action.title}</h4>
        <p className="mt-1 line-clamp-3 text-[12.5px] leading-relaxed text-ink-3">{action.description}</p>

        {action.escalation_note && (
          <p className="mt-2 border-l-2 border-warn/60 pl-2.5 text-[12px] leading-snug text-warn">{action.escalation_note}</p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <Chip title="Source adapter">{action.source_system} / {action.source_area}</Chip>
          <Chip mono={false}>{action.project}</Chip>
          <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-ink-3">
            risk <span className={toneText[riskTone(action.risk_level)]}>{action.risk_level}</span>
          </span>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-x-3 font-mono text-[10.5px] text-ink-4">
            {action.next_due && <span>due {action.next_due}</span>}
            <span>updated {ageOf(action.updated_at)}</span>
          </div>
          {(approvalOpen || canDispatch) && (
            <div className="flex items-center gap-1.5">
              {approvalOpen && (
                <>
                  <Button
                    size="xs"
                    variant="secondary"
                    icon={<Check aria-hidden="true" />}
                    aria-label={`Approve ${action.title}`}
                    disabled={disabled}
                    onClick={() => onApprove(action.id)}
                  >
                    Approve
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    icon={<Ban aria-hidden="true" />}
                    aria-label={`Waive ${action.title}`}
                    disabled={disabled}
                    onClick={() => onWaive(action.id)}
                  >
                    Waive
                  </Button>
                </>
              )}
              {canDispatch && (
                <Button
                  size="xs"
                  variant="secondary"
                  className="border-accent-line text-accent-hot hover:text-accent-hot"
                  icon={<Play aria-hidden="true" />}
                  aria-label={`Dispatch ${action.title}`}
                  disabled={disabled}
                  onClick={() => onDispatch(action.id)}
                >
                  Dispatch
                </Button>
              )}
            </div>
          )}
        </div>
      </article>
    </li>
  );
}
