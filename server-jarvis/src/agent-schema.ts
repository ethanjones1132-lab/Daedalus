// ═══════════════════════════════════════════════════════════════
// ── P1-01: File-Canonical Agent Schema ──
// ═══════════════════════════════════════════════════════════════
// Parses and validates soul.md files into typed AgentIdentity + AgentProvenance.
// soul.md format: YAML frontmatter (--- ... ---) followed by a markdown body
// that becomes the agent's `instructions`.

import { createHash } from "crypto";
import { readFileSync, statSync } from "fs";

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

export interface AgentProvenance {
  source_path: string;
  source_hash: string;
  source_size_bytes: number;
}

type ParsedSoulFile =
  | { ok: true; identity: AgentIdentity; provenance: AgentProvenance }
  | { ok: false; identity?: undefined; provenance: AgentProvenance; errors: ValidationError[] };

const ALLOWED_FRONTMATTER_KEYS = new Set([
  "slug",
  "name",
  "description",
  "instructions",
  "tools",
  "version",
]);

const RUNTIME_STATE_FIELDS = new Set([
  "active",
  "status",
  "last_run_at",
  "last_run",
  "created_at",
  "updated_at",
  "projection",
  "projections",
  "memory",
  "memories",
  "sessions",
  "last_active",
  "last_interaction",
  "happiness",
  "energy",
  "level",
  "xp",
]);

function parseScalar(raw: string): string | string[] {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const body = value.slice(1, -1).trim();
    if (!body) return [];
    return body.split(",").map((item) => item.trim()).filter(Boolean);
  }

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

function parseFrontmatter(raw: string): Record<string, string | string[]> {
  const fields: Record<string, string | string[]> = {};
  let activeArrayKey: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const keyMatch = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (keyMatch) {
      const [, key, value] = keyMatch;
      activeArrayKey = null;
      if (value.trim() === "") {
        fields[key] = [];
        activeArrayKey = key;
      } else {
        fields[key] = parseScalar(value);
      }
      continue;
    }

    const arrayItem = line.match(/^\s*-\s+(.+)$/);
    if (arrayItem && activeArrayKey) {
      const current = fields[activeArrayKey];
      if (Array.isArray(current)) {
        const parsed = parseScalar(arrayItem[1]);
        if (Array.isArray(parsed)) current.push(...parsed);
        else current.push(parsed);
      }
    }
  }

  return fields;
}

function addError(
  errors: ValidationError[],
  code: ValidationErrorCode,
  field?: string,
  message?: string,
) {
  errors.push({ code, field, message: message ?? field ?? code });
}

function requireString(
  fields: Record<string, string | string[]>,
  key: "slug" | "name" | "description" | "version",
  errors: ValidationError[],
): string | undefined {
  const value = fields[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    addError(errors, "INVALID_TYPE", key, `${key} must be a non-empty string`);
    return undefined;
  }
  return value.trim();
}

function requireStringArray(
  fields: Record<string, string | string[]>,
  key: "tools",
  errors: ValidationError[],
): string[] | undefined {
  const value = fields[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    addError(errors, "INVALID_TYPE", key, "tools must be a string array");
    return undefined;
  }
  const tools = value.filter((item) => typeof item === "string" && item.trim() !== "");
  if (tools.length !== value.length) {
    addError(errors, "INVALID_TYPE", key, "tools must contain only strings");
  }
  return tools;
}

function validateIdentity(
  fields: Record<string, string | string[]>,
  instructions: string,
  provenance: AgentProvenance,
): ParsedSoulFile {
  const errors: ValidationError[] = [];

  for (const key of Object.keys(fields)) {
    if (!ALLOWED_FRONTMATTER_KEYS.has(key)) {
      addError(errors, "UNKNOWN_KEY", key, `Unknown soul.md frontmatter key: ${key}`);
    }
    if (RUNTIME_STATE_FIELDS.has(key)) {
      addError(errors, "RUNTIME_STATE_FIELD", key, `${key} is runtime state; keep soul.md identity-only`);
    }
  }

  const slug = requireString(fields, "slug", errors);
  const name = requireString(fields, "name", errors);

  if (!slug) {
    addError(errors, "MISSING_REQUIRED_FIELD", "slug", "slug is required");
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    addError(errors, "INVALID_TYPE", "slug", "slug must use lowercase letters, numbers, and hyphens");
  }

  if (!name) {
    addError(errors, "MISSING_REQUIRED_FIELD", "name", "name is required");
  }

  const description = requireString(fields, "description", errors);
  const version = requireString(fields, "version", errors);
  const tools = requireStringArray(fields, "tools", errors);

  if (!instructions.trim()) {
    addError(errors, "MISSING_REQUIRED_FIELD", "instructions", "instructions body is required after the frontmatter block");
  }

  if (errors.length > 0) {
    return { ok: false, provenance, errors };
  }

  return {
    ok: true,
    identity: {
      slug: slug!,
      name: name!,
      ...(description ? { description } : {}),
      instructions: instructions.trim(),
      ...(tools ? { tools } : {}),
      ...(version ? { version } : {}),
    },
    provenance,
  };
}

export function parseSoulFile(sourcePath: string): ParsedSoulFile {
  const content = readFileSync(sourcePath, "utf-8");
  const provenance: AgentProvenance = {
    source_path: sourcePath,
    source_hash: createHash("sha256").update(content).digest("hex"),
    source_size_bytes: Buffer.byteLength(content, "utf-8"),
  };

  const match = content.match(/^---\r?\n([\s\S]*?)^---\s*(?:\r?\n|$)([\s\S]*)$/m);
  if (!match) {
    return {
      ok: false,
      provenance,
      errors: [{ code: "MISSING_REQUIRED_FIELD", field: "frontmatter", message: "soul.md must start with a YAML frontmatter block" }],
    };
  }

  const fields = parseFrontmatter(match[1]);
  const instructions = match[2];
  return validateIdentity(fields, instructions, provenance);
}
