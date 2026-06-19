// ═══════════════════════════════════════════════════════════════
// ── P1-03: Agent Lifecycle Pipeline ──
// ═══════════════════════════════════════════════════════════════
// Orchestrates the canonical agent lifecycle:
//   discover → validate → project → activate
//
// Discovery enumerates <slug>/soul.md entries under the configured
// agents root. Validation is delegated to the P1-01 schema parser.
// Projection is persisted via the P1-04 projection store.
    //
// Removal: projections whose backing directories are no longer
// present on disk are cleaned up at the end of each scan.

import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join } from "path";
import { parseSoulFile } from "./agent-schema";
import type { ProjectionStore } from "./projection-store";

// ── Public Types ──────────────────────────────────────────────────────────────
    
export type LifecycleScanStatus = "valid" | "invalid" | "collision";

/**
 * Per-agent result entry produced by a single scan run.
 */
export interface LifecycleScanEntry {
  /** The slug in effect for this entry (may be the dir name when parsing fails). */
  slug: string;
  /** Absolute path to the soul.md file that was read. */
      source_path: string;
  /** Outcome for this agent directory during this scan. */
  status: LifecycleScanStatus;
  /**
   * Validation errors from soul.md parsing, present when `status` is `"invalid"`.
   * Also present for `"collision"` entries — the error describes the duplicate.
   */
  errors?: Array<{ code: string; field?: string; message: string }>;
}

    /**
 * Aggregate result returned by `scan()`.
 */
export interface LifecycleRunResult {
  /** The agents root that was scanned. */
  agents_root: string;
  /** Total agent directories with a soul.md found. */
  scanned: number;
  /** Directories that produced a valid projection. */
  valid: number;
      /**
   * Directories that produced an invalid projection (parse failure or collision).
   * Collision entries are counted here because they are persisted as `invalid`.
   */
  invalid: number;
  /** Projections removed from the store (their directories no longer exist). */
  removed: number;
  /** Per-agent detail for every scanned directory. */
  results: LifecycleScanEntry[];
}
    
// ── Service Interface ─────────────────────────────────────────────────────────

export interface LifecycleService {
  /**
   * Scan the agents root, project all discovered agents, and remove stale
   * projections for directories that no longer exist on disk.
   */
  scan(): LifecycleRunResult;

      /**
   * Mark a valid projection as activated. Returns `false` when the slug is
   * unknown or the projection is not in `valid` status.
   *
   * Delegates directly to `store.activate(slug)`.
   */
  activate(slug: string): boolean;
}

// ── Factory ───────────────────────────────────────────────────────────────────
... 166 lines not shown ...