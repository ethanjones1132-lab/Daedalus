# Priority 4.2 — Attributable Researcher Implementation Plan

> **For agentic workers:** Implement the source plan sequentially through the assigned OpenCode `opencode-go/deepseek-v4.1-flash` executor. Luna reviews each bounded source slice before the next. This plan implements source only; do not conduct research for a real task or claim real-task acceptance.

**Goal:** Let a user run a bounded web research task against an exact persisted Session and successful Agent run, inspect source-bound retrieval evidence separately from a user-written synthesis, and explicitly save an accepted conclusion with durable native readback.

**Architecture:** Native Rust remains authoritative for the persisted Session, Agent, canonical project root, `session_runs` row, and Goal/task association where applicable. The selected Session/run IDs are selectors only. Bun resolves the exact stored trajectory and captures each permitted `web_search`/`web_fetch` call through the existing ToolRuntime. Native validates the returned response and every finding before persistence or display. Retrieved content, excerpt, digest, citation, tool call, trajectory/run binding, and user-authored synthesis remain different typed/displayed fields. Saving a conclusion is a separate user-clicked `memory_scoped_save` operation followed by fresh native readback; it is not Goal acceptance or verified memory provenance.

**Tech Stack:** Existing Tauri/Rust learning commands and SQLite authority; the private native-to-Bun capability; existing Bun `learning-session.ts`, `web-bundle.ts`, and ToolRuntime; React/Tauri `LearningView`; existing scoped-memory save/list/read commands.

**Spec:** `docs/superpowers/plans/2026-10-05-roadmap-priority-4-workflows.md` §“Phase 4.2 — Attributable Researcher workflow”; `docs/CURRENT_ROADMAP.md` §4; current Project Steward sequencing in `docs/superpowers/plans/2026-10-06-priority-4-phase-4-1-project-steward.md`; exact-source and authoritative-evidence principles in `docs/superpowers/plans/2026-10-05-priority-3-phase-3-independent-acceptance.md` §Phase 3.1.

## Global Constraints

- A concrete question/topic, source scope, persisted Session/run, and output destination must be visible before the user explicitly starts research. Do not substitute an inferred real-world task or submit automatically.
- Session/run IDs and topic/source inputs are request selectors and content only. Native re-reads the exact Session, Agent, canonical project root, successful persisted `session_runs` row, and any required Goal/run binding; Bun independently resolves the exact persisted trajectory by `agent_run_id + session_id`. Missing, duplicate, stale, unreadable, mismatched, or conflicting links mean no dispatch and an explicit blocked/unavailable state.
- Reuse only the existing `web_search` and `web_fetch` ToolRuntime tools and current `evaluatePolicy` decision. Preserve `allow`/`ask`/`deny`; approval-required or denied tools are not invoked. Do not add permissions, grants, approval bypass, browser automation, MCP, document connectors, alternate fetchers, or direct network clients. New integrations require separate user authorization/configuration.
- Facts are claims present in retrieved content, not independently verified truth. Show each retrieved excerpt, its exact retrieved-body SHA-256, canonical source URL/host, retrieval time, and native/tool provenance. A digest proves byte identity only; it does not prove a source is true or reputable. Keep rejected/unavailable sources visible as such.
- Keep the exact retrieved body identity, displayed excerpt, source reference, citation, run binding, and user-written synthesis separate. Never label a synthesis as retrieved fact, quote text beyond the retrieved excerpt, or silently rewrite/collapse citation evidence into prose.
- Bind every finding to the exact successful Agent run, persisted Session, canonical workspace, Bun instance, `web_fetch` call ID, and verified trajectory/tool-sequence digest. Preserve the Phase 3.1 discipline: strict typed decoding, recompute digests from the exact bytes being claimed, reject identity/hash mismatch, and treat missing evidence as unavailable rather than fabricate it.
- Research output stays in an app-owned local research-history destination. Do not write to the selected project, arbitrary caller path, external service, or user-chosen path without a separately designed safe export action and authorization. A research run is not itself permission to save a memory or Goal.
- Saving a conclusion is a separate explicit user action. Use only the existing scoped-memory API and re-read the exact saved row/scope before confirming it. The stored artifact is a **user-authored manual memory with cited research**, not a research-verified memory, automatic learning, Goal acceptance, or Goal completion. Do not create or complete a Goal from research output.
- Keep outcomes distinguishable as `complete`, `partial`, `blocked`, or `unavailable`; none is a quality/acceptance judgment. A partial result can be inspected and saved only if the user explicitly accepts that limitation and the UI keeps its partial status in the saved artifact.
- No tests, installations, runtime app calls, live research, real-task execution, project modifications, or external actions during implementation. Run only the five exact-source checks below once after all source slices are reviewed and frozen.

