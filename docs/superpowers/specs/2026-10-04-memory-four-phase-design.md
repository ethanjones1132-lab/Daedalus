# Priority #1 — Memory in Four Phases

**Date:** 2026-10-04\
**Status:** Planning complete: four plans written by separate agents and reviewed for shared contracts. Phases 1–2 source implemented; test/live acceptance open; Phases 3–4 source pending.\
**Parent source of truth:** `docs/CURRENT_ROADMAP.md`, priority #1.\
**Scope:** Only priority #1. Roadmap priorities #2–#5 remain queued.

## Purpose

Jarvis must remember accepted project knowledge and user corrections, use relevant information in live Session turns, and maintain continuity across Sessions and restart. The user must be able to inspect, correct, and forget that knowledge. Current workspace evidence takes precedence over stale memory.

Deliver this in exactly four sequential implementation phases. Each phase gets a separate complete implementation plan written by a separate planning agent. Planning may overlap after shared interfaces are fixed; implementation remains sequential.

## Phase boundaries

| Phase | Deliverable | Depends on | Completion gate |
|---|---|---|---|
| 1. Scoped memory foundation | One durable memory authority, explicit Agent/project scope, additive migrations, provenance, and scoped manual APIs | Existing native memory and Session stores | Isolation, legacy migration, scope validation, and lifecycle filtering pass focused checks |
| 2. Memory in live turns | Bounded scoped recall reaches the actual UI SSE path, native relay, and supported direct/orchestrated inference paths | Phase 1 scope/store contracts | Identical intended memory reaches supported paths; failures degrade observably; recalled data never grants permissions |
| 3. Safe capture and correction | Durable explicit memory capture, decisions/corrections, forgetting, and Session continuity tied to a unique turn lifecycle | Phase 1 scope/store plus Phase 2 turn identity | Capture is idempotent and transactional; interruption behavior is defined; no skill promotion is activated |
| 4. Continuity and user control | Operator controls, stale-context handling, regression scenarios, and real restart/cross-Session acceptance evidence | Phases 1–3 | Every priority #1 acceptance criterion has implementation evidence and the required live demonstration |

Each phase owns meaningful product behavior and its focused tests. Phase 4 integrates and proves the overall experience; it does not defer the earlier phases' unit or integration checks.

## Architecture requirements

- Rust/Tauri's native memory engine and App SQLite database remain the durable memory authority. Bun consumes bounded recall context and retains its distinct TaskRun/tool-context cache; it must not introduce a second writable durable memory store.
- Agent identity comes from the persisted Session/Agent relationship. Project scope is an explicit, validated workspace binding. Scope selection is separate from filesystem authorization.
- Existing unscoped records are preserved by additive migration. They do not become automatically shared across projects or Agents. Make any rescoping deliberate and inspectable.
- User-wide knowledge is explicitly scoped; sharing across Agents is an explicit policy, never a wildcard fallback.
- Filter Agent/project scope, status, expiry, and tier before ranking/limiting recalled entries. Otherwise unrelated rows can displace valid candidates or leak content.
- Recalled text is data, not authority. It cannot grant filesystem access, change Permission policy, or activate prompt deltas or skills.
- Preserve current FTS-based retrieval for the first slice. Add semantic retrieval only if the acceptance scenarios establish a need.
- Bound the generated memory context, preserve Unicode, and carry selected memory IDs, provenance, and store revision for diagnostics and invalidation.
- Define one unique turn identity shared by UI, Native surface, Bun stream, and capture receipts. Do not assume a model run ID exists for every direct answer or failed turn.
- Memory capture must distinguish explicit user facts, accepted decisions/corrections, verified observations, and assistant proposals. Assistant prose alone cannot become an accepted durable fact.
- Distinguish normative user constraints from descriptive workspace facts. Fresh source can invalidate a remembered observation; it must not silently override an accepted user requirement.
- Retrieval failures permit an ordinary turn with an observable memory status. Write failures cannot produce a confirmed save receipt.
- Deletion and correction affect the next turn immediately. Do not reuse a persisted or compaction-pinned memory block after its source is invalidated.
- Keep the existing native housekeeping helper's skill mutation, prompt deltas, and unrelated learning behaviors outside this priority.

## Verified integration seams

At baseline `1cb1ce6947edd84154c326fc19d0fbf9e71e0e2e`:

