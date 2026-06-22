// Dead-path guard (Phase 2.5).
//
// App.tsx's renderView() ends in `default: return <OverviewView />`, so a nav
// item whose ViewId has no `case` silently renders Overview instead — a dead
// path that compiles green (the same class of bug as the theme husk). This test
// statically asserts every nav view id resolves to a real renderView case.
//
// It reads App.tsx as text (rather than rendering the app, which needs Tauri
// IPC mocks) and runs under `npm run test`, so it gates in CI and locally.

import { describe, expect, it } from 'vitest';
// Vite `?raw` import — App.tsx source as a string, robust to cwd/URL scheme.
import src from './App.tsx?raw';

describe('nav dead-path guard', () => {
  it('every nav view id has a renderView case (no silent fallthrough to default)', () => {
    // NavItem literals: `{ id: 'x', label: ... }` — section objects use `title:`.
    const navIds = [...src.matchAll(/\{\s*id:\s*'([^']+)',\s*label:/g)].map((m) => m[1]);
    const caseLabels = new Set(
      [...src.matchAll(/case\s+'([^']+)'\s*:/g)].map((m) => m[1]),
    );

    expect(navIds.length, 'nav id extraction should find items').toBeGreaterThan(0);

    const missing = [...new Set(navIds)].filter((id) => !caseLabels.has(id));
    expect(
      missing,
      `nav items with no renderView case (would silently render Overview): ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
