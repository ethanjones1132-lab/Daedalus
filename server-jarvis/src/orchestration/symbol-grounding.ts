/**
 * Phase A1 — Symbol grounding for write turns.
 *
 * Extract identifiers named in the task/plan, grep the project source for them,
 * and format a `[Runtime grounding: symbol table]` block so the executor cannot
 * fabricate APIs that do not exist in the workspace.
 *
 * Pure logic lives here so unit tests do not need the pipeline. The pipeline
 * issues greps via `runToolCall` and injects `formatGroundingBlock` output.
 */

import { prepareToolResultForContext } from "../tool-result-truncation";
import { BASELINE_THETA, policy } from "./orchestration-policy";

export const MAX_GROUNDING_SYMBOLS = BASELINE_THETA.max_grounding_symbols;
export const MAX_GROUNDING_GREPS = BASELINE_THETA.max_grounding_greps;
export const GROUNDING_GREP_HEAD_LIMIT = BASELINE_THETA.grounding_grep_head_limit;
export const GROUNDING_BLOCK_CONTEXT_CHARS = BASELINE_THETA.grounding_block_context_chars;
export const DEP_DIR_CANDIDATES = [
  "node_modules",
  "vendor",
  "JUCE",
  "ThirdParty",
  "external",
] as const;

/** English/generic tokens that are never useful grounding targets. */
const STOPLIST = new Set([
  "the", "and", "for", "with", "from", "this", "that", "into", "when", "then",
  "else", "true", "false", "null", "undefined", "return", "const", "let", "var",
  "function", "class", "type", "interface", "import", "export", "default",
  "async", "await", "public", "private", "protected", "static", "void", "new",
  "file", "files", "path", "paths", "code", "line", "lines", "error", "errors",
  "test", "tests", "read", "write", "edit", "create", "update", "delete",
  "implement", "fix", "change", "add", "remove", "use", "using", "please",
  "should", "must", "need", "needs", "make", "ensure", "check", "verify",
  "before", "after", "about", "above", "below", "under", "over", "between",
  "request", "plan", "task", "stage", "executor", "workspace", "project",
  "source", "module", "package", "string", "number", "boolean", "object",
  "array", "value", "values", "result", "results", "output", "input",
  "message", "user", "agent", "model", "tool", "tools", "call", "calls",
  "true", "false", "none", "only", "also", "just", "like", "such", "each",
  "all", "any", "some", "other", "same", "than", "them", "they", "their",
  "your", "our", "its", "his", "her", "not", "but", "can", "will", "would",
  "could", "may", "might", "shall", "have", "has", "had", "been", "being",
  "are", "was", "were", "did", "does", "done", "doing", "get", "set", "put",
  "run", "see", "try", "via", "per", "out", "off", "on", "in", "to", "of",
  "or", "if", "as", "at", "by", "is", "it", "an", "a", "i", "we", "do",
  "no", "yes", "ok", "todo", "fixme", "note", "notes", "doc", "docs",
  "readme", "json", "yaml", "toml", "md", "txt", "cpp", "hpp", "h", "c",
  "py", "ts", "js", "tsx", "jsx", "rs", "go", "java", "kt", "swift",
  "name", "names", "api", "http", "url", "data", "item", "items", "list",
  "map", "key", "keys", "index", "main", "app", "lib", "src", "bin", "dist",
  "build", "config", "cfg", "env", "log", "logs", "debug", "info", "warn",
  "fail", "failed", "failure", "success", "pass", "passed", "skip",
  "first", "last", "next", "prev", "previous", "current", "new", "old",
  "left", "right", "start", "end", "begin", "finish", "complete",
  "solution", "helper", "utils", "util", "common", "base", "core",
  "handle", "handler", "process", "processor", "manager", "service",
  "state", "status", "mode", "type", "kind", "version", "id", "uuid",
]);

export interface SymbolGroundingHit {
  path: string;
  line: number;
  text: string;
}

/** Tri-state evidence: only `missing` may populate the fabricated-symbol deny-set. */
export type SymbolGroundingStatus = "found" | "missing" | "indeterminate";

export interface SymbolGroundingResult {
  symbol: string;
  status: SymbolGroundingStatus;
  hits: SymbolGroundingHit[];
  errors?: string[];
}

export interface SymbolGroundingSummary {
  symbols_searched: number;
  symbols_found: number;
  symbols_missing: number;
  symbols_indeterminate: number;
  greps_used: number;
}

