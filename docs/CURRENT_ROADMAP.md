# Jarvis — Current Product Roadmap

**Established:** 2026-10-04\
**Status:** Accepted direction; implementation proceeds one priority at a time.\
**Current priority:** #1 — Make memory change how Jarvis behaves.\
**Owner:** Ethan, with implementation tracked in this repository.\
**Canonical location:** `docs/CURRENT_ROADMAP.md`.

## Authority and purpose

This document is the current source of truth for Jarvis's development direction. It records the five priorities agreed on 2026-10-04 and supersedes older priority ordering in `AGENTS.md`, `PRIORITIES.md`, `docs/COMPLETION_BACKLOG.md`, and `docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md`. Those documents remain historical evidence and technical references. Their completion claims do not establish completion of this roadmap.

Jarvis should become a persistent local Agent platform that understands the user's projects, carries goals across days, completes useful work, and improves from verified experience. UI honesty, runtime verification, orchestration, and process reliability support these outcomes.

Preserve Jarvis's native architecture: Rust/Tauri Native surface, Bun server, canonical Tool runtime, React UI, SQLite, Agent lifecycle, and existing Permission policy. Use the terminology in `CONTEXT.md`.

## Sequence and completion rules

| Order | Priority | Status | Completion evidence |
|---|---|---|---|
| 1 | Make memory change how Jarvis behaves | Active; Phases 1–2 source implemented; runtime gates open; Phases 3–4 pending | Correct, scoped recall and capture in live turns; continuity across Sessions and restart |
| 2 | Connect goals, commitments, scheduling, and execution | Queued behind #1 | A goal progresses through approved execution, interruption, resumption, and verified delivery |
| 3 | Prove that learning improves future work | Queued behind #2 | Controlled comparisons show a reusable improvement on separate related tasks |
| 4 | Build complete workflows beyond coding | Queued behind #3 | Project stewardship, research, and recurring work produce usable outputs end to end |
| 5 | Measure local usefulness before expanding orchestration research | Queued behind #4 | Actual hardware measurements identify which changes improve accepted outcomes per resource spent |

1. Work on one numbered priority at a time, including its design, implementation, validation, and evidence record.
2. Advance only after the active priority's completion criteria have evidence. An unfinished criterion remains open with its concrete blocker.
3. Supporting fixes belong to the active priority when they are necessary to deliver or validate it. Record that relationship explicitly.
4. Urgent regressions may interrupt the sequence; record the reason and return to the active priority afterward. Changes to the agreed ordering require Ethan's direction.
5. Distinguish source implementation, automated checks, live runtime behavior, and packaged behavior. State which was verified.
6. Keep maintenance automation aligned with this sequence. Commit counts, test counts, and a clean defect queue are supporting indicators; accepted user outcomes determine progress.

## 1. Make memory change how Jarvis behaves

### Current implementation checkpoint

Memory Phases 1 and 2 have compiled source checkpoints. Phase 2 was divided into four sequential subphases planned by Luna and implemented through DeepSeek v4.1 Flash on OpenCode. The [Phase 2 source handoff](implementation/memory-phase-2-summary.md) records the source revision, plans, ledgers and checks. Tests/live acceptance remain NOT RUN; the completion criteria below remain open. Memory Phases 3–4 and roadmap priorities #2–#5 have not started.

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

Priority #1 is divided into four sequential phases. The [phase design](superpowers/specs/2026-10-04-memory-four-phase-design.md) defines their shared architecture, interfaces, and acceptance scenarios. A separate planning agent has drafted each full implementation plan; implementation and runtime validation remain pending.

| Phase | Deliverable | Implementation plan |
|---|---|---|
| 1 | Scoped memory authority, persistence, provenance, and manual APIs | [Scoped foundation](superpowers/plans/2026-10-04-memory-phase-1-scoped-foundation.md) |
| 2 | Bounded recall through actual UI and native inference paths | [Live recall](superpowers/plans/2026-10-04-memory-phase-2-live-recall.md) |
| 3 | Idempotent capture, accepted correction, forgetting, and objective continuity | [Safe capture](superpowers/plans/2026-10-04-memory-phase-3-safe-capture.md) |
| 4 | User controls, stale-context handling, and cross-Session/restart proof | [Continuity and controls](superpowers/plans/2026-10-04-memory-phase-4-continuity-controls.md) |

Finish and verify each phase before implementing the next. Completing these phases completes priority #1 only; priorities #2–#5 retain their separate gates.

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

### Completion criteria

- [ ] One real goal reaches accepted delivery through the connected runtime.
- [ ] A restart or interruption resumes from recorded progress without repeating completed effects.
- [ ] Missing approval or a blocker produces a specific waiting state and a usable request for the user.
- [ ] Cancelled or failed work remains distinguishable from completed work.
- [ ] Completion references acceptance evidence and a reviewable output.

## 3. Prove that learning improves future work

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
