import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CronTimeline, planTimeline } from './CronTimeline';
import type { CronJob } from './cron-model';

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

describe('planTimeline', () => {
  it('keeps only enabled jobs whose next run is inside the next 24 hours, soonest first', () => {
    const plan = planTimeline([
      job('later', { next_run: at(600) }),
      job('soon', { next_run: at(30) }),
      job('paused', { enabled: false, next_run: at(10) }),
      job('overdue', { next_run: at(-5) }),
      job('far', { next_run: at(25 * 60) }),
      job('none', { next_run: null }),
    ], NOW);
    expect(plan.map((m) => m.job.id)).toEqual(['soon', 'later']);
    expect(plan[0].pct).toBeCloseTo((30 / (24 * 60)) * 100, 5);
  });

  it('stacks near-simultaneous markers into separate lanes', () => {
    const plan = planTimeline([job('a', { next_run: at(60) }), job('b', { next_run: at(62) }), job('c', { next_run: at(64) })], NOW);
    expect(plan.map((m) => m.lane)).toEqual([0, 1, 2]);
    const spaced = planTimeline([job('a', { next_run: at(60) }), job('b', { next_run: at(600) })], NOW);
    expect(spaced.map((m) => m.lane)).toEqual([0, 0]);
  });
});

describe('CronTimeline', () => {
  it('names a job on hover and on focus, and reports clicks', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    const onSelect = vi.fn();
    render(<CronTimeline jobs={[job('Nightly digest', { next_run: at(90) })]} inFlightIds={new Set()} onSelect={onSelect} />);
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

  it('says plainly when nothing is scheduled', () => {
    render(<CronTimeline jobs={[job('x', { enabled: false })]} inFlightIds={new Set()} onSelect={() => {}} />);
    expect(screen.getByText('No enabled job is scheduled to run in the next 24 hours.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
