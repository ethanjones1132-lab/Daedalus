// ═══════════════════════════════════════════════════════════════
// ── Filesystem Bundle ──
// ═══════════════════════════════════════════════════════════════
// Canonical filesystem + search tools registered into the ToolRuntime:
// read_file, write_file, edit_file, multi_edit, apply_patch, glob, grep,
// list_directory.
//
// Handlers are ported verbatim from the legacy tools.ts so the chat model's
// behaviour is preserved exactly. Path scoping (fs-scope) and the
// read-before-edit guard (fs-read-cache) are shared so every surface agrees.
//
// Two registration entry points:
//   registerFilesystemBundle — all 7 tools (chat/agent surfaces)
//   registerSearchBundle     — read_file/glob/grep only (cron/mcp read-only)

import { promises as fs } from "fs";
import { join, relative, dirname } from "path";
import type { ToolRuntime, ExecutionContext } from "./tool-runtime";
import type { ToolDefinition } from "./tool-types";
import { resolveSafePath } from "./fs-scope";
import { markFileRead, hasFileBeenRead } from "./fs-read-cache";
import { applyUnifiedPatch, buildUnifiedDiff } from "./diff";
import { fingerprintBytes, fingerprintFile, recordWriteEffect } from "./orchestration/content-fingerprint";
import {
  applyRepairedEdit,
  repairEditPair,
  repairMultiEditPairs,
  stripLineNumberGutter,
} from "./edit-contract";

// ── Tool Definitions (copied byte-for-byte from legacy getAllTools) ──────────────

const READ_FILE_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read the contents of a single FILE (not a directory). Returns file content with line numbers, bounded to a prefix of the file and a per-line character cap — a truncation note in the output says when content was cut. Use this before editing any file. To list a folder's contents, use list_directory instead.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file to read" },
        offset: { type: "number", description: "Line number to start reading from (1-indexed)", default: 1 },
        limit: { type: "number", description: "Maximum number of lines to read", default: 500 },
      },
      required: ["path"],
    },
  },
  requires_approval: false,
  dangerous: false,
  capability: { class: "read", evidence: "content", parallel_safe: true, cacheable: true, read_only_profile: true },
};

const WRITE_FILE_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file" },
        content: { type: "string", description: "The full content to write to the file" },
      },
      required: ["path", "content"],
    },
  },
  requires_approval: true,
  dangerous: true,
  capability: { class: "write", evidence: "none" },
};

const EDIT_FILE_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "edit_file",
    description: "Edit a file by replacing an exact string. The old_string must match exactly including whitespace. Use read_file first to get the exact content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit" },
        old_string: { type: "string", description: "Exact string to find and replace (must match exactly)" },
        new_string: { type: "string", description: "Replacement string" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  requires_approval: true,
  dangerous: true,
  capability: { class: "write", evidence: "none" },
};

const MULTI_EDIT_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "multi_edit",
    description: "Apply multiple edits to a single file in sequence. Each edit's old_string is applied to the result of the previous edit.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit" },
        edits: {
          type: "array",
          description: "Array of edit operations to apply sequentially",
          items: {
            type: "object",
            description: "An edit with old_string and new_string",
          },
        },
      },
      required: ["path", "edits"],
    },
  },
  requires_approval: true,
  dangerous: true,
  capability: { class: "write", evidence: "none" },
};

const APPLY_PATCH_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "apply_patch",
    description: "Apply a unified diff (patch) to an existing file. Read the file first, then provide a standard unified-diff patch. Fails cleanly (without writing) if the patch context no longer matches the file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to patch" },
        patch: { type: "string", description: "Unified diff text to apply to the file" },
      },
      required: ["path", "patch"],
    },
  },
  requires_approval: true,
  dangerous: true,
  capability: { class: "write", evidence: "none" },
};

const GLOB_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "glob",
    description: "Find files matching a glob pattern. Supports ** for recursive matching.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern (e.g. '**/*.ts', 'src/*.rs')" },
        path: { type: "string", description: "Directory to search in (defaults to workspace root)" },
      },
      required: ["pattern"],
    },
  },
  requires_approval: false,
  dangerous: false,
  capability: { class: "list", evidence: "listing", parallel_safe: true, cacheable: true, read_only_profile: true },
};

