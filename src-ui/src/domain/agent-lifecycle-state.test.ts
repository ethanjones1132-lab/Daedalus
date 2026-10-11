import { describe, expect, it } from 'vitest';
import {
  effectiveLifecycleState,
  canActivateLifecycle,
  canDeactivateLifecycle,
  type AgentProjection,
} from './agent-lifecycle-state';

const hash = 'a'.repeat(64);
const agent = { id: 'coder', slug: 'coder', status: 'valid', source_hash: hash, source_path: '/agents/coder/soul.md' };
const projection: AgentProjection = {
  slug: 'coder', source_path: '/agents/coder/soul.md', source_hash: hash, projection_version: 1,
  status: 'valid', active: false, created_at: '', updated_at: '',
};

describe('Agent lifecycle effective state', () => {
  it('distinguishes inactive, active, stale, invalid, and unavailable discovery', () => {
    expect(effectiveLifecycleState(agent, undefined)).toBe('inactive');
    expect(effectiveLifecycleState(agent, { ...projection, active: true })).toBe('active');
    expect(effectiveLifecycleState(agent, { ...projection, active: true, source_hash: 'b'.repeat(64) })).toBe('stale');
    expect(effectiveLifecycleState({ ...agent, status: 'invalid' }, projection)).toBe('invalid');
    expect(effectiveLifecycleState({ ...agent, source_hash: undefined }, projection)).toBe('unavailable');
  });

  it('allows activation only for a current valid source and deactivation for any active projection', () => {
    expect(canActivateLifecycle(agent, undefined)).toBe(true);
    expect(canActivateLifecycle(agent, { ...projection, active: true, source_hash: 'b'.repeat(64) })).toBe(true);
    expect(canActivateLifecycle({ ...agent, status: 'invalid' }, undefined)).toBe(false);
    expect(canActivateLifecycle({ ...agent, source_hash: undefined }, undefined)).toBe(false);
    expect(canDeactivateLifecycle(agent, projection)).toBe(false);
    expect(canDeactivateLifecycle(agent, { ...projection, active: true })).toBe(true);
    expect(canDeactivateLifecycle({ ...agent, status: 'invalid' }, { ...projection, active: true })).toBe(true);
  });
});
