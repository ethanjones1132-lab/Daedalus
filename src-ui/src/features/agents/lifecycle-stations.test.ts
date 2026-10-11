import { describe, expect, it } from 'vitest';
import type { LifecycleAgent } from '../../domain/agent-discovery-state';
import type { AgentProjection } from '../../domain/agent-lifecycle-state';
import { aggregateStations, directoryStations } from './lifecycle-stations';

const hash = 'a'.repeat(64);
const agent = (over: Partial<LifecycleAgent> = {}): LifecycleAgent => ({
  id: 'coder', slug: 'coder', status: 'valid', source_hash: hash, source_path: '/home/me/agents/coder/soul.md', ...over,
});
const projection = (over: Partial<AgentProjection> = {}): AgentProjection => ({
  slug: 'coder', source_path: '/home/me/agents/coder/soul.md', source_hash: hash, projection_version: 3,
  status: 'valid', active: true, created_at: '', updated_at: '', ...over,
});
const states = (stations: ReturnType<typeof directoryStations>) => stations.map((s) => s.state);

describe('directoryStations', () => {
  it('marks all four stations done only for an active projection of the current source', () => {
    expect(states(directoryStations(agent(), projection()))).toEqual(['done', 'done', 'done', 'done']);
  });

  it('stops at Validate with a failed station and a blocked Project for an invalid source', () => {
    const stations = directoryStations(agent({ status: 'invalid' }), undefined);
    expect(states(stations)).toEqual(['done', 'failed', 'pending', 'pending']);
    expect(stations[1].result).toMatch(/failed validation/);
  });

  it('prefers the recorded validation errors as the failed result', () => {
    const stations = directoryStations(agent({ status: 'invalid' }), projection({ validation_errors: 'missing tools: heading' }));
    expect(stations[1].result).toBe('missing tools: heading');
  });

  it('shows a valid but unprojected directory as waiting at Project', () => {
    expect(states(directoryStations(agent(), undefined))).toEqual(['done', 'done', 'current', 'pending']);
  });

  it('shows a changed source as current at Project and Activate, never done', () => {
    const stations = directoryStations(agent({ source_hash: 'b'.repeat(64) }), projection());
    expect(states(stations)).toEqual(['done', 'done', 'current', 'current']);
    expect(stations[2].result).toMatch(/projection v3/);
  });

  it('keeps an inactive projection pending at Activate', () => {
    expect(states(directoryStations(agent(), projection({ active: false })))).toEqual(['done', 'done', 'done', 'pending']);
  });

  it('lets an in-flight or failed lifecycle operation override the Activate station', () => {
    const writing = directoryStations(agent(), projection({ active: false }), { slug: 'coder', action: 'activate', phase: 'writing' });
    expect(writing[3].state).toBe('current');
    const failed = directoryStations(agent(), projection({ active: false }), { slug: 'coder', action: 'activate', phase: 'write-failed' });
    expect(failed[3].state).toBe('failed');
    const unconfirmed = directoryStations(agent(), projection(), { slug: 'coder', action: 'deactivate', phase: 'read-failed' });
    expect(unconfirmed[3]).toMatchObject({ state: 'failed', result: expect.stringMatching(/unconfirmed/) });
  });
});

describe('aggregateStations', () => {
  it('does not claim an empty Agents root before discovery has succeeded', () => {
    const scanning = aggregateStations(null, null, { loading: true, error: false });
    expect(scanning[0].state).toBe('current');
    const failed = aggregateStations(null, null, { loading: false, error: true });
    expect(failed[0].state).toBe('failed');
  });

  it('reports an empty root only from a successful empty scan', () => {
    const stations = aggregateStations([], [], { loading: false, error: false });
    expect(states(stations)).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(stations[0].result).toBe('No Agent directories found.');
  });

  it('summarises validation failures and active counts across directories', () => {
    const agents = [agent(), agent({ id: 'b', slug: 'b', status: 'invalid' })];
    const stations = aggregateStations(agents, [projection()], { loading: false, error: false });
    expect(stations[1]).toMatchObject({ state: 'failed', result: '1 of 2 failed validation.' });
    expect(stations[3]).toMatchObject({ state: 'current', result: '1 of 2 active.' });
  });

  it('does not call projections observed when they could not be read', () => {
    const stations = aggregateStations([agent()], null, { loading: false, error: false });
    expect(stations[2].state).toBe('pending');
    expect(stations[3].state).toBe('pending');
  });
});
