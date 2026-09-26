// Dead-path guard (Phase 2.5).
//
// App.tsx's renderView() ends in `default: return <OverviewView />`, so a nav
// item whose ViewId has no `case` silently renders Overview instead — a dead
// path that compiles green (the same class of bug as the theme husk). This test
// statically asserts every nav view id resolves to a real renderView case.
//
// The second failure mode is the mirror image, and it is the one that cost this
// repo real iterations: a `case` that exists, is fully tested, and that no
// shipped entry point can ever select. `chat-feeds` was exactly that — a ViewId
// member with a live 90-line transcript browser in no NAV_SECTIONS entry, and
// the command palette is fed only the flattened nav sections, so setCurrentView
// was never called with it. A maintainer adds a surface, wires the case, writes
// the tests, and ships: suite green, this guard green, the surface invisible.
// So the guard asks the reverse question too, using the pure analysis in
// lib/view-reachability.
//
// It reads App.tsx and types.ts as text (rather than rendering the app, which
// needs Tauri IPC mocks) and runs under `npm run test`, so it gates in CI and
// locally. No Rust toolchain, no Tauri IPC.

import { describe, expect, it } from 'vitest';
// Vite `?raw` import — App.tsx source as a string, robust to cwd/URL scheme.
import src from './App.tsx?raw';
import typesSrc from './types.ts?raw';
import {
  isTestModule,
  parseLegacyViewIds,
  routeSurfaceImports,
  unreachableViewIds,
} from './lib/view-reachability';

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

  it('every ViewId union member has a renderView case', () => {
    const viewIds = [...typesSrc.matchAll(/export type ViewId =\s*([\s\S]*?);/g)];
    expect(viewIds.length).toBe(1);
    const members = [...viewIds[0][1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const caseLabels = new Set(
      [...src.matchAll(/case\s+'([^']+)'\s*:/g)].map((m) => m[1]),
    );
    const missing = members.filter((id) => !caseLabels.has(id));
    expect(
      missing,
      `ViewId members with no renderView case: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('the sidebar Chat entry opens the live Jarvis chat surface', () => {
    const chatSection = src.match(/\{\s*title:\s*'CHAT'[\s\S]*?items:\s*\[\{\s*id:\s*'([^']+)',\s*label:\s*'([^']+)'/);
    expect(chatSection, 'CHAT nav section should exist').not.toBeNull();
    expect(chatSection?.[1]).toBe('jarvis-chat');
    expect(chatSection?.[2]).toBe('Chat');
  });
});

describe('route reachability guard', () => {
  it('every renderView case is reachable from a shipped entry point', () => {
    // Reachable means: a nav id (the sidebar, and the palette, which is fed the
    // flattened nav sections) or a documented restored-navigation id that the
    // initial view read actually consults. A case nobody can select is a dead
    // path that compiles green and tests green.
    expect(
      unreachableViewIds(src),
      'renderView cases no entry point can select — wire a nav item or document the id in LEGACY_VIEW_IDS:',
    ).toEqual([]);
  });

  it('the restored-navigation allowlist is consulted, not just declared', () => {
    // A LEGACY_VIEW_IDS table nobody reads would let the case above pass while a
    // restored navigation state still fell back to Overview — the case would be
    // "reachable" on paper only.
    expect(parseLegacyViewIds(src).length, 'the allowlist should name the nav-less cases').toBeGreaterThan(0);
    expect(
      /LEGACY_VIEW_IDS\s*\.\s*(includes|has|indexOf)\s*\(\s*saved\b/.test(src),
      'the initial view read must check the restored local-storage value against LEGACY_VIEW_IDS',
    ).toBe(true);
  });

  it('no route mounts a surface whose only module is its own test', () => {
    // A route surface imported from a test module is unreachable in a build and
    // test-covered in the suite: the same dead path, one level down.
    const testMounted = routeSurfaceImports(src)
      .filter((entry) => isTestModule(entry.specifier))
      .map((entry) => `${entry.name} (${entry.specifier})`);
    expect(
      testMounted,
      'route surfaces imported from a test module:',
    ).toEqual([]);
  });

  it('mounts at least one route surface, so the analysis cannot pass vacuously', () => {
    expect(routeSurfaceImports(src).length).toBeGreaterThan(0);
  });
});
