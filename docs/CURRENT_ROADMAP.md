# Jarvis — Current Product Roadmap

**Established:** 2026-10-04\
**Status:** Accepted direction; implementation proceeds one priority at a time.\
**Current priority:** #3 — Prove that learning improves future work (source work and controlled roadmap evaluation explicitly authorized by the user on 2026-10-05; Priority #1 and #2 acceptance remain open).\
**Owner:** Ethan, with implementation tracked in this repository.\
**Canonical location:** `docs/CURRENT_ROADMAP.md`.

## Authority and purpose

This document is the current source of truth for Jarvis's development direction. It records the five priorities agreed on 2026-10-04 and supersedes older priority ordering in `AGENTS.md`, `PRIORITIES.md`, `docs/COMPLETION_BACKLOG.md`, and `docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md`. Those documents remain historical evidence and technical references. Their completion claims do not establish completion of this roadmap.

Jarvis should become a persistent local Agent platform that understands the user's projects, carries goals across days, completes useful work, and improves from verified experience. UI honesty, runtime verification, orchestration, and process reliability support these outcomes.

Preserve Jarvis's native architecture: Rust/Tauri Native surface, Bun server, canonical Tool runtime, React UI, SQLite, Agent lifecycle, and existing Permission policy. Use the terminology in `CONTEXT.md`.

## Sequence and completion rules

| Order | Priority | Status | Completion evidence |
|---|---|---|---|
| 1 | Make memory change how Jarvis behaves | Incomplete/open; Phases 1–4 source implemented; all runtime/test acceptance gates NOT RUN | Correct, scoped recall and capture in live turns; continuity across Sessions and restart |
| 2 | Connect goals, commitments, scheduling, and execution | Source plan complete; runtime acceptance open and deferred by explicit user direction | A goal progresses through approved execution, interruption, resumption, and verified delivery |
| 3 | Prove that learning improves future work | Active for source implementation and controlled evaluation by explicit user direction | Controlled comparisons show a reusable improvement on separate related tasks |
| 4 | Build complete workflows beyond coding | Queued until Priority #3 meets its completion criteria | Project stewardship, research, and recurring work produce usable outputs end to end |
| 5 | Measure local usefulness before expanding orchestration research | Queued behind #4 | Actual hardware measurements identify which changes improve accepted outcomes per resource spent |

1. Work on one numbered priority at a time, including its design, implementation, validation, and evidence record. The user may explicitly direct a sequence change; record the ruling and preserve all unfinished acceptance gates.
2. Advance only after the active priority's completion criteria have evidence, unless the user explicitly directs source work on another priority. Such direction does not close or satisfy the earlier priority: unfinished criteria remain open with their concrete blocker.
3. Supporting fixes belong to the active priority when they are necessary to deliver or validate it. Record that relationship explicitly.
4. Urgent regressions may interrupt the sequence; record the reason and return to the active priority afterward. Changes to the agreed ordering require Ethan's direction.
5. Distinguish source implementation, automated checks, live runtime behavior, and packaged behavior. State which was verified.
6. Keep maintenance automation aligned with this sequence. Commit counts, test counts, and a clean defect queue are supporting indicators; accepted user outcomes determine progress.

## 1. Make memory change how Jarvis behaves

### Current implementation checkpoint

Memory Phases 1–4 have compiled source checkpoints. Luna planned the four sequential source parts of Phases 2, 3, and 4 and performed source review and coordination; DeepSeek v4.1 Flash implemented every production source change through the OpenCode CLI. See the [Phase 2 handoff](implementation/memory-phase-2-summary.md), [Phase 3 handoff](implementation/memory-phase-3-summary.md), and [Phase 4 summary](implementation/memory-phase-4-summary.md). **Tests and runtime acceptance remain NOT RUN and all completion criteria remain open.** Priority #1 and #2 acceptance remain open. The user later explicitly directed Priority #3 source work and controlled evaluation before those acceptance gates; Priority #4 remains queued. Final Phase 4 source checkpoint: `2f6a226cf36ecd2aa351357b3fcb4ae7d7bafae5`; all five allowed checks passed and the final scoped review was clean.

