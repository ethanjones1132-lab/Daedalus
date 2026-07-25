// ═══════════════════════════════════════════════════════════════
// ── Check Runner façade ──
// ═══════════════════════════════════════════════════════════════
// Unifies run-gate (executes tests) and syntax-gate (static check) into a
// tiered CheckResult. Tier order: existing → builtin → synth → none.
// Deterministic, no inference. Python today; TS/Rust follow-on phases.

import { existsSync } from "fs";
import { extname, join } from "path";
import type { RunGateResult, RunTarget } from "./run-gate";
import type { SyntaxIssue } from "./syntax-gate";
import { runWrittenCodeGate, findRunnableTarget } from "./run-gate";
import { checkWrittenFilesSyntax, DEFAULT_CHECKERS, writtenCodePaths } from "./syntax-gate";

export type CheckTier = "existing" | "builtin" | "synth" | "none";

export interface CheckResult {
  tier: CheckTier;
  ran: boolean;
  passed: boolean | null; // null = detected but could not run
  detail: string;         // failing assertion / compiler error, truncated ~400 chars
  command: string;        // what was executed / checked, for telemetry
  durationMs: number;
}

export interface DetectedCheck {
  tier: Exclude<CheckTier, "none">;
  command: string;
  cwd: string;
  targetPath?: string;
}

/** Map a run-gate target reason to a reward tier. */
export function classifyRunGateTier(reason: RunTarget["reason"]): CheckTier {
  return reason === "standalone_script" ? "synth" : "existing";
}

/** Build a CheckResult from run-gate + syntax-gate outputs. */
export function mergeToCheckResult(input: {
  syntaxIssues: SyntaxIssue[];
  run: RunGateResult | null;
  hadWrittenCode: boolean;
}): CheckResult {
  const { syntaxIssues, run, hadWrittenCode } = input;

  // 1) If we have a run-gate result, it determines tier + pass/fail
  if (run && run.status !== "skipped") {
    const tier = run.target ? classifyRunGateTier(run.reason as RunTarget["reason"]) : "none";
    const passed = run.status === "passed";
    const detail = passed
      ? ""
      : run.issues.map((i) => i.error).join("; ").slice(0, 400) || "run failed without detail";
    return {
      tier,
      ran: true,
      passed,
      detail,
      command: run.target ? `python ${run.target}` : "run-gate",
      durationMs: 0, // filled by caller
    };
  }

  // 2) No runnable test, but syntax issues → builtin fail
  if (syntaxIssues.length > 0) {
    return {
      tier: "builtin",
      ran: true,
      passed: false,
      detail: syntaxIssues.map((i) => i.error).join("; ").slice(0, 400),
      command: "syntax-gate",
      durationMs: 0,
    };
  }

  // 3) No runnable test, clean syntax → builtin pass
  if (hadWrittenCode) {
    return {
      tier: "builtin",
      ran: true,
      passed: true,
      detail: "",
      command: "syntax-gate",
      durationMs: 0,
    };
  }

  // 4) Nothing to check → none tier
  return {
    tier: "none",
    ran: false,
    passed: null,
    detail: "",
    command: "none",
    durationMs: 0,
  };
}

