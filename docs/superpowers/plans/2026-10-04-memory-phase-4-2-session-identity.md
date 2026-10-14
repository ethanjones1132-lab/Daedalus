> **For agentic workers:** Execute the parts sequentially with the existing exact DeepSeek v4.1 Flash OpenCode CLI workflow. Steps use checkbox syntax for tracking.

**Goal:** Complete Phase 4 native operator controls, cross-Session identity, conservative source freshness handling, and truthful diagnostics while preserving the Phase 1–3 authority and safety contracts.

**Architecture:** Native Rust/Tauri and App SQLite remain durable memory authority. The Bun server uses only authenticated turn preparations and the existing Tool runtime/evidence machinery; React presents native-scoped controls and receipts. All four parts are dependent and sequential: native/UI operator controls, persisted Session identity and safe bound-workspace resolution, source revalidation, then turn-status/continuity UI and documentation closure.

**Tech Stack:** Existing Rust 2021/Tauri 2, rusqlite, React/TypeScript, Bun, Tool runtime and evidence-gate interfaces. Add no persistence service, embedding, verifier, inference dependency, test provider, test declaration, or test fixture.

**Spec:** `docs/superpowers/specs/2026-10-04-memory-four-phase-design.md`; full Phase 4 requirements and frozen parent contracts in `docs/superpowers/plans/2026-10-04-memory-phase-4-continuity-controls.md`.

## Global constraints

- The parent Phase 4 plan and accepted four-phase design are binding. These sequential parts change execution boundaries only; do not omit or narrow their requirements.
- Rust/Tauri App SQLite is the only durable memory authority. Do not create a second writable Bun store.
- Preserve Phase 1 scope, ownership, provenance, revision and legacy isolation; Phase 2 preparation, private transport, invalidation and applied-ID receipts; Phase 3 capture, idempotency, suppression, objective continuity and failure semantics.
- Keep `MemoryDraft` unchanged. `MemoryStatementKind` is `normative_constraint|descriptive_fact|unknown`; existing rows migrate to `unknown` without inferred classification.
- Only explicit constraint capture initializes `normative_constraint`; remember/decision capture remains `unknown`. No generic automatic `verified_observation` capture.
- Fresh evidence means a current authorized source read exists; it is not a semantic truth verdict, verification claim, or permission grant. Never silently rewrite accepted memory or override a normative user requirement.
- Bindings and recalled text do not create workspace grants. Existing Tool runtime policy, sandboxing, write/check/TaskPlan gates, and direct/native surfaces remain authoritative.
- Do not add or run tests, test declarations, fixtures, scripted runtime probes, live inference, restarts, or acceptance experiments. They are explicitly **NOT RUN / requires user request**. Use source inspection, `git diff --check`, Cargo check, Bun typecheck/build, and UI build only. Record missing checks as not run; never claim priority #1 runtime-complete.
- No scope beyond Phase 4. No push, merge, deploy, global install, permission/settings changes, broad staging/reset/clean, or mutation of unrelated dirty baseline files.

## Review focus

1. Memory list, preview, inspection or mutation resolves the wrong Session/scope after switching while a request is pending; capture target identity and guard stale results.
2. A new Session loses selected Agent/project, or an authenticated project candidate widens grants; resolve native identity and use existing authorization before workspace selection.
3. Cached or historical workspace results are misreported as fresh; only same-turn current content-bearing Tool runtime reads may support `fresh_evidence`.
4. Stale/conflicting source appears to erase a normative requirement or unknown accepted decision; surface conflict and require operator acceptance for durable changes.
5. Missing/malformed/replayed receipt or diagnostic appears as success; show unavailable/pending until native read-back confirms.

---
# Memory Phase 4.2 — Persisted Session Identity and Bound Workspace

## Part scope

Expose and preserve the canonical native Agent and project binding across listed/created Sessions, New Session UI state, and authenticated turn preparation. A binding is only a workspace candidate: existing grants, sandbox and Tool runtime permissions remain decisive. This part consumes Part 4.1's classification wire addition and does not implement freshness policy.

