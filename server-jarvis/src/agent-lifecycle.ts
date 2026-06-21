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
  /** The slug in effect for this entry (may be the dir name when parsing fails). */
  slug: string;
  /** Absolute path to the soul.md file that was read. */
  source_path: string;
  /** Outcome for this agent directory during this scan. */
  status: LifecycleScanStatus;
  /** Validation errors from soul.md parsing, present when `status` is `invalid` or `collision`. */
  errors?: Array<{ code: string; field?: string; message: string }>;
  /** Identity fields that can be displayed without loading the full instructions body. */
  name?: string;
  description?: string;
  version?: string;
  tools?: string[];
  source_hash?: string;
  source_size_bytes?: number;
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

export interface ProjectionStore {
  activate(slug: string): boolean;
}

/** Service interface for the agent lifecycle pipeline. */
export interface LifecycleService {
  scan(): LifecycleRunResult;
  activate(slug: string): boolean;
}

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

    return {
      agents_root: agentsRoot,
      scanned: results.length,
      valid,
      invalid: results.length - valid,
      removed: 0,
      results,
    };
  }

  return {
    scan,
    activate(slug: string): boolean {
      if (store) return store.activate(slug);
      return scan().results.some((entry) => entry.slug === slug && entry.status === "valid");
    },
  };
}
