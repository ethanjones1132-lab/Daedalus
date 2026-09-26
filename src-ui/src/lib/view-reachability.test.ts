// Contracts for the view-reachability analysis.
//
// The bug class this exists for: a surface that is built, tested, and wired
// into App.tsx's `renderView` switch, but that no shipped entry point can ever
// select. The existing guard in App.deadpath.test.ts only asked the opposite
// question ("does every nav id have a case?"), so a 100%-tested, 0%-reachable
// surface compiled green. These are pure contracts over source text: the
// analysis must name an unreachable case and an orphan module exactly, and it
// must never treat a test-only importer as a shipped one.
import { describe, expect, it } from 'vitest';
import {
  parseLegacyViewIds,
  parseNavIds,
  parseRenderViewCases,
  resolveImportPath,
  routeSurfaceImports,
  unreachableViewIds,
  unretainedOrphanModules,
  type ModuleSources,
} from './view-reachability';

const nav = `const NAV_SECTIONS: NavSection[] = [
  { title: 'CHAT', items: [{ id: 'jarvis-chat', label: 'Chat', icon: 'C' }] },
  { title: 'SYSTEM', items: [
    { id: 'health', label: 'Health', icon: 'H' },
  ] },
];`;

describe('entry-point parsing', () => {
  it('reads nav item ids and ignores section titles', () => {
    expect(parseNavIds(nav)).toEqual(['jarvis-chat', 'health']);
  });

  it('returns no ids when the source carries no nav table', () => {
    expect(parseNavIds('export const nothing = 1;')).toEqual([]);
  });

  it('reads the documented legacy allowlist', () => {
    const source = `const LEGACY_VIEW_IDS: ViewId[] = ['jarvis-hub', 'instances'];`;
    expect(parseLegacyViewIds(source)).toEqual(['jarvis-hub', 'instances']);
  });

  it('treats a missing allowlist as empty rather than as every id', () => {
    expect(parseLegacyViewIds('export const A = 1;')).toEqual([]);
  });
});

describe('renderView case reachability', () => {
  const app = `${nav}

const LEGACY_VIEW_IDS: ViewId[] = ['instances', 'usage', 'jarvis-hub'];

function AppInner() {
  const renderView = () => {
    switch (currentView) {
      case 'jarvis-chat': return <JarvisView />;
      case 'health':
      case 'jarvis-hub': return <JarvisView initialSubView="status" />;
      case 'chat-feeds': return <ChatFeedsView />;
      case 'instances':
      case 'usage': return <OverviewView />;
      default: return <OverviewView />;
    }
  };
}`;

  it('lists every case label, including stacked ones', () => {
    expect(parseRenderViewCases(app)).toEqual([
      'jarvis-chat', 'health', 'jarvis-hub', 'chat-feeds', 'instances', 'usage',
    ]);
  });

  it('names a case that no entry point can select', () => {
    // The real defect: `chat-feeds` is a ViewId member with a live case and a
    // 90-line surface, but it appears in no nav section, so `setCurrentView`
    // is never called with it.
    expect(unreachableViewIds(app)).toEqual(['chat-feeds']);
  });

  it('clears a case once the restored-navigation allowlist really covers it', () => {
    const covered = app.replace(
      "const LEGACY_VIEW_IDS: ViewId[] = ['instances', 'usage', 'jarvis-hub'];",
      "const LEGACY_VIEW_IDS: ViewId[] = ['instances', 'usage', 'jarvis-hub', 'chat-feeds'];",
    );
    expect(unreachableViewIds(covered)).toEqual([]);
  });

  it('does not read the default branch as a route', () => {
    expect(unreachableViewIds('switch (v) { default: return <OverviewView />; }')).toEqual([]);
  });
});

