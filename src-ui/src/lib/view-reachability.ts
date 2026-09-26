// Reachability analysis for the App surface map.
//
// The dead-path guard in `App.deadpath.test.ts` reads App.tsx as text (rendering
// the app would need Tauri IPC mocks) and asks whether a shipped entry point can
// reach each `renderView` case, and whether each route's surface comes from a
// shipped module rather than one only its own test imports.
//
// This module is that analysis, kept pure so it can be pinned by unit contracts
// instead of only by its one caller. It reads source text; it never imports the
// components it describes.

export interface ModuleSources {
  /** Repo-relative module path -> source text, including test modules. */
  [modulePath: string]: string;
}

export interface RouteSurfaceImport {
  /** The component name a `renderView` case mounts. */
  name: string;
  /** The module specifier App.tsx imported that component from. */
  specifier: string;
}

const NAV_ITEM = /\{\s*id:\s*'([^']+)',\s*label:\s*'([^']*)'/g;
const CASE_LABEL = /case\s+'([^']+)'\s*:/g;
const LEGACY_TABLE = /LEGACY_VIEW_IDS[^=]*=\s*\[([\s\S]*?)\]/;
const QUOTED = /'([^']+)'/g;
const DEFAULT_IMPORT = /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*'([^']+)'/g;
const NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g;
const RENDER_VIEW = /const\s+renderView\s*=/;

/** The renderView body, located by brace matching rather than by indentation. */
function renderViewBody(appSource: string): string {
  const declaration = appSource.match(RENDER_VIEW);
  if (!declaration || declaration.index === undefined) return '';
  const open = appSource.indexOf('{', declaration.index);
  if (open === -1) return '';
  let depth = 0;
  let quote = '';
  for (let at = open; at < appSource.length; at += 1) {
    const char = appSource[at];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return appSource.slice(open + 1, at);
    }
  }
  return appSource.slice(open + 1);
}

/** Nav item ids, in source order and de-duplicated. Section titles are not ids. */
export function parseNavIds(appSource: string): string[] {
  return unique([...appSource.matchAll(NAV_ITEM)].map((match) => match[1]));
}

/**
 * The documented restored-navigation allowlist, or `[]` when App.tsx declares
 * none. A missing allowlist must never read as "every id is allowed" — that is
 * the same collapse this guard exists to catch.
 */
export function parseLegacyViewIds(appSource: string): string[] {
  const table = appSource.match(LEGACY_TABLE);
  if (!table) return [];
  return unique([...table[1].matchAll(QUOTED)].map((match) => match[1]));
}

/** Every `case '<id>':` label inside the renderView switch, de-duplicated. */
export function parseRenderViewCases(appSource: string): string[] {
  return unique([...appSource.matchAll(CASE_LABEL)].map((match) => match[1]));
}

/**
 * Case labels no shipped entry point can select: neither a nav id (the sidebar
 * and the command palette, which is fed the flattened nav sections) nor a
 * documented restored-navigation id. The `default` branch is not a route.
 */
export function unreachableViewIds(appSource: string): string[] {
  const reachable = new Set([...parseNavIds(appSource), ...parseLegacyViewIds(appSource)]);
  return parseRenderViewCases(appSource).filter((id) => !reachable.has(id));
}

/** Component names mounted by a `renderView` case, with the module they came from. */
export function routeSurfaceImports(appSource: string): RouteSurfaceImport[] {
  const specifiers = new Map<string, string>();
  for (const match of appSource.matchAll(DEFAULT_IMPORT)) specifiers.set(match[1], match[2]);
  for (const match of appSource.matchAll(NAMED_IMPORT)) {
    for (const name of match[1].split(',')) {
      const local = name.trim().split(/\s+as\s+/).pop()?.trim();
      if (local) specifiers.set(local, match[2]);
    }
  }

  const body = renderViewBody(appSource);
  const mounted = new Set(
    [...body.matchAll(/<([A-Z][\w$]*)/g)].map((match) => match[1]),
  );

  return [...mounted]
    .map((name) => ({ name, specifier: specifiers.get(name) }))
    .filter((entry): entry is RouteSurfaceImport => entry.specifier !== undefined)
    .map(({ name, specifier }) => ({ name, specifier: specifier as string }));
}

function normalise(fromModule: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = fromModule.split('/').slice(0, -1).join('/');
  const segments = `${base}/${specifier}`.split('/');
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') resolved.pop();
    else resolved.push(segment);
  }
  return resolved.join('/');
}

/**
 * Resolve a relative specifier against the module map, trying an exact path, the
 * TypeScript extensions, then the directory index. Matching is by the specifier's
 * own path, never by basename alone, so an import of `./CompanionSprite` can
 * never be satisfied by `MythosCompanionSprite`.
 */
export function resolveImportPath(
  fromModule: string,
  specifier: string,
  modules: ModuleSources,
): string | null {
  const base = normalise(fromModule, specifier.split('?')[0]);
  if (base === null) return null;
  for (const candidate of [
    base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`,
  ]) {
    if (Object.prototype.hasOwnProperty.call(modules, candidate)) return candidate;
  }
  return null;
}

/** Modules whose only importer is a test module, ignoring the given entry points. */
export function orphanModules(modules: ModuleSources, entryPoints: string[] = []): string[] {
  const shipped = new Set(entryPoints);
  const importedBy = new Map<string, string[]>();
  for (const [path, source] of Object.entries(modules)) {
    if (isTestModule(path)) continue;
    for (const specifier of relativeSpecifiers(source)) {
      const target = resolveImportPath(path, specifier, modules);
      if (target === null) continue;
      const importers = importedBy.get(target) ?? [];
      importers.push(path);
      importedBy.set(target, importers);
    }
  }
  return Object.keys(modules)
    .filter((path) => !isTestModule(path) && !shipped.has(path) && !importedBy.has(path))
    .sort();
}

/**
 * Orphan modules the project has not yet resolved. A retained entry is a
 * deliberate, reviewable record — see `RETAINED_DEAD_MODULES` — and this helper
 * exists so the guard reports the difference rather than the whole set.
 */
export function unretainedOrphanModules(
  modules: ModuleSources,
  entryPoints: string[],
  retained: readonly string[] = [],
): string[] {
  const keep = new Set(retained);
  return orphanModules(modules, entryPoints).filter((path) => !keep.has(path));
}

export function isTestModule(path: string): boolean {
  return /(^|\/)(tests?)\//.test(path) || /\.test\.|\.spec\./.test(path);
}

function relativeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const quote of ["'", '"']) {
    const marker = `from ${quote}`;
    let at = source.indexOf(marker);
    while (at !== -1) {
      const start = at + marker.length;
      const end = source.indexOf(quote, start);
      if (end === -1) break;
      specifiers.push(source.slice(start, end));
      at = source.indexOf(marker, end);
    }
  }
  return specifiers;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