const GREP_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "grep",
    description: "Search file contents using a regex pattern. Returns matching files and line numbers.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory to search in (defaults to workspace root)" },
        output_mode: { type: "string", description: "Output mode: 'files_with_matches', 'content', or 'count'", enum: ["files_with_matches", "content", "count"], default: "files_with_matches" },
        head_limit: { type: "number", description: "Limit number of results", default: 50 },
      },
      required: ["pattern"],
    },
  },
  requires_approval: false,
  dangerous: false,
  capability: { class: "read", evidence: "content", parallel_safe: true, cacheable: true, read_only_profile: true },
};

const LIST_DIR_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "list_directory",
    description: "List the contents of a DIRECTORY (folder) with file sizes and types. Use this for any path that is a folder — including '.', the workspace root, or a project directory. Do NOT use read_file on a directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list" },
      },
      required: ["path"],
    },
  },
  requires_approval: false,
  dangerous: false,
  capability: { class: "list", evidence: "listing", parallel_safe: true, cacheable: true, read_only_profile: true },
};

// ── Handlers (ported from tools.ts) ─────────────────────────────────────────────

function resolveFilesystemPath(
  inputPath: unknown,
  ctx: ExecutionContext,
  forWrite = false,
) {
  return resolveSafePath(inputPath as string, ctx.config, {
    workspaceOverride: ctx.workspace_path,
    sessionGrants: ctx.session_grants,
    forWrite,
  });
}

function markResolutionRead(resolution: { path: string; canonicalPath: string }): void {
  markFileRead(resolution.path);
  markFileRead(resolution.canonicalPath);
}

function resolutionWasRead(resolution: { path: string; canonicalPath: string }): boolean {
  return hasFileBeenRead(resolution.path) || hasFileBeenRead(resolution.canonicalPath);
}

/**
 * DD-112: read_file must never slurp a whole huge file into memory or into the
 * model's context. Bound the bytes actually read to a prefix, and cap how many
 * characters a single line may contribute.
 *
 * The byte cap is the SAME 1 MB per-file ceiling grep's walk already applies
 * (see the `stats.size < MAX_TOOL_FILE_BYTES` gate in handleGrep), so read and
 * search agree on what "too big to take whole" means.
 */
export const MAX_TOOL_FILE_BYTES = 1_000_000;
/** Per-line character cap: one minified/data line must not swallow the context budget. */
export const READ_FILE_MAX_LINE_CHARS = 2_000;

/**
 * DD-130: grep on a single FILE reads at most this many bytes. It is the same
 * 1 MB ceiling the directory walk already applies (`stats.size <
 * MAX_TOOL_FILE_BYTES`), so single-file and directory grep agree on what is
 * too big to take whole — and a multi-hundred-megabyte bundle can never be
 * loaded into memory by one grep call.
 */
export const GREP_FILE_MAX_BYTES = MAX_TOOL_FILE_BYTES;

/**
 * Keep only whole UTF-8 character sequences in a byte-prefix read: if the cut
 * landed mid-character, drop the unfinished trailing sequence so the prefix
 * decodes without a replacement character at the cut point.
 */
function utf8CompletePrefix(buf: Buffer): Buffer {
  let leadIndex = buf.length - 1;
  let back = 0;
  while (leadIndex >= 0 && back < 3 && (buf[leadIndex] & 0xc0) === 0x80) {
    leadIndex--;
    back++;
  }
  if (leadIndex < 0) return buf.subarray(0, 0);
  const lead = buf[leadIndex];
  const need = (lead & 0x80) === 0x00 ? 1
    : (lead & 0xe0) === 0xc0 ? 2
    : (lead & 0xf0) === 0xe0 ? 3
    : (lead & 0xf8) === 0xf0 ? 4
    : 1; // invalid lead byte: leave it to the decoder
  // Complete only when every byte of the final sequence is inside the prefix.
  return leadIndex + need <= buf.length ? buf : buf.subarray(0, leadIndex);
}

/**
 * Read at most `maxBytes` (default MAX_TOOL_FILE_BYTES) from `path`. The
 * whole-file path (file is within the cap) decodes exactly like
 * `fs.readFile(path, "utf-8")` used to, so small reads stay byte-for-byte
 * identical.
 */
