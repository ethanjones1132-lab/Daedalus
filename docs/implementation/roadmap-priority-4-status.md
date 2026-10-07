# Roadmap Priority 4 — Status and evidence index

**As of:** 2026-10-07
**Scope:** Roadmap Priority #4, “Build complete workflows beyond coding.”
**State:** Phase 4.1–4.3 source is implemented; Phase 4.4 source and documentation are implemented. Priority #4 **real-task acceptance remains OPEN** for all three workflows. No real user task has been authorized or observed, and no external integration or consequential action has been run. The first Phase 4.4 permitted-check attempt, at the old source-worktree fingerprint `bf861df9fc0019e859718ca4cfb6df7bc89967c774ce40d90572f4f4c77bbb87` (795 files), **stopped on a UI build failure**: `cargo check`, server typecheck, and server build exited 0, but the UI build exited 1 with `TS2305`/`TS2304`, and `git diff --check` was not run because the plan says stop after a failed check. The failure was caused by deletion of the pre-existing `JarvisTerminalOutcome` type by the P4.4 selector edit. The deleted type was restored by an exact one-line restoration that Luna reviewed **clean**, producing the corrected source-worktree fingerprint `88fad2a4f058c9a54c2c2357291b36cca3b3da3b8cff98cc8a1a6fed646bdcf6` (795 files). The corrected-source permitted-check run at that fingerprint (capture/result recorded `2026-10-07T01:22:53Z`) had `cargo check`, server typecheck, server build, and UI build each exit 0 PASS (the UI build with a Vite advisory that some chunks are larger than 500 kB and a 1,365.86 kB JS bundle), while the full `git diff --check` exited 2 FAIL solely for unrelated pre-existing `docs/implementation/roadmap-priority-3-status.md:3` trailing whitespace. Four of five checks passed; not all five passed. The source-worktree fingerprint was the same before and after the checks. See the failed-attempt record [`priority4-source-checks-bf861df9fc0019e859718ca4cfb6df7bc89967c774ce40d90572f4f4c77bbb87.json`](../../work/opencode-memory/priority4-source-checks-bf861df9fc0019e859718ca4cfb6df7bc89967c774ce40d90572f4f4c77bbb87.json) and the corrected-source report [`priority4-source-checks-88fad2a4f058c9a54c2c2357291b36cca3b3da3b8cff98cc8a1a6fed646bdcf6.json`](../../work/opencode-memory/priority4-source-checks-88fad2a4f058c9a54c2c2357291b36cca3b3da3b8cff98cc8a1a6fed646bdcf6.json).

This is a concise index. Per-workflow details are in the three evidence records below; each keeps `source_checkpoint` (source revision, review, permitted checks) and `real_task_evidence` (real, user-authorized observations) separate, with missing values stated explicitly as `NOT RUN`, `not observed`, or `not applicable`.

## Evidence records

| Workflow | Evidence record | Source plan |
|---|---|---|
| Project Steward (P4.1) | [project-steward.md](priority-4-evidence/project-steward.md) | [2026-10-06-priority-4-phase-4-1-project-steward.md](../superpowers/plans/2026-10-06-priority-4-phase-4-1-project-steward.md) |
| Attributable Researcher (P4.2) | [attributable-researcher.md](priority-4-evidence/attributable-researcher.md) | [2026-10-06-priority-4-phase-4-2-attributable-researcher.md](../superpowers/plans/2026-10-06-priority-4-phase-4-2-attributable-researcher.md) |
| Recurring Operator (P4.3) | [recurring-operator.md](priority-4-evidence/recurring-operator.md) | [2026-10-06-priority-4-phase-4-3-recurring-operator.md](../superpowers/plans/2026-10-06-priority-4-phase-4-3-recurring-operator.md) |

**Parent plan:** [2026-10-05-roadmap-priority-4-workflows.md](../superpowers/plans/2026-10-05-roadmap-priority-4-workflows.md) §“Phase 4.4 — Cross-workflow readiness and evidence handoff”.
**Phase 4.4 plan:** [2026-10-06-priority-4-phase-4-4-cross-workflow-handoff.md](../superpowers/plans/2026-10-06-priority-4-phase-4-4-cross-workflow-handoff.md).

## Per-workflow source/check summary