describe('route surface imports', () => {
  const app = `import JarvisView from './components/jarvis/JarvisView';
import ChatFeedsView from './components/jarvis/ChatFeedsView';
import CronView from './components/jarvis/CronView.test';
import { SessionsView } from './components/jarvis/SessionsView';
const renderView = () => {
  switch (v) {
    case 'a': return <JarvisView />;
    case 'b': return <ChatFeedsView />;
    case 'c': return <CronView />;
    case 'd': return <SessionsView />;
    case 'e': return <OverviewView />;
  }
};`;

  it('lists the components a route mounts with the module each came from', () => {
    expect(routeSurfaceImports(app)).toEqual([
      { name: 'JarvisView', specifier: './components/jarvis/JarvisView' },
      { name: 'ChatFeedsView', specifier: './components/jarvis/ChatFeedsView' },
      { name: 'CronView', specifier: './components/jarvis/CronView.test' },
      { name: 'SessionsView', specifier: './components/jarvis/SessionsView' },
    ]);
  });

  it('names a surface whose only module is a test file', () => {
    const testMounted = routeSurfaceImports(app).filter((entry) => isTestSpecifier(entry.specifier));
    expect(testMounted.map((entry) => entry.name)).toEqual(['CronView']);
  });
});

function isTestSpecifier(specifier: string): boolean {
  return /\.test(\.|$)|\.spec(\.|$)/.test(specifier);
}

describe('import resolution', () => {
  const modules: ModuleSources = {
    'src/App.tsx': `import Sprite from './components/jarvis/MythosCompanionSprite';`,
    'src/components/jarvis/MythosCompanionSprite.tsx': 'export default 1;',
    'src/components/jarvis/CompanionSprite.tsx': 'export default 2;',
    'src/components/ui/index.tsx': 'export * from "./Inner";',
    'src/components/ui/Inner.tsx': 'export const Inner = 1;',
  };

  it('resolves a sibling specifier to its own module', () => {
    expect(resolveImportPath('src/App.tsx', './components/jarvis/CompanionSprite', modules))
      .toBe('src/components/jarvis/CompanionSprite.tsx');
  });

  it('never satisfies one module with a different module of a similar name', () => {
    expect(resolveImportPath('src/App.tsx', './components/jarvis/MythosCompanionSprite', modules))
      .toBe('src/components/jarvis/MythosCompanionSprite.tsx');
  });

  it('resolves through an index barrel', () => {
    expect(resolveImportPath('src/components/ui/index.tsx', './Inner', modules))
      .toBe('src/components/ui/Inner.tsx');
  });

  it('resolves nothing for a bare package specifier', () => {
    expect(resolveImportPath('src/App.tsx', 'react', modules)).toBeNull();
  });

  it('resolves nothing for a specifier with no module on disk', () => {
    expect(resolveImportPath('src/App.tsx', './components/jarvis/Gone', modules)).toBeNull();
  });
});

describe('orphan modules', () => {
  const modules: ModuleSources = {
    'src/main.tsx': `import App from './App';`,
    'src/App.tsx': `import Live from './components/LiveView';`,
    'src/components/LiveView.tsx': 'export default 1;',
    'src/components/DeadView.tsx': 'export default 2;',
    'src/components/DeadView.test.tsx': `import Dead from './DeadView';`,
  };

  it('names a module whose only importer is its own test', () => {
    expect(unretainedOrphanModules(modules, ['src/main.tsx']))
      .toEqual(['src/components/DeadView.tsx']);
  });

  it('treats the app entry point as shipped, not as an orphan', () => {
    expect(unretainedOrphanModules(modules, ['src/main.tsx']))
      .not.toContain('src/main.tsx');
  });

  it('reports the chain root as unreachable when no entry point is declared', () => {
    // Only the module nothing reaches and the module only a test reaches. The
    // root itself is named, so declaring the entry point is what makes it shipped.
    expect(unretainedOrphanModules(modules, [])).toEqual([
      'src/components/DeadView.tsx', 'src/main.tsx',
    ]);
  });
});
