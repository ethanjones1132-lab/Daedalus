# Language-Agnostic Build Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Python-only, test-reliant verification check with a language-agnostic build-system detector registry that runs the project's own check-level build, and make the check-runner report an honest `none` when nothing real ran instead of a vacuous `builtin` green.

**Architecture:** A new `build-check.ts` exposes a `runBuildCheck` that walks an ordered registry of build-system detectors (cargo/cmake/go/node/make, plus a Python `py_compile` fallback), runs the first applicable one synchronously with a bounded timeout, and returns a tri-state `CheckOutcome` (`clean` / `failed` / `not_applicable`). `check-runner.ts`'s `mergeToCheckResult` consumes that tri-state — only an actually-executed check yields a `builtin` pass; `not_applicable` maps to honest `none`. The pipeline wires the real runner at the workspace root.

**Tech Stack:** TypeScript, Bun (`bun test`), `child_process.execFile` (argv-only, never a shell). Spec: `docs/superpowers/specs/2026-07-25-language-agnostic-build-verification-design.md`.

> **Implementation status (2026-07-30 maintenance pass):** All 4 phases are **complete on `master`**. The build-check module landed as a 3-day rollout:
>
> - **Phase 1** (`build-check.ts` core): commit `8d498ef` `feat(build-check): writtenPathsFrom + CheckOutcome/detector types` (2026-07-25 evening, via the `094f9179` `WorkspaceGrantsChip`/build-check pass — `dd611bb` planning + `8d498ef` source).
> - **Phase 2** (`check-runner.ts` consumes the tri-state — the vacuous-green fix): commit `599d895` `fix(check-runner): consume build tri-state; not_applicable is honest none` (2026-07-26 morning, recorded in `4fee8dd`).
> - **Phase 3** (pipeline wiring + config): commit `5718f79` `feat(pipeline): wire build-check into verification + raise check timeout to 90s` — `runTurnVerification` injects `runBuildCheck` and `verification.check_timeout_ms` defaults 15000 → 90000 (same `4fee8dd` pass).
> - **Phase 4** (verification & rollout): the full test gate is green at 2266/2266 bun + 115/115 cargo + both `tsc` clean. Phase 4.1 Step 2/3 (tier-2B live benchmark + C++ honest-none / build smoke on Perihelion) remain **operator-gated** per the 2026-07-30 overnight pass entry — the build verification works, the rollout to the live system is a deploy call.
>
> **Doc drift note:** The per-task `- [ ]` checkboxes below were not flipped as the work landed, so a `grep -c "^- \[ \]"` reports the original plan count even though every phase is on `master`. Future passes that want to use the boxes as a tracking surface should either flip them to `- [x]` (a single sed across this file) or delete the boxes entirely and rely on the status block above. The `not_applicable` → honest-`none` regression pin (the key invariant of Phase 2 Task 2.1) is preserved by `check-runner.test.ts` lines 477–482 — `REGRESSION: build not_applicable → honest none, never a green`.

---

## File Structure

**New files:**
- `server-jarvis/src/orchestration/build-check.ts` — `CheckOutcome` type, `writtenPathsFrom`, the `BuildDetector` registry, and `runBuildCheck`.
- `server-jarvis/src/orchestration/build-check.test.ts` — unit tests (injected `exec`/`exists`/`readText`, no real toolchains).

**Modified files:**
- `server-jarvis/src/orchestration/check-runner.ts` — `mergeToCheckResult` consumes the build tri-state; `RunVerificationInput.runSyntax` → `runBuild`; `runVerificationCheck` updated.
- `server-jarvis/src/orchestration/check-runner.test.ts` — update to the new merge signature; add the honest-`none` regression pin.
- `server-jarvis/src/orchestration/pipeline.ts` — `runTurnVerification` injects `runBuildCheck`.
- `server-jarvis/src/config.ts` — default `verification.check_timeout_ms` 15000 → 90000.