- **P4.1 Project Steward — source-reviewed clean; four checks exit 0, diff-check exit 2 (unrelated).** Source fingerprint SHA-256 `9c1d5f7dcc32a7023b7086cab6ed4eb3490176ddd00443f649c989df6159e561` (a source fingerprint, not a commit SHA). `cargo check`, server typecheck, server build, and UI build each exited 0; `git diff --check` exited 2 solely for unrelated pre-existing `docs/implementation/roadmap-priority-3-status.md:3` trailing whitespace. Not claimed as all-five-pass.
- **P4.2 Attributable Researcher — source reviewed/frozen; exact checkpoint not recorded in-repo.** The in-repo Phase 4.3 plan records that “Phase 4.2 source is reviewed and frozen.” No exact source revision or per-check exit report is present in the available in-repo records; those fields are marked `not recorded`. Nothing is inferred.
- **P4.3 Recurring Operator — source-reviewed clean; four checks exit 0, diff-check exit 2 (unrelated).** Final check attempt held the same before/after **worktree fingerprint** (not a commit SHA) `164660dda7eed52a436a14069f146dfca7d88e20661ce22753cde985f363cd52`. `cargo check`, server typecheck, server build, and UI build each exited 0; `git diff --check` exited 2 solely for existing unrelated `docs/implementation/roadmap-priority-3-status.md:3` trailing whitespace. Not claimed as all-five-pass.

## Phase 4.4 source implementation

- Phase 4.4 Task 1 (selector-only cross-workflow navigation) and Task 2 (shared, presentational readiness/recovery panel) source are implemented in the worktree.
- The Task 2 source diff has been **Luna-reviewed clean**.
- **First Phase 4.4 permitted-check attempt — PARTIAL / STOPPED ON UI BUILD FAILURE** at the old source-worktree fingerprint `bf861df9fc0019e859718ca4cfb6df7bc89967c774ce40d90572f4f4c77bbb87` (795 files), recorded `2026-10-07T01:13:55Z`. `cargo check` exited 0 (with the captured warning categories), server typecheck exited 0, and server build exited 0, but the UI build exited 1 (`TS2305` at `chat-state.ts(1,30)` and `TS2304` at `types.ts(263,21)`), and `git diff --check` was **NOT RUN** because the plan says stop after a failed check. The source fingerprint was the same before and after the attempt. The failure was caused by deletion of the pre-existing `JarvisTerminalOutcome` type by the P4.4 selector edit. Full record: [`work/opencode-memory/priority4-source-checks-bf861df9fc0019e859718ca4cfb6df7bc89967c774ce40d90572f4f4c77bbb87.json`](../../work/opencode-memory/priority4-source-checks-bf861df9fc0019e859718ca4cfb6df7bc89967c774ce40d90572f4f4c77bbb87.json).
- **Correction and corrected source checkpoint:** the deleted `JarvisTerminalOutcome` type was restored by an exact one-line restoration that Luna reviewed **clean**, producing the corrected source-worktree fingerprint `88fad2a4f058c9a54c2c2357291b36cca3b3da3b8cff98cc8a1a6fed646bdcf6` (795 files, over the `src-tauri`, `server-jarvis`, and `src-ui` source/build-input trees; source/build-input only, not docs, generated output directories, or a commit; explicitly **not a commit SHA**). The corrected-source permitted-check run at that fingerprint (capture/result recorded `2026-10-07T01:22:53Z`) had `cargo check`, server typecheck, server build, and UI build each exit 0 PASS (UI build with a Vite advisory that some chunks are larger than 500 kB and a 1,365.86 kB JS bundle), and full `git diff --check` exit 2 FAIL solely for unrelated pre-existing `docs/implementation/roadmap-priority-3-status.md:3` trailing whitespace: [`work/opencode-memory/priority4-source-checks-88fad2a4f058c9a54c2c2357291b36cca3b3da3b8cff98cc8a1a6fed646bdcf6.json`](../../work/opencode-memory/priority4-source-checks-88fad2a4f058c9a54c2c2357291b36cca3b3da3b8cff98cc8a1a6fed646bdcf6.json). Four of five checks passed; not all five passed. The source-worktree fingerprint was the same before and after the run. No test, runtime, live research, scheduler, or external action was run.
- Phase 4.4 Task 3 (these evidence records, this status index, and `work/opencode-memory/priority4-coordination.md`) is documentation-only.
- Phase 4.4 Task 4 published the acceptance checklist below, the five-check report, and the Priority 4 roadmap handoff; the Task 4 documentation work is **Luna-reviewed clean**. The first permitted-check attempt then stopped on the UI build failure recorded above, and the corrected-source checkpoint record froze the source/build-input identity as the corrected source-worktree fingerprint `88fad2a4f058c9a54c2c2357291b36cca3b3da3b8cff98cc8a1a6fed646bdcf6`. The corrected-source permitted-check run at that fingerprint subsequently recorded `cargo check`, server typecheck, server build, and UI build each exit 0 PASS (UI build with the Vite chunk-size advisory) and full `git diff --check` exit 2 FAIL solely for the unrelated pre-existing `docs/implementation/roadmap-priority-3-status.md:3` trailing whitespace; four of five checks passed, and not all five passed.

