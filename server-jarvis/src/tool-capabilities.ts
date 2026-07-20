// ═══════════════════════════════════════════════════════════════
// ── Capability index — derived tool sets for supervision code ──
// ═══════════════════════════════════════════════════════════════
// Supervision used to branch on six hand-maintained tool-name lists spread
// across the effect gate, the pipeline, mode selection, evidence accounting,
// and config. Registering a new tool meant remembering all six; forgetting one
// produced a silent, hard-to-attribute behavioural gap (a write that earned no
// write credit, a read that earned no evidence, a safe tool serialized).
//
// The lists are now DERIVED from the capability each tool declares at its
// registration site. `bundles-registry.test.ts` pins that every derived set is
// a superset of the legacy list it replaced, so the migration cannot regress
// and a newly-registered tool cannot be missed.

import type {
  ToolCapability,
  ToolCapabilityClass,
  ToolDefinition,
  ToolEvidenceClass,
} from "./tool-types";

export interface CapabilityIndex {
  /** Tools whose success constitutes a real workspace mutation (effect gate). */
  writeEffect: Set<string>;
  /** Security allowlist for the `read_only` execution profile. */
  readOnlyProfile: Set<string>;
  /** Safe to run concurrently inside one batch. */
  parallelSafe: Set<string>;
  /** Output may be served from the per-turn read cache. */
  cacheable: Set<string>;
  /** Successful calls yield file/document CONTENT (deep-read floor). */
  contentEvidence: Set<string>;
  /** Successful calls yield a directory/name LISTING only. */
  listingEvidence: Set<string>;
  /** Successful calls yield repository/file METADATA. */
  metadataEvidence: Set<string>;
  /** Successful calls yield command EXECUTION evidence. */
  executionEvidence: Set<string>;
  /** Successful calls yield NETWORK-retrieved evidence. */
  networkEvidence: Set<string>;
  /** Every registered name, grouped by capability class. */
  byClass: Record<ToolCapabilityClass, Set<string>>;
  /** Names registered without a declared capability. */
  unclassified: Set<string>;
}

const CLASSES: ToolCapabilityClass[] = [
  "read",
  "list",
  "write",
  "shell",
  "network",
  "delegate",
  "meta",
  "interactive",
];

const EVIDENCE_SET_BY_CLASS: Record<ToolEvidenceClass, keyof CapabilityIndex | null> = {
  content: "contentEvidence",
  listing: "listingEvidence",
  metadata: "metadataEvidence",
  execution: "executionEvidence",
  network: "networkEvidence",
  none: null,
};

function emptyIndex(): CapabilityIndex {
  const byClass = {} as Record<ToolCapabilityClass, Set<string>>;
  for (const cls of CLASSES) byClass[cls] = new Set<string>();
  return {
    writeEffect: new Set(),
    readOnlyProfile: new Set(),
    parallelSafe: new Set(),
    cacheable: new Set(),
    contentEvidence: new Set(),
    listingEvidence: new Set(),
    metadataEvidence: new Set(),
    executionEvidence: new Set(),
    networkEvidence: new Set(),
    byClass,
    unclassified: new Set(),
  };
}

/**
 * Build the derived capability sets from tool definitions.
 *
 * A tool WITHOUT a declared capability is treated as maximally restricted: it
 * joins `unclassified` and no permissive set. That way an unannotated tool
 * fails closed (no write credit, no read-only admission, no parallel batching)
 * instead of silently inheriting privileges.
 */
export function buildCapabilityIndex(defs: readonly ToolDefinition[]): CapabilityIndex {
  const index = emptyIndex();

  for (const def of defs) {
    const name = def.function.name;
    const cap: ToolCapability | undefined = def.capability;

    if (!cap) {
      index.unclassified.add(name);
      continue;
    }

    index.byClass[cap.class].add(name);

    if (cap.class === "write") index.writeEffect.add(name);
    if (cap.read_only_profile) index.readOnlyProfile.add(name);
    if (cap.parallel_safe) index.parallelSafe.add(name);
    if (cap.cacheable) index.cacheable.add(name);

    const evidenceSet = EVIDENCE_SET_BY_CLASS[cap.evidence];
    if (evidenceSet) (index[evidenceSet] as Set<string>).add(name);
  }

  return index;
}

/** Convenience: build the index straight from a runtime. */
export function buildCapabilityIndexFromRuntime(runtime: {
  listTools(): ToolDefinition[];
}): CapabilityIndex {
  return buildCapabilityIndex(runtime.listTools());
}