**Reused unchanged:** `syntax-gate.ts` `pythonSyntaxCheck` (imported by the Python detector); `run-gate.ts` (the `existing`/`synth` test tier keeps precedence).

---

## Phase 1 — `build-check.ts` core

### Task 1.1: `writtenPathsFrom` + `CheckOutcome` types

**Files:**
- Create: `server-jarvis/src/orchestration/build-check.ts`
- Test: `server-jarvis/src/orchestration/build-check.test.ts`

- [ ] **Step 1: Write the failing test**

`build-check.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { writtenPathsFrom } from "./build-check";
import type { ToolCallRecord } from "./stage-output";

function call(name: string, path?: string, is_error = false): ToolCallRecord {
  return { name, arguments: path ? { path } : {}, output: "ok", is_error, duration_ms: 1 };
}

describe("writtenPathsFrom", () => {
  test("collects successful write-effect paths, dedupes, skips errors/reads", () => {
    const calls = [
      call("write_file", "a.cpp"),
      call("edit_file", "a.cpp"),          // dup
      call("read_file", "b.cpp"),          // not a write
      call("write_file", "c.py", true),    // errored write
      call("multi_edit", "d.rs"),
    ];
    expect(writtenPathsFrom(calls).sort()).toEqual(["a.cpp", "d.rs"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/build-check.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the types + `writtenPathsFrom`**

`build-check.ts`:
```ts
import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import { extname, join } from "path";
import type { ToolCallRecord } from "./stage-output";
import { pythonSyntaxCheck } from "./syntax-gate";

const WRITE_TOOL_NAMES = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);

/** Successful write-effect target paths from a turn's tool calls (deduped). */
export function writtenPathsFrom(toolCalls: readonly ToolCallRecord[]): string[] {
  const seen = new Set<string>();
  for (const c of toolCalls) {
    if (c.is_error || !WRITE_TOOL_NAMES.has(c.name)) continue;
    const p = typeof c.arguments?.path === "string" ? c.arguments.path.trim() : "";
    if (p) seen.add(p);
  }
  return [...seen];
}

export type CheckOutcome =
  | { kind: "clean"; command: string }
  | { kind: "failed"; command: string; detail: string }
  | { kind: "not_applicable"; reason: string };

export interface ExecResult {
  code: number | null;
  enoent: boolean;
  timedOut: boolean;
  stderr: string;
  stdout: string;
}
export type ExecFn = (cmd: string, args: string[], cwd: string, timeoutMs: number) => Promise<ExecResult>;

export interface DetectedCommand { command: string; args: string[]; cwd: string; }

export interface DetectInput {
  root: string;
  writtenPaths: string[];
  exists: (p: string) => boolean;
  readText: (p: string) => string | null;
}

