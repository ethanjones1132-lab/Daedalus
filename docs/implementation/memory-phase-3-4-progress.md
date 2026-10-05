# Memory Phase 3.4 — Reviewed source handoff

**Planning:** Luna (`gpt-6-luna`).
**Execution:** DeepSeek v4.1 Flash (`opencode-go/deepseek-v4.1-flash`) through sequential OpenCode passes.
**Branch:** `codex/memory-deepseek-20261004`.
**Baseline:** Part 3.3 source checkpoint `ceb5d9830397d720c9b610cb468ece67fa9d0713`.
**Status:** Source implemented, reviewed and independently compiled/bundled. No tests or runtime acceptance were run.

## Native continuity and capture

- Exact saved-user controls: `Objective: <text>`, `Clear active objective`, `Continue active objective`. The objective suffix retains its exact bytes, must be non-whitespace and fit 4,096 UTF-8 bytes. Ordinary messages and corrections preserve the accepted objective. No old summary, assistant suggestion, or keyword guess seeds typed state.
- Preparation previews typed continuity without durable writes or recursive mutation gates. A valid replacement is available on its own turn, including with zero recalled facts. Capture commits replacement/clear with the operation, audit, receipt and ledger inside the same savepoint. Resume adds no saved/pending operation and does not rewrite native objective revision.
- The objective namespace has one exclusive `turn/<id>/user/0` operation: Saved for objective replacement, Forgotten for clear, Blocked for stale instructions, Pending for malformed directives. Words such as Remember inside goal text are data. Existing memory-only hashes remain byte-compatible; exact legacy receipts replay without retroactively admitting objectives or changing revisions.
- Additive action and manual boundary columns retain monotonic source ordering through clear, source deletion, restart and manual selection of older saved source. Complete old null metadata remains compatible; partial/corrupt cursors fail closed. Preview, classification, cleanup planning and commit use the same ordering policy.
- `memory_continuity_read` and `memory_continuity_set` are registered. The operator setter requires same-Session saved user source, exact substring/clear proof, positive expected revision for a new operation, and wire-safe operation ID before replay/cleanup. Its canonical hash binds exact source bytes; replay returns the original response/revision only after source revalidation.
- Automatic capture validates canonical saved source/hash/role/Session/terminal observation before derived cleanup. Objective changes invalidate the originating Session only; rejected/replayed controls do not select memory-scope cleanup. Existing capture/recovery/direct/relay paths share this gate.

## Bun context and task state

- The optional private continuity preview is mirrored in the envelope, registered through the native capability route, strictly validated and deeply cloned/frozen. Session identity, safe integer revision, nullable IDs, source/turn binding, mode/objective agreement, text/array/ID bounds and unknown fields are checked. Ordinary HTTP callers cannot supply goal authority.
- Native and Bun share one JSON-escaped frame, ordered objective then memories, with objective excerpt at most 600 Unicode scalars and whole frame at most 4,000 scalars. Provider fitting drops whole lowest-ranked memory entries and keeps applied IDs aligned. Objective-only context is valid; an objective frame that cannot fit is omitted with budget_omitted. Memory-only framing remains compatible.
- Preserve builds an independent ephemeral question TaskRun with fresh identity, plan, progress and evidence. Routing, planning, pipeline callbacks and completion use that local contract; the stored task remains unchanged. Independent executed tool/file/check caches stay available.
- Resume forces continuation of the accepted native goal, retaining task identity, plan/evidence/grants and advancing real task progress under the existing ownership and invalidation guards. Neutralized or mismatched cached goal text is repaired from typed native state; mismatched plan text is marked for reconstruction without discarding independent executed evidence. No summary-derived goal revival.
- Replace establishes a fresh task text/plan/progress boundary for the originating Session; old evidence counts are not attributed to the new goal. Clear ends that active boundary and removes its continuation requirement. The clear turn itself uses a local contract so completion cannot reactivate the cleared run.
- Native mode requirement, depth, write intent and provider budget use the same effective task. Only an exact matching resume inherits previous task intent. Side questions and replacement goals classify independently. Accepted goal text never grants filesystem roots. Side questions retain their existing narrower read scope.
- Registry consumption uses the original request message/hash first. Actual downstream inference, tool-intent, prompt, routing and acceptance consumers use the effective accepted goal on resume/replace. Internal continuation cues remain confined to trusted routing. Original native source/receipt identity is unchanged.

## Safe compatibility and UI

`review_session` reads typed capture receipts only. It validates identity, revisions, operation IDs and count/status agreement, reports Saved/Corrected/Forgotten separately from Pending/Blocked, and creates zero memories or skills. `commit_session_end` resets review bookkeeping only. Neither calls summary extraction, deferred review, consolidation or housekeeping. Stable commands/signatures remain compatible.

The Part 3.3 UI receipt decoder/projection is unchanged. Only small labels changed: Saved (N), Capture pending, Capture failed, No new saved items. They describe objective/forget/clear outcomes without claiming factual memory rows or unchanged durable state.

## Independent source checks

Root independently checked the final reviewed production diff against baseline `ceb5d9830397d720c9b610cb468ece67fa9d0713` before checkpointing.

| Check | Result | Elapsed |
|---|---|---|
| cargo check | PASS (exit 0) | 4.37s |
| Bun server typecheck | PASS (exit 0) | 3.25s |
| Bun server build | PASS (exit 0) | 0.07s |
| UI build | PASS (exit 0) | 7.61s |
| git diff --check | PASS (exit 0) | 0.05s |

Rust reported only preexisting supervisor.rs/wsl.rs warnings. UI retained the existing large-chunk warning. Server bundled 197 modules; UI transformed 2,719 modules. A static added-line/file scan found no added test declarations or changed test files. These are compiler/type/build checks, not runtime acceptance.


## Environment and execution record

Several exact-model corrective passes resolved root source-review findings before finalization. OpenCode automatically rejected external cache and /tmp access; no permission settings were changed. Root restored exact already-installed dependency files offloaded by iCloud, removing their ignored placeholders before writing canonical paths. Installed package versions, manifests and lockfiles were unchanged; no ambient type shim was introduced. Earlier interrupted or failed checks are historical and do not establish the final result.

## Open acceptance — NOT RUN

No tests, test files/declarations, live acceptance experiments or packaged runs were added/run. Admission/replay/rollback, stale/manual objective ordering, direct/relay interruption, side-question preservation, forced resume, safe review/end, correction/forget races, restart and cross-Session/project/Agent cases require runtime evidence. Compiler/type/build checks establish source compilation and bundling only. Generic verified-observation auto-capture remains unsupported. Priority #1 remains active; memory Phase 4 and roadmap priorities #2–#5 remain pending.