- `src-ui/src/components/jarvis/JarvisView.tsx` directly fetches Bun `/chat/stream` in `streamFromJarvisApi`. A plan that wires only `jarvis_send_message` misses the main UI transport.
- `src-tauri/src/commands/jarvis_commands.rs::jarvis_send_message` also supplies a native relay through `src-tauri/src/jarvis/runner.rs::run_jarvis_message`.
- Native Session persistence is in `src-tauri/src/commands/sessions.rs`; Bun owns inference and orchestration.
- Memory CRUD is in `src-tauri/src/commands/memory.rs`; recall/capture primitives exist in `src-tauri/src/jarvis/memory/engine.rs`.
- Native pre-turn and post-turn memory helpers and Bun `memory-recall.ts` have no production callers found during the source review.
- Bun's `orchestration/session-memory.ts` already persists TaskRun and scoped tool context. Preserve those responsibilities.

The plans must identify exact supported surfaces and explicitly report a memory-unavailable status for surfaces outside the integrated native authority. Do not advertise unsupported HTTP-only/cron/Agent/MCP paths as memory-enabled.

## Shared contract decisions

Phase 1 owns the exact Rust definitions and scoped command signatures in its implementation plan. Later plans consume those definitions rather than inventing competing representations:

The [Phase 1 frozen contracts](../plans/2026-10-04-memory-phase-1-scoped-foundation.md#cross-phase-interfaces-frozen-store-and-wire-contracts) are authoritative for store DTOs/signatures. Phase 2 owns its prepared-turn transport contract; Phase 3 owns its capture contract. A later plan consumes earlier definitions and records any necessary additive extension explicitly.

- `MemoryScope`: `kind` (`project`, `agent`, `user`, or `legacy_unscoped`), `agent_id`, and nullable `project_root`.
- Project scope belongs to one Agent and one canonical existing workspace directory. Agent scope belongs to one Agent without a project. Explicit user scope uses an empty stored Agent ID and no project; recall includes it only when the operator has explicitly opted in. Legacy scope is excluded from automatic recall.
- `ScopeSelector` chooses `project`, `agent`, or `user`; native scope resolution uses a persisted Session ID, never a caller-provided Agent identity.
- Add nullable `sessions.project_root`; add scope, authority, provenance, and per-entry revision fields to existing memory rows. Preserve existing data and lifecycle fields.
- `ScopedMemoryEntry` wraps the existing `MemoryEntry` with scope, authority, verification provenance, and revision. `ScopedMemoryRecall` includes that entry, score, matched terms, and stale status.
- `MutationResult` returns the resulting scoped entry, `store_revision`, and whether the mutation changed state. A singleton native store revision changes transactionally with knowledge/scope/eligibility mutations; recall usage counters alone must not invalidate the store.
- Phase 1 defines `MemoryDraft`, `MemoryProvenance`, `RecallOptions`, typed errors, and the exact signatures of scoped save/read/list/update/delete/restore/preview/adoption and Session workspace binding.
- Manual APIs force manual authority. Automatic capture later distinguishes `user_statement`, `verified_observation`, and `assistant_proposal`; proposals and `legacy_unknown` entries are excluded from automatic recall. Verification provenance must be validated, never inferred from assistant prose.

### Phase 2 transport decision

The Native surface prepares and registers memory context with Bun using a private internal endpoint and a random app-lifetime capability passed to the owned Bun process. The UI receives an opaque preparation ID and a stable turn ID, then references them in `/chat/stream`. Native relay uses the same preparation path. Bun owns an ephemeral registry only; it does not read or mutate the app memory database.

The native entry point is `memory_prepare_turn({request:{session_id,turn_id,user_message_id,include_user_scope:false}}) -> MemoryTurnPreparation`. The user message must already exist in native Session persistence; Native loads its content and ownership. `memory_sync_turn({request:{session_id,turn_id}}) -> MemoryTurnDiagnostic` synchronizes authenticated runtime diagnostics. `read_memory_turn(conn, session_id, turn_id) -> PersistedMemoryTurn` is the Phase 3 source/provenance handoff. Phase 2 defines the exact DTOs and error behavior in its plan.

`memory_turn_history` supplies native prompt history before the exact persisted source row to both transports. Keep operator-visible Session history separate. Diagnostics preserve prepared `selected` metadata and a non-null `applied_selected_ids` list from authenticated runtime observations; only the latter identifies memory actually included in inference. An empty applied list is valid. Per-call `memory_applied` frames distinguish stage, retry, and provider-budget differences.

Private Bun transport paths are `POST /internal/memory/preparations`, `POST /internal/memory/invalidate`, `GET /internal/memory/turns/{preparation_id}`, and `POST /internal/memory/turns/{preparation_id}/ack`. Use `JARVIS_NATIVE_MEMORY_CAPABILITY` and `JARVIS_NATIVE_APP_INSTANCE_ID` only within Native/owned Bun startup. Remove those variables from Bun's environment after bootstrap so Tool runtime and inference child processes cannot inherit them. A per-launch Bun instance ID disambiguates restart receipts.

Phase 2 owns the exact prepared-turn envelope, native preparation record, internal registration/invalidation endpoints, single-consumption registry, context integration, and restart behavior. Bind each preparation to its Session, turn identity, exact UTF-8 message hash, effective workspace, selected memory IDs, and store revision. Protect the internal endpoint and never expose its capability through UI, logs, prompts, or health responses. An independently started Bun server without that capability reports memory unavailable.

Recall limits are at most five entries, 4,000 Unicode scalar values for the full memory block including framing, and 600 scalar values per item. The complete block must also fit the existing model context budget; omit lowest-ranked items if necessary. Unconsumed preparations expire after 120 seconds; consumption begins the turn and does not impose a new inference deadline.

Do not persist recalled blocks in chat history, compaction summaries, TaskRun discovered facts, or reusable tool caches. Each new turn prepares fresh context. Invalidate outstanding unconsumed preparations before committing a relevant mutation. Already-started turns retain their snapshot; the following turn reflects the mutation. Registering a preparation does not grant workspace access.

Within the shared native operation gate, invalidate outstanding preparations before committing a memory or binding mutation. If a current registry cannot acknowledge invalidation, return an observable typed failure without committing. A confirmed exited/replaced owned Bun process has lost its registry and does not block mutation. Do not automatically stop a healthy Bun process to complete an invalidation. Bun's actual effective workspace must match project-bound preparation scope; a mismatch permits inference without memory, records `scope_mismatch`, and requires explicit rebinding plus fresh preparation.

### Phase 3 capture decision

Phase 3 owns native capture receipts and commit contracts tied to the Phase 2 persisted preparation/turn identity. Use the recorded user message and source message IDs as provenance. Explicit user instructions can be committed independently of inference success; assistant proposals require explicit acceptance, and verified observations require authoritative runtime evidence. Define separate behavior for completed, partial, cancelled, failed, and unterminated streams.

Capture and correction are transactional and idempotent. Replay with the same turn/operation identity and payload is a no-op returning the prior receipt; a conflicting replay is rejected. Correction creates a replacement with `supersedes_id` pointing to the old row and tombstones the old row atomically. Forgetting and mutations invoke Phase 2 invalidation. Native Session continuity stores the active objective separately from side-question text and never promotes assistant output to accepted project knowledge by default.

The native UI contracts are `memory_capture_turn`, `memory_capture_receipts`, `memory_scoped_correct`, and `memory_scoped_forget`, using the Phase 3 plan's request/receipt definitions. No caller can supply Agent ownership, verification authority, or trusted provenance. Generic automatic `verified_observation` capture is unsupported in this priority until attributable authoritative evidence exists; a model success claim or native Session run success alone is insufficient. User-approved facts use `user_statement` authority.

Prompt assembly must also respect forgetting for original memory-bearing source messages and derived summaries. Retain the operator-visible transcript, but exclude or neutrally replace forgotten source spans in future model context. Do not reintroduce them through old compaction or continuation summaries.

Phase 3 adds `memory_turn_messages` and optional `memory_turn_id` to existing assistant-message append requests. Native validates Session/turn ownership and associates the actual saved message ID transactionally. Suppression covers affected source messages and assistant responses from turns that used invalidated memory; late responses and cache writes must not restore forgotten context. When precise span provenance is absent, neutralize the whole source message and report the affected IDs. The shared derived-invalidation gate and durable outbox coordinate this with Bun cache cleanup.

### Phase 4 classification extension

Phase 4 adds `MemoryStatementKind` (`normative_constraint`, `descriptive_fact`, or `unknown`) to persisted memory and `ScopedMemoryEntry`; migrated rows default to `unknown`. Keep `MemoryDraft` unchanged. Save/update/correction requests gain an optional classification: absent creation defaults to unknown; absent update/correction preserves the previous kind. `memory_scoped_classify` changes classification with scoped ownership, expected revision, an audit event, and preparation invalidation.

Only explicit constraint capture initializes normative meaning automatically. Explicit remember/decision capture remains unknown; operator classification is deliberate. Fresh source revalidation uses the existing Tool runtime and evidence machinery with a current read that bypasses cached results. It informs the current turn without silently rewriting durable memory or overriding an accepted user requirement. Durable changes still require native user acceptance.

Phase 4 also adds per-turn `MemoryRevalidationResult` to authenticated runtime receipts, native persisted diagnostics, and UI read-back. Its states (`not_required`, `required`, `fresh_evidence`, `unavailable`) report current-source evidence availability, with memory IDs, current tool-call IDs, and a reason code. `fresh_evidence` records that source was freshly read; it is not a semantic truth verdict or verified-observation capture.

For new bound Sessions whose current request does not repeat a workspace path, Phase 4 uses the authenticated preparation's project root as a requested working-root candidate. Validate the preparation's immutable tuple and process generation before reading that candidate, then apply existing Tool runtime/sandbox/permission policy before resolving the effective workspace and consuming memory. Binding cannot create a grant. An explicit conflicting workspace in the current request still produces scope mismatch and requires deliberate rebinding; an unauthorized root remains denied with observable memory/freshness status.

## Responsibility and evidence map

| Roadmap #1 requirement | Primary owner | End-to-end evidence |
|---|---|---|
| One authority, scope, provenance, legacy records | Phase 1 | Phase 4 migration and isolation scenarios |
| Bounded relevant live recall and inspectable selection | Phase 2 | Phase 4 direct/orchestrated transport scenarios |
| Explicit capture, accepted corrections, forgetting | Phase 3 | Phase 4 persistence, correction, and deletion scenarios |
| Preserve active objective through side questions | Phase 3 | Phase 4 continuation and interruption scenarios |
| Expiry, supersession, stale workspace evidence | Phase 1 eligibility + Phase 3 mutation + Phase 4 revalidation/control | Phase 4 fresh-evidence scenario |
| Retrieval/write failure and duplicate events | Phase 2 retrieval + Phase 3 capture | Phase 4 combined failure scenarios |
| New Session and restart continuity | Phases 1–3 persistence contracts | Phase 4 live restart demonstration |

## Acceptance scenario set

1. Save a project constraint in Session A; start Session B for the same Agent/project; the relevant constraint is recalled without the user repeating it.
2. Repeat after Bun server and Jarvis restart; inspect persisted memory and recall provenance.
3. Use a second project with overlapping vocabulary, then a second Agent; private context remains isolated.
4. Correct the constraint; subsequent recall contains the accepted replacement and its provenance.
5. Forget the constraint; it is absent from fresh recall, retained memory blocks, and derived Session context on the next turn.
6. Change a workspace fact; Jarvis checks fresh evidence instead of acting on the remembered stale value.
7. Ask a side question during an active objective; resume the objective with its original goal intact.
8. Force a retrieval failure and a capture failure; ordinary inference remains usable, and save status is truthful.
9. Interrupt a stream, then replay its terminal event; no duplicate or falsely accepted capture appears.
10. Exercise UI direct SSE and native relay with direct and orchestrated inference; inspect the actual context delivered and applicable status.

Every live result records source revision, inference backend/model, Agent, project scope, turn identity, selected memory IDs, elapsed time, outcome, and limitations. Passing synthetic tests is not a substitute for the restart demonstration.

## Plan requirements

Every plan includes its goal, architecture, stack, spec references, global constraints, five concrete review risks, exact files and interfaces, focused failing/passing checks, phase handoff contracts, and completion gate. Preserve shared interface names and values across all four plans. Planning agents write only their assigned document; implementation, dependency installation, commits, and product test runs are outside this planning request.

Cargo, rustc, and rustup are not currently on the local shell PATH. Rust toolchain setup and required Tauri build resources must be included before Rust validation. Plan documents must distinguish future validation commands from checks actually run.

## Implementation plans

| Phase | Plan | Planning agent | Implementation status |
|---|---|---|---|
| 1 | [Scoped foundation](../plans/2026-10-04-memory-phase-1-scoped-foundation.md) | `memory_phase1_plan` | Pending |
| 2 | [Live recall](../plans/2026-10-04-memory-phase-2-live-recall.md) | `memory_phase2_plan` | Pending |
| 3 | [Safe capture and correction](../plans/2026-10-04-memory-phase-3-safe-capture.md) | `memory_phase3_plan` | Pending |
| 4 | [Continuity and controls](../plans/2026-10-04-memory-phase-4-continuity-controls.md) | `memory_phase4_plan` | Pending |
