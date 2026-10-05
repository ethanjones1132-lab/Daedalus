# Roadmap Priority 3 — Status and evidence

**As of:** 2026-10-05  
**Scope:** Roadmap Priority #3, “Prove that learning improves future work.”  
**State:** Phase 1 source implementation is complete and has passed its exact-SHA review/checkpoint. Priority #3 remains active/incomplete: Phases 2–4 and the controlled evidence gate remain open. Priority #1 and #2 acceptance remain open/NOT RUN. Priority #4 source planning is authorized next by the user, but Priority #4 execution is queued behind Priority #3 work.

## Sequence ruling

The user explicitly authorized Priority #3 source work and the roadmap controlled transfer evaluation before Priority #1 or #2 runtime acceptance. This does not waive or satisfy either open acceptance gate. See the [current roadmap](../CURRENT_ROADMAP.md) and [four-phase implementation plan](../superpowers/plans/2026-10-05-roadmap-priority-3-learning-effectiveness.md).

## Phase 1 authority gate

- The original `run_learning_session` command had no UI caller, caller-bound Session/run identity, or persisted link to source trajectory evidence. Its old placeholder output was fabricated.
- The first DeepSeek source pass added a native URL validator and private Bun research machinery. Luna review rejected caller-supplied Agent/Session/snapshot fields as authority.
- A focused correction removed those fields. The native command now returns explicit `unavailable`, no findings, and no output path when it cannot resolve an authoritative run; it does not dispatch research or create a file. This is fail-closed source behavior, but it leaves the intended source-backed success path unavailable.
- The user-directed follow-up is to add explicit user selection of a persisted Session and exact completed Agent run as selectors only. Native must reread and validate the run, Session, Agent, enabled projection, and canonical workspace; Bun must resolve and validate the stored source/trajectory evidence for the same tuple. Missing, duplicate, stale, or conflicting records remain unavailable with no dispatch and no success write.
- The UI must display read failures distinctly from an empty eligible-run list. Tool execution uses only existing `web_search`/`web_fetch` ToolRuntime policy with the validated Session/workspace context; no new Permission or approval bypass is allowed.
- No live research request, controlled fixture evaluation, test, build, or runtime acceptance has been run for Phase 1. The exact final source review and five allowed source checks remain pending after the selector/binding slice.

## 2026-10-05 Phase 1 source checkpoint

- Committed source SHA: `77f60d488a5f8f42c321deeb7b154e1def17c88b` (`feat(learning): bind research to stored run evidence`). It adds explicit persisted Session/run selection; native resolves the Session→Agent→enabled projection→canonical workspace and exact successful `session_runs` tuple; Bun looks up exactly one stored trajectory by run+Session, strictly decodes it, requires successful run outcome, and executes existing web tools only through current ToolRuntime policy in the bound Session/workspace context.
- Luna review rejected the initial caller-authority design and then reviewed the selector/binding implementation. A focused correction now defers output-directory creation until genuine findings are validated; binds the UI result to the captured Session/run and drops stale responses; rejects non-success trajectory snapshots before ToolRuntime creation; and validates response/run/session/digest and every finding's run, trajectory digest, Bun instance, tool call, source host/URL, content digest, and reference before writing.
- The five permitted exact-SHA source checks all passed for the committed SHA: Cargo check; server TypeScript typecheck; server build; UI build; and diff-check. The UI build reported its existing large-chunk advisory; Cargo reported existing warnings. Detailed logs and results are in `/Users/charlottehughes/Documents/Codex/2026-10-04/ca/work/opencode-memory/p3-1-source-77f60d4-checks.json`.
- No tests, runtime learning request, live research, controlled transfer evaluation, or acceptance evidence was run. These are not implied by source checks.
- Remaining Priority #3 work: Phase 2 frozen paired transfer evaluator; Phase 3 independent acceptance and staging/rollback gate; Phase 4 authorized synthetic-fixture transfer run and report. Priority #3 remains incomplete until these produce reviewed independent evidence.

## Priority 3 acceptance status

Controlled transfer evaluation is **NOT RUN**. There is no candidate effectiveness result, independent acceptance report, or basis to claim Priority #3 complete. Priority #4 source planning is authorized after the Phase 1 checkpoint; implementation remains queued until the planned Priority #3 work and its evidence gate are addressed.