type GroundingSearchAttempt =
  | { status: "ok"; hits: SymbolGroundingHit[] }
  | { status: "error"; reason: string }
  | { status: "budget_exhausted" };

export type GroundingGrepFn = (args: {
  pattern: string;
  path: string;
  headLimit: number;
}) => Promise<{ output: string; is_error: boolean }>;

/**
 * Local identifier extraction — no model call.
 * Pulls candidates from task + plan prose: backticked spans, qualified names
 * (`a::b`, `a.b.c`), CamelCase tokens, and `name(` call shapes.
 */
export function extractGroundingIdentifiers(text: string): string[] {
  if (!text || !text.trim()) return [];

  const candidates: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    const symbol = raw.trim();
    if (!symbol || seen.has(symbol)) return;
    if (!isGroundingCandidate(symbol)) return;
    seen.add(symbol);
    candidates.push(symbol);
  };

  // 1) Backticked code spans that contain an identifier character.
  for (const match of text.matchAll(/`([^`\n]{1,120})`/g)) {
    const span = match[1]?.trim();
    if (!span) continue;
    if (!/[A-Za-z_]/.test(span)) continue;
    // Prefer the whole span when it looks like a single symbol / qualified name.
    if (/^[A-Za-z_@][\w.:]*$/.test(span) || /^[\w.]+::[\w.:]+$/.test(span)) {
      push(span.replace(/[()[\];,]+$/g, ""));
      continue;
    }
    // Otherwise harvest identifiers inside the span.
    harvestFromFragment(span, push);
  }

  // 2) Qualified names: a::b or a.b.c (two or more segments).
  for (const match of text.matchAll(
    /\b([A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)+|[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*){2,})\b/g,
  )) {
    push(match[1]!);
  }

  // 3) CamelCase / PascalCase identifiers (at least two humps, length ≥ 4).
  for (const match of text.matchAll(
    /\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+[A-Za-z0-9]*)\b/g,
  )) {
    push(match[1]!);
  }

  // 4) Function-call shaped tokens name(
  for (const match of text.matchAll(/\b([A-Za-z_][\w]*)\s*\(/g)) {
    push(match[1]!);
  }

  return candidates.slice(0, policy().max_grounding_symbols);
}

function harvestFromFragment(fragment: string, push: (s: string) => void): void {
  for (const match of fragment.matchAll(
    /\b([A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)+|[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*){2,}|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+[A-Za-z0-9]*|[A-Za-z_][\w]*)\b/g,
  )) {
    push(match[1]!);
  }
}

function isGroundingCandidate(symbol: string): boolean {
  if (symbol.length < 2 || symbol.length > 80) return false;
  // Single pure-lowercase English-ish word → drop.
  if (/^[a-z]+$/.test(symbol)) {
    if (STOPLIST.has(symbol)) return false;
    // Allow short API-looking lowercase only when long enough and not stoplisted
    // is still too noisy — plan: filter single lowercase words.
    return false;
  }
  const base = symbol.includes("::")
    ? symbol.split("::").pop()!
    : symbol.includes(".")
      ? symbol.split(".").pop()!
      : symbol;
  if (STOPLIST.has(base.toLowerCase()) && !/[A-Z]/.test(base.slice(1))) {
    // Keep CamelCase even if a segment is English-adjacent; drop pure stop tokens.
    if (STOPLIST.has(symbol.toLowerCase())) return false;
  }
  if (STOPLIST.has(symbol.toLowerCase())) return false;
  // Must contain at least one letter.
  if (!/[A-Za-z]/.test(symbol)) return false;
  return true;
}

/** Escape a symbol for use inside a RegExp character class / pattern. */
export function escapeRegex(symbol: string): string {
  return symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary pattern for content-mode grep. */
export function buildGroundingGrepPattern(symbol: string): string {
  // For qualified names with :: or ., avoid \b on every segment boundary —
  // escape the whole symbol and wrap with \b only at the outer edges when possible.
  const escaped = escapeRegex(symbol);
  if (/^[A-Za-z_][\w]*$/.test(symbol)) {
    return `\\b${escaped}\\b`;
  }
  // Leading/trailing word chars get \b; operators inside stay literal.
  const prefix = /^[A-Za-z_]/.test(symbol) ? "\\b" : "";
  const suffix = /[A-Za-z0-9_]$/.test(symbol) ? "\\b" : "";
  return `${prefix}${escaped}${suffix}`;
}

/**
 * Parse content-mode grep lines (`path:line: text` or `line: text` for file greps).
 */
export function parseGrepContentHits(output: string, fallbackPath = ""): SymbolGroundingHit[] {
  if (!output || output.trim() === "No matches found") return [];
  const hits: SymbolGroundingHit[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    // path:line: text  (path may contain drive letters on Windows — take last :digits: split carefully)
    const m = line.match(/^(.*?):(\d+):\s*(.*)$/);
    if (m) {
      hits.push({
        path: m[1] || fallbackPath,
        line: Number(m[2]),
        text: m[3] ?? "",
      });
      continue;
    }
    // bare "line: text" from single-file grep
    const bare = line.match(/^(\d+):\s*(.*)$/);
    if (bare) {
      hits.push({
        path: fallbackPath || "?",
        line: Number(bare[1]),
        text: bare[2] ?? "",
      });
    }
  }
  return hits;
}

/**
 * Render the injected grounding block.
 * Confirmed misses get NOT FOUND; search failures are SEARCH INDETERMINATE
 * (never proof of absence).
 */
export function formatGroundingBlock(results: SymbolGroundingResult[]): string {
  if (results.length === 0) {
    return "No task identifiers extracted for grounding.";
  }

  const lines: string[] = [
    "Verified project symbols for this write turn. Prefer these declarations; do not invent APIs.",
    "",
  ];

  for (const result of results) {
    if (result.status === "found" && result.hits.length > 0) {
      lines.push(`${result.symbol}:`);
      for (const hit of result.hits.slice(0, policy().grounding_grep_head_limit)) {
        const declaration = hit.text.trim().slice(0, 200);
        lines.push(`  ${hit.path}:${hit.line}: ${declaration}`);
      }
    } else if (result.status === "indeterminate") {
      lines.push(
        `${result.symbol}: SEARCH INDETERMINATE — runtime grep failed; do not treat this as proof of absence. ` +
          `Read or search the relevant source before relying on it.`,
      );
    } else {
      lines.push(
        `${result.symbol}: NOT FOUND in project source — do not reference ${result.symbol}; ` +
          `use only the verified symbols above or read the library before writing code.`,
      );
    }
    lines.push("");
  }

  const raw = lines.join("\n").trimEnd();
  return prepareToolResultForContext(raw, policy().grounding_block_context_chars).context;
}

/**
 * Orchestrate greps: primary pass at root, miss pass into dep dirs.
 * Injectable `grep` keeps this unit-testable without the pipeline.
 * Errors and budget exhaustion yield `indeterminate`, never a confirmed miss.
 */
export async function collectSymbolGrounding(options: {
  symbols: string[];
  searchRoot: string;
  /** Directory names present at searchRoot (from list_directory or fixture). */
  rootEntries?: string[];
  grep: GroundingGrepFn;
  maxSymbols?: number;
  maxGreps?: number;
  headLimit?: number;
}): Promise<{ results: SymbolGroundingResult[]; grepsUsed: number; summary: SymbolGroundingSummary }> {
  const maxSymbols = options.maxSymbols ?? policy().max_grounding_symbols;
  const maxGreps = options.maxGreps ?? policy().max_grounding_greps;
  const headLimit = options.headLimit ?? policy().grounding_grep_head_limit;
  const symbols = options.symbols.slice(0, maxSymbols);
  // When `rootEntries` is supplied (even empty), only listed dep dirs are searched.
  // When omitted, try all DEP_DIR_CANDIDATES (errors on present dirs → indeterminate).
  const rootEntriesSupplied = options.rootEntries !== undefined;
  const rootEntries = new Set(
    (options.rootEntries ?? []).map((e) => e.replace(/[\\/]+$/, "")),
  );

  let grepsUsed = 0;
  const results: SymbolGroundingResult[] = [];

  const runGrep = async (symbol: string, path: string): Promise<GroundingSearchAttempt> => {
    if (grepsUsed >= maxGreps) return { status: "budget_exhausted" };
    grepsUsed += 1;
    try {
      const res = await options.grep({
        pattern: buildGroundingGrepPattern(symbol),
        path,
        headLimit,
      });
      if (res.is_error) {
        return {
          status: "error",
          reason: res.output.trim() || `grep failed at ${path}`,
        };
      }
      return {
        status: "ok",
        hits: parseGrepContentHits(res.output, path).slice(0, headLimit),
      };
    } catch (error) {
      return {
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };

  type PendingMiss = { symbol: string; errors: string[] };
  const pendingMiss: PendingMiss[] = [];

  for (const symbol of symbols) {
    const attempt = await runGrep(symbol, options.searchRoot);
    if (attempt.status === "ok" && attempt.hits.length > 0) {
      results.push({ symbol, status: "found", hits: attempt.hits });
      continue;
    }
    if (attempt.status === "budget_exhausted") {
      results.push({
        symbol,
        status: "indeterminate",
        hits: [],
        errors: ["search budget exhausted"],
      });
      continue;
    }
    if (attempt.status === "error") {
      results.push({
        symbol,
        status: "indeterminate",
        hits: [],
        errors: [attempt.reason],
      });
      continue;
    }
    // Successful exhaustive zero hits at root — candidate for miss pass.
    pendingMiss.push({ symbol, errors: [] });
    results.push({ symbol, status: "missing", hits: [] });
  }

  // Miss pass: search dep dirs that exist at root (handleGrep skips node_modules
  // on recursive walk, so JS deps need an explicit path).
  if (pendingMiss.length > 0) {
    const depDirs = DEP_DIR_CANDIDATES.filter((d) => {
      if (!rootEntriesSupplied) return true;
      return rootEntries.has(d);
    });

    // No dep dirs scheduled → successful root no-matches stay confirmed missing.
    if (depDirs.length === 0) {
      // leave pending results as status "missing"
    } else for (const entry of pendingMiss) {
      if (grepsUsed >= maxGreps) {
        // Remaining scheduled miss-pass greps cannot run → indeterminate.
        const idx = results.findIndex((r) => r.symbol === entry.symbol && r.status === "missing");
        if (idx >= 0) {
          results[idx] = {
            symbol: entry.symbol,
            status: "indeterminate",
            hits: [],
            errors: ["search budget exhausted before miss-pass completed"],
          };
        }
        for (const later of pendingMiss) {
          if (later.symbol === entry.symbol) continue;
          const i = results.findIndex((r) => r.symbol === later.symbol && r.status === "missing");
          if (i >= 0) {
            results[i] = {
              symbol: later.symbol,
              status: "indeterminate",
              hits: [],
              errors: ["search budget exhausted before miss-pass completed"],
            };
          }
        }
        break;
      }

      let foundHits: SymbolGroundingHit[] = [];
      let sawError = false;
      const errors: string[] = [];
      for (const dep of depDirs) {
        if (grepsUsed >= maxGreps) {
          // Budget mid miss-pass without a hit → indeterminate (not confirmed miss).
          sawError = true;
          errors.push("search budget exhausted during miss-pass");
          break;
        }
        const depPath = joinPath(options.searchRoot, dep);
        const attempt = await runGrep(entry.symbol, depPath);
        if (attempt.status === "ok" && attempt.hits.length > 0) {
          foundHits = attempt.hits;
          break;
        }
        if (attempt.status === "error") {
          sawError = true;
          errors.push(attempt.reason);
        }
        if (attempt.status === "budget_exhausted") {
          sawError = true;
          errors.push("search budget exhausted");
          break;
        }
      }

      const idx = results.findIndex((r) => r.symbol === entry.symbol);
      if (idx < 0) continue;
      if (foundHits.length > 0) {
        results[idx] = { symbol: entry.symbol, status: "found", hits: foundHits };
      } else if (sawError) {
        results[idx] = {
          symbol: entry.symbol,
          status: "indeterminate",
          hits: [],
          errors,
        };
      }
      // else: all scheduled dep greps completed ok with zero hits → keep missing
    }
  }

  const symbolsFound = results.filter((r) => r.status === "found").length;
  const symbolsMissing = results.filter((r) => r.status === "missing").length;
  const symbolsIndeterminate = results.filter((r) => r.status === "indeterminate").length;
  const summary: SymbolGroundingSummary = {
    symbols_searched: symbols.length,
    symbols_found: symbolsFound,
    symbols_missing: symbolsMissing,
    symbols_indeterminate: symbolsIndeterminate,
    greps_used: grepsUsed,
  };

  return { results, grepsUsed, summary };
}

/** Minimal path join that works for tests without importing node:path semantics deeply. */
function joinPath(root: string, segment: string): string {
  if (!root) return segment;
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return root.endsWith("/") || root.endsWith("\\")
    ? `${root}${segment}`
    : `${root}${sep}${segment}`;
}
