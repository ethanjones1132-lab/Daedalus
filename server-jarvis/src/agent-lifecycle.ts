// ═══════════════════════════════════════════════════════════════
// ── P1-03: Agent Lifecycle Pipeline ──
// ═══════════════════════════════════════════════════════════════
// Orchestrates the canonical agent lifecycle:
//   discover → validate → project → activate
//
// Discovery enumerates <slug>/soul.md entries under the configured
// agents root. Validation is delegated to the P1-01 schema parser.
// Projection is represented here as a lean runtime result; persistent
// projection writes remain owned by the native Rust store.

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { parseSoulFile } from "./agent-schema";

// ── Public Types ──────────────────────────────────────────────────────────────

export type LifecycleScanStatus = "valid" | "invalid" | "collision";

/** Per-agent result entry produced by a single scan run. */
export interface LifecycleScanEntry {
  slug: string;
  source_path: string;
  status: LifecycleScanStatus;
  errors?: Array<{ code: string; field?: string; message: string }>;
  name?: string;
  description?: string;
  version?: string;
  tools?: string[];
  instructions?: string;
  source_hash?: string;
  source_size_bytes?: number;
  active?: boolean;
  projection_version?: number;
  activated_at?: string | null;
  deactivated_at?: string | null;
}

/** Aggregate result returned by `scan()`. */
export interface LifecycleRunResult {
  /** The agents root that was scanned. */
  agents_root: string;
  /** Total agent directories with a soul.md found. */
  scanned: number;
  /** Directories that produced a valid projection. */
  valid: number;
  /** Directories that produced an invalid projection (parse failure or collision). */
  invalid: number;
  /** Projections removed from the store. The Bun lifecycle layer does not delete Rust projections. */
  removed: number;
  /** Per-agent detail for every scanned directory. */
  results: LifecycleScanEntry[];
}

export interface ProjectionWriteResult {
  active: boolean;
  slug?: string;
  source_path?: string;
  source_hash?: string;
  projection_version?: number;
  activated_at?: string | null;
  deactivated_at?: string | null;
  [key: string]: unknown;
}

export interface ProjectionEntry {
  source_path?: string;
  source_hash?: string;
  projection_version?: number;
  activated_at?: string | null;
  deactivated_at?: string | null;
}

export interface ProjectionStore {
  activate(slug: string, entry?: ProjectionEntry): boolean | ProjectionWriteResult;
  deactivate?(slug: string): boolean | ProjectionWriteResult;
  get?(slug: string): ProjectionWriteResult | null | undefined;
}

export type LifecycleActivationCode =
  | "activated"
  | "deactivated"
  | "agent_not_found"
  | "agent_invalid"
  | "agent_collision"
  | "source_changed"
  | "store_unavailable"
  | "store_rejected"
  | "store_failed";

export interface LifecycleOperationResult {
  ok: boolean;
  code: LifecycleActivationCode;
  message: string;
  entry?: LifecycleScanEntry;
  projection?: ProjectionWriteResult;
}

export interface LifecycleService {
  scan(): LifecycleRunResult;
  activate(slug: string, expectedSourceHash?: string): boolean;
  activateDetailed(slug: string, expectedSourceHash?: string): LifecycleOperationResult;
  deactivate(slug: string): boolean;
  deactivateDetailed(slug: string): LifecycleOperationResult;
}

export interface LifecycleSnapshot {
  slug: string;
  source_hash?: string;
  active?: boolean;
  [key: string]: unknown;
}

export type LifecycleSnapshotValidation =
  | { ok: true; entry: LifecycleScanEntry }
  | { ok: false; code: "projection_missing" | "projection_invalid" | "projection_inactive" | "projection_stale"; message: string };

function emptyResult(agentsRoot: string): LifecycleRunResult {
  return {
    agents_root: agentsRoot,
    scanned: 0,
    valid: 0,
    invalid: 0,
    removed: 0,
    results: [],
  };
}

function entryFromParse(
  agentsRoot: string,
  slugDir: string,
  parsed: ReturnType<typeof parseSoulFile>,
): LifecycleScanEntry {
  const fallbackSlug = slugDir.replace(/[^a-z0-9-]/gi, "-").toLowerCase().replace(/^-|-$/g, "") || slugDir;

  if (!parsed.ok) {
    return {
      slug: fallbackSlug,
      source_path: parsed.provenance.source_path,
      status: "invalid",
      errors: parsed.errors,
      source_hash: parsed.provenance.source_hash,
      source_size_bytes: parsed.provenance.source_size_bytes,
    };
  }

  return {
    slug: parsed.identity.slug,
    source_path: parsed.provenance.source_path,
    status: "valid",
    name: parsed.identity.name,
    description: parsed.identity.description,
    instructions: parsed.identity.instructions,
    version: parsed.identity.version,
    tools: parsed.identity.tools,
    source_hash: parsed.provenance.source_hash,
    source_size_bytes: parsed.provenance.source_size_bytes,
  };
}

function markCollisions(entries: LifecycleScanEntry[]): LifecycleScanEntry[] {
  const slugCounts = new Map<string, number>();
  for (const entry of entries) {
    slugCounts.set(entry.slug, (slugCounts.get(entry.slug) ?? 0) + 1);
  }

  return entries.map((entry) => {
    if (entry.status !== "valid" || (slugCounts.get(entry.slug) ?? 0) <= 1) {
      return entry;
    }

    return {
      ...entry,
      status: "collision",
      errors: [
        ...(entry.errors ?? []),
        {
          code: "SLUG_COLLISION",
          field: "slug",
          message: `Another agent directory declares slug "${entry.slug}"`,
        },
      ],
    };
  });
}

