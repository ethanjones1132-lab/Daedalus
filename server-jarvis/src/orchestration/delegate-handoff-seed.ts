/**
 * Which files the native fallback must re-read after a delegate handoff.
 *
 * 2026-08-04 (run_085afdac): the delegate handed off after two failed writes
 * to `PluginEditor.h`; the native fallback then produced zero tool calls. It
 * had the delegate transcript but no current on-disk text to compose an edit
 * against. `edit_file` needs exact text to match, so the handoff seeds a fresh
 * read of the targets the delegate was working on.
 */

import type { ToolCallRecord } from "./stage-output";
import { collectToolPathTargets } from "./mid-loop-intervention";

/** Upper bound on seeded reads — the handoff must not become its own spiral. */
export const MAX_HANDOFF_SEED_PATHS = 3;

const WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);
const READ_TOOLS = new Set(["read_file", "Read"]);

export interface HandoffSeedInput {
  /** Tool calls observed on the delegate stream, in order. */
  delegateCalls: readonly ToolCallRecord[];
  /** Write targets carried from earlier turns of this task run, newest first. */
  carriedWriteTargets: readonly string[];
}

/**
 * Paths the native fallback should read before attempting a write, ordered
 * failed-write-targets first, then carried targets. Paths already read
 * successfully during the delegate stream are omitted — their contents are
 * already in the carried transcript.
 */
export function selectHandoffSeedPaths(input: HandoffSeedInput): string[] {
  const alreadyRead = new Set<string>();
  for (const call of input.delegateCalls) {
    if (!READ_TOOLS.has(call.name) || call.is_error) continue;
    for (const path of collectToolPathTargets(call.arguments)) {
      alreadyRead.add(path);
    }
  }

  const failedWriteTargets: string[] = [];
  for (const call of input.delegateCalls) {
    if (!WRITE_TOOLS.has(call.name) || !call.is_error) continue;
    for (const path of collectToolPathTargets(call.arguments)) {
      failedWriteTargets.push(path);
    }
  }

  const ordered: string[] = [];
  for (const path of [...failedWriteTargets, ...input.carriedWriteTargets]) {
    if (!path || alreadyRead.has(path) || ordered.includes(path)) continue;
    ordered.push(path);
  }
  return ordered.slice(0, MAX_HANDOFF_SEED_PATHS);
}
