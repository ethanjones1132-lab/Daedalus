# Memory Phase 4.2 — Persisted Session Identity and Bound Workspace

**Execution:** DeepSeek v4.1 Flash (`opencode-go/deepseek-v4.1-flash`) via OpenCode CLI.
**Branch:** `codex/memory-deepseek-20261004`.
**Source SHA (execution HEAD):** `c9987dc95f6939bbb99af01693ddb6a305cadbad` (Phase 4.1 checkpoint).
**Working tree:** uncommitted production source on top of the HEAD above; no commit, stage, push, or reset was performed.
**Status:** Production source implemented; permitted compiler/type/build checks pass. **No tests, fixtures, or live/restart acceptance were written or run.** Priority #1 remains active and is not runtime-complete.

## Scope delivered

Persisted Session Agent/project identity across the Rust, Bun, and UI projections, explicit New-Session Agent selection with native validation, native workspace binding controls for the current Session, and safe authenticated bound-workspace candidate resolution before memory consumption. Classification fields and Part 4.1 operator controls are unchanged. Fresh-source revalidation (4.3) and integrated turn-status/continuity UI (4.4) were **not** started.

## Native

- `src-tauri/src/jarvis/types.rs::JarvisSession` gained `agent_id: String` and `project_root: Option<String>` (both `#[serde(default)]` so any legacy inbound payload still decodes). These are projection fields only; Agent identity remains owned by the persisted Session row and project scope by the explicit native binding.
- `src-tauri/src/commands/jarvis_commands.rs::summary_to_jarvis_session` now projects the canonical `SessionSummary.agent_id` / `project_root` instead of dropping them.
- `jarvis_new_session` gained `agent_id: Option<String>`. An omitted Agent preserves the historical `main` alias behavior. An explicit selection is trimmed, looked up through `commands/agents.rs::fetch_agent`, and must resolve to an **enabled** native Agent; an empty, unknown, or disabled selection returns an error **without creating a Session**. Existing Session Agent ownership is never reassigned. Session creation still goes through the canonical `commands/sessions.rs::create_session_row`.

## Bun

- `server-jarvis/src/memory-contract.ts` and the Rust/Bun wire contract for MemoryScope were **not modified**; the existing `{kind, agent_id, project_root}` shape is reused.
- `server-jarvis/src/native-memory.ts`: added `ScopeCandidateIdentity {preparation_id,turn_id,session_id,message}` and `NativeMemoryRegistry.inspectScopeCandidate(...): MemoryScope | null`. The probe calls `prune()`, returns `null` without a captured bootstrap, requires a currently **unconsumed** entry, and validates the immutable tuple (exact Session, turn, SHA-256 of the exact UTF-8 message), monotonic TTL expiry, and process generation (`app_instance_id === bootstrap.appInstanceId`). It returns a **copy** of the scope and never consumes, mutates, or exposes the envelope or any recalled text.
- `server-jarvis/src/memory-workspace.ts` (new): `resolveBoundMemoryWorkspace({sessionId,identity,registry,affinity,cfg,rawMessage,history,sessionGrants}):{active_workspace,memory_status}`.
  - A latest explicit user workspace (current raw message, else latest user history) always wins; the ordinary `WorkspaceAffinityStore.resolve` result is returned and `scope_mismatch` is reported when it conflicts with the authenticated project binding.
  - Otherwise, when the authenticated preparation carries a project scope, the candidate is offered to the existing `fs-scope.ts::resolveSafePath(candidate, cfg, {sessionGrants, forWrite:true})` **without** passing the candidate as its own `workspaceOverride`. Only a successful resolution that canonicalizes (`orchestration/path-identity.ts::pathsHaveSameIdentity`) to the bound directory becomes the active workspace. `resolution.revalidate()` runs before use.
  - On denial or canonical mismatch the ordinary affinity result is retained and `scope_mismatch` is reported. No permission, grant, cache, or root is created or widened.