### Intended outcome

The user explains a project once. Jarvis recalls its purpose, decisions, constraints, unresolved questions, and relevant corrections in later Sessions, survives a restart, and verifies facts that may have changed. The user can correct or remove remembered information.

### Starting evidence

The native memory engine already provides recall, events, deletion/restoration, Session summaries, and tier management. Bun also has durable, workspace-aware Session planning and context caches.

At the reviewed baseline, production callers were not found for native `build_turn_memory_context`, `load_relevant_memories`, or `run_post_turn_housekeeping`, or Bun `recallForMessage`. This is source evidence of a connection gap; it does not measure recall quality in the installed application.

Relevant source:

- `src-tauri/src/jarvis/memory/engine.rs`
- `src-tauri/src/jarvis/memory/mod.rs`
- `src-tauri/src/commands/memory.rs`
- `src-tauri/src/commands/jarvis_commands.rs`
- `src-tauri/src/jarvis/runner.rs`
- `server-jarvis/src/memory-recall.ts`
- `server-jarvis/src/orchestration/session-memory.ts`

### Work to deliver

- Establish one durable memory authority and explicit contracts for recall and capture across the Native surface and Bun server. Preserve the distinct role of the existing TaskRun and Session context cache.
- Carry Agent identity and project/workspace scope through those contracts. Project knowledge must not leak into unrelated projects or Agents; user-wide preferences need explicit scope.
- Integrate bounded, relevant recall into the live Session turn. Make the selected memory IDs and sources inspectable through existing diagnostics or memory events.
- Capture explicit remember/forget requests, accepted decisions, constraints, and useful corrections with provenance. Distinguish user statements, verified observations, and assistant proposals.
- Preserve the active objective when a user asks a side question or provides a correction. Keep Session continuity separate from durable project knowledge.
- Handle superseded, deleted, expired, and stale information predictably. Current workspace evidence takes precedence over remembered project facts.
- Keep ordinary turns usable if memory retrieval fails, while recording an observable failure. A failed memory write must not be reported as saved.

### Completion criteria

- [ ] A fact or constraint saved in one Session is recalled appropriately in a new Session for the same Agent and project.
- [ ] The same behavior survives a Bun server and Jarvis restart using persisted state.
- [ ] A second project and a second Agent do not receive the first project's private context.
- [ ] A correction supersedes the previous fact; forgetting removes it from subsequent recall and derived context.
- [ ] A changed workspace fact is rechecked and the newer evidence is used.
- [ ] Recall stays within a defined context budget and irrelevant memories are excluded.
- [ ] Memory failures, interrupted turns, and repeated terminal events have explicit, tested behavior without duplicate capture or false save claims.
- [ ] Direct and orchestrated inference paths used by the application receive the intended context; supported paths outside the initial integration are explicitly identified.
- [ ] A live continuity demonstration and focused regression checks record the source revision, inference backend, scenario, selected memories, and observed result.

### First implementation slice

Implement phase 1's scoped store, additive migrations, provenance, and manual APIs first. Phase 2 connects that authority to both the UI's direct Bun `/chat/stream` transport and the native `jarvis_send_message` / `run_jarvis_message` relay; phase 3 adds capture and continuity.

Do not wire the current housekeeping helper wholesale without reviewing its side effects: it also applies skill improvements and consolidation. Keep skill promotion governed by #3. Embeddings, a knowledge graph, external cold storage, and a redesigned memory UI are optional follow-ups only if the active acceptance cases demonstrate a need.

### Four implementation phases

Priority #1 is divided into four sequential phases. The [phase design](superpowers/specs/2026-10-04-memory-four-phase-design.md) defines their shared architecture, interfaces, and acceptance scenarios. The four parent plans and Luna's sequential subplans define the implementation. Phases 1–4 have reviewed source checkpoints; all runtime acceptance remains pending.