## Bounded Source Map

- `src-tauri/src/jarvis/learning.rs` — `LearningResearchRequest`, `Finding`, `LearningRunResult`, `EvidenceBinding`, `LearningOutcome`, source allowlist/evaluation, and report/path helpers.
- `src-tauri/src/commands/jarvis_commands.rs` — `resolve_learning_authority`, `validate_learning_response`, `get_learning_source_choices`, and `run_learning_session`; exact Session/run authority is resolved here before the private transport and the response is checked before native output persistence.
- `src-tauri/src/lib.rs` — Tauri registration for learning commands and any new exact report readback command.
- `server-jarvis/src/learning-session.ts` — exact persisted trajectory lookup, research response DTO, bounded timeout, existing ToolRuntime context, policy check, actual `web_search`/`web_fetch` calls, and source extraction/hash.
- `server-jarvis/src/web-bundle.ts` — existing web tool registration/schema; reuse its current tools only. No connector additions are in scope.
- `server-jarvis/src/tool-runtime.ts` and `server-jarvis/src/tool-types.ts` — canonical ToolRuntime and Permission behavior; inspect only the exact execution/context APIs needed by this workflow and preserve their contract.
- `src-ui/src/components/jarvis/LearningView.tsx` — persisted Session/run selectors, request generation guard, explicit research submission, result display, and the existing empty/report states.
- `src-tauri/src/commands/memory.rs` — existing `memory_scoped_save`, `memory_scoped_list`, and `memory_scoped_read`; `ScopedSaveRequest` resolves ownership/scope from a persisted Session and carries no caller Agent/workspace/provenance authority.
- `src-tauri/src/jarvis/memory/contracts.rs` and `src-tauri/src/jarvis/memory/scope.rs` — `ScopeSelector`, `MemoryDraft`, `ScopedMemoryEntry`, `MutationResult`, scope rules, manual provenance, and statement-kind semantics. Reuse their existing authority; do not add a new memory evidence authority.
- `src-tauri/src/commands/goals.rs` and `src-ui/src/components/jarvis/GoalsView.tsx` — Goal and trusted-acceptance path. Research findings are not trusted acceptance evidence; Phase 4.2 must not modify Goal completion or trusted acceptance.

## Task 1: Make the native research record exact, durable, and readable

**Allowed files:**

- Modify `src-tauri/src/jarvis/learning.rs`.
- Modify `src-tauri/src/commands/jarvis_commands.rs`.
- Modify `src-tauri/src/db/mod.rs` to retain and expose the app-data root anchor bound to the database.
- Modify `src-tauri/src/lib.rs` only for the existing manual `AppDb` initializer and, if needed, registering a focused native report-readback command.
- Modify `src-tauri/src/commands/models.rs`, `src-tauri/src/commands/sessions.rs`, `src-tauri/src/commands/settings.rs`, `src-tauri/src/commands/skills.rs`, and `src-tauri/src/commands/recovery_stubs.rs` only to update existing `AppDb` in-memory test fixture literals required by the retained-root field; keep their `:memory:` behavior and leave test logic/coverage unchanged.
- Modify `server-jarvis/src/learning-session.ts` only for strict request/response/source-evidence DTO and outcome corrections required by the contract.
- Do not modify `web-bundle.ts`, ToolRuntime permissions, Goals, memory storage, or UI in this task.

