# Language-Agnostic Build Verification — Design Spec

- **Date:** 2026-07-25
- **Status:** Approved (brainstorm complete) → implementation planning
- **Author:** Ethan + Claude
- **Related:** `2026-07-24-verification-gated-conductor-design.md`, memory `tier2b-benchmark-diagnosis-2026-07-24`

## 1. Motivation

The verification-gated conductor (shipped 2026-07-25, 30/30 on tier-2B) is **Python-only and test-reliant**. On the live Perihelion session (a C++/JUCE/CMake VST3 plugin) this produced a *false green*: `check-runner.ts` `mergeToCheckResult` returns `builtin passed=true` whenever `syntaxIssues.length === 0` — and `syntaxIssues` is empty precisely when there were **no Python files to check**. So "nothing was checked" and "everything checked out" collapse to the same pass. Turn 6 ("Phase 1 complete and verified") was never compiled.

Two rejected non-goals drive the redesign:
- **We will not build a syntax checker per language.** That treadmill never ends and a syntax check is a weak signal.
- **We will not require a pre-existing test suite.** Real projects (and mid-implementation states) often have none.

## 2. Objective & the reframe

**Verify the build, not the language.** The most language-agnostic, ungameable "did you break it" signal is whether the project's *own* toolchain still passes its check-level build. Detect the **build system** (a handful of them, each covering many languages), run its check command, read the exit code. A build is not a test, needs no authored suite, and catches the largest class of breakage (syntax, types, missing symbols, broken includes) — exactly what the Perihelion false-green missed.

Success criteria:
- A C++/CMake, Rust, TS, or Go change that breaks the build is caught (`builtin failed`) and feeds the existing repair chain; a clean one earns a real `builtin` pass.
- When no real check ran (no detector, missing toolchain, timeout, unconfigured project), the result is **honest `none`** ("unverified") — never a false green.
- Python behavior is unchanged (tier-2B stays 30/30): `py_compile` becomes one detector among many.
- Runs synchronously in-turn, check-level (compile/typecheck, not full build+link+package), bounded by a timeout; worst case is a bounded delay, never an unbounded block or a false pass.

## 3. Locked design decisions

| Fork | Decision |
|------|----------|
| First slice | **Build-floor + honest-none.** Spec-derived / model-authored checks deferred to a later slice. |
| Execution model | **Synchronous, check-level, bounded.** Prefer each build system's check mode (`cargo check`, `tsc --noEmit`, `go build`, `cmake --build <configured>`). Timeout / missing toolchain / unconfigured → honest `none`. |
| Tier taxonomy | The build check **is** the generalized `builtin` tier (ungameable, full reward). Existing run-gate `test` tiers (`existing`/`synth`) still take precedence when a runnable test exists. |
| Vacuous-green fix | Detection+run returns a **tri-state** (`clean` / `failed` / `not_applicable`); only an actually-executed check yields a `builtin` pass. |

## 4. Component design

### 4.1 New module `build-check.ts`

```ts
export type CheckOutcome =
  | { kind: "clean"; command: string }
  | { kind: "failed"; command: string; detail: string }   // stderr tail, ~400 chars
  | { kind: "not_applicable"; reason: string };

export interface BuildDetector {
  id: string;                       // "cargo" | "cmake" | "node" | "go" | "make" | "python"
  /** Returns a runnable command when this detector applies AND the project is
   * in a checkable state; null to decline (→ try next / honest none). */
  detect(input: { root: string; writtenPaths: string[]; exists: (p: string) => boolean }):
    | { command: string; args: string[]; cwd: string; fileLevel?: boolean }
    | null;
}

export interface RunBuildCheckInput {
  root: string;
  writtenPaths: string[];           // paths from successful write-effect tool calls
  timeoutMs: number;
  exists?: (p: string) => boolean;  // injectable for tests
  exec?: (cmd: string, args: string[], cwd: string, timeoutMs: number)
    => Promise<{ code: number | null; enoent: boolean; timedOut: boolean; stderr: string; stdout: string }>;
}

export async function runBuildCheck(input: RunBuildCheckInput): Promise<CheckOutcome>;
```

**Detector precedence (first slice):** project-level detectors first, in this order, then the file-level Python fallback:

| id | marker (at `root`) | check command | notes |
|----|--------------------|---------------|-------|
| `cargo` | `Cargo.toml` | `cargo check` | |
| `cmake` | `CMakeLists.txt` **and** a configured build dir (`build/CMakeCache.txt`, `out/CMakeCache.txt`, or `cmake-build-*`) | `cmake --build <dir>` | declines (→ null) when unconfigured, so we never pay cold-configure cost in-turn or false-fail |
| `node` | `package.json` with a `typecheck`/`build` script, or a `tsconfig.json` | the declared script, else `tsc --noEmit` (via `npx`/`bunx`) | |
| `go` | `go.mod` | `go build ./...` | already check-level |
| `make` | `Makefile` | `make -n`? no — `make` (or a `check`/`test` phony target if present) | |
| `python` | any written `*.py` | `pythonSyntaxCheck` (reuse `syntax-gate.ts`) | **file-level**: run per written `.py`; the existing behavior, now a detector |