## Priority #4 acceptance status

**OPEN.** All three workflows require their own concrete, user-authorized real task with exact native readback, any required consequential confirmations and recovery observations, and a user-accepted artifact or observable result. Source review, source checks, build success, and UI labels cannot satisfy any real-task box.

- Project Steward real task/artifact acceptance: `NOT RUN` / `OPEN`.
- Attributable Researcher real question/cited-output acceptance: `NOT RUN` / `OPEN`.
- Recurring Operator real commitment/observed-interval acceptance: `NOT RUN` / `OPEN`.

## Real-task acceptance checklist (preparatory — all fields OPEN)

This checklist is preparatory only and was published by Phase 4.4 Task 4 without running anything. Every task-specific real-task field is `OPEN` until the user supplies a concrete task and the work is separately authorized and observed. No test, synthetic fixture, source review, build, or UI label can check a real-task box. External integrations/actions require their own explicit authorization.

### Project Steward

| Field | Value |
|---|---|
| User-selected repository / concrete task | `OPEN` |
| Canonical workspace / `project_root` | `OPEN` |
| Native Session ID | `OPEN` |
| Goal ID | `OPEN` |
| Session run ID | `OPEN` |
| Backend / model identity and version | `OPEN` |
| Tooling and requested budget | `OPEN` |
| Consequential user confirmation boundary | `OPEN` |
| Expected output (reviewable diff / checks) and native readback | `OPEN` |
| Applicable interruption / recovery observation | `OPEN` |
| Final user acceptance of the artifact | `OPEN` |

### Attributable Researcher

| Field | Value |
|---|---|
| User-selected question | `OPEN` |
| Source scope | `OPEN` |
| Audience | `OPEN` |
| Native Session ID | `OPEN` |
| Successful persisted Agent run ID | `OPEN` |
| Native research receipt ID and hash | `OPEN` |
| Backend / model and ToolRuntime tool identity and version | `OPEN` |
| Configured source / time budget | `OPEN` |
| Consequential user confirmation boundary (explicit memory save) | `OPEN` |
| Expected output and native receipt / readback | `OPEN` |
| Applicable recovery observation (source choice / `ask` / `deny` / partial) | `OPEN` |
| Final user acceptance of the cited output | `OPEN` |

### Recurring Operator

| Field | Value |
|---|---|
| User-selected Goal | `OPEN` |
| Commitment | `OPEN` |
| Supported action | `OPEN` |
| Observation interval | `OPEN` |
| Goal ID | `OPEN` |
| Cron job ID | `OPEN` |
| Activation ID | `OPEN` |
| Cron run ID | `OPEN` |
| Backend / model and tool identity and version | `OPEN` |
| Configured schedule / occurrence budget | `OPEN` |
| Consequential user confirmation boundary | `OPEN` |
| Expected outcome and native readback (`CronExecutionEvidence`) | `OPEN` |
| Applicable recovery observation (waiting / blocked / ambiguous / cancelled / failed) | `OPEN` |
| Final user acceptance of the observed result | `OPEN` |

## Boundaries and non-claims

- Priority #1, #2, and #3 acceptance states are unchanged and remain open/incomplete where previously recorded; this index does not alter them and does not imply the Priority #4 sequencing override waived any acceptance gate.
- The first Phase 4.4 permitted-check attempt ran `cargo check`, server typecheck, and server build (each exit 0) and the UI build (exit 1, `TS2305`/`TS2304`); it did **not** run the full `git diff --check` because the plan says stop after a failed check. The failure was caused by deletion of a pre-existing type (`JarvisTerminalOutcome`) by the P4.4 selector edit and was corrected by an exact one-line restoration reviewed clean by Luna. The old-fingerprint record reports the failure honestly and does not claim all five checks passed. The corrected-source five-check report contains the corrected source-worktree fingerprint and the final run results: `cargo check`, server typecheck, server build, and UI build each exit 0 PASS, and full `git diff --check` exit 2 FAIL solely for the unrelated pre-existing Priority 3 whitespace; four of five checks passed, and the report does not claim all five passed. No check result or capture time was invented.
- Deviation: during documentation inspection before final freeze, a path-scoped `git diff --check` over the P4 docs paths ran and produced no output, but its exit code was not retained; it is not the permitted final full `git diff --check`.
- Source checks establish source buildability/formatting status only. `git diff --check` remains not green on the shared worktree because of an unrelated pre-existing Priority 3 docs file, which was not modified.
