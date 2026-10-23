// Static tool-call scoring — rate a candidate without running it
// Used by best-of-N sampling to choose between candidates before any side
// effect occurs. Deliberately separate from run-reward.ts: that grades a
// completed run from executed evidence, which is unavailable at choice time.
//
// Scoring is on [0, 1] and evidence-based only — no model call, no I/O.

import type { ToolCall, ToolDefinition } from "../tool-types";

export interface ToolCallScore {
  score: number;
  /** Structurally unusable — never select a fatal candidate. */
  fatal: boolean;
  reasons: string[];
}

/**
 * Strings models emit when inventing a path instead of using a real one.
 * Narrow on purpose: a broad pattern would penalize legitimate paths.
 */
const PLACEHOLDER_PATTERNS = [
  /path\/to\//i,
  /your[-_/]?(?:file|project|path)/i,
  /<[^>]+>/,
  /\{\{.+\}\}/,
  /\bexample\.(?:com|org)\b/i,
  /\bTODO\b/,
];

function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((p) => p.test(value));
}

function typeMatches(expected: unknown, value: unknown): boolean {
  switch (expected) {
    case "string": return typeof value === "string";
    case "number":
    case "integer": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    default: return true;
  }
}

export function scoreToolCall(call: ToolCall, tools: readonly ToolDefinition[]): ToolCallScore {
  const reasons: string[] = [];
  const def = tools.find((t) => t.function.name === call.name);

  if (!def) {
    return { score: 0, fatal: true, reasons: [`unknown tool: ${call.name}`] };
  }

  const params = def.function.parameters ?? { type: "object", properties: {}, required: [] };
  const properties = (params.properties ?? {}) as Record<string, { type?: unknown }>;
  const required: string[] = (params.required ?? []) as string[];
  const args = call.arguments ?? {};

  const missing = required.filter((k) => !(k in args) || args[k] === undefined);
  if (missing.length > 0) {
    return {
      score: 0,
      fatal: true,
      reasons: [`missing required argument(s): ${missing.join(", ")}`],
    };
  }

  // Start from a valid baseline and subtract for every specific defect. A
  // candidate with no defects lands at 1.0.
  let score = 1;

  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (!spec) {
      score -= 0.15;
      reasons.push(`unknown argument: ${key}`);
      continue;
    }
    if (!typeMatches(spec.type, value)) {
      score -= 0.25;
      reasons.push(`argument "${key}" has the wrong type`);
    }
    if (typeof value === "string") {
      if (value.trim().length === 0) {
        score -= 0.2;
        reasons.push(`argument "${key}" is empty`);
      } else if (looksLikePlaceholder(value)) {
        score -= 0.3;
        reasons.push(`argument "${key}" looks like a placeholder`);
      }
    }
  }

  return { score: Math.max(0, Math.min(1, score)), fatal: false, reasons };
}
