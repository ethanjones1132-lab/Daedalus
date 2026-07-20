// Keystone pin for the capability taxonomy (P2.1).
//
// Supervision used to branch on six hand-maintained tool-name lists. Those
// lists are now DERIVED from the capability each tool declares at its
// registration site. The whole point of the refactor is that "someone
// registered a tool and forgot to add it to one of the lists" becomes
// impossible — so this file pins exactly that:
//
//   1. every tool a standard bundle registers declares a capability;
//   2. every derived set is a SUPERSET of the legacy list it replaced.
//
// Superset rather than equality: the taxonomy is allowed to be more complete
// than the hand-written lists were (that is the improvement), but it may never
// silently DROP a tool a legacy list covered — that would be a regression in
// write accounting, evidence credit, or the read-only security allowlist.

import { describe, expect, test } from "bun:test";
import { createToolRuntime } from "./tool-runtime";
import { registerStandardBundles } from "./bundles-registry";
import { buildCapabilityIndex, buildCapabilityIndexFromRuntime } from "./tool-capabilities";
import type { ToolDefinition } from "./tool-types";

// ── The legacy lists, transcribed verbatim from their pre-refactor sites ──
const LEGACY = {
  /** effect-gate.ts WRITE_EFFECT_TOOLS */
  writeEffect: ["write_file", "edit_file", "multi_edit", "apply_patch"],
  /** modes.ts READ_ONLY_TOOLS — the read_only PROFILE security allowlist */
  readOnlyProfile: ["read_file", "list_directory", "glob", "grep", "git_metadata"],
  /** pipeline.ts READ_ONLY_TOOLS — the parallel-batch / non-mutating set */
  parallelSafe: ["read_file", "list_directory", "glob", "grep", "git_metadata", "web_fetch"],
  /** pipeline.ts READ_CACHE_TOOLS */
  cacheable: ["read_file", "list_directory", "glob", "grep", "web_fetch"],
  /** evidence-sufficiency.ts DEEP_READ_CONTENT_TOOLS */
  contentEvidence: ["read_file", "grep"],
  /** evidence-sufficiency.ts LISTING_TOOLS */
  listingEvidence: ["list_directory", "glob"],
  /** evidence-sufficiency.ts NETWORK_TOOLS */
  networkEvidence: ["web_fetch", "web_search"],
  /** The single tool that declares `evidence: "metadata"` (git_metadata-bundle.ts).
   *  Note: SHALLOW_EVIDENCE_TOOLS in evidence-sufficiency.ts is a UNION of
   *  content + metadata evidence for the shallow floor; the metadata-evidence
   *  set itself is just the metadata tools. */
  metadataEvidence: ["git_metadata"],
  /** Every tool that declares `class: "shell"` (bash + powershell today; the
   *  legacy SHELL_TOOLS set in evidence-sufficiency.ts also lists `shell` and
   *  `run_background_command`, but those names are not registered as tools in
   *  the live runtime — the keystone pins the LIVE registry, not the alias
   *  table). */
  executionEvidence: ["bash", "powershell"],
} as const;

function standardRuntimeIndex() {
  const runtime = createToolRuntime();
  registerStandardBundles(runtime);
  return { runtime, index: buildCapabilityIndexFromRuntime(runtime) };
}

describe("capability taxonomy", () => {
  test("every standard-bundle tool declares a capability", () => {
    const { runtime, index } = standardRuntimeIndex();
    expect(runtime.listTools().length).toBeGreaterThan(0);
    expect([...index.unclassified].sort()).toEqual([]);
  });

  for (const [setName, legacyNames] of Object.entries(LEGACY)) {
    test(`derived ${setName} covers every legacy entry`, () => {
      const { index } = standardRuntimeIndex();
      const derived = index[setName as keyof typeof LEGACY] as Set<string>;
      const missing = legacyNames.filter((name) => !derived.has(name));
      expect(missing).toEqual([]);
    });
  }

  test("shell + delegate tools are not admitted to the read-only profile", () => {
    const { index } = standardRuntimeIndex();
    for (const name of [...index.byClass.shell, ...index.byClass.delegate, ...index.byClass.write]) {
      expect(index.readOnlyProfile.has(name)).toBe(false);
    }
  });

  test("no write tool is parallel-safe or cacheable", () => {
    const { index } = standardRuntimeIndex();
    for (const name of index.writeEffect) {
      expect(index.parallelSafe.has(name)).toBe(false);
      expect(index.cacheable.has(name)).toBe(false);
    }
  });

  test("git_metadata is parallel-safe but never cached (HEAD moves mid-turn)", () => {
    const { index } = standardRuntimeIndex();
    expect(index.parallelSafe.has("git_metadata")).toBe(true);
    expect(index.cacheable.has("git_metadata")).toBe(false);
  });
});

describe("buildCapabilityIndex", () => {
  function defOf(name: string, capability?: ToolDefinition["capability"]): ToolDefinition {
    return {
      type: "function",
      function: { name, description: "", parameters: { type: "object", properties: {}, required: [] } },
      requires_approval: false,
      dangerous: false,
      ...(capability ? { capability } : {}),
    };
  }

  test("an unannotated tool fails closed rather than inheriting privileges", () => {
    const index = buildCapabilityIndex([defOf("mystery_tool")]);
    expect(index.unclassified.has("mystery_tool")).toBe(true);
    expect(index.writeEffect.has("mystery_tool")).toBe(false);
    expect(index.readOnlyProfile.has("mystery_tool")).toBe(false);
    expect(index.parallelSafe.has("mystery_tool")).toBe(false);
    expect(index.cacheable.has("mystery_tool")).toBe(false);
  });

  test("class write implies write-effect membership", () => {
    const index = buildCapabilityIndex([defOf("zap", { class: "write", evidence: "none" })]);
    expect([...index.writeEffect]).toEqual(["zap"]);
    expect([...index.byClass.write]).toEqual(["zap"]);
  });

  test("evidence class routes into exactly one evidence set", () => {
    const index = buildCapabilityIndex([
      defOf("a", { class: "read", evidence: "content" }),
      defOf("b", { class: "list", evidence: "listing" }),
      defOf("c", { class: "shell", evidence: "execution" }),
      defOf("d", { class: "network", evidence: "network" }),
      defOf("e", { class: "read", evidence: "metadata" }),
      defOf("f", { class: "meta", evidence: "none" }),
    ]);
    expect([...index.contentEvidence]).toEqual(["a"]);
    expect([...index.listingEvidence]).toEqual(["b"]);
    expect([...index.executionEvidence]).toEqual(["c"]);
    expect([...index.networkEvidence]).toEqual(["d"]);
    expect([...index.metadataEvidence]).toEqual(["e"]);
    // `none` contributes to no evidence set at all.
    for (const key of ["contentEvidence", "listingEvidence", "executionEvidence", "networkEvidence", "metadataEvidence"] as const) {
      expect(index[key].has("f")).toBe(false);
    }
  });
});