async function readBytePrefix(
  path: string,
  maxBytes: number = MAX_TOOL_FILE_BYTES,
): Promise<{ text: string; bytesRead: number; totalBytes: number }> {
  const handle = await fs.open(path, "r");
  try {
    const { size } = await handle.stat();
    const target = Math.min(size, maxBytes);
    const buf = Buffer.alloc(target);
    let filled = 0;
    while (filled < target) {
      const { bytesRead } = await handle.read(buf, filled, target - filled, filled);
      if (bytesRead <= 0) break;
      filled += bytesRead;
    }
    const prefix = buf.subarray(0, filled);
    const text = filled < size
      ? utf8CompletePrefix(prefix).toString("utf-8")
      : prefix.toString("utf-8");
    return { text, bytesRead: filled, totalBytes: size };
  } finally {
    await handle.close();
  }
}

/** Cap one line's contribution, naming exactly how much was dropped. */
function capLineChars(line: string): string {
  if (line.length <= READ_FILE_MAX_LINE_CHARS) return line;
  const dropped = line.length - READ_FILE_MAX_LINE_CHARS;
  return `${line.slice(0, READ_FILE_MAX_LINE_CHARS)} …[+${dropped} chars truncated on this line]`;
}

async function handleReadFile(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const resolution = resolveFilesystemPath(args.path, ctx);
  const path = resolution.canonicalPath;
  const offset = (args.offset as number) || 1;
  // 2000-line default (2026-07-18, formerly 500): the old default silently
  // cut real source files with NO indication anything was missing, so
  // executors composed edits against a file they had only partially seen.
  const limit = (args.limit as number) || 2000;

  resolution.revalidate();
  const stat = await fs.stat(path).catch(() => null);
  resolution.revalidate();
  if (stat?.isDirectory()) {
    throw new Error(`Error: "${args.path}" is a directory, not a file. Use list_directory to see its contents, then read_file on a specific file inside it.`);
  }

  try {
    resolution.revalidate();
    const { text, bytesRead, totalBytes } = await readBytePrefix(path);
    resolution.revalidate();
    // DD-112: a prefix read is NOT the whole file. Drop the line the byte cap
    // cut in half so a truncated line can never pass for real content — unless
    // the file's very first line is itself longer than the cap, in which case
    // the per-line cap reports the loss instead.
    const byteTruncated = bytesRead < totalBytes;
    const lastNewline = byteTruncated ? text.lastIndexOf("\n") : -1;
    const pageText = lastNewline >= 0 ? text.slice(0, lastNewline) : text;
    const lines = pageText.split("\n");
    const start = Math.max(0, offset - 1);
    const end = Math.min(lines.length, start + limit);
    // F1 / W4.1: only a complete whole-file read unlocks edit_file. A partial
    // offset/limit page — or a byte-capped prefix — must not be treated as
    // "file fully seen".
    const coversWholeFile = start === 0 && end >= lines.length && !byteTruncated;
    if (coversWholeFile) {
      markResolutionRead(resolution);
    }

    const numbered = lines.slice(start, end).map((line, i) => `${(start + i + 1).toString().padStart(6)} | ${capLineChars(line)}`);
    // A cut-off read must SAY so, with the exact call that continues it —
    // silence here previously read as "that was the whole file". When the byte
    // cap stopped the read we do NOT know the file's line count, so the count
    // must not claim to be the total.
    const lineTotal = byteTruncated ? `at least ${lines.length}` : `${lines.length} total`;
    const emptyPage = end <= start;
    const continuation = emptyPage
      // Offset past what the byte cap makes readable: say so instead of
      // printing an empty page that looks like "no content there".
      ? (byteTruncated
        ? `\n[read_file: offset=${start + 1} is past the readable prefix of this file — read_file serves the first ${bytesRead} of ${totalBytes} bytes (its first ${lines.length} lines); deeper content is beyond the byte cap]`
        : (start > 0
          ? `\n[showing lines ${start + 1}-${end} of ${lineTotal} — earlier lines were not included in this call]`
          : ""))
      : (end < lines.length
        ? `\n[showing lines ${start + 1}-${end} of ${lineTotal} — call read_file with offset=${end + 1} to continue]`
        : (start > 0
          ? `\n[showing lines ${start + 1}-${end} of ${lineTotal} — earlier lines were not included in this call]`
          : ""));
    // DD-112: the byte cap needs its own note, stating exactly how much of the
    // file is missing. The model must never take a prefix for the whole file.
    const percent = totalBytes > 0 ? Math.round((bytesRead / totalBytes) * 100) : 100;
    const byteNote = byteTruncated && !emptyPage && end >= lines.length
      ? (text.includes("\n")
        ? `\n[read_file truncated: this is a ${bytesRead}-byte prefix of ${totalBytes} bytes (${percent}%) — the remaining ${totalBytes - bytesRead} bytes are beyond the read_file byte cap]`
        : `\n[read_file truncated: ${bytesRead} of ${totalBytes} bytes were read (${percent}%) — the file's first line alone exceeds the ${MAX_TOOL_FILE_BYTES}-byte read cap, and lines are capped at ${READ_FILE_MAX_LINE_CHARS} chars]`)
      : "";
    return numbered.join("\n") + continuation + byteNote;
  } catch {
    throw new Error(`File not found: ${resolution.path}. Use glob with pattern to find the correct path before retrying.`);
  }
}