**Execution + interpretation** (`runBuildCheck`):
1. Walk project-level detectors in order; take the **first** whose `detect()` returns a command.
2. Run it (bounded by `timeoutMs`):
   - exit 0 → `clean`
   - exit ≠ 0 with diagnostic → `failed(detail = stderr||stdout tail)`
   - `ENOENT` (toolchain absent) → treat as *this detector unavailable*: continue to the next detector rather than failing.
   - timed out → `not_applicable("<id> check timed out")`
3. If no project detector produced `clean`/`failed`, run the **file-level Python** detector over written `.py` (reusing `pythonSyntaxCheck`): any issue → `failed`; all clean → `clean`; no `.py` → skip.
4. Nothing applied → `not_applicable("no build system or checker matched the written files")`.

Reuses `run-gate.ts`'s `execFile`-with-argv discipline (never a shell; workspace names never interpolated) and its ENOENT/timeout handling shape.

### 4.2 `check-runner.ts` — consume the tri-state

`RunVerificationInput.runSyntax` (returns `SyntaxIssue[]`) is **replaced** by `runBuild` (returns `CheckOutcome`). `mergeToCheckResult` is rewritten to consume the tri-state, which is the actual fix for the vacuous green:

```ts
export function mergeToCheckResult(input: {
  run: RunGateResult;          // the test gate (existing/synth) — unchanged precedence
  build: CheckOutcome;         // NEW: replaces syntaxIssues
  hadWrittenCode: boolean;
  durationMs?: number;
}): CheckResult {
  if (!input.hadWrittenCode) return NONE;
  if (input.run.status === "passed" || input.run.status === "failed") { /* existing/synth, unchanged */ }
  switch (input.build.kind) {
    case "clean":  return { tier: "builtin", ran: true,  passed: true,  detail: "", command: input.build.command, durationMs };
    case "failed": return { tier: "builtin", ran: true,  passed: false, detail: input.build.detail, command: input.build.command, durationMs };
    case "not_applicable": return { tier: "none", ran: false, passed: null, detail: "", command: "", durationMs };  // ← honest none
  }
}
```

`runVerificationCheck` calls `runBuild` in place of `runSyntax` (still parallel with `runTests`).

### 4.3 `pipeline.ts` — wire the real detector

`runTurnVerification` replaces the `runSyntax` injection with a `runBuild` that calls `runBuildCheck` at the workspace root with the written paths and the (raised) timeout:

```ts
runBuild: () => runBuildCheck({
  root: workspaceRoot,
  writtenPaths: writtenPathsFrom(toolCalls),   // successful write-effect call paths
  timeoutMs,
}),
```
A small `writtenPathsFrom(toolCalls)` helper (successful `write_file`/`edit_file`/`multi_edit`/`apply_patch` `path` args) lives in `build-check.ts` and is shared. `gateWrittenSyntax` is retained only for its other call sites (the high-complexity retry gate ~L3448); the verification path no longer uses it.

### 4.4 Config

`orchestrator.verification.check_timeout_ms` default raised **15000 → 90000** (build check-level needs headroom; Python `py_compile` still returns in ms). No new config keys required for this slice.

## 5. Testing strategy

- **Unit (deterministic, injected `exec`/`exists` — no real toolchains):** detector precedence (cargo before python when both present), CMake declines when unconfigured, `detect()` marker matching, and `runBuildCheck` interpretation of exit 0 / exit≠0+diagnostic / ENOENT-skips-to-next / timeout→not_applicable / nothing-matched→not_applicable.
- **Unit `mergeToCheckResult`:** the three build outcomes → builtin clean / builtin failed / **none** (the anti-vacuous-green regression pin); test-gate precedence unchanged.
- **Integration (opt-in, toolchain-gated):** a broken-Rust fixture (`cargo check` fails), a broken-TS fixture (`tsc` fails), a clean fixture each; assert `builtin failed`/`clean`. Gated behind toolchain presence so CI without cargo/tsc skips rather than fails.
- **Regression:** full `bun test` green; **re-run tier-2B (Python) → still 30/30, still `check_tier=builtin`** (py_compile detector path); a Perihelion smoke confirming `cmake` detection + honest `none` when the build dir isn't configured.

## 6. Rollout

Behind the existing `verification.enabled` flag (still default-off pending canary). Additive: the detector registry only changes what fills the `builtin` tier. Re-run the tier-2B live benchmark to confirm no regression, then a C++ smoke against a configured Perihelion build.

## 7. Out of scope (next slices)

- **Spec-derived / acceptance-criteria checks** (the "build a proper test" path) — deriving executable checks from the plan's requirements, with the gameability controls that implies. A separate design.
- **Async/full-build** execution for genuinely slow projects.
- The conductor-progression work (recursive-topology no-write fence gap; big-phase read-loop timeout) — tracked separately per Ethan's #2.
