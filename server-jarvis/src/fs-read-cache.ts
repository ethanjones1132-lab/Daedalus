// ═══════════════════════════════════════════════════════════════
// ── Read-before-edit guard ──
// ═══════════════════════════════════════════════════════════════
// edit_file / multi_edit require a path to have been read at least once in this
// process before they will modify it. Shared so the read tool (which marks) and
// the edit tools (which check) agree on the same set. Mirrors the legacy
// READ_FILES_CACHE that lived in tools.ts.

const readFiles = new Set<string>();

export function markFileRead(resolvedPath: string): void {
  readFiles.add(resolvedPath);
}

export function hasFileBeenRead(resolvedPath: string): boolean {
  return readFiles.has(resolvedPath);
}