## Files and responsibilities

- Modify `src-tauri/src/commands/jarvis_commands.rs::{jarvis_new_session,summary_to_jarvis_session}` and `src-tauri/src/jarvis/types.rs::JarvisSession`; use canonical `commands/sessions.rs::create_session_row` and existing bind command.
- Modify `src-ui/src/components/jarvis/{types.ts,JarvisView.tsx,MemoryScopeControls.tsx}`. Extend Part 4.1’s existing Session/scope control with new-Session Agent/project selection and active Session bind/unbind behavior.
- Modify `server-jarvis/src/index.ts` Session projection, `native-memory.ts` authenticated reference validation and workspace resolution seam. Create `server-jarvis/src/memory-workspace.ts`.
- Do not move Agent ownership between existing Sessions. Do not treat server-file Session metadata as scope authority.

## Interfaces

- Extend native `jarvis_new_session(name:Option<String>,agent_id:Option<String>,state,db)->Result<JarvisSession,String>`; omitted Agent retains `main` and alias behavior. Explicit Agent resolves to an enabled native Agent identity or creation fails without creating a Session.
- Keep projections consistent as `{agent_id:string,project_root:string|null}` in Rust, UI and Bun. Decode historical absence only in explicit compatibility adapters; never fabricate scope.
- Implement UI `SessionMemorySelection {session_id:string|null,agent_id:string,project_root:string|null,include_user_scope:boolean}`. Scope controls select Agent for a future Session, bind/unbind canonical workspace for current Session through native command, and default user-wide inclusion to false; reset opt-in when Session/Agent changes and app restarts.
- Add registry `inspectScopeCandidate({preparation_id,turn_id,session_id,message}):MemoryScope|null`; validate immutable Session/turn/message UTF-8 hash, generation, expiry and invalidation without consuming or exposing the preparation.
- Implement `resolveBoundMemoryWorkspace({identity,registry,affinity,cfg,rawMessage,history,sessionGrants}):{active_workspace,memory_status}`. An authenticated project binding may supply missing root for a new Session only after immutable tuple validation and `resolveSafePath(candidate,cfg,{sessionGrants,forWrite:true})` succeeds. Do not supply the candidate as its own `workspaceOverride` during authorization.
- Preserve latest explicit conflicting workspace choice: actual workspace remains user-selected and memory becomes `scope_mismatch` until deliberate rebind. Unauthorized candidate cannot widen read/write grants; ordinary affinity and Permission policy remain unchanged.
- Before memory consume, require exact effective canonical workspace match and existing preparation tuple checks. No caller request field can forge Agent, project or trusted envelope.

## Steps

- [ ] Inspect Session creation/projection and actual direct `/chat/stream` path. Trace native binding and preparation ordering; record exact current behavior.
- [ ] Extend Rust/UI/Bun Session projections with persisted `agent_id` and `project_root`; preserve legacy `main` behavior and reject unknown/disabled explicit Agent selection.
- [ ] Implement New Session controls so selected Agent/project are applied to the created native Session. On first send, create once, bind and confirm canonical read-back before user append/preparation/fetch; binding failure preserves draft, shows actionable error and does not repeatedly create Sessions.
- [ ] Ensure switching Sessions uses each Session's saved Agent/project; new Session does not inherit private memory implicitly. Keep user-scope opt-in unchecked and reset on identity changes.
- [ ] Implement authenticated non-consuming scope-candidate inspection and bound-workspace resolution. Preserve explicit path conflicts, authorize candidate under existing roots for writes, and expose unavailable/mismatch truth without changing grants.
- [ ] Review source against parent Phase 4 Task 1 and cross-phase scope invariants. Run only allowed Rust/Bun/UI source checks and `git diff --check`; no tests or actual app restart.
- [ ] Record exact files, checks, limitations and source SHA in `docs/implementation/memory-phase-4-2-progress.md`.

## Handoff

Part 3 may use the bound authenticated project identity to determine which recalled descriptive/unknown project statements require a fresh current-source read. It must not treat binding itself as authorization or evidence.