- `server-jarvis/src/index.ts`: `JarvisSession` gained the same `agent_id` / `project_root` projection fields. The direct `/chat/stream` path now computes the opaque scope-candidate identity from the authenticated `turn_id`/`memory_preparation_id`, resolves the effective workspace through `resolveBoundMemoryWorkspace` **before** `resolveTurnMemory`, and feeds that workspace into the existing registry consume (which still enforces canonical equality of bound/effective/active roots). A non-null `memory_status` from the resolver becomes the turn's observable memory status when consume did not run. Public request fields (`memory`, `scope`, `agent_id`, `effective_workspace`, message text) are still never read as identity.

## UI

- `src-ui/src/components/jarvis/types.ts`: `JarvisSession` gained optional `agent_id` / `project_root` (compatibility only; native always emits them). Added `SessionMemorySelection {session_id,agent_id,project_root,include_user_scope}` and `AgentOption {id,name,enabled}`.
- `src-ui/src/components/jarvis/MemoryScopeControls.tsx`: the exported component now dispatches on a `selection` prop. Without it, the exact Part 4.1 operator control is rendered unchanged. With it, `SessionIdentityControls` renders the New-Session Agent selector (disabled/fixed for an existing Session), a project path field with Apply/Unbind that calls native `memory_bind_session_workspace` for the current Session, canonical read-back (`Bound · …` / `Unbound · Agent scope`), and the local user-wide opt-in checkbox.
- `src-ui/src/components/jarvis/JarvisView.tsx`: `ChatPanel` accepts optional `sessions` / `onSessionsChanged` (defaulted, so existing render sites and tests still compile). It loads enabled Agents via `list_agents` (a failed/malformed read keeps the safe `main` default), constructs the `SessionMemorySelection` from the persisted Session row or the pending New-Session choice, and renders the identity controls above the composer.
  - First send creation order is: `jarvis_new_session` (with `agentId` only when non-default) → `memory_bind_session_workspace(newId, pendingProjectRoot)` confirmed by native read-back → user append → preparation → fetch. A binding failure keeps the created empty Session (reused on retry via `pendingNewSessionRef`), preserves the draft, shows an actionable error, and performs no append/preparation/fetch.
  - Existing-Session Apply/Unbind goes through the native command only; the Agent select is fixed. The user-wide opt-in resets on Session change, Agent change, and app restart (never persisted).
  - The prior standalone user-wide checkbox was removed (its state moved into the identity control); the memory recall status label is retained.

## Permitted checks actually run (unmasked exit codes)

| Check | Command | Result |
|---|---|---|
| Whitespace/conflict | `git diff --check` | PASS (exit 0) |
| Rust compile | `cargo check --manifest-path src-tauri/Cargo.toml` | PASS (exit 0); only pre-existing `supervisor.rs`/`wsl.rs` warnings |
| Bun typecheck | `server-jarvis: bun run typecheck` | PASS (exit 0) |
| Bun build | `server-jarvis: bun run build` | PASS (exit 0); 198 modules bundled |
| UI build | `src-ui: bun run build` (`tsc -b && vite build`) | PASS (exit 0); 2,721 modules, existing large-chunk warning only |

No pipeline masked any check. No tests/test declarations/fixtures were added or edited; no product tests, scripted runtime probes, live inference, restarts, or acceptance experiments were run. **All of those remain NOT RUN / requires user request.**

## Compatibility rulings

1. **`resolveBoundMemoryWorkspace` input includes `sessionId`.** The parent/part interface listing names `identity` but the ordinary `WorkspaceAffinityStore.resolve` needs a Session id even when no memory reference exists (identity `null`). `sessionId` was added as a required input; behavior and boundaries are otherwise exactly as specified.
2. **`ChatPanel` new props are optional.** The part plan's UI checks construct `ChatPanel` directly; making `sessions`/`onSessionsChanged` required would have required editing existing test files, which this authorization forbids. They are optional with safe defaults.
3. **`MemoryScopeControls` extends rather than replaces the Part 4.1 control.** The 4.2 identity interface coexists with the 4.1 operator props through a discriminated `selection` prop, so Part 4.1's Memory-view control is untouched.
4. **Prepared envelope `schema_version` stays 1.** MemoryScope itself is unchanged, so no wire bump was needed for 4.2.
5. **Inherited Phase 4.1 final source-review correction.** `decodeScopedMemoryEntry` now requires `revision` to be a positive safe integer (`Number.isSafeInteger(value.revision) && value.revision > 0`) rather than any finite number, because that revision is passed into every scoped mutation target and the native `expected_revision`. Fractions, zero, negatives, and values above JavaScript's exact integer range now decode as unavailable. Legacy decoder behavior is unchanged.