export interface BuildDetector {
  id: string;
  /** A runnable check command when this detector applies AND the project is in
   * a checkable state; null to decline (→ try next / honest none). */
  detect(input: DetectInput): DetectedCommand | null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/build-check.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/build-check.ts server-jarvis/src/orchestration/build-check.test.ts
git commit -m "feat(build-check): writtenPathsFrom + CheckOutcome/detector types"
```

### Task 1.2: The detector registry

**Files:**
- Modify: `server-jarvis/src/orchestration/build-check.ts`
- Modify: `server-jarvis/src/orchestration/build-check.test.ts`

- [ ] **Step 1: Write the failing test**

Append:
```ts
import { PROJECT_DETECTORS, detectorFor } from "./build-check";

function di(over: Partial<{ root: string; files: string[]; makefile: string }>) {
  const files = new Set(over.files ?? []);
  return {
    root: over.root ?? "/ws",
    writtenPaths: [] as string[],
    exists: (p: string) => files.has(p.replace(/\\/g, "/")),
    readText: (p: string) => (p.endsWith("Makefile") ? (over.makefile ?? null) : null),
  };
}

describe("detector registry", () => {
  test("cargo detected from Cargo.toml → cargo check", () => {
    const d = detectorFor(di({ files: ["/ws/Cargo.toml"] }));
    expect(d?.id).toBe("cargo");
    expect(d?.cmd).toMatchObject({ command: "cargo", args: ["check", "--quiet"] });
  });

  test("cmake declines when no configured build dir exists", () => {
    expect(detectorFor(di({ files: ["/ws/CMakeLists.txt"] }))).toBeNull();
  });

  test("cmake runs incremental build when a configured build dir exists", () => {
    const d = detectorFor(di({ files: ["/ws/CMakeLists.txt", "/ws/build/CMakeCache.txt"] }));
    expect(d?.id).toBe("cmake");
    expect(d?.cmd.command).toBe("cmake");
    expect(d?.cmd.args).toEqual(["--build", "/ws/build".replace(/\//g, require("path").sep)]);
  });

  test("go detected from go.mod → go build ./...", () => {
    expect(detectorFor(di({ files: ["/ws/go.mod"] }))?.id).toBe("go");
  });

  test("node detected from tsconfig.json → tsc --noEmit", () => {
    const d = detectorFor(di({ files: ["/ws/tsconfig.json"] }));
    expect(d?.id).toBe("node");
    expect(d?.cmd.args).toContain("--noEmit");
  });

  test("make only when a check/test target exists", () => {
    expect(detectorFor(di({ files: ["/ws/Makefile"], makefile: "all:\n\tgcc x\n" }))).toBeNull();
    const d = detectorFor(di({ files: ["/ws/Makefile"], makefile: "check:\n\tctest\n" }));
    expect(d?.cmd).toMatchObject({ command: "make", args: ["check"] });
  });

  test("cargo wins over cmake when both markers present (precedence)", () => {
    const d = detectorFor(di({ files: ["/ws/Cargo.toml", "/ws/CMakeLists.txt", "/ws/build/CMakeCache.txt"] }));
    expect(d?.id).toBe("cargo");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/build-check.test.ts`
Expected: FAIL — `PROJECT_DETECTORS`/`detectorFor` not exported.

- [ ] **Step 3: Implement the registry**

Add to `build-check.ts`:
```ts
const CMAKE_BUILD_DIRS = ["build", "out", "cmake-build-debug", "cmake-build-release"];

export const PROJECT_DETECTORS: BuildDetector[] = [
  {
    id: "cargo",
    detect: ({ root, exists }) =>
      exists(join(root, "Cargo.toml")) ? { command: "cargo", args: ["check", "--quiet"], cwd: root } : null,
  },
  {
    id: "cmake",
    detect: ({ root, exists }) => {
      if (!exists(join(root, "CMakeLists.txt"))) return null;
      for (const d of CMAKE_BUILD_DIRS) {
        const dir = join(root, d);
        if (exists(join(dir, "CMakeCache.txt"))) return { command: "cmake", args: ["--build", dir], cwd: root };
      }
      return null; // unconfigured → decline → honest none (no cold configure in-turn)
    },
  },
  {
    id: "go",
    detect: ({ root, exists }) =>
      exists(join(root, "go.mod")) ? { command: "go", args: ["build", "./..."], cwd: root } : null,
  },
  {
    id: "node",
    detect: ({ root, exists }) =>
      exists(join(root, "tsconfig.json"))
        ? { command: "npx", args: ["--no-install", "tsc", "--noEmit"], cwd: root }
        : null,
  },
  {
    id: "make",
    detect: ({ root, exists, readText }) => {
      if (!exists(join(root, "Makefile"))) return null;
      const body = readText(join(root, "Makefile")) ?? "";
      // Only run a check-like phony target; a bare `make` could trigger an
      // unbounded full build.
      const target = /^check:/m.test(body) ? "check"
        : /^typecheck:/m.test(body) ? "typecheck"
        : /^test:/m.test(body) ? "test"
        : null;
      return target ? { command: "make", args: [target], cwd: root } : null;
    },
  },
];

/** First applicable project detector, or null. Exposed for tests. */
export function detectorFor(input: DetectInput): { id: string; cmd: DetectedCommand } | null {
  for (const det of PROJECT_DETECTORS) {
    const cmd = det.detect(input);
    if (cmd) return { id: det.id, cmd };
  }
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/build-check.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/build-check.ts server-jarvis/src/orchestration/build-check.test.ts
git commit -m "feat(build-check): build-system detector registry (cargo/cmake/go/node/make)"
```

### Task 1.3: `runBuildCheck` — execute + interpret to a tri-state

**Files:**
- Modify: `server-jarvis/src/orchestration/build-check.ts`
- Modify: `server-jarvis/src/orchestration/build-check.test.ts`

- [ ] **Step 1: Write the failing test**

Append:
```ts
import { runBuildCheck, type ExecResult } from "./build-check";

function fakeExec(map: Record<string, Partial<ExecResult>>) {
  return async (cmd: string, args: string[]): Promise<ExecResult> => {
    const base: ExecResult = { code: 0, enoent: false, timedOut: false, stderr: "", stdout: "" };
    return { ...base, ...(map[cmd] ?? {}) };
  };
}
function files(...paths: string[]) {
  const s = new Set(paths.map((p) => p.replace(/\\/g, "/")));
  return (p: string) => s.has(p.replace(/\\/g, "/"));
}

describe("runBuildCheck", () => {
  test("clean build → clean outcome", async () => {
    const r = await runBuildCheck({
      root: "/ws", writtenPaths: ["/ws/a.rs"], timeoutMs: 1000,
      exists: files("/ws/Cargo.toml"), exec: fakeExec({ cargo: { code: 0 } }),
    });
    expect(r).toMatchObject({ kind: "clean" });
    expect((r as any).command).toContain("cargo check");
  });

  test("failed build → failed outcome with stderr detail", async () => {
    const r = await runBuildCheck({
      root: "/ws", writtenPaths: ["/ws/a.rs"], timeoutMs: 1000,
      exists: files("/ws/Cargo.toml"),
      exec: fakeExec({ cargo: { code: 101, stderr: "error[E0425]: cannot find value `x`" } }),
    });
    expect(r.kind).toBe("failed");
    expect((r as any).detail).toContain("E0425");
  });

  test("toolchain absent (ENOENT) skips to next detector, then honest none", async () => {
    const r = await runBuildCheck({
      root: "/ws", writtenPaths: ["/ws/a.rs"], timeoutMs: 1000,
      exists: files("/ws/Cargo.toml"), exec: fakeExec({ cargo: { enoent: true } }),
    });
    expect(r).toMatchObject({ kind: "not_applicable" });
  });

  test("timeout → not_applicable", async () => {
    const r = await runBuildCheck({
      root: "/ws", writtenPaths: ["/ws/a.rs"], timeoutMs: 1000,
      exists: files("/ws/Cargo.toml"), exec: fakeExec({ cargo: { timedOut: true, code: null } }),
    });
    expect(r).toMatchObject({ kind: "not_applicable", reason: expect.stringContaining("timed out") });
  });

  test("no detector and no python → honest not_applicable", async () => {
    const r = await runBuildCheck({
      root: "/ws", writtenPaths: ["/ws/a.cpp"], timeoutMs: 1000,
      exists: files(), exec: fakeExec({}),
    });
    expect(r).toMatchObject({ kind: "not_applicable" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/build-check.test.ts`
Expected: FAIL — `runBuildCheck` not exported.

- [ ] **Step 3: Implement `runBuildCheck` + default exec**

Add to `build-check.ts`:
```ts
export interface RunBuildCheckInput {
  root: string;
  writtenPaths: string[];
  timeoutMs: number;
  exists?: (p: string) => boolean;
  readText?: (p: string) => string | null;
  exec?: ExecFn;
}

function defaultReadText(p: string): string | null {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

const defaultExec: ExecFn = (cmd, args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, enoent: false, timedOut: false, stderr: stderr || "", stdout: stdout || "" });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        resolve({
          code: typeof e.code === "number" ? e.code : null,
          enoent: e.code === "ENOENT",
          timedOut: e.killed === true || e.signal === "SIGTERM",
          stderr: stderr || "",
          stdout: stdout || "",
        });
      });
  });

function tailDetail(r: ExecResult): string {
  return (r.stderr || r.stdout || "").trim().split("\n").slice(-8).join("\n").slice(0, 400);
}

/** Detect the project's build system and run its check-level command, or fall
 * back to per-file Python syntax check. Returns a tri-state outcome; only an
 * actually-executed check yields clean/failed — everything else is
 * not_applicable (→ honest `none` upstream). */
export async function runBuildCheck(input: RunBuildCheckInput): Promise<CheckOutcome> {
  const exists = input.exists ?? existsSync;
  const readText = input.readText ?? defaultReadText;
  const exec = input.exec ?? defaultExec;
  const ctx: DetectInput = { root: input.root, writtenPaths: input.writtenPaths, exists, readText };

  for (const det of PROJECT_DETECTORS) {
    const cmd = det.detect(ctx);
    if (!cmd) continue;
    const r = await exec(cmd.command, cmd.args, cmd.cwd, input.timeoutMs);
    if (r.enoent) continue;                                   // toolchain unavailable → try next
    const commandStr = `${cmd.command} ${cmd.args.join(" ")}`.trim();
    if (r.timedOut) return { kind: "not_applicable", reason: `${det.id} check timed out` };
    if (r.code === 0) return { kind: "clean", command: commandStr };
    const detail = tailDetail(r);
    if (detail) return { kind: "failed", command: commandStr, detail };
    // nonzero with no diagnostic → cannot determine; try next detector
  }

  const pyFiles = input.writtenPaths.filter((p) => extname(p).toLowerCase() === ".py" && exists(p));
  if (pyFiles.length > 0) {
    const issues: string[] = [];
    for (const p of pyFiles) {
      const issue = await pythonSyntaxCheck(p);
      if (issue) issues.push(`[${p}] ${issue}`);
    }
    return issues.length > 0
      ? { kind: "failed", command: "py_compile", detail: issues.join("\n").slice(0, 400) }
      : { kind: "clean", command: "py_compile" };
  }

  return { kind: "not_applicable", reason: "no build system or checker matched the written files" };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/build-check.test.ts`
Expected: PASS (13 tests total).

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/build-check.ts server-jarvis/src/orchestration/build-check.test.ts
git commit -m "feat(build-check): runBuildCheck synchronous bounded tri-state runner"
```

---

## Phase 2 — `check-runner.ts` consumes the tri-state (the vacuous-green fix)

### Task 2.1: Rewrite `mergeToCheckResult` for the build tri-state

**Files:**
- Modify: `server-jarvis/src/orchestration/check-runner.ts`
- Modify: `server-jarvis/src/orchestration/check-runner.test.ts`

- [ ] **Step 1: Update the failing tests**

In `check-runner.test.ts`, replace the `mergeToCheckResult` tests with the new signature and add the honest-`none` regression pin:
```ts
import { mergeToCheckResult } from "./check-runner";
import type { RunGateResult } from "./run-gate";
import type { CheckOutcome } from "./build-check";

const skipped: RunGateResult = { status: "skipped", reason: "no test", issues: [] };

describe("mergeToCheckResult (build tri-state)", () => {
  test("passing test gate still wins as existing", () => {
    const run: RunGateResult = { status: "passed", target: "sol/_t.py", reason: "adjacent_test", issues: [] };
    const r = mergeToCheckResult({ run, build: { kind: "clean", command: "x" }, hadWrittenCode: true });
    expect(r).toMatchObject({ tier: "existing", ran: true, passed: true });
  });

  test("build clean → builtin passed", () => {
    const build: CheckOutcome = { kind: "clean", command: "cargo check --quiet" };
    expect(mergeToCheckResult({ run: skipped, build, hadWrittenCode: true }))
      .toMatchObject({ tier: "builtin", ran: true, passed: true });
  });

  test("build failed → builtin failed with detail", () => {
    const build: CheckOutcome = { kind: "failed", command: "cmake --build", detail: "error: no member" };
    const r = mergeToCheckResult({ run: skipped, build, hadWrittenCode: true });
    expect(r).toMatchObject({ tier: "builtin", ran: true, passed: false });
    expect(r.detail).toContain("no member");
  });

  test("REGRESSION: build not_applicable → honest none, never a green", () => {
    const build: CheckOutcome = { kind: "not_applicable", reason: "no build system matched" };
    expect(mergeToCheckResult({ run: skipped, build, hadWrittenCode: true }))
      .toMatchObject({ tier: "none", ran: false, passed: null });
  });

  test("no written code → none regardless of build", () => {
    expect(mergeToCheckResult({ run: skipped, build: { kind: "clean", command: "x" }, hadWrittenCode: false }))
      .toMatchObject({ tier: "none", ran: false });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/check-runner.test.ts`
Expected: FAIL — `mergeToCheckResult` still expects `syntaxIssues`.

- [ ] **Step 3: Rewrite `mergeToCheckResult` and imports**

In `check-runner.ts`, change the import line `import type { SyntaxIssue } from "./syntax-gate";` to `import type { CheckOutcome } from "./build-check";`, and replace `mergeToCheckResult` entirely:
```ts
export function mergeToCheckResult(input: {
  run: RunGateResult;
  build: CheckOutcome;
  hadWrittenCode: boolean;
  durationMs?: number;
}): CheckResult {
  const durationMs = input.durationMs ?? 0;
  if (!input.hadWrittenCode) {
    return { tier: "none", ran: false, passed: null, detail: "", command: "", durationMs };
  }
  if (input.run.status === "passed" || input.run.status === "failed") {
    const tier = input.run.reason ? classifyRunGateTier(input.run.reason as RunTarget["reason"]) : "existing";
    const passed = input.run.status === "passed";
    return {
      tier, ran: true, passed,
      detail: passed ? "" : input.run.issues.map((i) => `[${i.path}] ${i.error}`).join("\n").slice(0, 400),
      command: `run:${input.run.target ?? "?"}`, durationMs,
    };
  }
  switch (input.build.kind) {
    case "clean":
      return { tier: "builtin", ran: true, passed: true, detail: "", command: input.build.command, durationMs };
    case "failed":
      return { tier: "builtin", ran: true, passed: false, detail: input.build.detail, command: input.build.command, durationMs };
    case "not_applicable":
      return { tier: "none", ran: false, passed: null, detail: "", command: "", durationMs };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/check-runner.test.ts`
Expected: PASS (the merge tests; `runVerificationCheck` tests updated in Task 2.2).

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/check-runner.ts server-jarvis/src/orchestration/check-runner.test.ts
git commit -m "fix(check-runner): consume build tri-state; not_applicable is honest none"
```

### Task 2.2: `runVerificationCheck` uses `runBuild` instead of `runSyntax`

**Files:**
- Modify: `server-jarvis/src/orchestration/check-runner.ts`
- Modify: `server-jarvis/src/orchestration/check-runner.test.ts`

- [ ] **Step 1: Update the failing test**

Replace the `runVerificationCheck` tests in `check-runner.test.ts`:
```ts
import { runVerificationCheck } from "./check-runner";
import type { ToolCallRecord } from "./stage-output";

describe("runVerificationCheck (build)", () => {
  const write: ToolCallRecord = { name: "write_file", arguments: { path: "a.cpp" }, output: "ok", is_error: false, duration_ms: 1 };

  test("runs build + test gates and merges (build clean → builtin)", async () => {
    const r = await runVerificationCheck({
      toolCalls: [write], request: "fix a.cpp", plan: "", workspaceRoot: "/ws", timeoutMs: 1000,
      runBuild: async () => ({ kind: "clean", command: "cmake --build /ws/build" }),
      runTests: async () => ({ status: "skipped", reason: "no test", issues: [] }),
    });
    expect(r).toMatchObject({ tier: "builtin", ran: true, passed: true });
  });

  test("no build system → honest none", async () => {
    const r = await runVerificationCheck({
      toolCalls: [write], request: "fix a.cpp", plan: "", workspaceRoot: "/ws", timeoutMs: 1000,
      runBuild: async () => ({ kind: "not_applicable", reason: "no build system matched" }),
      runTests: async () => ({ status: "skipped", reason: "no test", issues: [] }),
    });
    expect(r.tier).toBe("none");
  });

  test("no written code short-circuits to none", async () => {
    const r = await runVerificationCheck({
      toolCalls: [{ name: "read_file", arguments: { path: "a.cpp" }, output: "x", is_error: false, duration_ms: 1 }],
      request: "explain", plan: "", workspaceRoot: "/ws", timeoutMs: 1000,
      runBuild: async () => ({ kind: "clean", command: "x" }),
      runTests: async () => ({ status: "skipped", reason: "no test", issues: [] }),
    });
    expect(r.tier).toBe("none");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/check-runner.test.ts`
Expected: FAIL — `RunVerificationInput` still has `runSyntax`.

- [ ] **Step 3: Swap the injection**

In `check-runner.ts`: update the imports to include `type { CheckOutcome } from "./build-check"`, change `RunVerificationInput`:
```ts
export interface RunVerificationInput {
  toolCalls: readonly ToolCallRecord[];
  request: string;
  plan: string;
  workspaceRoot: string;
  timeoutMs: number;
  /** Detect + run the project's build-system check (tri-state). */
  runBuild: () => Promise<CheckOutcome>;
  runTests: (toolCalls: readonly ToolCallRecord[], request: string, plan: string) => Promise<RunGateResult>;
}
```
and `runVerificationCheck`:
```ts
export async function runVerificationCheck(input: RunVerificationInput): Promise<CheckResult> {
  const startedAt = Date.now();
  const written = hadWrittenCode(input.toolCalls);
  if (!written) {
    return { tier: "none", ran: false, passed: null, detail: "", command: "", durationMs: Date.now() - startedAt };
  }
  const [build, run] = await Promise.all([
    input.runBuild(),
    input.runTests(input.toolCalls, input.request, input.plan),
  ]);
  return mergeToCheckResult({ run, build, hadWrittenCode: true, durationMs: Date.now() - startedAt });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/check-runner.test.ts`
Expected: PASS (all check-runner tests).

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/check-runner.ts server-jarvis/src/orchestration/check-runner.test.ts
git commit -m "feat(check-runner): runVerificationCheck runs the build tier"
```

---

## Phase 3 — Pipeline wiring + config

### Task 3.1: Wire `runBuildCheck` into `runTurnVerification`

**Files:**
- Modify: `server-jarvis/src/orchestration/pipeline.ts`

- [ ] **Step 1: Add the import**

At the top of `pipeline.ts` (near the other check imports around L4-7):
```ts
import { runBuildCheck, writtenPathsFrom } from "./build-check";
```

- [ ] **Step 2: Replace the `runSyntax` injection in `runTurnVerification`**

Change the body of `runTurnVerification` (the `runVerificationCheck({...})` call) so the timeout default is 90000 and the injection is `runBuild`:
```ts
    const timeoutMs = this.ctx.config.orchestrator.verification.check_timeout_ms ?? 90000;
    try {
      return await runVerificationCheck({
        toolCalls,
        request,
        plan: planSummary,
        workspaceRoot,
        timeoutMs,
        runBuild: () => runBuildCheck({
          root: workspaceRoot,
          writtenPaths: writtenPathsFrom(toolCalls),
          timeoutMs,
        }),
        runTests: (tc, req, pl) => this.gateWrittenRun([...tc], req, pl),
      });
    } catch (e) {
```
(`gateWrittenSyntax` stays defined for its other call site at the high-complexity retry gate — do not remove it.)

- [ ] **Step 3: Typecheck**

Run: `cd server-jarvis && bun run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add server-jarvis/src/orchestration/pipeline.ts
git commit -m "feat(pipeline): verification runs the build-check registry"
```

### Task 3.2: Raise the check timeout default

**Files:**
- Modify: `server-jarvis/src/config.ts`

- [ ] **Step 1: Bump the default**

In the default-config factory `verification` block, change `check_timeout_ms: 15000` to:
```ts
      check_timeout_ms: 90000,
```

- [ ] **Step 2: Typecheck + config regression test**

Run: `cd server-jarvis && bun run typecheck && bun test src/config-regression.test.ts`
Expected: exit 0; PASS.

- [ ] **Step 3: Commit**

```bash
git add server-jarvis/src/config.ts
git commit -m "feat(config): raise verification.check_timeout_ms default to 90s for build checks"
```

---

## Phase 4 — Verification & rollout

### Task 4.1: Full suite + tier-2B regression

**Files:** none (verification)

- [ ] **Step 1: Full typecheck + test suite**

Run: `cd server-jarvis && bun run typecheck && bun test`
Expected: exit 0; all tests pass. Confirm the old `syntaxIssues`-based `mergeToCheckResult` tests are gone and the new tri-state + honest-`none` tests pass.

- [ ] **Step 2: Re-run the tier-2B live benchmark (Python regression)**

With a server running the branch and `verification.enabled: true`:
Run: `python scripts/benchmark-tier2b/runbench2b.py --arm architecture --k 3 --live`
Expected: **30/30 preserved**; query `self-tuning.db` and confirm the Python runs still record `check_tier=builtin` (now via the `py_compile` fallback detector), `verified_via=runtime_check`.

- [ ] **Step 3: C++ honest-none / build smoke (Perihelion)**

Point a change turn at `C:\Users\ethan\Downloads\Perihelion`. Confirm: with **no configured CMake build dir**, a C++ write records `check_tier=none` (honest unverified — no more false `builtin` green). With a configured `build/` dir present, a breaking change records `check_tier=builtin, passed=false` and triggers repair.

- [ ] **Step 4: Commit any doc/telemetry notes**

```bash
git add -A
git commit -m "docs(verification): record build-verification tier-2B regression + C++ smoke"
```

---

## Self-Review

- **Spec coverage:** §4.1 build-check module → Phase 1 (Tasks 1.1–1.3); §4.2 tri-state merge → Task 2.1; §4.2 runBuild injection → Task 2.2; §4.3 pipeline wiring → Task 3.1; §4.4 timeout default → Task 3.2; §5 testing → per-task TDD + Task 4.1; §6 rollout → Phase 4. All covered.
- **Type consistency:** `CheckOutcome` (build-check.ts) is produced by `runBuildCheck`/`runBuild` and consumed by `mergeToCheckResult`/`runVerificationCheck` identically. `DetectInput`/`DetectedCommand`/`ExecFn`/`ExecResult` are defined in Task 1.1 and used in 1.2/1.3. `writtenPathsFrom` defined in 1.1, used in 3.1. `RunVerificationInput.runBuild` replaces `runSyntax` in 2.2 and is supplied by the pipeline in 3.1 — no call site still passes `runSyntax`.
- **Placeholder scan:** none — every code step shows complete code; the `make` detector's "only a check/test target" decision is resolved concretely (regex on the Makefile body).
- **Known follow-ups (explicitly out of scope, not placeholders):** node detector uses `npx --no-install tsc --noEmit` and does not yet resolve package-manager-specific `typecheck` scripts; `make` covers only `check`/`typecheck`/`test` phony targets. Both are extensible in the registry and noted in the spec's §7.