/**
 * read_file returns line-numbered content ("    42 | code"), but edit
 * old_strings must match the RAW file. Weak models routinely paste the
 * numbered text verbatim; instead of failing them into a read→edit death
 * spiral, strip the number gutter when (and only when) the literal string
 * does not match. Re-exported from edit-contract (Phase A2) for tests.
 */
export { stripLineNumberGutter };

async function handleWriteFile(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const resolution = resolveFilesystemPath(args.path, ctx, true);
  const path = resolution.canonicalPath;
  const content = args.content as string;
  resolution.revalidate();
  const before = await fingerprintFile(path);
  resolution.revalidate();
  const requested = fingerprintBytes(content, path);
  if (before.exists && before.sha256 === requested.sha256) {
    throw new Error(`wrote identical content — file unchanged: ${args.path}`);
  }

  const dir = dirname(path);
  resolution.revalidate();
  await fs.mkdir(dir, { recursive: true });
  resolution.revalidate();
  await fs.writeFile(path, content, "utf-8");
  resolution.revalidate();
  const after = await fingerprintFile(path);
  recordWriteEffect(ctx, { toolName: "write_file", path: resolution.path, before, after });
  const lines = content.split("\n").length;
  return `Wrote ${lines} lines to ${args.path}`;
}

async function handleEditFile(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const resolution = resolveFilesystemPath(args.path, ctx, true);
  const path = resolution.canonicalPath;
  const oldStr = args.old_string as string;
  const newStr = args.new_string as string;

  if (!resolutionWasRead(resolution)) {
    throw new Error(`Error: File "${args.path}" has not been read yet in this conversation. Call read_file on "${args.path}" first, then retry your edit with the exact content you see.`);
  }

  let content: string;
  try {
    resolution.revalidate();
    content = await fs.readFile(path, "utf-8");
    resolution.revalidate();
  } catch {
    throw new Error(`File not found: ${resolution.path}`);
  }

  // Phase A2: exact-text contract — exact, gutter, or whitespace-tolerant unique
  // match; rewrite against the live span so free-tier whitespace drift still lands.
  const repair = repairEditPair(content, oldStr, newStr);
  if (!repair.ok) {
    if (repair.reason === "ambiguous") {
      throw new Error(`Error: old_string appears multiple times in ${args.path}. Make it more specific.`);
    }
    if (repair.reason === "noop") {
      throw new Error(`edit is a no-op — old_string equals new_string: ${args.path}`);
    }
    throw new Error(`Error: old_string not found in "${args.path}". The file content may have changed. Call read_file on "${args.path}" to see current content, then use the exact text for old_string WITHOUT the line-number gutter ("   42 | ").`);
  }

  const updated = applyRepairedEdit(content, repair);
  resolution.revalidate();
  const before = await fingerprintFile(path);
  resolution.revalidate();
  await fs.writeFile(path, updated, "utf-8");
  resolution.revalidate();
  const after = await fingerprintFile(path);
  recordWriteEffect(ctx, { toolName: "edit_file", path: resolution.path, before, after });
  const how =
    repair.matchKind === "tolerant"
      ? " (whitespace-tolerant match)"
      : repair.matchKind === "gutter"
        ? " (gutter-stripped match)"
        : "";
  return `Edited ${args.path}: replaced ${repair.old_string.length} chars with ${repair.new_string.length} chars${how}`;
}