**Contract:**

- Define a versioned native research receipt keyed by a native-generated request/run-record ID. Bind it to the exact request ID, question/topic, selected Session ID, successful Agent run ID, persisted Agent ID, canonical project root, trajectory/tool-sequence digest, Bun instance ID, start/finish time, outcome/reason, every finding and rejected source, and canonical receipt hash.
- Bind receipt storage to the directory that actually owns the open SQLite database. During `AppDb` initialization, securely acquire the final app-data root directory with `O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC` (or the platform equivalent), retain its handle/identity, and bind or verify the opened `jarvis.db` against that same root using a root-relative database open or equivalent identity check before publishing `AppDb`. Reject a final-component symlink for research storage. Do not treat `db_path` or a canonicalized pathname alone as proof of directory identity. The ordinary and manual `AppDb` initialization paths must establish the same invariant.
- Do not create the final app-data root component through a pre-existing symlink. If secure root acquisition or safe final-component creation cannot be established, the app may preserve its normal pathname database startup, but `AppDataRoot` must be marked unsupported so research receipt read/write fails closed as unavailable. Ancestor symlinks follow the OS-resolved parent-path policy; reject them only if a separate requirement calls for full-chain canonicalization.
- Pass the retained root anchor from `AppDb` into research receipt persistence and readback; do not reopen `db_path.parent()` for receipt I/O. Perform all `research-history` directory and receipt operations relative to the retained root handle, with no-follow and regular-file/directory checks, create-once or exact-byte idempotency, strict decoding, hash recomputation, and exact readback. Remove or reject arbitrary `out_dir` authority. On any mismatch or uncertain write, return unresolved/unavailable and do not claim the report was saved.
- Fail closed for this research persistence/readback feature on platforms where the app-data directory identity cannot be retained and the SQLite file cannot be bound or verified against that root. Return an explicit unavailable/unsupported result; do not fall back to pathname-only receipt access. This limitation must not require changing ToolRuntime policy or granting new permissions.
- Strictly validate `request_id`, exact Session/run/Agent/root, exact successful trajectory/session identity, nonempty tool call identity, `web_fetch` tool identity, Bun instance ID, source URL/host, fetched-body hash/reference, retrieval time, and all per-finding bindings before persistence. Hash the exact retrieved body returned by the tool, not a derived excerpt. Keep the excerpt bounded and prove it is a substring of the retrieved body where the transport contract provides that body; if raw bytes are not available to native, retain the existing native-validated Bun digest/reference contract explicitly and do not describe the digest as native recomputation.
- Keep actual facts/excerpts and source reference separate from the request topic or any synthesis. Do not invent a new model synthesis call. Preserve or refine `complete | partial | blocked | unavailable`: approval-required/policy-denied and other policy stops are `blocked`; time/resource cap with usable findings is `partial`; missing identity/transport/readback is `unavailable`; `complete` requires normal bounded completion with no rejected/failed source. Outcomes describe execution/evidence coverage only.
- Re-read the full Session/run/Agent/root binding and report after persistence before returning; identity conflict, malformed data, stale binding, write/read error, or ambiguous duplicate record fails closed with evidence cleared or marked unavailable.

**Acceptance criteria:**

- Native is the only source of authority fields; caller values remain topic/seeds/selectors only.
- The exact receipt can be freshly loaded and its hash and every identity field are revalidated; read error is distinct from a genuine empty result.
- A crash or lost response cannot be reported as a saved report without exact durable readback. Reconciliation uses the same request identity and exact bytes; changed payload is a conflict.
- Existing ToolRuntime permission policy is unchanged; no new tool, permission, integration, model synthesis, or project write is introduced.
- **Luna checkpoint:** Task 1 requires a fresh DeepSeek repair and review. Review AppDb root-handle retention and SQLite/root identity binding in both initialization paths, receipt I/O through that retained anchor, platform fail-closed behavior, DTO closure, digest provenance, native authority reread, durable write/idempotency/readback, status semantics, and the unchanged ToolRuntime allow/ask/deny boundary before Task 2.

