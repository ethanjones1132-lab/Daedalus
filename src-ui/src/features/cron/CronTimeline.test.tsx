import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CronTimeline, planTimeline } from './CronTimeline';
import { projectCronTimeline, type CronJob } from './cron-model';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const job = (id: string, over: Partial<CronJob> = {}): CronJob => ({
  id, name: id, schedule: '0 * * * *', agent_id: 'jarvis', session_id: null, prompt: 'p', enabled: true,
  last_run: null, next_run: at(60), run_count: 0, metadata: null, created_at: at(-1000), updated_at: at(-1000),
  ...over,
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('projectCronTimeline', () => {
  it('gives every job exactly one state, and the pending missed list outranks the rest', () => {
    const projection = projectCronTimeline(
      [
        job('soon', { next_run: at(30) }),
        job('blocked', { next_run: at(90) }), // also named pending — blocked wins
        job('paused', { enabled: false, next_run: at(10) }),
        job('overdue', { next_run: at(-5) }),
        job('far', { next_run: at(25 * 60) }),
        job('none', { next_run: null }),
      ],
      [job('blocked', { next_run: at(-200) })],
      NOW,
    );
    expect(projection.states.map((s) => [s.job.id, s.state])).toEqual([
      ['blocked', 'missed-blocked'],
      ['soon', 'scheduled'],
      ['paused', 'paused'],
      ['overdue', 'missed-blocked'],
      ['far', 'beyond-window'],
      ['none', 'unscheduled'],
    ]);
    expect(projection.scheduled.map(({ job }) => job.id)).toEqual(['soon']);
    expect(projection.missedBlocked.map((job) => job.id)).toEqual(['blocked', 'overdue']);
  });

  it('never leaves an enabled overdue job invisible when the pending registry has not named it', () => {
    const projection = projectCronTimeline([job('overdue', { next_run: at(-101 * 24 * 60) })], [], NOW);
    expect(projection.states[0].state).toBe('missed-blocked');
    expect(projection.missedBlocked.map((j) => j.id)).toEqual(['overdue']);
  });
});

describe('planTimeline', () => {
  const inputs = (jobs: CronJob[]) =>
    projectCronTimeline(jobs, [], NOW).scheduled;

  it('keeps only enabled jobs whose next run is inside the next 24 hours, soonest first', () => {
    const plan = planTimeline(inputs([
      job('later', { next_run: at(600) }),
      job('soon', { next_run: at(30) }),
      job('paused', { enabled: false, next_run: at(10) }),
      job('overdue', { next_run: at(-5) }),
      job('far', { next_run: at(25 * 60) }),
      job('none', { next_run: null }),
    ]), NOW);
    expect(plan.map((m) => m.job.id)).toEqual(['soon', 'later']);
    expect(plan[0].pct).toBeCloseTo((30 / (24 * 60)) * 100, 5);
  });

  it('stacks near-simultaneous markers into separate lanes', () => {
    const plan = planTimeline(inputs([job('a', { next_run: at(60) }), job('b', { next_run: at(62) }), job('c', { next_run: at(64) })]), NOW);
    expect(plan.map((m) => m.lane)).toEqual([0, 1, 2]);
    const spaced = planTimeline(inputs([job('a', { next_run: at(60) }), job('b', { next_run: at(600) })]), NOW);
    expect(spaced.map((m) => m.lane)).toEqual([0, 0]);
  });
});

describe('CronTimeline', () => {
  it('names a job on hover and on focus, and reports clicks', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    const onSelect = vi.fn();
    render(
      <CronTimeline
        jobs={[job('Nightly digest', { next_run: at(90) })]}
        pendingMissed={[]}
        inFlightIds={new Set()}
        onSelect={onSelect}
      />,
    );
    const marker = screen.getByRole('button', { name: /^Nightly digest, next run in 1h 30m/ });
    expect(screen.getAllByText('Nightly digest')).toHaveLength(1); // only the "next up" line
    fireEvent.mouseEnter(marker);
    expect(screen.getAllByText('Nightly digest')).toHaveLength(2);
    fireEvent.mouseLeave(marker);
    expect(screen.getAllByText('Nightly digest')).toHaveLength(1);
    fireEvent.focus(marker);
    expect(screen.getAllByText('Nightly digest')).toHaveLength(2);
    fireEvent.click(marker);
    expect(onSelect).toHaveBeenCalledWith('Nightly digest');
  });

  it('shows a missed-blocked job as a distinct marker explaining why nothing is scheduled', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    const onSelect = vi.fn();
    render(
      <CronTimeline
        jobs={[
          job('Stale digest', { next_run: at(-101 * 24 * 60) }),
          job('Other habit', { next_run: at(-10) }),
        ]}
        pendingMissed={[]}
        inFlightIds={new Set()}
        onSelect={onSelect}
      />,
    );
    // Both jobs render as blocked, and the empty ruler copy explains itself.
    for (const name of ['Stale digest', 'Other habit']) {
      const marker = screen.getByRole('button', { name: new RegExp(`${name}, blocked on a missed run`) });
      fireEvent.click(marker);
      expect(onSelect).toHaveBeenCalledWith(name);
    }
    expect(
      screen.getByText(/No enabled run is scheduled in the next 24 hours: 2 enabled jobs blocked on a missed run/),
    ).toBeInTheDocument();
    expect(screen.getByText(/that awaits trigger or dismissal/)).toBeInTheDocument();
  });

  it('appends the blocked note to the next-up sentence instead of pretending the ruler is complete', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    render(
      <CronTimeline
        jobs={[
          job('Soon', { next_run: at(30) }),
          job('Overdue', { next_run: at(-5) }),
        ]}
        pendingMissed={[job('Overdue', { next_run: at(-5) })]}
        inFlightIds={new Set()}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/Next up:/)).toBeInTheDocument();
    // The blocked job is present as its distinct marker, never as a future marker.
    expect(screen.getByRole('button', { name: /Overdue, blocked on a missed run/ })).toBeInTheDocument();
    // The overdue job never gets a future-scheduled marker.
    expect(screen.queryByRole('button', { name: /^Overdue, next run/ })).not.toBeInTheDocument();
  });

  it('says plainly when nothing is scheduled', () => {
    render(
      <CronTimeline
        jobs={[job('x', { enabled: false })]}
        pendingMissed={[]}
        inFlightIds={new Set()}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText('No enabled job is scheduled to run in the next 24 hours.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
