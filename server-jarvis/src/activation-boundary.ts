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

function projectionDbPath(): string {
  return join(CONFIG_DIR, "agent_projections.db");
}

function snapshotsDir(): string {
  return join(CONFIG_DIR, "agent-snapshots");
}

function snapshotPath(slug: string): string {
  return join(snapshotsDir(), `${slug}.json`);
}

export function defaultSnapshot(slug = "default"): ProjectionSnapshot {
  return { ...DEFAULT_SNAPSHOT, slug, updated_at: new Date().toISOString() };
}

export function restoreBoundary(slug = "default"): ActivationBoundary {
  const path = snapshotPath(slug);
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

export function saveBoundary(snapshot: ProjectionSnapshot): ActivationBoundary {
  mkdirSync(snapshotsDir(), { recursive: true });
  const normalized: ProjectionSnapshot = { ...snapshot, slug: snapshot.slug || "default", updated_at: new Date().toISOString() };
  writeFileSync(snapshotPath(normalized.slug), JSON.stringify(normalized, null, 2));
  try {
    writeFileSync(projectionDbPath(), JSON.stringify({ active: normalized.slug, updated_at: normalized.updated_at }, null, 2));
  } catch {
    // The JSON snapshot is the source of truth; the marker file is best-effort.
  }
  return { slug: normalized.slug, snapshot: normalized };
}
