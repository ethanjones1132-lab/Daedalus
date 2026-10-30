import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  alertIsActive,
  initialRegistryState,
  type ActionRegistryAlert,
  type RegistrySnapshotState,
} from '../../domain/action-registry-state';
import { AlertLedger, isHistoricalAlert } from './AlertLedger';

const approvalAlert = (over: Partial<ActionRegistryAlert> = {}): ActionRegistryAlert => ({
  id: 'approval-a1',
  kind: 'approval_required',
  severity: 'medium',
  title: 'Approve this',
  message: 'Requires user approval.',
  action_id: 'a1',
  created_at: new Date().toISOString(),
  ...over,
});

const stateWith = (alerts: ActionRegistryAlert[]): RegistrySnapshotState<ActionRegistryAlert[]> => ({
  ...initialRegistryState<ActionRegistryAlert[]>(),
  loading: false,
  snapshot: alerts,
});

afterEach(cleanup);

describe('the alert ledger', () => {
  it('labels a superseded alert and counts it out of the active set', () => {
    const superseded = approvalAlert({ id: 'approval-old', superseded: true });
    const active = approvalAlert({ id: 'approval-live', action_id: 'a2' });
    render(<AlertLedger state={stateWith([superseded, active])} onRefresh={() => {}} />);
    expect(screen.getAllByText('superseded')).toHaveLength(1);
    expect(screen.getByText('1 of 2 active')).toBeInTheDocument();
    expect(screen.getByText(/kept as history/)).toBeInTheDocument();
  });

  it('marks nothing on an active fresh alert beyond its plain count', () => {
    render(<AlertLedger state={stateWith([approvalAlert()])} onRefresh={() => {}} />);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.queryByText('superseded')).not.toBeInTheDocument();
    expect(screen.queryByText('historical')).not.toBeInTheDocument();
  });

  it('keeps old-but-still-pending alerts visible as history rather than hiding them', () => {
    // An alert older than the historical threshold that is NOT superseded is
    // still a genuinely pending approval — it must stay on the board, only
    // flagged.
    const old = approvalAlert({ created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() });
    expect(isHistoricalAlert(old)).toBe(true);
    expect(alertIsActive(old)).toBe(true);
    render(<AlertLedger state={stateWith([old])} onRefresh={() => {}} />);
    expect(screen.getByText('historical')).toBeInTheDocument();
    expect(screen.queryByText('superseded')).not.toBeInTheDocument();
    expect(screen.getByText('Approve this')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('shows a relative age, not only the raw ISO line', () => {
    render(
      <AlertLedger
        state={stateWith([approvalAlert({ created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() })])}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText(/age: .* ago/)).toBeInTheDocument();
  });

  it('never claims unknown-verdict alerts as superseded', () => {
    render(<AlertLedger state={stateWith([approvalAlert({ superseded: null })])} onRefresh={() => {}} />);
    expect(screen.queryByText('superseded')).not.toBeInTheDocument();
  });
});
