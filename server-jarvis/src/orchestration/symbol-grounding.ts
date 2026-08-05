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

export const MAX_GROUNDING_SYMBOLS = 8;
export const MAX_GROUNDING_GREPS = 16;
export const GROUNDING_GREP_HEAD_LIMIT = 3;
export const GROUNDING_BLOCK_CONTEXT_CHARS = 4_000;
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

export interface SymbolGroundingResult {
  symbol: string;
  found: boolean;
  hits: SymbolGroundingHit[];
}

export interface SymbolGroundingSummary {
  symbols_searched: number;
  symbols_found: number;
  symbols_missing: number;
  greps_used: number;
}

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

  return candidates.slice(0, MAX_GROUNDING_SYMBOLS);
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
 * Render the injected grounding block. Missing symbols get an explicit
 * anti-fabrication statement — that is the point of A1.
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
    if (result.found && result.hits.length > 0) {
      lines.push(`${result.symbol}:`);
      for (const hit of result.hits.slice(0, GROUNDING_GREP_HEAD_LIMIT)) {
        const declaration = hit.text.trim().slice(0, 200);
        lines.push(`  ${hit.path}:${hit.line}: ${declaration}`);
      }
    } else {
      lines.push(
        `${result.symbol}: NOT FOUND in project source — do not reference ${result.symbol}; ` +
          `use only the verified symbols above or read the library before writing code.`,
      );
    }
    lines.push("");
  }

  const raw = lines.join("\n").trimEnd();
  return prepareToolResultForContext(raw, GROUNDING_BLOCK_CONTEXT_CHARS).context;
}

/**
 * Orchestrate greps: primary pass at root, miss pass into dep dirs.
 * Injectable `grep` keeps this unit-testable without the pipeline.
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
  const maxSymbols = options.maxSymbols ?? MAX_GROUNDING_SYMBOLS;
  const maxGreps = options.maxGreps ?? MAX_GROUNDING_GREPS;
  const headLimit = options.headLimit ?? GROUNDING_GREP_HEAD_LIMIT;
  const symbols = options.symbols.slice(0, maxSymbols);
  const rootEntries = new Set(
    (options.rootEntries ?? []).map((e) => e.replace(/[\\/]+$/, "")),
  );

  let grepsUsed = 0;
  const results: SymbolGroundingResult[] = [];

  const runGrep = async (symbol: string, path: string): Promise<SymbolGroundingHit[]> => {
    if (grepsUsed >= maxGreps) return [];
    grepsUsed += 1;
    try {
      const res = await options.grep({
        pattern: buildGroundingGrepPattern(symbol),
        path,
        headLimit,
      });
      if (res.is_error) return [];
      return parseGrepContentHits(res.output, path).slice(0, headLimit);
    } catch {
      return [];
    }
  };

  const missing: string[] = [];

  for (const symbol of symbols) {
    const hits = await runGrep(symbol, options.searchRoot);
    if (hits.length > 0) {
      results.push({ symbol, found: true, hits });
    } else {
      missing.push(symbol);
      results.push({ symbol, found: false, hits: [] });
    }
  }

  // Miss pass: search dep dirs that exist at root (handleGrep skips node_modules
  // on recursive walk, so JS deps need an explicit path).
  if (missing.length > 0) {
    const depDirs = DEP_DIR_CANDIDATES.filter((d) => {
      if (rootEntries.size === 0) return true; // try; failures tolerated
      return rootEntries.has(d);
    });

    for (const symbol of missing) {
      if (grepsUsed >= maxGreps) break;
      let foundHits: SymbolGroundingHit[] = [];
      for (const dep of depDirs) {
        if (grepsUsed >= maxGreps) break;
        const depPath = joinPath(options.searchRoot, dep);
        const hits = await runGrep(symbol, depPath);
        if (hits.length > 0) {
          foundHits = hits;
          break;
        }
      }
      if (foundHits.length > 0) {
        const idx = results.findIndex((r) => r.symbol === symbol && !r.found);
        if (idx >= 0) {
          results[idx] = { symbol, found: true, hits: foundHits };
        }
      }
    }
  }

  const symbolsFound = results.filter((r) => r.found).length;
  const summary: SymbolGroundingSummary = {
    symbols_searched: symbols.length,
    symbols_found: symbolsFound,
    symbols_missing: symbols.length - symbolsFound,
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
