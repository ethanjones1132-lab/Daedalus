import { createRequire } from "node:module";
import { resolve } from "node:path";

// A single accurate token estimator used across context optimization, history
// compaction, and cost accounting. Replaces the legacy heuristic, which
// under-counted code-heavy content and risked context overflow before compaction
// triggered.
//
// The pinned gpt-tokenizer package-root encoder is exact for OpenAI-family
// models and a close proxy for local models (Qwen, Nemotron, etc.). Production
// bundles load that same encoder from an adjacent self-contained artifact on
// first use, keeping its large BPE table off the startup path.

const SAFETY_MULTIPLIER = 1.1;
const PACKAGED_TOKENIZER = process.env.JARVIS_TOKENIZER_PACKAGED === "true";

type TokenizerModule = {
  encodeTokenCount(text: string): number;
};

const sourceRequire = createRequire(import.meta.url);
let tokenizer: TokenizerModule | undefined;
let tokenizerLoadAttempted = false;
let tokenizerLoadAttempts = 0;

function loadTokenizer(): TokenizerModule | undefined {
  if (tokenizerLoadAttempted) return tokenizer;
  tokenizerLoadAttempted = true;
  tokenizerLoadAttempts++;

  try {
    if (PACKAGED_TOKENIZER) {
      // The Tauri resource map puts this beside index.js. Resolve from Bun's
      // actual entry path so startup CWD and global package caches are irrelevant.
      const entryPath = process.argv[1];
      if (!entryPath) return undefined;
      const runtimeRequire = createRequire(resolve(entryPath));
      const localTokenizer = runtimeRequire("./tokenizer.cjs") as TokenizerModule;
      if (typeof localTokenizer.encodeTokenCount !== "function") return undefined;
      // The first call is allowed to load. Later calls must reuse that module:
      // returning it without storing it made the next countTokens fall through
      // to the len/4 heuristic while reporting a single load attempt.
      tokenizer = localTokenizer;
      return tokenizer;
    }

    // Source and test runs use the exact package root installed for this
    // checkout. The production build folds PACKAGED_TOKENIZER to true and can
    // never fall through to this package-resolution path.
    const packageTokenizer = sourceRequire("gpt-tokenizer") as {
      encode(text: string): number[];
    };
    tokenizer = { encodeTokenCount: (text) => packageTokenizer.encode(text).length };
    return tokenizer;
  } catch {
    return undefined;
  }
}

/**
 * Estimate the number of tokens in text.
 *
 * - Returns 0 for empty/null/undefined.
 * - Never throws: falls back to the legacy len/4 heuristic if encoding fails.
 */
export function countTokens(text: string | null | undefined): number {
  if (!text) return 0;
  try {
    const encodedCount = loadTokenizer()?.encodeTokenCount(text);
    if (typeof encodedCount !== "number" || !Number.isFinite(encodedCount) || encodedCount < 0) {
      throw new Error("tokenizer unavailable");
    }
    return Math.ceil(encodedCount * SAFETY_MULTIPLIER);
  } catch {
    // Defensive fallback — the hot path must never throw on a token estimate.
    return Math.ceil(text.length / 4);
  }
}

/** @internal Exposes lazy-load behavior to the isolated bundle regression test. */
export function getTokenizerLoadAttemptsForTest(): number {
  return tokenizerLoadAttempts;
}