# Memory Phase 3 — Four sequential implementation parts

**Authority:** The accepted memory four-phase design and `2026-10-04-memory-phase-3-safe-capture.md` remain binding. This document changes execution boundaries, not their frozen contracts. User requested Phase 3 with the same Luna planning / DeepSeek v4.1 Flash OpenCode execution workflow.

**Baseline:** `af9299c6a8c6ef8a296302e712bbe745921319e7` on `codex/memory-deepseek-20261004`. Phases 1–2 source compiled; tests and runtime acceptance remain open. User authorized source advancement to Phase 3. Rust/Tauri App SQLite remains accepted memory authority.

## Scope and sequence

| Part | Deliverable | Parent coverage |
|---|---|---|
| 3.1 | Native additive persistence, exact admission, idempotent operations, atomic correction/forget/proposal acceptance and source suppression helpers | Tasks 1–2, native portions of 3–4; suppression persistence needed by 4 |
| 3.2 | Capability-only derived context invalidation, outbox draining, sanitized native prompt history, late-write barriers, all compatible mutation paths; expose safe commands | Task 5; command integration from 3–4 |
| 3.3 | Capture after direct SSE/native relay exits, same-turn assistant association, truthful bounded receipts, recovery of recorded instructions | Remaining Task 3 and lifecycle integration; consume 3.2 gates |
| 3.4 | Explicit objective continuity in native preparations and Bun TaskRuns, safe review/end compatibility, final source handoff | Task 6; continuity setter uses safe gates |

Each part receives a full plan written by Luna. DeepSeek executes these sequentially. Root reviews changed production source and requests corrections from the same executor. No implementation step may silently omit a parent requirement because it crosses part boundaries.

## Binding interfaces and invariants

Copy the parent Phase 3 exact DTOs, command table, helper signatures, deterministic grammar, scope rules, canonical operation hash, receipt replay semantics, source suppression consequence IDs, and objective modes verbatim into the appropriate plans. Preserve Phase 2 signatures and current actual source conventions. Internal factoring may support these contracts but cannot narrow lifecycle coverage or weaken admission.

- Only native saved user source can admit accepted factual knowledge. Generic verified observation remains unsupported; persisted assistant substring proposals stay excluded until exact later same-Session acceptance.
- Automatic capture reads immutable Phase 2 turn scope/message/hash. No arbitrary public Agent/project/provenance/outcome input. Null run and terminal IDs remain legitimate.
- One atomic savepoint covers each operation, audit, suppression, continuity effects and ledger. Exact retry returns persisted original result; conflicts fail without partial writes.
- Gate cleanup ACK precedes SQLite commit; unknown live owned Bun state fails closed, never kill healthy Bun to manufacture success. No HTTP under DB mutex or nested operation gate.
- Part 3.1 adds native primitives without enabling unsafe live callers before Part 3.2 installs derived cleanup. Suppression is mandatory for correction/forget already in 3.1. Part 3.2 must route legacy/manual mutations too.
- Suppress whole message when exact spans cannot be proven, preserve visible operator transcript, prevent late started-turn assistant/cache persistence from reviving facts. Persist cleanup outbox and watermark, drain before history/preparation.
- Part 3.3 extends existing whole-lifecycle finalizers. Preserve the original immutable Session/turn across switches, bounded waits, stale guards, and ordinary terminal/error delivery. UI status requires committed receipt. No assistant prose acknowledgement.
- Part 3.4 explicitly sets/replaces/clears/resumes objectives; ordinary questions/corrections/cancellation preserve them. Continuity is untrusted JSON data in the shared <=4000 Unicode scalar block, objective excerpt <=600. Zero selected memories still permits objective context. Bun private native envelope only; HTTP callers cannot forge it.
- Preserve independent TaskRun/tool/check evidence and permissions. No roadmap #2 scheduler features, Phase 4 control redesign or classification/revalidation work.
- Review/end retain compatibility but create zero memories/skills, never run old housekeeping, summary extraction, deferred review or consolidation. Recovery handles recorded turn capture.

## Validation authority

Current developer instruction prohibits adding or running tests unless the user asks. Do not edit test files, add test declarations, run tests, or substitute live/ephemeral acceptance experiments. Plans may document future regression scenarios as **NOT RUN / requires user request**. Use existing compiler/type/build and diff checks only. Parent test-driven steps are deferred, not satisfied.

Available source checks: `cargo check` in `src-tauri`; `bun run typecheck` and `bun run build` in `server-jarvis`; `bun run build` in `src-ui`; `git diff --check`. Use separate simple commands with proper tool workdir. Preserve preexisting dirty docs and generated schemas. No push, merge, deploy, credential/settings edits, global installs, broad staging. Per-part progress ledgers record actual source/check evidence and explicitly open tests/runtime gates.

## Handoff

After all four source parts, update canonical roadmap and Phase 3 source summary. Copy user-reviewable split, Luna plans and source progress summaries into this chat outputs. Priority #1 remains active; Phase 4 remains pending. Source compiled is not runtime accepted.