## Files changed

Modified (production only): `server-jarvis/src/index.ts`, `server-jarvis/src/native-memory.ts`, `src-tauri/src/commands/jarvis_commands.rs`, `src-tauri/src/jarvis/types.rs`, `src-ui/src/components/jarvis/JarvisView.tsx`, `src-ui/src/components/jarvis/MemoryScopeControls.tsx`, `src-ui/src/components/jarvis/types.ts`.
Created (production only): `server-jarvis/src/memory-workspace.ts` (sha256 `fe29d22f173d7239adea969c49d97231f090bf3b393d9e188c3af06021f9d33d`).
Created (this record): `docs/implementation/memory-phase-4-2-progress.md`.

No tests, fixtures, or test declarations were modified. The pre-existing dirty baseline files (`AGENTS.md`, `PRIORITIES.md`, `README.md`, `docs/COMPLETION_BACKLOG.md`, `docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md`) and the untracked `outputs/` / `src-tauri/gen/schemas/*` artifacts were left untouched. Nothing was staged or committed.

## Gaps and limitations

- The UI is a source-level control surface. No product tests verify the New-Session bind ordering, binding-failure recovery, or switching behavior; those are Phase 4 acceptance work.
- `jarvis_new_session` explicit-Agent validation is native; the UI only offers Agents returned by `list_agents` and always allows the literal `main` default. A native Agent row with id `main` is not required for the omitted/default path.
- `inspectScopeCandidate` validates the app-instance generation recorded in the envelope, not a separate per-launch Bun id; a restarted owned Bun has no registered entries, so replay cannot select a root.
- `fresh_evidence`, revalidation receipts, and the integrated prepared-vs-applied turn-status UI remain intentionally absent (Parts 4.3–4.4).
- Compiler/type/build success establishes source compilation and bundling only and does not close priority #1 or constitute runtime acceptance.

## Self-review

Reviewed the production diff against parent Phase 4 Task 1 and the Phase 1–3 frozen contracts:

- **Identity authority.** Agent ownership is read only from the persisted Session row (native `session_owner`/`SessionSummary` → Rust/UI/Bun projection). No public request field can supply or change Agent ownership; an explicit new-Session Agent must resolve to an enabled native row or no Session is created. Existing Session ownership is immutable.
- **Binding is not a grant.** `resolveBoundMemoryWorkspace` offers the authenticated candidate to `resolveSafePath` with `forWrite:true` and no candidate `workspaceOverride`, so the candidate must independently satisfy roots/grants policy. It never mutates grants, caches, or the affinity store, and it does not widen read or write behavior.
- **Explicit conflict preserved.** A latest explicit user path (message or history) always wins; the bound project is reported as `scope_mismatch` and never silently forced. The registry consume remains the final authority on canonical bound/effective/active equality.
- **No envelope exposure.** `inspectScopeCandidate` returns only a copy of the scope and never the envelope, block, or recalled text; the private capability and internal transport are unchanged. `/chat/stream` still accepts only opaque reference fields.
- **Phase 1–3 preserved.** Memory CRUD, scope/store revisions, provenance, capture/receipt/idempotency, suppression, objective continuity, preparation TTL/invalidation, and the derived-state gate are untouched. Part 4.1 classification fields and operator controls are unchanged.
- **Migration/DB.** No schema, migration, or persistence change was made in 4.2; `sessions.project_root` and `sessions.agent_id` already existed.
- No unresolved authority, grant-widening, or scope-forgery finding was found in the reviewed diff.