async function handleMultiEdit(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const resolution = resolveFilesystemPath(args.path, ctx, true);
  const path = resolution.canonicalPath;
  const edits = args.edits as Array<{ old_string: string; new_string: string }>;

  if (!resolutionWasRead(resolution)) {
    throw new Error(`Error: File "${args.path}" has not been read yet in this conversation. Call read_file on "${args.path}" first, then retry your edit with the exact content you see.`);
  }

  let content: string;
  try {
    resolution.revalidate();
    content = await fs.readFile(path, "utf-8");
    resolution.revalidate();
  } catch {
    throw new Error(`File not found: ${resolution.path}`);
  }

  resolution.revalidate();
  const before = await fingerprintFile(path);
  // Phase A2: rolling tolerant/gutter repair for each edit.
  const { content: next, items, applied } = repairMultiEditPairs(content, edits);
  const results = items.map((item) => {
    if (item.skipped === "not_found" || item.skipped === "empty_old") {
      return `SKIP: "${item.old_string.slice(0, 40)}..." not found`;
    }
    if (item.skipped === "ambiguous") {
      return `SKIP: "${item.old_string.slice(0, 40)}..." appears multiple times`;
    }
    if (item.skipped === "noop") {
      return `SKIP: "${item.old_string.slice(0, 40)}..." no-op`;
    }
    const tag =
      item.matchKind === "tolerant"
        ? " (tolerant)"
        : item.matchKind === "gutter"
          ? " (gutter)"
          : "";
    return `OK: replaced "${item.old_string.slice(0, 40)}..."${tag}`;
  });

  if (applied === 0) {
    throw new Error(`multi_edit has no applicable edits — every requested edit was skipped: ${args.path}`);
  }

  resolution.revalidate();
  await fs.writeFile(path, next, "utf-8");
  resolution.revalidate();
  const after = await fingerprintFile(path);
  recordWriteEffect(ctx, { toolName: "multi_edit", path: resolution.path, before, after });
  return `Multi-edit on ${args.path}:\n${results.join("\n")}`;
}

async function handleApplyPatch(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const resolution = resolveFilesystemPath(args.path, ctx, true);
  const path = resolution.canonicalPath;
  const patch = args.patch as string;

  if (!resolutionWasRead(resolution)) {
    throw new Error(`Error: File "${args.path}" has not been read yet in this conversation. Call read_file on "${args.path}" first, then apply the patch.`);
  }

  let content: string;
  try {
    resolution.revalidate();
    content = await fs.readFile(path, "utf-8");
    resolution.revalidate();
  } catch {
    throw new Error(`File not found: ${resolution.path}`);
  }

  const result = applyUnifiedPatch(content, patch);
  if (!result.ok || result.content === undefined) {
    throw new Error(`Error: patch did not apply cleanly to "${args.path}". The file may have changed since it was read — call read_file again and regenerate the patch against the current content.`);
  }

  resolution.revalidate();
  const before = await fingerprintFile(path);
  resolution.revalidate();
  await fs.writeFile(path, result.content, "utf-8");
  resolution.revalidate();
  const after = await fingerprintFile(path);
  recordWriteEffect(ctx, { toolName: "apply_patch", path: resolution.path, before, after });
  const diff = buildUnifiedDiff(content, result.content, args.path as string);
  return `Patched ${args.path}: +${diff.additions}/-${diff.deletions}`;
}

