# Roadmap Priority 3 — Status and evidence

**As of:** 2026-10-05  
**Scope:** Roadmap Priority #3, “Prove that learning improves future work.”  
**State:** Source implementation is active under the user-directed sequence override. Priority #1 and #2 acceptance remain open/NOT RUN. Priority #4 stays queued until Priority #3 completion evidence passes.

## Sequence ruling

The user explicitly authorized Priority #3 source work and the roadmap controlled transfer evaluation before Priority #1 or #2 runtime acceptance. This does not waive or satisfy either open acceptance gate. See the [current roadmap](../CURRENT_ROADMAP.md) and [four-phase implementation plan](../superpowers/plans/2026-10-05-roadmap-priority-3-learning-effectiveness.md).

## Phase 1 authority gate

- The original `run_learning_session` command had no UI caller, caller-bound Session/run identity, or persisted link to source trajectory evidence. Its old placeholder output was fabricated.
- The first DeepSeek source pass added a native URL validator and private Bun research machinery. Luna review rejected caller-supplied Agent/Session/snapshot fields as authority.
- A focused correction removed those fields. The native command now returns explicit `unavailable`, no findings, and no output path when it cannot resolve an authoritative run; it does not dispatch research or create a file. This is fail-closed source behavior, but it leaves the intended source-backed success path unavailable.
- The user-directed follow-up is to add explicit user selection of a persisted Session and exact completed Agent run as selectors only. Native must reread and validate the run, Session, Agent, enabled projection, and canonical workspace; Bun must resolve and validate the stored source/trajectory evidence for the same tuple. Missing, duplicate, stale, or conflicting records remain unavailable with no dispatch and no success write.
- The UI must display read failures distinctly from an empty eligible-run list. Tool execution uses only existing `web_search`/`web_fetch` ToolRuntime policy with the validated Session/workspace context; no new Permission or approval bypass is allowed.
- No live research request, controlled fixture evaluation, test, build, or runtime acceptance has been run for Phase 1. The exact final source review and five allowed source checks remain pending after the selector/binding slice.

## Priority 3 acceptance status

Controlled transfer evaluation is **NOT RUN**. There is no candidate effectiveness result, independent acceptance report, or basis to claim Priority #3 complete. Priority #4 remains queued.