## Task 2: Present the research request and evidence without conflating synthesis

**Allowed files:**

- Modify `src-ui/src/components/jarvis/LearningView.tsx` only.
- Reuse the Task 1 native source choices and exact receipt/readback APIs. No new navigation, Goal, memory, route, or connector files in this task.

**Request UI:**

- Require a nonempty user-entered research question/topic. Make source scope concrete by describing the existing source-tier allowlist and accepting only optional seed URLs that native/Bun already validate; do not imply unrestricted web coverage. Show maximum source count and time limit from the native contract.
- Show the selected persisted Session and exact successful Agent run, its persisted Agent, and canonical workspace as context. They remain selectors; submission waits for native revalidation. Show the app-owned “Research history” output destination before Run.
- Use an explicit Run action. Freeze the submitted question/seeds/Session/run and request generation while in flight. Drop stale responses after selector/input/route change; never display a result under a different submitted tuple.
- Distinguish loading, read error, empty choices, blocked, unavailable, partial, complete, and report-readback failure. Do not render a native failure as an empty finding list or an empty source history.

**Evidence and synthesis UI:**

- Load the durable native receipt by exact run-record ID and require its request/Session/run/Agent/root/trajectory/Bun identity to match current freshly read selectors before rendering it. A direct command response is not enough for a saved/durable claim.
- Show per source: canonical URL and host, retrieval timestamp, exact content SHA-256, bounded retrieved excerpt, reference, `web_fetch` tool call ID, run ID, trajectory digest, and Bun instance ID. Visibly label this as retrieved excerpt/evidence, not verified fact. List rejected/failed sources and why.
- Keep the user synthesis in a separate editable field, initially blank. Do not generate or infer synthesis from excerpts. Label all prose in that field “user-authored synthesis”; do not show it as retrieved content.
- Display execution coverage state `complete`, `partial`, `blocked`, or `unavailable` adjacent to every result and preserve it when selecting/copying a report. Partial, blocked, or unavailable states never become successful/accepted because some findings exist.

**Acceptance criteria:**

- A request can be sent only through the existing explicit user action and with currently selected persisted selectors; no mount/load path dispatches research.
- Every displayed finding is bound to the exact durable native receipt and source identity tuple. Missing/invalid receipt is unavailable, not an empty result.
- Source evidence and user-written synthesis are structurally and visually distinct. No synthesized claims are inserted into the retrieved facts list.
- **Luna checkpoint:** review stale-request handling, fresh receipt readback, exact-source identity rendering, status distinctions, and the absence of auto-research or auto-synthesis before Task 3.

## Task 3: Add explicit user-accepted scoped-memory save with exact readback

**Allowed files:**

- Modify `src-ui/src/components/jarvis/LearningView.tsx` only.
- Modify native memory files only if a concrete missing readback/idempotency contract is demonstrated and separately bounded for Luna review before implementation. The default path reuses `memory_scoped_save`, `memory_scoped_read`, and `memory_scoped_list` unchanged.
- Do not modify `goals.rs`, trusted acceptance, Goal completion, memory provenance authority, or memory recall ranking.

**Save flow:**

