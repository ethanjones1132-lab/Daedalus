// The capability index for the STANDARD bundle set.
//
// Kept in its own module so `tool-capabilities.ts` stays a pure, dependency-free
// transform (easy to unit-test with synthetic definitions) while supervision
// code that needs "the real sets" has one obvious place to get them.
//
// Built lazily and memoized: registration is cheap but not free, and importing
// this module must not cost anything for callers that never ask for the index.

import { createToolRuntime } from "./tool-runtime";
import { registerStandardBundles } from "./bundles-registry";
import { buildCapabilityIndexFromRuntime, type CapabilityIndex } from "./tool-capabilities";

let cached: CapabilityIndex | null = null;

/** The derived capability sets for the standard bundles. Memoized. */
export function defaultCapabilityIndex(): CapabilityIndex {
  if (cached === null) {
    const runtime = createToolRuntime();
    registerStandardBundles(runtime);
    cached = buildCapabilityIndexFromRuntime(runtime);
  }
  return cached;
}

/** Test seam — drops the memo so a test can observe a rebuilt index. */
export function resetDefaultCapabilityIndex(): void {
  cached = null;
}