async function handleGlob(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const pattern = args.pattern as string;
  const rootResolution = resolveFilesystemPath((args.path as string) || ".", ctx);
  const searchPath = rootResolution.path;
  const operationRoot = rootResolution.canonicalPath;
  rootResolution.revalidate();
  await assertSearchDirectory(operationRoot);
  rootResolution.revalidate();

  // Simple glob implementation
  const results: string[] = [];
  const isRecursive = pattern.includes("**");
  const visited = new Set<string>();

  async function walk(displayDir: string, operationDir: string) {
    if (visited.has(operationDir)) return;
    visited.add(operationDir);
    let entries: string[];
    try {
      rootResolution.revalidate();
      entries = await fs.readdir(operationDir);
      rootResolution.revalidate();
    } catch {
      return;
    }

    for (const entry of entries) {
      const displayFull = join(displayDir, entry);
      const rel = relative(searchPath, displayFull).replace(/\\/g, "/");
      let childResolution;
      try {
        childResolution = resolveFilesystemPath(displayFull, ctx);
        childResolution.revalidate();
      } catch {
        continue;
      }

      const stats = await fs.stat(childResolution.canonicalPath).catch(() => null);
      if (!stats) continue;
      if (shouldMatch(rel, pattern)) {
        results.push(`${displayFull} (${formatSize(stats.size)})`);
      }

      if (stats.isDirectory() && isRecursive && !entry.startsWith(".") && entry !== "node_modules") {
        await walk(displayFull, childResolution.canonicalPath);
      }
    }
  }

  await walk(searchPath, operationRoot);
  return results.slice(0, 100).join("\n") || "No files matched";
}

function shouldMatch(filepath: string, pattern: string): boolean {
  // Simple glob matching
  const regexPattern = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*\//g, "___GLOBSTAR_DIR___")
    .replace(/\*\*/g, "___GLOBSTAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(/___GLOBSTAR_DIR___/g, "(?:.*/)?")
    .replace(/___GLOBSTAR___/g, ".*");
  return new RegExp(`^${regexPattern}$`).test(filepath);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function handleGrep(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const pattern = args.pattern as string;
  const rootResolution = resolveFilesystemPath((args.path as string) || ".", ctx);
  const searchPath = rootResolution.path;
  const operationRoot = rootResolution.canonicalPath;
  const outputMode = (args.output_mode as string) || "files_with_matches";
  const headLimit = (args.head_limit as number) || 50;

  const results: string[] = [];
  const regex = new RegExp(pattern);

  // 2026-07-18: grep on a single FILE is legitimate ("grep prepareToPlay in
  // PluginProcessor.cpp") — the old directory-only assertion threw
  // "Directory not found" at exactly the moment a live write-repair stage
  // was locating its edit target, derailing the whole repair.
  rootResolution.revalidate();
  const searchStat = await fs.stat(operationRoot).catch(() => null);
  rootResolution.revalidate();
  if (searchStat?.isFile()) {
    const displayPath = (args.path as string) || searchPath;
    let prefix: { text: string; bytesRead: number; totalBytes: number };
    try {
      rootResolution.revalidate();
      prefix = await readBytePrefix(operationRoot, GREP_FILE_MAX_BYTES);
      rootResolution.revalidate();
    } catch (err) {
      // DD-130: a read failure is NOT "no matches". The old catch-all turned
      // every I/O error into an empty verdict, so callers concluded the
      // pattern was absent from a file nobody had actually read.
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`grep could not read ${displayPath}: ${detail}`);
    }
    const { text, bytesRead, totalBytes } = prefix;
    const truncated = bytesRead < totalBytes;
    // The byte cap can cut the final line in half; never report or match
    // against that fragment as if it were whole content.
    const searchable = truncated && text.includes("\n")
      ? text.slice(0, text.lastIndexOf("\n"))
      : text;
    if (outputMode === "files_with_matches") {
      if (regex.test(searchable)) return displayPath;
    } else {
      const lines = searchable.split("\n");
      for (let i = 0; i < lines.length && results.length < headLimit; i++) {
        if (regex.test(lines[i])) results.push(`${i + 1}: ${lines[i].trim()}`);
      }
    }
    if (!truncated) return results.join("\n") || "No matches found";
    // DD-130: the cap stopped the search, so a bare "No matches found" would
    // claim a completeness we never had. State the truncation, the cap, and
    // exactly how much of the file went unsearched.
    const note = `[grep truncated: searched the first ${bytesRead} of ${totalBytes} bytes of ${displayPath} — the remaining ${totalBytes - bytesRead} bytes are beyond the ${GREP_FILE_MAX_BYTES}-byte grep cap and were NOT searched]`;
    return [...results, note].join("\n");
  }
  if (!searchStat?.isDirectory()) {
    throw new Error(`Path not found: ${searchPath}. Use glob with pattern "**" from the workspace root to find the correct path.`);
  }

  const visited = new Set<string>();
  async function walk(displayDir: string, operationDir: string) {
    if (results.length >= headLimit || visited.has(operationDir)) return;
    visited.add(operationDir);
    let entries: string[];
    try {
      rootResolution.revalidate();
      entries = await fs.readdir(operationDir);
      rootResolution.revalidate();
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= headLimit) break;
      const displayFull = join(displayDir, entry);
      let childResolution;
      try {
        childResolution = resolveFilesystemPath(displayFull, ctx);
        childResolution.revalidate();
      } catch {
        continue;
      }
      const stats = await fs.stat(childResolution.canonicalPath).catch(() => null);
      if (!stats) continue;

      if (stats.isDirectory()) {
        if (!entry.startsWith(".") && entry !== "node_modules" && entry !== ".git") {
          await walk(displayFull, childResolution.canonicalPath);
        }
      } else if (stats.isFile() && stats.size < MAX_TOOL_FILE_BYTES) {
        try {
          childResolution.revalidate();
          const content = await fs.readFile(childResolution.canonicalPath, "utf-8");
          childResolution.revalidate();
          if (outputMode === "files_with_matches") {
            if (regex.test(content)) {
              results.push(relative(searchPath, displayFull));
            }
          } else {
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push(`${relative(searchPath, displayFull)}:${i + 1}: ${lines[i].trim()}`);
                if (results.length >= headLimit) break;
              }
            }
          }
        } catch { /* binary file */ }
      }
    }
  }

  await walk(searchPath, operationRoot);
  return results.join("\n") || "No matches found";
}

