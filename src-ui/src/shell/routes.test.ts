// Dead-path guard, rebuilt for the route registry: every route is lazily
// routable, every legacy ViewId resolves to a real route (never a silent
// fallback), and unknown ids fall back to the default explicitly.
import { describe, expect, it } from 'vitest';
import typesSrc from '../types.ts?raw';
import { ALIASES, DEFAULT_ROUTE, GROUP_ORDER, ROUTES, resolveRoute, routeById } from './routes';

const legacyViewIds = (() => {
  const m = typesSrc.match(/export type ViewId =\s*([\s\S]*?);/);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
})();

describe('route registry', () => {
  it('has unique ids, a component for every route, and only known groups', () => {
    const ids = ROUTES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of ROUTES) {
      expect(r.component, r.id).toBeTruthy();
      expect(GROUP_ORDER).toContain(r.group);
    }
  });

  it('resolves every legacy ViewId to a real route', () => {
    expect(legacyViewIds.length).toBeGreaterThan(20);
    const ids = new Set(ROUTES.map((r) => r.id as string));
    const unresolved = legacyViewIds.filter((v) => !ids.has(v) && !(v in ALIASES));
    expect(unresolved, `legacy ViewIds with no route or alias: ${unresolved.join(', ')}`).toEqual([]);
  });

  it('maps every alias onto an existing route', () => {
    for (const [alias, target] of Object.entries(ALIASES)) {
      expect(routeById(target), alias).toBeDefined();
    }
  });

  it('opens the live Sessions surface for the legacy chat entries', () => {
    for (const id of ['jarvis', 'jarvis-chat', 'jarvis-hub', 'chat-feeds']) expect(resolveRoute(id)).toBe('sessions');
    expect(resolveRoute('action-registry')).toBe('actions');
    expect(resolveRoute('config')).toBe('settings');
    expect(resolveRoute('control')).toBe('health');
  });

  it('falls back to the default route for empty or unknown ids', () => {
    expect(resolveRoute(null)).toBe(DEFAULT_ROUTE);
    expect(resolveRoute('')).toBe(DEFAULT_ROUTE);
    expect(resolveRoute('definitely-not-a-view')).toBe(DEFAULT_ROUTE);
  });
});