/** Detect a check to run (deterministic, file-glob + config sniff). */
export function detectCheck(input: {
  workspaceRoot: string;
  changedPaths: string[];
  toolCalls: any[] | undefined; // ToolCallRecord[] from stage-output
  planItem?: { acceptanceChecks?: { command?: string; kind?: string }[] };
}): DetectedCheck | null {
  const { workspaceRoot, changedPaths, toolCalls, planItem } = input;

  // 1) synth: plan item declares an explicit check command
  if (planItem?.acceptanceChecks?.some((c) => c.command)) {
    const cmd = planItem.acceptanceChecks.find((c) => c.command)!.command!;
    return { tier: "synth", command: cmd, cwd: workspaceRoot };
  }

  // 2) existing: adjacent test files or declared scripts
  for (const path of changedPaths) {
    const dir = path.split("/").slice(0, -1).join("/");
    const base = path.split("/").pop() || "";
    const testPatterns = [
      `test_${base}`,
      `${base.replace(/\.py$/, "")}_test.py`,
      `${base.replace(/\.ts$/, "").replace(/\.js$/, "")}.test.ts`,
      `${base.replace(/\.ts$/, "").replace(/\.js$/, "")}.spec.ts`,
    ];
    for (const pattern of testPatterns) {
      const testPath = join(dir, pattern);
      if (existsSync(join(workspaceRoot, testPath))) {
        return { tier: "existing", command: `pytest ${testPath}`, cwd: workspaceRoot, targetPath: testPath };
      }
    }
  }

  // 3) existing: declared scripts in config files
  const pkgJson = join(workspaceRoot, "package.json");
  if (existsSync(pkgJson)) {
    try {
      const pkg = JSON.parse(require("fs").readFileSync(pkgJson, "utf-8"));
      if (pkg.scripts?.test) return { tier: "existing", command: "npm test", cwd: workspaceRoot };
      if (pkg.scripts?.typecheck) return { tier: "existing", command: "npm run typecheck", cwd: workspaceRoot };
    } catch {}
  }
  const pyproject = join(workspaceRoot, "pyproject.toml");
  if (existsSync(pyproject)) {
    try {
      const content = require("fs").readFileSync(pyproject, "utf-8");
      if (content.includes("pytest")) return { tier: "existing", command: "pytest", cwd: workspaceRoot };
    } catch {}
  }
  const cargoToml = join(workspaceRoot, "Cargo.toml");
  if (existsSync(cargoToml)) {
    return { tier: "existing", command: "cargo test", cwd: workspaceRoot };
  }

  // 4) builtin: language-native static check on changed files
  const supportedExts = new Set(DEFAULT_CHECKERS.keys());
  const changedWithSupported = changedPaths.filter((p) => supportedExts.has(extname(p).toLowerCase()));
  if (changedWithSupported.length > 0) {
    const primary = changedWithSupported[0];
    const ext = extname(primary).toLowerCase();
    let cmd: string;
    if (ext === ".py") cmd = "python -m py_compile";
    else if (ext === ".ts" || ext === ".tsx") cmd = "tsc --noEmit";
    else if (ext === ".js" || ext === ".jsx") cmd = "node --check";
    else if (ext === ".rs") cmd = "cargo check";
    else cmd = "builtin";
    return { tier: "builtin", command: cmd, cwd: workspaceRoot, targetPath: primary };
  }

  // 5) synth: executor wrote a test this turn (hasWrittenCode but no adjacent test)
  const hasWrittenCode = writtenCodePaths(toolCalls, new Set(supportedExts)).length > 0;
  if (hasWrittenCode) {
    return { tier: "synth", command: "synth-check", cwd: workspaceRoot };
  }

  return null;
}

/** Execute a detected check with bounded timeout, no network. */
export async function runCheck(
  detected: DetectedCheck,
  opts: { timeoutMs: number; toolCalls?: any[] } = { timeoutMs: 15_000, toolCalls: undefined },
): Promise<CheckResult> {
  const start = Date.now();
  const { tier, command, cwd, targetPath } = detected;

  // tier "synth" with "synth-check" command means: run the run-gate
  if (tier === "synth" && command === "synth-check" && opts.toolCalls) {
    const run = await runWrittenCodeGate(
      opts.toolCalls,
      "",
      "",
      { root: cwd, timeoutMs: opts.timeoutMs },
    );
    const syntaxIssues = await checkWrittenFilesSyntax(opts.toolCalls);
    const result = mergeToCheckResult({ syntaxIssues, run, hadWrittenCode: true });
    result.durationMs = Date.now() - start;
    return result;
  }

  // tier "builtin" with targetPath: run syntax checker on that file
  if (tier === "builtin" && targetPath) {
    const fullPath = join(cwd, targetPath);
    const syntaxIssues = await checkWrittenFilesSyntax([{ name: "write_file", arguments: { path: fullPath }, output: "", is_error: false, duration_ms: 0 }], {
      checkers: DEFAULT_CHECKERS,
      exists: existsSync,
    });
    if (syntaxIssues.length > 0) {
      return {
        tier: "builtin",
        ran: true,
        passed: false,
        detail: syntaxIssues.map((i) => i.error).join("; ").slice(0, 400),
        command: "syntax-gate",
        durationMs: Date.now() - start,
      };
    }
    return {
      tier: "builtin",
      ran: true,
      passed: true,
      detail: "",
      command: "syntax-gate",
      durationMs: Date.now() - start,
    };
  }

  // For "existing" tier and other commands, we'd need a proper subprocess runner.
  // This is a placeholder for the full implementation - the test file will test
  // the tier mapping and merge logic, not the actual subprocess execution.
  return {
    tier,
    ran: false,
    passed: null,
    detail: "check execution not yet implemented for this tier",
    command,
    durationMs: Date.now() - start,
  };
}