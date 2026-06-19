// ─── Token counting ──────────────────────────────────────────────────────────
// A single accurate token estimator used across context optimization, history
// compaction, and cost accounting. Replaces the legacy `Math.ceil(len / 4)`
// heuristic, which under-counted code-heavy content by ~25% and risked context
// overflow before compaction triggered.
//
// We use gpt-tokenizer's cl100k_base BPE encoder. For OpenAI-family models this
// is exact; for local models (Qwen, Nemotron, etc.) it is a close proxy, so we
// apply a small upward safety multiplier to stay conservative and avoid
// overflowing the real context window.

import { encode } from "gpt-tokenizer";

// Conservative margin for non-OpenAI tokenizers (Qwen/SentencePiece tends to be
// within ~10% of cl100k for typical chat + code).
const SAFETY_MULTIPLIER = 1.1;

/**
 * Estimate the number of tokens in `text`.
 *
 * - Returns 0 for empty/null/undefined.
 * - Never throws: falls back to the legacy len/4 heuristic if encoding fails.
 */
export function countTokens(text: string | null | undefined): number {
  if (!text) return 0;
  try {
    return Math.ceil(encode(text).length * SAFETY_MULTIPLIER);
  } catch {
    // Defensive fallback — the hot path must never throw on a token estimate.
    return Math.ceil(text.length / 4);
  }
}
