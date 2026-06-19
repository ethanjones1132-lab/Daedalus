// ═══════════════════════════════════════════════════════════════
// ── P1-01: File-Canonical Agent Schema ──
// ═══════════════════════════════════════════════════════════════
// Parses and validates soul.md files into typed AgentIdentity + AgentProvenance.
// soul.md format: YAML frontmatter (--- ... ---) followed by a markdown body
// that becomes the agent's `instructions`.

import { createHash } from "crypto";

// ── Public Types ──────────────────────────────────────────────────────────────

export type ValidationErrorCode =
  | "MISSING_REQUIRED_FIELD"
  | "INVALID_TYPE"
  | "UNKNOWN_KEY"
  | "RUNTIME_STATE_FIELD";

export interface ValidationError {
  code: ValidationErrorCode;
  field?: string;
  message: string;
}

/** Identity fields extracted from soul.md — no runtime state allowed here. */
export interface AgentIdentity {
  slug: string;
  name: string;
  description?: string;
  /** The full markdown body after the frontmatter block. */
  instructions: string;
  tools?: string[];
  version?: string;
}