| Phase | Deliverable | Implementation plan |
|---|---|---|
| 1 | Scoped memory authority, persistence, provenance, and manual APIs | [Scoped foundation](superpowers/plans/2026-10-04-memory-phase-1-scoped-foundation.md) |
| 2 | Bounded recall through actual UI and native inference paths | [Live recall](superpowers/plans/2026-10-04-memory-phase-2-live-recall.md) |
| 3 | Idempotent capture, accepted correction, forgetting, and objective continuity | [Safe capture](superpowers/plans/2026-10-04-memory-phase-3-safe-capture.md) |
| 4 | User controls, stale-context handling, and cross-Session/restart proof | [Continuity and controls](superpowers/plans/2026-10-04-memory-phase-4-continuity-controls.md) |

**Phase 4 source checkpoint (Part 4.4, final source SHA `2f6a226cf36ecd2aa351357b3fcb4ae7d7bafae5`):** native classification and operator controls (4.1), persisted Session Agent/project identity and bound-workspace resolution (4.2), conservative fresh-source revalidation receipts (4.3), and turn-status/continuity UI plus closure (4.4) are implemented in source. All five permitted compiler/type/build checks passed against the exact source SHA, and final fresh source review was clean. **NOT RUN:** tests, fixtures, scripted provider, live inference, cross-Session/restart, packaging, installation, and acceptance scenarios. Source compilation is not runtime proof; priority #1 remains incomplete/open and no runtime-complete claim is made.

Priority #1 source Phases 1–4 are implemented, but #1 remains incomplete: tests and live/runtime/restart acceptance are NOT RUN and every completion criterion remains open. On 2026-10-05 the user first directed source work to begin on Priority #2 while that acceptance remained outstanding, then explicitly directed Priority #3 source work and controlled evaluation before Priority #1/#2 acceptance. These sequence overrides do not claim either priority complete or accepted. Priority #3 is active; Priorities #4–#5 remain queued.

## 2. Connect goals, commitments, scheduling, and execution

### Intended outcome

The user assigns a goal with acceptance criteria. Jarvis owns its progress, works within permissions and resource limits, resumes after interruption, and delivers evidence or a specific blocker.

### Starting evidence

Durable TaskPlans, cron execution, approvals, commitments, and an action registry exist. Commitments currently support manual CRUD. At the reviewed baseline, eligible native action dispatch returns `unavailable` / `verification_manifest_missing`.

### Work to deliver

- Link a durable goal to its TaskPlan, commitments, scheduled activations, runs, and output evidence.
- Define states for pending, running, waiting for user input, blocked, paused, completed, failed, and cancelled work.
- Complete approved action execution with a trusted acceptance manifest and verified completion.
- Preserve checkpoints across restart; make retry and scheduling behavior safe against duplicate effects.
- Apply Permission policy, cancellation, and resource bounds to unattended work.
- Notify on meaningful progress, completion, failure, or required user action according to the user's preferences.

### Current implementation checkpoint

Priority #2 source work was explicitly authorized by the user on 2026-10-05 while Priority #1 acceptance remains incomplete/open. Luna authored four sequential plans and reviewed source; DeepSeek v4.1 Flash is the sole production source executor through the OpenCode CLI. This direction changes source sequencing only. Priority #2 has no runtime or real-goal acceptance evidence yet. See the [Priority 2 status record](implementation/roadmap-priority-2-status.md), [Part 1 source evidence](implementation/roadmap-priority-2-part-1-progress.md), and [Part 2 source evidence](implementation/roadmap-priority-2-part-2-progress.md).