export function createLifecycleService(
  agentsRoot: string,
  store?: ProjectionStore,
): LifecycleService {
  function scan(): LifecycleRunResult {
    if (!existsSync(agentsRoot)) {
      return emptyResult(agentsRoot);
    }

    const entries = readdirSync(agentsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const soulPath = join(agentsRoot, entry.name, "soul.md");
        return existsSync(soulPath) ? entryFromParse(agentsRoot, entry.name, parseSoulFile(soulPath)) : null;
      })
      .filter((entry): entry is LifecycleScanEntry => entry !== null);

    const results = markCollisions(entries.sort((a, b) => a.slug.localeCompare(b.slug) || a.source_path.localeCompare(b.source_path)));
    const valid = results.filter((entry) => entry.status === "valid").length;
    const withProjection = results.map((entry) => {
      const projection = store?.get?.(entry.slug);
      if (!projection) return entry;
      return {
        ...entry,
        active: projection.active === true,
        projection_version: projection.projection_version,
        activated_at: projection.activated_at,
        deactivated_at: projection.deactivated_at,
      };
    });

    return {
      agents_root: agentsRoot,
      scanned: withProjection.length,
      valid,
      invalid: withProjection.length - valid,
      removed: 0,
      results: withProjection,
    };
  }

  function activateDetailed(slug: string, expectedSourceHash?: string): LifecycleOperationResult {
    const entry = scan().results.find((candidate) => candidate.slug === slug);
    if (!entry) {
      return { ok: false, code: "agent_not_found", message: `Agent ${slug} was not found` };
    }
    if (entry.status === "collision") {
      return { ok: false, code: "agent_collision", message: `Agent ${slug} has a slug collision` };
    }
    if (entry.status !== "valid" || !entry.source_hash) {
      return { ok: false, code: "agent_invalid", message: `Agent ${slug} is not valid` };
    }
    if (expectedSourceHash && expectedSourceHash !== entry.source_hash) {
      return { ok: false, code: "source_changed", message: `Agent ${slug} changed before activation` };
    }
    if (!store) {
      return { ok: false, code: "store_unavailable", message: "Agent activation persistence is unavailable" };
    }

    let written: boolean | ProjectionWriteResult;
    try {
      written = store.activate(slug, entry);
    } catch {
      return { ok: false, code: "store_failed", message: `Agent ${slug} could not be activated` };
    }
    if (!written || (typeof written === "object" && written.active !== true)) {
      return { ok: false, code: "store_rejected", message: `Agent ${slug} could not be activated` };
    }
    const projection: ProjectionWriteResult = typeof written === "object"
      ? { ...written, slug: written.slug ?? slug, source_hash: written.source_hash ?? entry.source_hash }
      : { active: true, slug, source_hash: entry.source_hash };
    if (projection.source_hash !== entry.source_hash) {
      return { ok: false, code: "source_changed", message: `Agent ${slug} changed before activation` };
    }
    return {
      ok: true,
      code: "activated",
      message: `Agent ${slug} activated`,
      entry: { ...entry, ...projection },
      projection,
    };
  }

  function deactivateDetailed(slug: string): LifecycleOperationResult {
    if (!store?.deactivate) {
      return { ok: false, code: "store_unavailable", message: "Agent deactivation persistence is unavailable" };
    }
    let written: boolean | ProjectionWriteResult;
    try {
      written = store.deactivate(slug);
    } catch {
      return { ok: false, code: "store_failed", message: `Agent ${slug} could not be deactivated` };
    }
    if (!written || (typeof written === "object" && written.active !== false)) {
      return { ok: false, code: "store_rejected", message: `Agent ${slug} could not be deactivated` };
    }
    const projection: ProjectionWriteResult = typeof written === "object"
      ? { ...written, slug: written.slug ?? slug }
      : { active: false, slug };
    return {
      ok: true,
      code: "deactivated",
      message: `Agent ${slug} deactivated`,
      projection,
    };
  }

  return {
    scan,
    activate: (slug, expectedSourceHash) => activateDetailed(slug, expectedSourceHash).ok,
    activateDetailed,
    deactivate: (slug) => deactivateDetailed(slug).ok,
    deactivateDetailed,
  };
}

export function validateLifecycleSnapshot(
  lifecycle: LifecycleService,
  snapshot: LifecycleSnapshot,
): LifecycleSnapshotValidation {
  const entry = lifecycle.scan().results.find((candidate) => candidate.slug === snapshot.slug);
  if (!entry) {
    return { ok: false, code: "projection_missing", message: `Agent ${snapshot.slug} is no longer present` };
  }
  if (entry.status !== "valid") {
    return { ok: false, code: "projection_invalid", message: `Agent ${snapshot.slug} is not valid` };
  }
  if (snapshot.active !== true) {
    return { ok: false, code: "projection_inactive", message: `Agent ${snapshot.slug} is not active` };
  }
  if (!snapshot.source_hash || snapshot.source_hash !== entry.source_hash) {
    return { ok: false, code: "projection_stale", message: `Agent ${snapshot.slug} source changed` };
  }
  return { ok: true, entry };
}