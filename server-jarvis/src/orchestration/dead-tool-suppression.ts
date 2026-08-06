/** A tool failure is "structural" (never going to succeed this turn) when the
 * runtime cannot invoke it at all — a missing executable or a permission
 * denial — as opposed to a recoverable argument/target error. */
const STRUCTURAL_SIGNATURES = [
  "executable not found",
  "not_permitted",
  "delegate_tool_not_permitted",
  "command not found",
  "eacces",
];

const REDIRECT: Record<string, string> = {
  glob: "glob is unavailable this turn — use list_directory or read_file instead.",
  grep: "grep is unavailable this turn — read the file with read_file and scan it instead.",
  bash: "bash is unavailable this turn — use the dedicated file tools (read_file/write_file/edit_file).",
  powershell: "powershell is unavailable this turn — use the dedicated file tools instead.",
};

import { BASELINE_THETA, policy } from "./orchestration-policy";

const SUPPRESS_THRESHOLD = BASELINE_THETA.dead_tool_suppress_threshold;

function isStructural(output: string): boolean {
  const o = (output || "").toLowerCase();
  return STRUCTURAL_SIGNATURES.some((sig) => o.includes(sig));
}

export class DeadToolTracker {
  private structuralFailures = new Map<string, number>();
  /** Snapshot the request policy so this tracker cannot inherit a later turn's ALS. */
  private readonly suppressThreshold = policy().dead_tool_suppress_threshold;

  record(tool: string, isError: boolean, output: string): void {
    if (!isError) {
      this.structuralFailures.set(tool, 0);
      return;
    }
    if (!isStructural(output)) return;
    this.structuralFailures.set(tool, (this.structuralFailures.get(tool) ?? 0) + 1);
  }

  isSuppressed(tool: string): boolean {
    return (this.structuralFailures.get(tool) ?? 0) >= this.suppressThreshold;
  }

  redirectNote(tool: string): string {
    return REDIRECT[tool] ?? `${tool} is unavailable this turn — use an alternative tool.`;
  }

  reset(): void {
    this.structuralFailures.clear();
  }
}