**Part 1 source checkpoint (commit `7bf50fafe01f785252874ccb09ad8de23d4a6a45`):** the durable native Goal authority and its additive association contracts are implemented in source — an additive SQLite migration (`goals`, `goal_criteria`, `goal_events`, `goal_links`, plus nullable `goal_id` columns on `session_runs`/`cron_jobs`/`cron_runs`), native create/read/list/update/transition/link commands with validated identities and lifecycle transitions, and a Goal view. Scope attribution is validated against native authorities (enabled Agent row, canonicalized project root), links resolve through each target's authoritative store (cron/run in SQLite, commitment in its native JSON store) with unwired kinds rejected, and the Goal view discards stale detail reads and guards duplicate transitions. All five allowed compiler/type/build/diff checks passed against the exact committed source SHA; details are in the status record. **NOT RUN:** tests, fixtures, live execution, real-goal acceptance, restart/interruption, packaging, and installation. This is source progress only: Priority #1 remains incomplete/open and Priority #2 runtime acceptance remains open.

**Part 2 source checkpoint (commit `1157cc6fff5dd8fb09ae9af007e681ec01f2dc19`):** native Goal run preparation binds Goal, Agent/workspace, Session, turn, exact persisted user source-row ID and body hash, and a stable TaskRun identity. Direct UI and native relay carry the same source ID; Bun consumes the private registration once only when the request's Session/turn/source ID and actual body hash match. Native terminal recording checks the consumed receipt and checkpoint state remains resumable; Goal-linked checkpoints expose authorized references while final accepted-output evidence is pending Part 4. All five allowed compiler/type/build/diff checks passed against the exact source SHA. **NOT RUN:** tests, live execution, restart/interruption demonstration, real-goal acceptance, packaging, or installation. Priority #1 remains incomplete/open and Priority #2 runtime acceptance remains open.

**Part 3 source checkpoints (not complete):** Commitment association checkpoint `5b1d6211b879ec80a4ee620d05687a7f47b26e9a` gives the native Commitment JSON record authoritative Goal ownership and reconciles Goal detail reads; cron activation checkpoint `0baf5b4f4cec6102397bde2553a635e2dde3de73` adds Goal-linked cron CRUD, unique deterministic occurrence claims, startup ambiguity reconciliation, and run attribution; cancellation/resource/notification commits (`425d70d`, `1b0e278`, `d916710`, `f301be3`, `2506bc0`) propagate in-flight cancellation with terminal reasons, enforce the Agent lifecycle/projection boundary and resource gates on activation/resume, and emit preference-aware notifications. The UI-slice checkpoints `f655346437071e98a75c14a779f750113efff2ba` (initial), `5e085baf8450dc1467cf1e3ceaf945d934037ef9` (honesty/usability corrections), `015772e52e0279c53680630cd40a54939cb85e74` (per-operation evidence-gated reconciliation), `2b226db1e9989445a1c10465ec6f5bf39430f3fd` (effect-aware reconciliation), and `cf7234e24f65bbbed69ddb844d72cfc3e819c3ce` (neutral pending status copy) add the Goal-detail links/views for Goal-linked Commitments, cron schedules, durable activations and run history, and actionable `waiting_for_user`/`blocked`/`ambiguous` reasons. Schedule controls use only existing native durable APIs — pause/resume (`disable_cron_job`/`enable_cron_job`), cancel (`cancel_cron_job`, in-flight only), and a manual `run_cron_job` labeled as a new occurrence (never `trigger_missed` relabeled). Every mutation is guarded against duplicates and confirmed by authoritative native readback before the UI reports success; a mutation that succeeds but cannot be read back is shown as uncertain without optimistic display, and completion is never inferred from a run or submission (Part 4 gate preserved). A failed or malformed (non-array) `get_commitments`, `list_cron_jobs`, or `get_in_flight_cron_jobs` read is treated as unavailable, never as an authoritative empty list, so no "none linked" state or stale actionable control is shown while the authority is unreadable; a read-only Refresh/Reconcile action re-reads the authoritative schedule + activation/run state but clears a pending operation only when the observed state shows that operation's own requested effect — pause/resume require the expected enabled value, run requires newly observed activation/run evidence beyond the baseline captured at submission (or after the submission time when the baseline was unreadable), and cancel requires the tracked in-flight execution to be absent with history still readable — and never re-submits the mutation or treats missing history as confirmation. Unlinked consumers and permissions are unchanged. All five permitted checks passed on each previously committed native checkpoint SHA; the in-flight schedule status is neutral pending copy ("Submitting and confirming the authoritative schedule state…") that does not imply native acceptance before the command returns. The five allowed checks were run by the coordinator against the final UI source SHA `cf7234e24f65bbbed69ddb844d72cfc3e819c3ce`: Rust `cargo check` PASS (two unrelated existing warnings — deprecated `Atomic` fetch_update and unused `shlex_join`); server `bun run typecheck` PASS; server `bun run build` PASS; UI `bun run build` PASS (existing >500 kB chunk advisory); and `git diff --check` from `2506bc0adadddec0c9ea4293368caea880a01a36` to `acfd3ee200fd645f6e3f9d523eb970e0ccf39ce2` PASS. Tests and runtime acceptance remain **NOT RUN/open**. **Remaining:** all runtime/restart/missed-run/cancellation/acceptance evidence. Details are in the [Priority 2 status record](implementation/roadmap-priority-2-status.md). Priority #1 remains incomplete/open; Priority #2 runtime acceptance remains open.