async function handleListDir(args: Record<string, unknown>, ctx: ExecutionContext): Promise<string> {
  const resolution = resolveFilesystemPath(args.path, ctx);
  const path = resolution.canonicalPath;

  try {
    resolution.revalidate();
    const entries = await fs.readdir(path);
    resolution.revalidate();
    const items = await Promise.all(
      entries.map(async (entry) => {
        const displayFull = join(resolution.path, entry);
        try {
          const childResolution = resolveFilesystemPath(displayFull, ctx);
          childResolution.revalidate();
          const stats = await fs.stat(childResolution.canonicalPath);
          const type = stats.isDirectory() ? "📁" : "📄";
          const size = stats.isDirectory() ? "" : ` (${formatSize(stats.size)})`;
          return `${type} ${entry}${size}`;
        } catch {
          return `❓ ${entry}`;
        }
      })
    );

    return `${entries.length} items in ${args.path}:\n${items.join("\n")}`;
  } catch {
    throw new Error(`Directory not found: ${resolution.path}. Use glob with pattern "**" from the workspace root to find the correct directory path.`);
  }
}

async function assertSearchDirectory(path: string): Promise<void> {
  const stat = await fs.stat(path).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Directory not found: ${path}. Use glob with pattern "**" from the workspace root to find the correct directory path.`);
  }
}

// ── Registration ────────────────────────────────────────────────────────────────

/** Register all 7 filesystem tools (chat/agent surfaces). */
export function registerFilesystemBundle(rt: ToolRuntime): void {
  rt.register(READ_FILE_DEF, (a, c) => handleReadFile(a, c));
  rt.register(WRITE_FILE_DEF, (a, c) => handleWriteFile(a, c));
  rt.register(EDIT_FILE_DEF, (a, c) => handleEditFile(a, c));
  rt.register(MULTI_EDIT_DEF, (a, c) => handleMultiEdit(a, c));
  rt.register(APPLY_PATCH_DEF, (a, c) => handleApplyPatch(a, c));
  rt.register(GLOB_DEF, (a, c) => handleGlob(a, c));
  rt.register(GREP_DEF, (a, c) => handleGrep(a, c));
  rt.register(LIST_DIR_DEF, (a, c) => handleListDir(a, c));
}

/** Register the read-only search triad (read_file/glob/grep) for cron/mcp. */
export function registerSearchBundle(rt: ToolRuntime): void {
  rt.register(READ_FILE_DEF, (a, c) => handleReadFile(a, c));
  rt.register(GLOB_DEF, (a, c) => handleGlob(a, c));
  rt.register(GREP_DEF, (a, c) => handleGrep(a, c));
}
