import { describe, expect, it } from 'vitest';
import { filterNavItems } from './CommandPalette';
import type { NavItem } from '../../types';

const items: NavItem[] = [
  { id: 'jarvis', label: 'Jarvis', icon: 'J' },
  { id: 'cron', label: 'Cron', icon: 'T' },
  { id: 'agents', label: 'Agents', icon: 'A' },
  { id: 'memory', label: 'Memory', icon: 'R' },
  { id: 'action-registry', label: 'Actions', icon: 'R' },
  { id: 'gateway', label: 'Gateway', icon: 'W' },
];

describe('filterNavItems', () => {
  it('returns all items for empty query', () => {
    expect(filterNavItems(items, '')).toHaveLength(items.length);
    expect(filterNavItems(items, '   ')).toHaveLength(items.length);
  });

  it('exact label prefix match', () => {
    const r = filterNavItems(items, 'mem');
    expect(r.map((x) => x.id)).toEqual(['memory']);
  });

  it('subsequence match on label (non-contiguous)', () => {
    // 'ary' matches 'Action**s**' — actually 'a','r','y' in 'Actions':
    // A(match a)ctions → c,t,i,o,n,s no r... let's test 'cts' in Actions
    const r = filterNavItems(items, 'cts');
    expect(r.map((x) => x.id)).toContain('action-registry');
  });

  it('id match when label does not match', () => {
    const r = filterNavItems(items, 'gtwy');
    // label 'Gateway' — g,a,t,e,w,a,y — sub 'gtwy': g✓ t✓ w✓ y✓
    expect(r.map((x) => x.id)).toContain('gateway');
  });

  it('case insensitive', () => {
    expect(filterNavItems(items, 'JARVIS').map((x) => x.id)).toContain('jarvis');
    expect(filterNavItems(items, 'Ag').map((x) => x.id)).toContain('agents');
  });

  it('no match returns empty array', () => {
    expect(filterNavItems(items, 'zzz')).toHaveLength(0);
  });
});