### Sequential implementation parts

| Part | Deliverable | Plan |
|---|---|---|
| 1 | Durable Goal authority and association contracts | [Goal authority](superpowers/plans/2026-10-05-roadmap-priority-2-part-1-goal-authority.md) |
| 2 | Goal-linked TaskRun, native run evidence, checkpoints, and recovery | [Execution and recovery](superpowers/plans/2026-10-05-roadmap-priority-2-part-2-execution-recovery.md) |
| 3 | Goal-linked commitments, scheduling, cancellation, resource gates, and notifications | [Commitments and scheduling](superpowers/plans/2026-10-05-roadmap-priority-2-part-3-commitments-scheduling.md) |
| 4 | Trusted acceptance-manifest execution and verified delivery evidence | [Trusted delivery](superpowers/plans/2026-10-05-roadmap-priority-2-part-4-trusted-delivery.md) |

**Part 4 trust source decision:** trusted acceptance manifests will live in a distinct native SQLite table in app-owned `jarvis.db` under Tauri `app_data_dir`, bound to exact Agent ID and canonical project root, with stable ID, version, and canonical content hash. Users explicitly manage manifest add/replace/remove through Settings; no executable manifests are auto-seeded. Goal, model, task, and Action Registry content can reference a manifest ID but cannot provide trust or manifest content. The file-backed Action Registry remains untrusted. Native dispatch revalidates scope and still enforces the current canonical ToolRuntime Permission policy. This is source scope only; tests, live action execution, restart demonstrations, and all Priority #2 acceptance criteria remain NOT RUN/open.

**Part 4 slice 1 source checkpoints (`731417b0af66547a1be5bc37b293a97601ead0fb`, `ebc9f3d3103e8ee8c4243d820f122a0cd3a9e390`, `82aa16a37b07410ee098f72b158414f8bbcc68a1`):** the native trust registry and its explicit Settings management surface are implemented in source — additive `trusted_acceptance_manifests` table in the app-owned `jarvis.db`, native list/create/replace/remove commands with stable UUID IDs, incrementing registry version, schema version, canonical content SHA-256, exact enabled-Agent and canonical workspace scope, a single bound Action Registry `action_id` (opaque identity; uniqueness per canonical root + action id; legacy rows stay unbound until explicitly replaced), and optimistic expected-version-or-hash guards, plus strict bounded v1 content validation (distinct execution and acceptance allowlists: `execution` may use read tools plus the minimal bounded writers `write_file`/`edit_file` with workspace-relative paths and bounded UTF-8 payloads, while `acceptance` stays deterministic read-only; unknown keys, shell tools/commands, `apply_patch`/`multi_edit`, web tools, scripts, templates, and unbounded content rejected). Create/replace resolve the action id against one active open/in_progress item satisfying the existing approval condition; missing/ambiguous/unapproved metadata is rejected rather than inferred, and Goal/model text may select a manifest ID only. The management panel lives in the mounted `JarvisView` ConfigPanel (not the unmounted `SettingsView`) and requires explicit add/replace/remove with the action id and authoritative readback; registration grants no permission and performs no execution — later execution must use the canonical ToolRuntime under current Agent/Permission policy and persists `blocked`/`waiting` on denial or approval rather than dispatching. **NOT RUN:** tests, live execution, dispatch/acceptance evidence, restart/interruption acceptance, packaging, installation, and all Priority #2 acceptance criteria; the five allowed checks have not been run by the source executor against these SHAs.

