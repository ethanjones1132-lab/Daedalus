// ═══════════════════════════════════════════════════════════════
// ── Activation Boundary Snapshots ──
// ═══════════════════════════════════════════════════════════════
// Minimal file-backed projection snapshot support for cron runs.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "./config";

export interface ProjectionSnapshot {
  slug: string;
  active?: boolean;
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
  writeFileSync(snapshotPath(normalized.slug, baseDir), JSON.stringify(normalized, null, 2));
  try {
    writeFileSync(projectionDbPath(baseDir), JSON.stringify({ active: normalized.slug, updated_at: normalized.updated_at }, null, 2));
  } catch {
    // The JSON snapshot is the source of truth; the marker file is best-effort.
  }
  return { slug: normalized.slug, snapshot: normalized };
}