- Offer a separate button only after the user has inspected a durable research receipt and entered a nonempty synthesis. The button text must say the action saves a user-authored memory; it is never labeled “verify,” “complete Goal,” or “accept facts.”
- Require explicit writable scope selection (`project`, `agent`, or `user`) using the existing `ScopeSelector`. Native derives ownership and canonical project root from the persisted selected Session. If project scope is unavailable, explain the existing workspace-binding recovery; never fall back silently to Agent or user scope.
- Build the saved content deterministically from the user-authored synthesis plus a visibly marked citation/evidence appendix containing the exact report/request ID, receipt hash, selected Session/run IDs, Agent/root binding, trajectory digest, and each source URL/content hash/reference/tool call ID. Keep the synthesis and appendix separately labeled in storage. Include the execution coverage state so a partial report cannot be mistaken for complete research. The user can inspect the exact content before Save.
- Call existing `memory_scoped_save` once per explicit click. Include a stable unique research-report marker in the draft tags/content for reconciliation; do not set hidden verified provenance, claim source_run_id, or grant a new evidence status. Existing manual provenance is expected and must be rendered truthfully.
- Confirm save only after `memory_scoped_read` of the returned native memory ID and comparison of exact content, title, requested scope, persisted Session-derived scope, `authority_kind=manual`, statement kind, and revision. Do not trust the mutation response alone.
- If the write response is lost/ambiguous, do not blindly call save again. Re-read the exact selected scope for the stable report marker: reconcile only a unique exact matching row with exact content/scope; zero matches remains unresolved, multiple matches is ambiguous. A deterministic retry API is out of scope unless its current native contract is separately proven idempotent.
- Changing Session, run, report, scope, or synthesis invalidates an in-flight save confirmation. Do not show a saved state below another selection. Preserve the draft and show a retry/reconcile path that cannot duplicate an uncertain write.

**Acceptance criteria:**

- No memory is written automatically after a research run. User must separately inspect, author/confirm, and click Save.
- Native API performs scope/ownership validation, and the UI shows confirmation only after exact row readback.
- The durable row clearly represents manual/user-authored memory with citations; it does not claim verified factual correctness, accepted Goal evidence, automatic memory provenance, or completed work.
- No Goal is created/completed and no external destination is contacted.
- **Luna checkpoint:** review the explicit authorization boundary, safe ambiguous-write reconciliation, exact saved-content/scope readback, and accurate manual-provenance labeling before final checks.

## Failure, Permission, and Recovery Contract

- A selector-list or report-history read error is unavailable, never an empty history. A genuinely empty native list may show a separate empty state.
- Missing or conflicting native Session/run/Goal binding blocks before any ToolRuntime call. Bun trajectory lookup must resolve exactly one successful run/session pair before tool creation.
- Existing ToolRuntime `ask` or `deny` does not execute a tool. Render blocked with the policy reason when available; do not retry through another tool, connector, permission mode, or direct network path.
- Timeout, source rejection, partial source coverage, failed tool call, cancellation, and no finding remain distinct. Preserve usable bound evidence only if native validates and durably reads it; never promote partial to complete.
- Digest/reference mismatch, duplicate source/run identity, malformed receipt, changed Session/root, report write/readback mismatch, or stale result clears/withholds confirmation and explains the exact unavailable/blocked state.
- Ambiguous memory save is reconciled by stable marker and exact row readback; no blind second write. Scope change or multiple matches stays unresolved.
- Goal trusted acceptance is not applicable to research reports. Existing Goal completion continues to require its own registered acceptance manifest, exact run, native acceptance receipt, and readback.

## Exact-Source Review and Permitted Checks

- After every task, Luna reviews only the exact changed source slice against this plan before the next task begins. Final review covers authority resolution, actual ToolRuntime policy use, source digest provenance, request/receipt/persisted-row identity, user-consented save, ambiguous retry behavior, and no changes to Goal acceptance or external integration permissions.
- Once all three source tasks are reviewed and source files frozen, run only these five checks at the exact final source SHA: `(cd src-tauri && /Users/charlottehughes/.cargo/bin/cargo check)`; `(cd server-jarvis && bun run typecheck)`; `(cd server-jarvis && bun run build)`; `(cd src-ui && bun run build)`; and `git diff --check`. Record each command and exit code against the same exact source SHA. Do not run tests, app/UI runtime, live web research, real tasks, or model calls.
- Source checks prove only source buildability. Real-task acceptance remains **OPEN** until the user provides or authorizes a concrete research question, source scope, output audience/destination, and then explicitly accepts the cited user-authored output after readback. This plan and its checks are not that evidence.