**Part 4 source checkpoint:** all four planned source slices are complete through `200e4e190b9a6c5f1c25ca41743e46a5251603d8`. The source chain runs from the Part 3 UI checkpoint `cf7234e24f65bbbed69ddb844d72cfc3e819c3ce`, through native manifest/Settings, dispatch, acceptance, cancellation, and operation UI commits ending at `ff4aa1750b36c7172b47156b28b40e58b3ec8147`, followed by acceptance-evidence UI commit `adb823cea6ada338b3b827d6e5a33008e3b83bf0` and strict receipt binding/readback commit `200e4e190b9a6c5f1c25ca41743e46a5251603d8`. The Goal/Action Registry UI invokes native trusted acceptance only for exact pending-acceptance executions, decodes receipts strictly, binds the Goal/root/manifest/action/execution tuple, compares command and persisted receipt payloads, and shows accepted/completed only after confirmed evidence and exact readback. Cargo check, server typecheck, server build, UI build, and diff-check all PASS at the exact final SHA; see `work/opencode-memory/part4-acceptance-ui-final-200e4e1-checks.json`. No planned Part 4 source work remains. **NOT RUN / open:** tests, live action dispatch, trusted acceptance execution, real-goal delivery, interruption/restart acceptance, packaging, installation, and every Priority #2 completion criterion. Priority #2 is not complete or runtime-accepted.

All parts are source implementation plans. Tests, live execution, restart/interruption demonstrations, and all Priority #2 completion criteria remain NOT RUN/open.

### Completion criteria

- [ ] One real goal reaches accepted delivery through the connected runtime.
- [ ] A restart or interruption resumes from recorded progress without repeating completed effects.
- [ ] Missing approval or a blocker produces a specific waiting state and a usable request for the user.
- [ ] Cancelled or failed work remains distinguishable from completed work.
- [ ] Completion references acceptance evidence and a reviewable output.

## 3. Prove that learning improves future work

**Sequence override — 2026-10-05:** At the user's explicit direction, Priority #3 source work and the roadmap's controlled evaluation are active before Priority #1 or #2 runtime acceptance is complete. Priority #1 and Priority #2 acceptance remain **open/NOT RUN**; this direction does not waive or satisfy those gates. Priority #4 remains queued until Priority #3 has its required independent controlled-transfer evidence. The full Luna plan is [Priority 3 learning effectiveness](superpowers/plans/2026-10-05-roadmap-priority-3-learning-effectiveness.md).

### Intended outcome

Experience produces reusable improvements that help Jarvis complete separate, related tasks with better quality or less time and intervention.

### Starting evidence

Trajectory storage, skill distillation, source-grounded promotion, performance windows, policy staging, rollout fixtures, and CMA-ES machinery exist. Source grounding establishes support for guidance. Before/after success windows alone cannot isolate the skill's contribution.

### Work to deliver

- Evaluate candidate skills, reusable memories, and policy changes with controlled baseline/candidate comparisons.
- Keep inference backend, task conditions, and resource budgets comparable; record variability and sample counts.
- Use separate related tasks to measure transfer and guard against fitting the source experience.
- Measure accepted correctness, latency, tool failures, resource consumption, and user intervention.
- Preserve source-grounding checks, independent acceptance evidence, staging, and rollback.
- Implement real research findings where the current native learning command returns placeholders, when required by these outcomes.

