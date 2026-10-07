# Priority 4 Evidence — Attributable Researcher

**Workflow:** Roadmap Priority #4, Phase 4.2 — Attributable Researcher workflow.
**Source plan:** [2026-10-06-priority-4-phase-4-2-attributable-researcher.md](../../superpowers/plans/2026-10-06-priority-4-phase-4-2-attributable-researcher.md)
**Parent plan:** [2026-10-05-roadmap-priority-4-workflows.md](../../superpowers/plans/2026-10-05-roadmap-priority-4-workflows.md) §“Phase 4.2”.
**Overall state:** Source plan reviewed/frozen per the in-repo sequencing record; exact checkpoint values are not recorded in the available in-repo records. Real user-task acceptance remains **OPEN**. No real research task has been authorized or observed.

This record keeps two distinct sections. `source_checkpoint` records the reviewed source revision/fingerprint, changed-file scope, Luna review result, and each permitted check with its unmasked exit code. `real_task_evidence` records what was actually observed while a user-authorized real task ran. Every field not actually observed is stated explicitly as `NOT RUN`, `not observed`, or `not applicable`; nothing is inferred, and no question text, source excerpt, research synthesis, credential, or private output is copied here.

## source_checkpoint

- **Source revision:** `not recorded` — the available in-repo authoritative records do not contain an exact source SHA or worktree fingerprint for the Phase 4.2 checkpoint. No value is inferred.
- **Changed-file scope:** exact frozen changed-file list `not recorded`. Authorized scope per the source plan:
  - Task 1 (native research record): `src-tauri/src/jarvis/learning.rs`; `src-tauri/src/commands/jarvis_commands.rs`; `src-tauri/src/db/mod.rs`; `src-tauri/src/lib.rs`; `server-jarvis/src/learning-session.ts`; and narrowly bounded `AppDb` test-fixture literals in `src-tauri/src/commands/models.rs`, `sessions.rs`, `settings.rs`, `skills.rs`, `recovery_stubs.rs`.
  - Task 2–3 (request/evidence/synthesis UI and explicit scoped-memory save): `src-ui/src/components/jarvis/LearningView.tsx`.
  - Reused without modification: `server-jarvis/src/web-bundle.ts`, `src-tauri/src/commands/memory.rs`, `src-tauri/src/jarvis/memory/contracts.rs`, `src-tauri/src/jarvis/memory/scope.rs`, `src-tauri/src/commands/goals.rs`, `src-ui/src/components/jarvis/GoalsView.tsx`.
- **Luna review result:** the in-repo Phase 4.3 source plan sequencing record states “Phase 4.2 source is reviewed and frozen.” No more specific review statement is recorded in-repo; further detail is `not recorded`.
- **Permitted checks:** `not recorded` — the available in-repo records contain no per-check command/exit report for this workflow. None of the five checks is claimed here, and no check was run as part of this documentation task.

  | Check | Command (as specified by the plan) | Exit | Notes |
  |---|---|---|---|
  | Rust compile | `(cd src-tauri && /Users/charlottehughes/.cargo/bin/cargo check)` | `not recorded` | No in-repo result available. |
  | Server typecheck | `(cd server-jarvis && bun run typecheck)` | `not recorded` | No in-repo result available. |
  | Server build | `(cd server-jarvis && bun run build)` | `not recorded` | No in-repo result available. |
  | UI build | `(cd src-ui && bun run build)` | `not recorded` | No in-repo result available. |
  | Whitespace/conflict | `git diff --check` | `not recorded` | No in-repo result available; not claimed green. |

- **Warnings/failures:** `not recorded`; not observed in the available in-repo records.
- **Source-check boundary:** because no in-repo check report is available, this workflow’s source buildability is asserted only by the plan’s frozen-review statement, not by a re-verified check table. Whatever the original results, they are not real-task acceptance evidence.

## real_task_evidence

- **Acceptance checklist:** published in [roadmap-priority-4-status.md](../roadmap-priority-4-status.md). Every task-specific real-task field for this workflow remains `OPEN` as of Phase 4.4 Task 4 (2026-10-06). Source review, source checks, build success, and UI labels cannot check a real-task box.
- **User authorization / task reference:** `NOT RUN` — no concrete research question, source scope, audience, or output destination has been supplied or authorized.
- **Persisted selectors:** `not observed` — no real research task exists, so no persisted selectors were collected. Planned selector kinds (from the source plan) that remain unpopulated:
  - `session_id`: `not observed`
  - `agent_run_id` (successful persisted Agent run): `not observed`
  - native research request/receipt ID and receipt hash: `not observed`
  - trajectory/tool-sequence digest: `not observed`
  - persisted `agent_id` / canonical `project_root`: `not observed`
- **Backend/tool identity and version:** `not observed` — no real run exposed an authoritative backend/model identity or ToolRuntime tool (`web_search` / `web_fetch`) identity/version.
- **Configured / requested / observed budgets:** `not observed` / `not applicable` — no real task; no maximum source count, time limit, or other budget was configured, requested, or observed.
- **Output reference / hash:** `NOT RUN` — no report, retrieved-body SHA-256, excerpt, or citation reference was produced by a real task.
- **Native readback and acceptance result:** `NOT RUN` — no native receipt readback, no scoped-memory save/readback, and no user acceptance of cited output occurred.
- **User interventions / consequential confirmations:** `not applicable` — no explicit save/acceptance boundary occurred.
- **Recovery observed:** `not observed` — no source-choice, ToolRuntime `ask`/`deny`, partial-coverage, or readback failure/recovery was observed in a real task.
- **Remaining limitations:**
  - Real-task acceptance remains **OPEN** until the user supplies/authorizes a concrete question and source scope and accepts a cited, user-authored output after exact readback.
  - The exact source revision, changed-file diff, and five-check results for this workflow are not recorded in-repo, so buildability cannot be re-verified from this record alone.
  - No tests, runtime app calls, live research, model calls, or external actions were run for this workflow.
