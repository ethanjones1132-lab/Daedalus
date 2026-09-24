// ═══════════════════════════════════════════════════════════════
// ── Activation Boundary Snapshots ──
// ═══════════════════════════════════════════════════════════════
// Minimal file-backed projection snapshot support for cron runs.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "./config";

export interface ProjectionSnapshot {
  slug: string;
  active: boolean;
  source_path?: string;
  source_hash?: string;
  projection_version?: number;
  activated_at?: string | null;
  deactivated_at?: string | null;
  updated_at?: string;
  [key: string]: unknown;
}

export interface ActivationBoundary {
  slug: string;
  snapshot: ProjectionSnapshot;
}

const DEFAULT_SNAPSHOT: ProjectionSnapshot = {
  slug: "default",
  active: true,
  updated_at: new Date(0).toISOString(),
};

function projectionDbPath(baseDir: string): string {
  return join(baseDir, "agent_projections.db");
}

function snapshotsDir(baseDir: string): string {
  return join(baseDir, "agent-snapshots");
}

function snapshotPath(slug: string, baseDir: string): string {
  return join(snapshotsDir(baseDir), `${slug}.json`);
}

export function defaultSnapshot(slug = "default"): ProjectionSnapshot {
  return { ...DEFAULT_SNAPSHOT, slug, updated_at: new Date().toISOString() };
}

// Path-injection (baseDir) is an internal seam for tests; production callers
// (cron-runtime.ts:73, :177) leave it unset and get the canonical
// CONFIG_DIR. A regression that broke the disk I/O seam — slug normalization
// on save, fall-through to a safe default on read, the best-effort marker-DB
// dual-write — would silently corrupt the durable projection record and
// leave the cron runtime pointing at the wrong slug. The dedicated
// activation-boundary.test.ts pins the observable contracts.
export function restoreBoundary(slug = "default", baseDir: string = CONFIG_DIR): ActivationBoundary {
  const path = snapshotPath(slug, baseDir);
  if (existsSync(path)) {
    try {
      const snapshot = JSON.parse(readFileSync(path, "utf-8")) as ProjectionSnapshot;
      return { slug: snapshot.slug || slug, snapshot };
    } catch {
      // Fall through to a safe default snapshot.
    }
  }
  return { slug, snapshot: defaultSnapshot(slug) };
}

export function saveBoundary(snapshot: ProjectionSnapshot, baseDir: string = CONFIG_DIR): ActivationBoundary {
  mkdirSync(snapshotsDir(baseDir), { recursive: true });
  const normalized: ProjectionSnapshot = { ...snapshot, slug: snapshot.slug || "default", updated_at: new Date().toISOString() };
  const path = snapshotPath(normalized.slug, baseDir);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(normalized, null, 2));
  renameSync(temporary, path);
  try {
    writeFileSync(projectionDbPath(baseDir), JSON.stringify({ active: normalized.slug, updated_at: normalized.updated_at }, null, 2));
  } catch {
    // The JSON snapshot is the source of truth; the marker file is best-effort.
  }
  return { slug: normalized.slug, snapshot: normalized };
}

function assertSafeSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error("invalid agent slug");
  }
}

function readProjection(slug: string, baseDir: string): ProjectionSnapshot | null {
  assertSafeSlug(slug);
  const path = snapshotPath(slug, baseDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as ProjectionSnapshot;
    if (!parsed || typeof parsed !== "object" || parsed.slug !== slug) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createBoundaryProjectionStore(baseDir: string = CONFIG_DIR) {
  return {
    get(slug: string): ProjectionSnapshot | null {
      return readProjection(slug, baseDir);
    },
    activate(
      slug: string,
      entry: {
        source_path?: string;
        source_hash?: string;
        projection_version?: number;
        activated_at?: string | null;
        deactivated_at?: string | null;
      } = {},
    ): ProjectionSnapshot {
      assertSafeSlug(slug);
      const previous = readProjection(slug, baseDir);
      const sourceHash = entry.source_hash ?? previous?.source_hash;
      if (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/i.test(sourceHash)) {
        throw new Error("activation requires a source hash");
      }
      const now = new Date().toISOString();
      const sameActiveProjection = previous?.active === true && previous.source_hash === sourceHash;
      const next: ProjectionSnapshot = {
        ...previous,
        ...entry,
        slug,
        source_hash: sourceHash,
        active: true,
        projection_version: sameActiveProjection
          ? previous?.projection_version ?? 1
          : (previous?.projection_version ?? 0) + 1,
        activated_at: previous?.activated_at ?? now,
        deactivated_at: null,
        updated_at: now,
      };
      saveBoundary(next, baseDir);
      return next;
    },
    deactivate(slug: string): ProjectionSnapshot {
      assertSafeSlug(slug);
      const previous = readProjection(slug, baseDir);
      const now = new Date().toISOString();
      const next: ProjectionSnapshot = {
        ...previous,
        slug,
        active: false,
        projection_version: previous?.projection_version ?? 1,
        activated_at: previous?.activated_at ?? null,
        deactivated_at: now,
        updated_at: now,
      };
      saveBoundary(next, baseDir);
      return next;
    },
  };
}
