# Organism Loop v1 — Implementation Spec (Layer B)

**Companion to:** `docs/superpowers/plans/2026-07-02-tier1-moonshots-fable5-handoff.md` (Layer A — Autonomy charter, gap table, phased moonshots)
**Produced by:** Fable 5 planning session, 2026-07-02
**For:** Sonnet 5 implementer session (or any implementer following the handoff's Autonomy charter)

---

## Sonnet handoff — read this first

**Read order:**
1. `docs/superpowers/plans/2026-07-02-tier1-moonshots-fable5-handoff.md` — Autonomy charter (you have the same freedom to improve architecture; document deltas) + safety rails + entry-snapshot section (added alongside this spec — corrects the original gap table against verified repo state).
2. This document, in full, before touching code.
3. `server-jarvis/src/intelligence/skill-types.ts`, `skill-store.ts`, `skill-distiller.ts`, `skill-promotion.ts`, `skill-resolver.ts` — the existing pipeline this spec extends, not replaces.
4. `server-jarvis/src/index.ts` around lines 1740–1930 (resolve hook, pipelineOptions injection, distill hook) and 2960–3130 (existing `/skills/*` routes).
5. `server-jarvis/src-tauri/src/commands/skills.rs` lines 495–690 (Tauri commands, especially `sync_distilled_skill_candidates` which already exists).
6. `src-ui/src/components/jarvis/SkillsView.tsx`.

**Pitfalls (verified this session, not assumptions):**
- **Bun cannot open the native `jarvis.db`.** It's held open by the Rust process in WAL mode on a Windows path reached over the WSL 9p mount; a second opener can't coordinate the `-shm` file and gets `SQLITE_IOERR` on every write (`self-tuning/store.ts:188–193`). Never route candidate lifecycle writes through jarvis.db. Bun owns the JSON candidate store; native SQLite is a **pulled, one-way projection** via `sync_distilled_skill_candidates`.
- **The conductor's system prompt is KV-cache-guarded** (`persistent-conductor.ts:218–236`, hash-compared, A-02). Injecting a skills block there defeats prefix reuse on every turn. Any conductor-facing skill hint must ride the per-turn **user delta** (`buildTurnUserContent`, line 217), not the system prompt.
- **Coordinator routing happens before skill resolution.** `route()` (→ `task_type`) runs before `resolveSkillsForTurn(message, route.task_type)` at `index.ts:1781`. A conductor-side pre-match (before routing) cannot use `task_type` — it only has raw message signals.
- **The judge (`eval/judge.ts`) does exact-verbatim string matching** on rubric items — `covered.length / rubric.length`, no paraphrase credit, hallucinated "covered" items filtered against the literal rubric list. Write rubrics as short factual claims the candidate body either contains verbatim-ish or doesn't; don't expect semantic fuzziness.
- **Promotion currently runs automatically, inline, with no gate beyond heuristics.** The existing post-distill hook (`index.ts:1902–1921`) calls `runSkillPromotionPass()` immediately after every successful distillation — every candidate that clears 6 heuristic gates is already live and injecting into prompts, today, with zero human or semantic review. This spec's `auto_promote: false` default is a **behavior change** — document it loudly in the outcome doc; it's the single highest-leverage safety fix in this spec.
- **UI's native enable/disable toggle is a no-op for orchestration on distilled skills.** It writes `skills.enabled` in jarvis.db; the resolver reads `status === "promoted"` from the Bun JSON store, which the toggle never touches. Don't "fix" this by wiring the toggle to write JSON — replace it with explicit Promote/Demote actions (see D1).
- **`getStageRuns` access pattern in the distill hook is a private-field reach-through**: `outcomeCollector["store"].getStageRuns(agentRunId)` (index.ts:1902 area). Don't copy this pattern into new code — call the store directly or add a public method; note it but don't feel obligated to refactor unrelated to this work unless trivial.

---

## Data flow (organism loop v1, end to end)

```
User turn
 → conductor/coordinator route (produces task_type)
     [conductor user-delta includes resolveSkillsForConductor(message) hint — D4]
 → resolveSkillsForTurn(message, task_type)  [index.ts:1781]
 → distilledSkillsBlock → pipelineOptions    [index.ts:1803]
 → planner/executor stage prompts via resolveStagePrompt  [pipeline.ts:173–187]
 → run completes; outcome computed            [index.ts:1863, replan-loop.ts:140–165]
 → conductorLearning.completeRun → trajectory_snapshots (self-tuning.db)
 → distill hook (success only): distillSkillCandidate → candidate JSON
     (~/.openclaw/jarvis/skills/candidates/)  [index.ts:1902–1921]
 → heuristic SCREEN only (auto_promote=false — D2): junk rejected, passers stay candidate
 → operator opens SkillsView → sync_distilled_skill_candidates → SQLite projection → UI
 → operator: POST /skills/candidates/:id/promote → heuristic gates + judge vs source trajectory
 → status=promoted + promoted_at → UI re-sync → native row enabled=1
 → next matching turn: resolver injects; win rate measurable from agent_runs split at promoted_at
```

---

## Decisions

### D1 — Source of truth: Bun JSON candidate store owns distilled-skill lifecycle; native SQLite is a synced projection

- **Rationale:** Bun physically cannot open jarvis.db (WAL/9p, see pitfalls above); the resolver already reads JSON; `sync_distilled_skill_candidates` already exists and correctly sets `enabled = (status === promoted)` on both insert and update.
- **Consequences:**
  - All candidate lifecycle mutations (eval / promote / reject / demote) happen in Bun, exposed over HTTP. Precedent for UI→Bun HTTP already exists: `SystemHealthView` fetches `http://127.0.0.1:19877/health/inference`.
  - After any candidate action, the UI re-invokes `sync_distilled_skill_candidates` then `list_skills` to refresh the projection.
  - SkillsView's native enable/disable toggle is **wrong for distilled skills** — it writes native `enabled`, which the resolver never reads. For distilled skills the toggle is replaced by Promote/Demote actions hitting Bun. Bundled skills keep the native toggle unchanged.
- **Rejected alternative:** making native SQLite authoritative — rejected because Bun can't read it, and building a Tauri→Bun push channel is unjustified new infrastructure for a problem the pull-sync already solves.

### D2 — Judge-gated promotion (C-04)

- Keep the existing 6 heuristic gates in `evaluateSkillPromotion` as a cheap pre-screen, unchanged in order or logic. Add a semantic gate after them:
  - `buildGroundingRubric(candidate, snapshot)` — a deterministic rubric derived from the source trajectory snapshot (fetched via `SelfTuningStore.getTrajectorySnapshots` filtered to `source_run_ids[0]`, or by direct snapshot lookup if a by-id query is added). Rubric items are short factual claims, e.g.:
    - "mentions task type {taskType}"
    - "does not state an absolute path that is absent from the source run's stage outputs"
    - "every tool named in the body was actually invoked in the source run" (cross-check against `stage_runs`/`tool_sequence_digest`)
    - "includes a worker guidance section" — only included as a rubric item if the source `worker_instructions` was non-empty
  - `judgeAnswer(callModel, snapshot.user_request, candidate.body, rubric)` using `callModel` built by a new shared helper (extract `makeCallModel(cfg, stage)` out of `eval/semantic-harness.ts:116` into `server-jarvis/src/eval/call-model.ts`, export it, and re-import in semantic-harness.ts — no behavior change there, pure extraction).
  - Pass condition: `verdict.score >= cfg.orchestrator.skill_distillation.min_judge_score`.
- New function `promoteSkillCandidate(id, callModel, cfg)` in `skill-promotion.ts`: run heuristic gates (reuse `evaluateSkillPromotion`) → if heuristics pass, run judge gate → on pass, `updateSkillCandidateStatus(id, "promoted", verdict.score)` plus set new `promoted_at` field (see D5a type changes); on judge fail, `updateSkillCandidateStatus(id, "rejected", verdict.score, "eval_failed", detail)` where detail lists missed rubric items.
- **Config additions** to `SkillDistillationConfig` (`config.ts`): `min_judge_score: 0.75`, `auto_promote: false`, `distill_on: ["success"]` (array, for forward-compat with D3's deferred degraded-rescue policy — v1 only ever contains `"success"`).
- **Behavior change to document in the outcome doc:** the `index.ts:1902–1921` post-distill hook stops unconditionally calling the full `runSkillPromotionPass()`. New behavior: always run the **heuristic screen** (rejects junk immediately, same as today's gates 1–6), but only proceed to judge-gated promotion when `auto_promote === true`. With the new default `auto_promote: false`, candidates that clear the heuristic screen stay in `status: "candidate"` and wait for an operator action (or a future scheduled pass — see open questions). Setting `auto_promote: true` restores full automatic promotion including the judge gate, for operators who want the old (now safer, since judge-gated) behavior.
- **Grounding fallback:** if no trajectory snapshot is found for the candidate's `source_run_ids[0]` (e.g. pruned past `max_trajectory_snapshots`), judge against the candidate body plus whatever `stage_runs` output is still queryable for those run ids. If neither trajectory snapshot nor stage run data exists, promotion fails immediately with `rejection_reason: "eval_failed"`, `rejection_detail: "no grounding source available"` — never promote a candidate that can't be checked against its origin.

### D3 — Trajectory-backed distillation (C-01) — **ALREADY SHIPPED, do not re-implement**

> **Status update:** a separate maintenance session landed this exact design (commit `d0cea3c feat(distill): distill_on policy + audit/replay from trajectory snapshots`, 2026-07-02 08:07, on `master` before this spec was finalized). What follows describes what already exists — read it to understand the shipped behavior, then skip straight to D2 for the actual remaining work.
- `distillFromTrajectorySnapshot(input: { snapshot: TrajectorySnapshot, config: SkillDistillationConfig }): SkillCandidate | null` in `skill-distiller.ts` (lines 130–178) — parses `snapshot.snapshot_json`, maps fields onto `DistillationInput`, calls the existing `distillSkillCandidate`. Guards: `config.enabled`, `distill_on` policy, malformed JSON → null. The live post-run hook path in `index.ts` is unchanged — this is an additional entry point for replay/audit.
- `SkillDistillationConfig.distill_on?: ("success" | "degraded" | "failed")[]` already added to `config.ts` (default `["success"]`, non-breaking). `computeConfidence` in `skill-distiller.ts` already uses an outcome-dependent baseline (0.45 success / 0.30 degraded / 0.0 failed) so `distill_on: ["success","degraded"]` actually produces usable candidates instead of always failing the confidence gate (this was a real bug the landing session found and fixed in the same commit).
- CLI `server-jarvis/src/intelligence/redistill.ts` already exists: `--agent-run-id=<id>` / `--session-id=<id>` / `--all`, `--status=success|degraded|failed` filter, `--dry-run`. Reads via `SelfTuningStore.getTrajectorySnapshots`.
- 6 tests already in `skill-distillation.test.ts` (lines 277–445) covering the policy gate, confidence floors, snapshot round-trip, malformed JSON, and disabled config.
- **Not yet done (still relevant to this spec):** `tool_sequence_digest` on `SkillCandidate` (needed for D2's grounding rubric) was not part of the landed commit — still needs adding as part of D5a's type changes. The degraded-rescue *policy decision* (when should a live turn's hook actually set `distill_on` to include `"degraded"`) is still deferred pending B-04, matching this spec's original guidance — the landed commit only builds the mechanism, not a policy change to the live hook's default config.

### D4 — Conductor injection (C-03) — KV-safe delta only — **Done (2026-07-02, same session)**

> Implemented as designed below. See `docs/superpowers/plans/2026-07-02-organism-loop-outcome.md`
> "D4/D6/demos closeout" for exact files/tests.

- Hard constraint from the pitfalls section: never touch the conductor's system prompt path.
- New `resolveSkillsForConductor(message: string): string` in `skill-resolver.ts` — signal/requirement-only matching (no `task_type`, since routing hasn't happened yet) over `status === "promoted"` candidates using `classifyTurnRequirements(message).signals`. Returns a compact hint capped at 3 skills and roughly 400 characters: `- {name}: {description} (tasks: {task_types.join(", ")})` per line, empty string if nothing matches.
- Wire it into `buildTurnUserContent` in `persistent-conductor.ts` (around line 217) as an appended section of the per-turn user delta — never the system prompt.
- Stage injection for planner/executor via `resolveStagePrompt` (`pipeline.ts:173–187`, `worker-prompt.ts:60–81`) is unchanged; this decision only adds the conductor path that was previously missing (confirmed gap: conductor/coordinator prompt does not receive skills today).
- **Tests:**
  - Unmatched turn: conductor wire body (the JSON sent to Ollama) is byte-identical to today's baseline — reuse the wire-capture assertion pattern already established in `persistent-conductor.test.ts` for the A-02 prefix-reuse tests.
  - Matched turn: the user-delta content contains the matched skill's name.
  - `resolveStagePrompt` output is unchanged when `distilledSkillsBlock` is `undefined` — pin this with a snapshot/equality test (behavior already holds; this just guards against regression).

### D5 — Cockpit (C-05): extend `SkillsView`; no separate `SelfImprovementView` in v1

- Rationale for not building a new view: the existing `SkillsView` already has a `candidates` filter and a detail panel; the missing pieces are data fields and actions, not a new page. A separate view is deferred to a later pass if the combined view gets crowded — not forbidden, just not necessary for the MSS.
- Candidate detail panel additions: `confidence`, `eval_score`, `eval_missed`, `rejection_reason` + `rejection_detail`, `source_session_id`, `source_run_ids`, `promoted_at`.
- New actions, shown only for skills where `metadata.source === "trajectory_distillation"` (i.e. distilled skills — bundled skills keep their existing enable/disable toggle unchanged):
  - **Run eval** — calls the eval endpoint, updates the displayed `eval_score`/`eval_missed`, does not change status.
  - **Promote** — calls the promote endpoint.
  - **Reject** — calls the reject endpoint.
  - **Demote** — calls the demote endpoint (only enabled when status is `promoted`).
  - **Revert** — existing `skill_restore_revision` Tauri command, unchanged.
  - After every action: call `sync_distilled_skill_candidates()` then re-fetch `list_skills()` to refresh (same pattern already used on mount).
- **"Performance since promotion" panel:** query the self-tuning DB for `agent_runs` where `task_type` is in the candidate's `trigger.task_types`, split into a "before" window and an "after" window at `promoted_at` (equal-length windows — use the same duration before `promoted_at` as has elapsed after it, capped at whatever history exists), report run counts, success counts, success rate, and the delta. Reuses the existing `getAgentRuns` / `getAgentPerformance` query patterns in `self-tuning/store.ts` — add a new query method rather than raw SQL in the route handler.

### D5a — API contract (request/response shapes — implement exactly as specified, do not invent alternate shapes)

**Type changes first**, in `server-jarvis/src/intelligence/skill-types.ts`:
- `SkillCandidate` gains: `promoted_at?: string` (ISO 8601 timestamp, set on promote, cleared on demote), `tool_sequence_digest?: string` (set by D3's distiller), `eval_missed?: string[]` (rubric items missed on the most recent judge run, for UI display).
- `SkillRejectionReason` gains two new members: `"eval_failed"` and `"manual"`.
- **Error convention** for every new route below: non-2xx responses have body `{ "error": string, "detail"?: string }`. The `:id` path segment is the candidate's `id` field from the skill store, URL-encoded.

---

`GET /skills/candidates?status=candidate|promoted|rejected` — **existing route, payload now includes the new fields**:
```json
{
  "candidates": [
    {
      "id": "skill_debug_a1b2c3d4",
      "name": "...",
      "description": "...",
      "trigger": { "task_types": ["debug"], "requirements": ["workspace_read"], "signals": ["path:file_ext"] },
      "body": "# Distilled: debug\n...",
      "source_run_ids": ["run_..."],
      "source_session_id": "sess_...",
      "confidence": 0.72,
      "status": "candidate",
      "eval_score": 0.8,
      "eval_missed": [],
      "rejection_reason": null,
      "rejection_detail": null,
      "promoted_at": null,
      "tool_sequence_digest": "sha256:...",
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

**`POST /skills/candidates/:id/eval`** — body: none. Runs the judge, persists `eval_score` + `eval_missed`, does **not** change status.
```json
200 { "id": "...", "status": "candidate",
      "verdict": { "score": 0.8, "covered": ["..."], "missed": ["..."], "rationale": "..." } }
404 { "error": "candidate_not_found" }
503 { "error": "judge_unavailable", "detail": "<model call failure>" }
```

**`POST /skills/candidates/:id/promote`** — body: none. Runs heuristic gates then judge gate.
```json
200 (pass) { "id": "...", "status": "promoted", "eval_score": 0.83, "promoted_at": "2026-07-02T..." }
200 (fail) { "id": "...", "status": "rejected", "rejection_reason": "eval_failed",
             "rejection_detail": "missed: does not state absolute paths...", "eval_score": 0.4 }
404 { "error": "candidate_not_found" }
409 { "error": "wrong_status", "detail": "status is promoted" }
503 { "error": "judge_unavailable", "detail": "..." }
```
Note on 503: a judge call failure leaves the candidate in `status: "candidate"` (it does not get rejected on infra failure) — only a judge response that actually scores below threshold produces a rejection.

**`POST /skills/candidates/:id/reject`** — body: `{ "reason"?: string }` (stored as `rejection_detail`; `rejection_reason` is always `"manual"` for this route).
```json
200 { "id": "...", "status": "rejected", "rejection_reason": "manual" }
404 / 409 as above
```

**`POST /skills/candidates/:id/demote`** — body: none. `promoted → candidate`; clears `promoted_at` and any rejection metadata (existing `updateSkillCandidateStatus` semantics already clear rejection fields on a non-`rejected` status transition — reuse it).
```json
200 { "id": "...", "status": "candidate" }
404 / 409 as above
```

**`GET /skills/candidates/:id/performance`** — only meaningful when `status === "promoted"`.
```json
200 { "id": "...", "promoted_at": "2026-07-02T...", "task_types": ["debug"],
      "before": { "runs": 14, "successes": 9, "success_rate": 0.64 },
      "after":  { "runs": 6,  "successes": 5, "success_rate": 0.83 },
      "delta": 0.19 }
409 { "error": "wrong_status", "detail": "status is candidate" }
```
`delta` is `null` when either window has 0 runs.

**Existing routes, unchanged shape:** `POST /skills/promote` (bulk pass) keeps its `{ promoted, rejected, total_evaluated }` response shape but its internal behavior now respects `auto_promote` and the judge gate. `GET /skills` (bundled/custom disk skills, separate from candidates) is untouched.

### D6 — Eval harness additions (C-04) — **Done (2026-07-02, same session)**

> Implemented as designed below (3 cases, `baseline.json` refreshed to 38/38). See the outcome doc's
> "D4/D6/demos closeout" section.

- The existing 2 skill cases in `eval/cases.ts` (`skill/trigger-debug-promoted`, `skill/regression-candidate-not-injected`) already cover what the handoff calls `skill_trigger` and `skill_regression`. Formalize this naming in a doc comment but don't rename the case ids (would break `baseline.json` diffing for no benefit).
- Add a new case kind `skill_grounding`: deterministic tests of `buildGroundingRubric` (D2) against fixture trajectory snapshots, plus the judge path exercised with a **mocked** `callModel` that returns a canned JSON verdict (no live model calls in `bun test` — that stays in `eval/semantic-harness.ts`).
- Add one "bad skill" fixture whose body states an invented absolute path (e.g. `C:\fake\path\that\does\not\exist`) not present in its source snapshot — this must fail grounding (score below `min_judge_score` given the mocked judge response, or fail a "no invented paths" rubric item deterministically). This is the C-04 acceptance criterion from the handoff ("bad skill... fails and stays disabled").
- After adding cases, run `bun run src/eval/harness.ts --write-baseline` to refresh `eval/baseline.json`; commit the updated baseline alongside the new cases.

---

## State machine (candidate lifecycle)

```
(distill) → candidate
candidate --heuristic screen fail--> rejected(reason: below_eval_delta | low_confidence |
                                              suspicious_paths | body_length_out_of_range |
                                              missing_signals | wrong_status)
candidate --Run eval--> candidate (eval_score, eval_missed recorded; no status change)
candidate --Promote: heuristic gates + judge pass--> promoted (promoted_at, eval_score set)
candidate --Promote: judge fail--> rejected(eval_failed, eval_missed populated)
candidate --Reject (manual)--> rejected(manual)
promoted --Demote--> candidate (promoted_at cleared; native row enabled=0 after next sync)
rejected --Reconsider (re-run distillation superset, or manual)--> candidate
  (updateSkillCandidateStatus already clears rejection metadata on non-rejected transitions)
```

Config keys governing transitions (`orchestrator.skill_distillation` in `config.ts`):
```json
{
  "enabled": true,
  "min_confidence": 0.55,
  "promotion_eval_delta": 0.02,
  "max_candidates": 200,
  "min_judge_score": 0.75,
  "auto_promote": false,
  "distill_on": ["success"]
}
```

---

## Files & hooks

| Area | File | What's there today | What changes |
|---|---|---|---|
| Types | `server-jarvis/src/intelligence/skill-types.ts` | `SkillCandidate`, `SkillCandidateStatus`, `SkillRejectionReason` | Add `promoted_at`, `tool_sequence_digest`, `eval_missed`; extend `SkillRejectionReason` with `eval_failed`, `manual` |
| Store | `server-jarvis/src/intelligence/skill-store.ts` (1–95) | `saveSkillCandidate`, `loadSkillCandidate`, `listSkillCandidates(status?)`, `updateSkillCandidateStatus`, `pruneSkillCandidates` | No signature changes; new fields flow through existing JSON read/write since it's untyped-at-rest serialization |
| Distiller | `server-jarvis/src/intelligence/skill-distiller.ts` (75–110) | `distillSkillCandidate(input, config)` | Add `distillFromTrajectorySnapshot(snapshotJson, config)`; add `tool_sequence_digest` computation |
| Promotion | `server-jarvis/src/intelligence/skill-promotion.ts` (1–138) | `scoreSkillCandidate`, `evaluateSkillPromotion`, `runSkillPromotionPass` | Add `buildGroundingRubric(candidate, snapshot)`, `promoteSkillCandidate(id, callModel, cfg)`; `runSkillPromotionPass` gains judge-gate call when `auto_promote` true |
| Resolver | `server-jarvis/src/intelligence/skill-resolver.ts` (1–45) | `resolveSkillsForTurn(message, taskType, stage?)` | Add `resolveSkillsForConductor(message)` |
| Judge extraction | `server-jarvis/src/eval/semantic-harness.ts:116` (`makeCallModel`) | Local helper | Extract to new `server-jarvis/src/eval/call-model.ts`, export, re-import in both semantic-harness.ts and skill-promotion.ts |
| Conductor | `server-jarvis/src/orchestration/persistent-conductor.ts` (210–291, esp. 217) | `buildTurnUserContent`, hash-guarded system prompt | Append conductor skill hint to user delta only |
| Server routes | `server-jarvis/src/index.ts` (1740–1930 hooks; 2960–3130 routes) | Resolve hook (1781), pipelineOptions (1803), distill hook (1902–1921), `/skills/candidates` GET, `/skills/promote` POST | Distill hook: screen-then-conditionally-promote per `auto_promote`; new routes: `POST /skills/candidates/:id/{eval,promote,reject,demote}`, `GET /skills/candidates/:id/performance` |
| Config | `server-jarvis/src/config.ts` (213–222 type, 464–469 defaults) | `SkillDistillationConfig` | Add `min_judge_score`, `auto_promote`, `distill_on` |
| Self-tuning queries | `server-jarvis/src/self-tuning/store.ts` | `getAgentRuns`, `getAgentPerformance`, `getTrajectorySnapshots` | Add a windowed query method for the performance-since-promotion split (e.g. `getAgentRunsInWindow(taskTypes, before, after)`) |
| Native sync | `server-jarvis/src-tauri/src/commands/skills.rs` (620–690) | `sync_distilled_skill_candidates` | No changes required — already correct for this design; verify it round-trips the new fields into `metadata` JSON if you want them visible without a Bun round-trip (optional, not required since UI hits Bun directly for actions) |
| UI | `src-ui/src/components/jarvis/SkillsView.tsx` (454 lines) | Filters, enable/disable, revisions, restore | Add candidate detail fields, action buttons calling new Bun routes, performance panel |

---

## Tests to add

- `server-jarvis/src/intelligence/skill-distillation.test.ts` (existing file): add cases for judge-gated promotion — mock `callModel` returning canned `JudgeVerdict`; assert pass → `promoted` with `promoted_at` set; assert fail → `rejected` with `eval_failed` + `eval_missed`; assert judge-unavailable (`callModel` throws) → stays `candidate`, no status change.
- Same file: add case for `distillFromTrajectorySnapshot` — fixture snapshot JSON in, candidate out, confidence/body match what `distillSkillCandidate` would produce from the equivalent `DistillationInput`.
- `server-jarvis/src/orchestration/persistent-conductor.test.ts` (existing file): add the three D4 tests — unmatched-turn wire-body equality, matched-turn delta contains skill name, no-skills-block prompt equality — following the existing wire-capture pattern used for A-02.
- `server-jarvis/src/eval/cases.ts` + `server-jarvis/src/eval/harness.ts`: add `skill_grounding` case kind and at least 2 cases (one good skill grounds cleanly, one bad-path skill fails grounding). Add fixture snapshot JSONs under `server-jarvis/src/eval/fixtures/` (new directory — none exists today, harness/semantic-harness currently build fixtures inline via `mkdtempSync`; a committed fixtures directory is appropriate here since these are static grounding inputs, not temp workspaces).
- `server-jarvis/src/eval/harness.test.ts`: no new test needed beyond the existing "0 failures" and "no baseline drift" assertions, which will now cover the new cases automatically once `baseline.json` is refreshed.
- New unit tests for the HTTP routes (`index.test.ts` or wherever existing `/skills/*` routes are tested — check for an existing routes test file before creating a new one) covering the 5 new endpoints' success and error paths from the D5a contract.

---

## Acceptance demos

Document these in `docs/superpowers/demos/organism-loop-v1.md` per the handoff's Task 1.6.

**D1 — Promoted skill changes routing:**
1. Seed a promoted skill candidate matching `workspace_read` + a path signal (either via a real successful run + manual promote, or by directly constructing a candidate JSON with `status: "promoted"` and dropping it in `~/.openclaw/jarvis/skills/candidates/`).
2. Send a chat turn that triggers `workspace_read` classification and matches the skill's `task_types`/signals.
3. Expected: server logs show the turn classified as `workspace_read`; the executor stage prompt (visible via debug logging or a temporary log line) contains the skill's body; the final answer's tool usage is consistent with the skill's guidance.

**D2 — No skill, baseline behavior:**
1. Same message as D1, but with the skill candidate either absent or left at `status: "candidate"` (not promoted).
2. Expected: identical routing/classification, but the executor prompt lacks the skill appendix — same as pre-organism-loop behavior.

**D3 — Distill → promote → repeat improves the second turn:**
1. Trigger a turn that goes through a replan (`conductor_replan`) to completion, or any turn producing a `success` outcome with a non-trivial `worker_instructions`.
2. Confirm a candidate appears via `GET /skills/candidates?status=candidate`.
3. `POST /skills/candidates/:id/promote` and confirm `status: "promoted"`.
4. Repeat a similar task-type request.
5. Expected (measure via `self-tuning.db` `agent_runs`/`stage_runs`, or judge score if comparable): fewer stages, lower latency, or higher subsequent judge score than the first attempt — record the actual before/after numbers, don't just claim improvement.

Copy-paste smoke commands (adjust host/port to the running Bun server, default `127.0.0.1:19877`):
```bash
curl -s http://127.0.0.1:19877/skills/candidates?status=candidate | jq
curl -s -X POST http://127.0.0.1:19877/skills/candidates/<id>/eval | jq
curl -s -X POST http://127.0.0.1:19877/skills/candidates/<id>/promote | jq
curl -s http://127.0.0.1:19877/skills/candidates/<id>/performance | jq
```

---

## Minimum shippable slice

Ship in this order; each step should leave `bun test` green:

1. Config keys (`min_judge_score`, `auto_promote`, `distill_on`) + type changes (`skill-types.ts`) + distill-hook behavior change (screen-only when `auto_promote: false`).
2. `promoteSkillCandidate` with the judge gate; `makeCallModel` extraction into `eval/call-model.ts`.
3. The 5 per-candidate HTTP endpoints (eval/promote/reject/demote/performance).
4. `SkillsView` updates: confidence/eval/rejection display, action buttons, sync-after-action.

**Demo that proves the flywheel closed:** a successful turn produces a candidate visible in `SkillsView`; clicking Promote runs the judge and flips status; the next matching turn's executor prompt provably contains the skill block (verify via logs and/or a `self-tuning.db` query showing the skill's `source_run_ids` distinct from the new turn's `agent_run_id`).

**Later slices — all now done** (D3 trajectory-backed distiller was already shipped independently — see D3 status note above; D4 conductor delta injection, D5's performance-since-promotion panel, and the golden demos doc were completed in a same-session follow-up pass — see the outcome doc's "D4/D6/demos closeout" section for exact files/tests). The only genuinely open item from this spec is **running D3's live demo and recording real numbers** — no Bun server was running during implementation, so the demos doc's D3 section is an accurate recipe, not a captured result.

---

## Open questions left for the implementer

- **Judge model stage label:** reuse the existing `"orchestrator"` pool stage for judge calls, or introduce a dedicated `"judge"` stage label so the agent pool can route it independently? Either is defensible; if a dedicated label is added, the pool must be configured to land on a non-reasoning model for it (see the `minimax-m3` memory note on why: reasoning-model `<think>` output breaks strict-JSON judge parsing).
- **Scheduled/batch promotion pass:** should there be a cron-triggered `runSkillPromotionPass` (with `auto_promote` effectively forced on for the batch) so candidates don't pile up waiting for an operator to click through SkillsView one at a time? Out of scope for the MSS; worth a follow-up issue.
- **SkillsView native toggle for distilled skills:** this spec says hide/replace it with Promote/Demote (D5). An alternative is to keep it visible but make it proxy to the new promote/demote endpoints instead of the native `enable_skill`/`disable_skill` commands. Either is acceptable; document whichever is chosen.
- **Exact fixture format for `skill_grounding` cases:** this spec recommends 2 committed fixture JSONs under `server-jarvis/src/eval/fixtures/` (new directory). The precise snapshot shape should mirror the real `trajectory_snapshots.snapshot_json` structure from `conductor-learning.ts` — copy a real (redacted) snapshot as a starting point rather than hand-authoring one that might drift from the real schema.

---

## Phase 2/3 forward pointers (not specced in depth — Phase 1 is the priority)

- **Fleet stage:** survey `server-jarvis/src/bridge.ts` and the Hermes gateway integration point before designing; correlate via `jarvis_agent_run_id` ↔ `hermes_child_id`. Not blocked by anything in this spec — could be picked up in parallel if it's a faster path to "remarkable" per the handoff's autonomy charter.
- **Shadow tournament:** no shadow/tournament code exists in the repo today (confirmed this session) — only the ε-greedy instruction-variant bandit in `conductor-learning.ts`. A new table would append to `SELF_TUNING_SCHEMA` in `self-tuning/store.ts` (confirmed migration pattern: schema-in-code + `CREATE TABLE IF NOT EXISTS` + guarded `ALTER`). Arms would reuse the `makeCallModel` extraction from D2 and `judgeAnswer`. Entry point: `bun run src/eval/shadow-tournament.ts --once`.