### Completion criteria

- [ ] At least one reusable improvement demonstrates benefit on separate related tasks.
- [ ] A harmful or ineffective candidate is rejected or rolled back using observed outcomes.
- [ ] Results identify the baseline, candidate, tasks, resource budget, sample count, and limitations.
- [ ] Evaluation and promotion cannot silently alter their own acceptance criteria.

## 4. Build complete workflows beyond coding

### Intended outcome

Jarvis performs useful daily work across the user's projects and information, with usable artifacts and a clear handoff.

### Initial workflows

1. **Project steward:** Understand a repository, retain decisions, diagnose a real issue, make a controlled change, and deliver a reviewable diff with checks.
2. **Researcher:** Gather attributable sources, produce a useful report, retain accepted conclusions, and revisit them when evidence changes.
3. **Recurring operator:** Follow through on an assigned commitment, produce the requested outcome, and escalate a concrete blocker when needed.

### Work to deliver

- Exercise the shared memory, goal, execution, and learning capabilities through those workflows.
- Add browser capabilities, MCP connections, document tools, or external integrations when a selected workflow requires them.
- Make permissions, artifact review, approval, and final delivery understandable to the user.
- Prove onboarding for the required capabilities and failure recovery within each workflow.

### Completion criteria

- [ ] Each initial workflow completes a real user task with an accepted artifact or observable result.
- [ ] The user can inspect the evidence and approve consequential external actions at the appropriate boundary.
- [ ] Missing credentials, tools, sources, or permissions produce actionable recovery paths.
- [ ] A week-long project stewardship demonstration records continuity, accepted tasks, restart recovery, and blocker handling.

## 5. Measure local usefulness before expanding orchestration research

### Intended outcome

Jarvis's local operation delivers measured value on the user's actual hardware. Further orchestration investment follows evidence about where performance is constrained.

### Work to deliver

- Benchmark the application's actual configured inference paths, including llama.cpp and Ollama where used.
- Compare a direct Agent loop, the current orchestration pipeline, and memory/tool improvements on the same representative tasks and comparable budgets.
- Measure accepted completion rate, time to useful output, human intervention, memory usage, and resource cost per accepted outcome.
- Record hardware, model artifact, runtime configuration, warm/cold conditions, and source revision.
- Improve local setup and capability diagnostics based on observed failures.
- Keep learned orchestration research bounded by a stated hypothesis, held-out results, and calibration/regression gates.

### Completion criteria

- [ ] A reproducible hardware baseline covers the selected daily workflows.
- [ ] Comparative results identify the contribution of inference backend, context, tools, and coordination.
- [ ] At least one measured bottleneck is improved without weakening acceptance or Permission policy.
- [ ] Any expanded optimization campaign has a functioning live rollout, independent acceptance evidence, and demonstrated held-out benefit.

## Evidence and status maintenance

For the active priority, maintain a dated evidence record with: source revision, changed behavior, focused checks, live scenario results, remaining gaps, and completion decision. Update the status table and checkboxes when evidence changes.

Track accepted outcomes, user intervention, repeated context the user must supply, time to useful output, and resource cost. Preserve the existing reliability and completion-integrity checks as guardrails.

### Baseline and preparation record — 2026-10-04

- Reviewed source: `1cb1ce6947edd84154c326fc19d0fbf9e71e0e2e` on `master`.
- This roadmap records source findings and accepted direction; no new live capability is claimed.
- #1 entry points and existing memory helpers have been inspected. Implementation has not started.
- Bun is available in this workspace. Cargo was not found on the current shell PATH; establish the native Rust toolchain before validating Rust changes.
- Historical July/August reports remain historical measurements. New completion evidence must come from the implementation being delivered.
