# Orchestration Supervision-Starvation Remediation — Implementation Plan

**Date:** 2026-07-16 (afternoon)
**Source diagnosis:** `docs/DIAGNOSIS_ORCHESTRATION_SUPERVISION_2026-07-16.md` (findings F1–F10, all CONFIRMED against `self-tuning.db` session `a074271b`, build `d8c505f`+dirty)
**Goal:** make the diagnosed failure classes *structurally impossible* — deterministic guards instead of prompt hope, usage-based budgets instead of wall-clock windows, partial answers instead of refusals — and make any new failure class loud (honest errors, attributed supervision, deep-read smoke coverage).

**Scope of guarantee (read first):** this plan eliminates every failure class observed in the 2026-07-16 PM forensics and pins each with a regression test plus a live-fire DB check. It cannot promise "no further errors" — F1 and F2 were themselves interaction regressions of correct earlier fixes (live supervision shipped to fix an inert conductor; the T1.1 anti-re-arm shipped to fix coordinator retry burn). The defense against the *next* interaction regression is Phase 0 (invariant harness) and Phase 9 (live-fire gate), not any single fix.

**Execution order matters.** Phases 1–3 are the payload; each is independently shippable and verifiable. Phases 4–8 harden. Phase 9 gates deployment. Within a phase, follow TDD: write the failing test, watch it fail, implement, watch it pass, commit.

---

## Phase 0 — Pin the incident as fixtures

**Files:** create `server-jarvis/src/orchestration/incident-20260716.test.ts`

- [x] **0.1** Write a fixture test replaying run `run_5283dd64`'s exact timing against `createTurnBudget("full_execution","high",T0)`:
  - `beginStage("planner", T0+14s)`; advance clock to T0+88s; assert `canStart("planner")` — **currently false (bug), must become true** after Phase 2 (planner *used* only ~50s of its 60s budget; wall-clock elapsed is 74s).
  - `beginStage("reviewer", T0+58s)`; advance to T0+109s; assert `stageRemainingMs("reviewer") === 60_000 − usedMs`, not `60_000 − 51_000`.
  - Mark both assertions `.todo`/failing until Phase 2 lands, then flip them green. This is the falsifiability contract from the diagnosis, executable.
  - Landed: `server-jarvis/src/orchestration/incident-20260716.test.ts` (bug pins + F2 todos).
- [x] **0.2** Write a fixture test for the conductor digest: `afterStage("planner","completed", "<750-token plan text>", ["executor","reviewer","synthesizer"], { request: "Identify all remaining gaps in the repo…", workspaceRoot: "C:\\Projects\\Versutus" })` with a stub supervisor that *always* answers `{"directive":"reroute","newRemaining":["re-enter:planner"]}` — assert the returned directive is `continue` (deterministic guard must win over the model). Failing until Phase 1.
  - Landed: bug pin (reroute currently admitted) + F1 `test.todo` for the continue contract.
- [x] **0.3** `git commit -m "test(orchestration): pin 2026-07-16 supervision-starvation incident fixtures"`

---

## Phase 1 — F1: stage-aware supervision + deterministic reroute policy

**Files:** modify `server-jarvis/src/orchestration/conductor.ts`, `server-jarvis/src/orchestration/reroute-policy.ts`, `server-jarvis/src/orchestration/pipeline.ts:685-720` (planner call sites); tests `conductor.test.ts`, `reroute-policy.test.ts`

- [ ] **1.1** `reroute-policy.ts` — grow the module into the actual policy (it currently only holds the counter check):

```ts
export const EVIDENCE_CAPABLE_STAGES = new Set<string>(["executor", "rewriter"]);

export interface RerouteValidationInput {
  triggerStage: string;
  triggerOutcome: "completed" | "failed";
  newRemaining: string[];
  reason: string;
}

const EVIDENCE_RUBRIC_REASON = /\bevidence\b|\btool (?:calls?|results?|outputs?)\b|\bworkspace\b/i;

/** Deterministic reroute admission. Returns null when admissible, else a rejection reason. */
export function rejectReroute(input: RerouteValidationInput): string | null {
  const reentersSelf = input.newRemaining.some(
    (s) => s === `re-enter:${input.triggerStage}` || s === input.triggerStage,
  );
  // A stage that just completed cleanly may not be re-entered by directive —
  // EXCEPT the evidence-capable stages, whose completed-with-evidence-gap
  // re-entry is the legitimate deterministic deep-read top-up pattern
  // (conductor.ts:110-124 emits exactly this and it flows through this gate).
  if (
    input.triggerOutcome === "completed" &&
    reentersSelf &&
    !EVIDENCE_CAPABLE_STAGES.has(input.triggerStage)
  ) {
    return "self_reroute_after_clean_completion";
  }
  // Evidence-motivated reroutes may only target evidence-capable stages.
  if (
    EVIDENCE_RUBRIC_REASON.test(input.reason) &&
    input.newRemaining.some((s) => s.replace(/^re-enter:/, "") === "planner")
  ) {
    return "evidence_reroute_targeting_toolless_stage";
  }
  return null;
}
```

- [ ] **1.2** Tests first in `reroute-policy.test.ts`: completed-planner self-reroute rejected; failed-planner self-reroute admitted (genuine retry); evidence-reasoned planner reroute rejected even from executor trigger; executor evidence reroute to `re-enter:executor` admitted.
- [ ] **1.3** Wire into `pipeline.ts` `afterConductorStage` (currently at `:509-526`): before `normalizeRemainingStages`, call `rejectReroute({ triggerStage: stage, triggerOutcome: outcome, newRemaining: directive.newRemaining, reason: directive.reason ?? "" })`; on rejection `console.warn` with the rejection reason, record the directive in `conductor_directives` with `directive_type: "reroute_rejected"`, and treat as `continue`. The audit row is load-bearing: Phase 9 queries it.
- [ ] **1.4** `conductor.ts` — stage-aware digests. In `afterStage` (`:105`), compute `evidenceAssessment` **only when** `EVIDENCE_CAPABLE_STAGES.has(stage)`; make `SupervisionDigest.evidenceAssessment` optional; in `supervise()` (`:171`) render the line as `Evidence assessment: not applicable — the ${stage} stage produces no tool calls by design` when absent. Test: planner-completed digest text must not contain `"sufficient":false`.
- [ ] **1.5** Pass real context at the planner call sites — `pipeline.ts:685/:702/:720` currently omit the evidence arg entirely; pass `{ request: options.rawMessage ?? request, workspaceRoot: this.ctx.workspace_path || this.ctx.config.jarvis_path || process.cwd() }` so nothing downstream ever assesses against `request: ""` again.
- [ ] **1.6** Flip fixture 0.2 green. Run `bun test src/orchestration/reroute-policy.test.ts src/orchestration/conductor.test.ts src/orchestration/incident-20260716.test.ts`. Commit: `fix(orchestration): stage-aware supervision digests + deterministic reroute admission (F1)`.

---

## Phase 2 — F2 + F3: usage-based stage accounting + honest exhaustion errors

**Files:** modify `server-jarvis/src/orchestration/turn-budget.ts`, `server-jarvis/src/stream-liveness.ts`, `server-jarvis/src/index.ts:1844-1906` (beginStage/canStart path); tests `turn-budget.test.ts` (create if absent), `orchestration.test.ts:1120` (describePipelineError mapping)

- [ ] **2.1** `turn-budget.ts` — replace wall-clock anchoring with cumulative usage:

```ts
const stageUsedMs = new Map<string, number>();
const stageInflightStart = new Map<string, number>();

beginStage(stage, now = Date.now()) {
  if (this.stage_ms[stage] === undefined) return;
  if (!stageInflightStart.has(stage)) stageInflightStart.set(stage, now);
},
endStage(stage, now = Date.now()) {              // NEW — add to TurnBudget interface
  const start = stageInflightStart.get(stage);
  if (start === undefined) return;
  stageInflightStart.delete(stage);
  stageUsedMs.set(stage, (stageUsedMs.get(stage) ?? 0) + Math.max(0, now - start));
},
stageRemainingMs(stage, now = Date.now()) {
  const stageBudget = this.stage_ms[stage];
  if (stageBudget === undefined) return this.remainingMs(now);
  const inflight = stageInflightStart.has(stage) ? now - stageInflightStart.get(stage)! : 0;
  const used = (stageUsedMs.get(stage) ?? 0) + Math.max(0, inflight);
  return Math.max(0, Math.min(stageBudget - used, this.remainingMs(now)));
},
```

  `stageStreamDeadlineAt` becomes `now + stageRemainingMs(stage, now)` clamped by `deadlineAt`. Retries within one attempt window still share budget (each attempt's duration accumulates into `used`) — the T1.1 property that motivated wall-clock anchoring is preserved, but idle time between segments no longer counts. **Every `beginStage` call site must gain a paired `endStage`** — the single chokepoint is `index.ts:1844` (`if (stageLabel) turnBudget.beginStage(stageLabel)`); add `endStage(stageLabel)` in that request wrapper's `finally`.
- [ ] **2.2** Tests first: (a) two 20s planner attempts separated by 60s of idle leave `stageRemainingMs("planner") === 20_000`; (b) a stage never begun has full budget at any wall-clock time; (c) `extendStageOnProgress` still raises the ceiling. Flip fixture 0.1 green.
- [ ] **2.3** `stream-liveness.ts` — new error class beside `TurnDeadlineExceededError` (`:101`):

```ts
export class StageBudgetExhaustedError extends Error {
  constructor(stage: string, usedMs: number, budgetMs: number, turnRemainingMs: number) {
    super(`Stage budget exhausted on stage=${stage} (used ${usedMs}ms of ${budgetMs}ms; turn has ${turnRemainingMs}ms remaining)`);
  }
}
```

- [ ] **2.4** `index.ts:1849-1850` — the `canStart` failure currently throws `TurnDeadlineExceededError` unconditionally. Distinguish: if `turnBudget.remainingMs() <= turnBudget.finalization_reserve_ms` throw `TurnDeadlineExceededError` (true turn exhaustion); else throw `StageBudgetExhaustedError(stage, usedMs, stage_ms[stage], remainingMs)`. Expose `usedMs` via a new `stageUsedMs(stage)` accessor. Update `describePipelineError` (see `orchestration.test.ts:1120`) to map the new message to a user-safe description. Stage rows recording these failures set `partial_error_code: "stage_window_exhausted"`.
- [ ] **2.5** Tuner hygiene: in `self-tuning` consumers that aggregate `stage_runs.had_error` for model/instruction learning (grep `had_error` under `server-jarvis/src/self-tuning/` and `orchestration/model-scorecard.ts`), exclude rows with `partial_error_code IN ('stage_window_exhausted','turn_deadline')` — runtime starvation is not model failure. One test per touched query.
- [ ] **2.6** Commit: `fix(orchestration): usage-based stage budgets + StageBudgetExhaustedError (F2,F3)`.

---

## Phase 3 — F6: partial-evidence synthesis instead of refusal

**Files:** modify `server-jarvis/src/orchestration/pipeline.ts:2008-2032` (pre-synth fence), `server-jarvis/src/orchestration/evidence-sufficiency.ts:254-268`; tests `evidence-sufficiency.test.ts`, `orchestration.test.ts:351`

- [ ] **3.1** Fence change at `pipeline.ts:2013`: refusal is reserved for **zero evidence**. When `!sufficient` but `contentReads >= 1 || listings >= 1`, do not return a fatal error — run the synthesizer with an injected notice and keep the replan request alive:

```ts
if (requiresWorkspaceEvidence && !preSynthAssessment.sufficient) {
  const failure = evidenceFailure(preSynthAssessment);
  if (options.allowMidRunReplan !== false) {
    replanRequested = { trigger: "evidence_insufficient", detail: failure.message };
  }
  if (preSynthAssessment.contentReads + preSynthAssessment.listings === 0) {
    return { state, synthesizerAnswer: "", synthesizerFatalError: failure.message,
             synthesizerEmptyCompletion: false, fatalErrorCode: failure.code,
             effectGate, partialStage, replanRequested };
  }
  // Partial evidence: synthesize with explicit disclosure instead of refusing.
  effectGate = { ...effectGate, synthesizerNotice: [
    effectGate.synthesizerNotice,
    `Evidence disclosure requirement: workspace evidence is INCOMPLETE (${preSynthAssessment.reason}). ` +
    `State plainly which files you actually read, answer only from them, and name what remains unread.`,
  ].filter(Boolean).join("\n") };
}
```

  The replan loop still gets first refusal-free shot at topping up evidence; when replans are capped, the segment now ships a grounded partial answer instead of `insufficient_workspace_evidence`.
- [ ] **3.2** Tests first: (a) deep-read turn, 2 distinct source reads → synthesizer runs, answer non-empty, no fatal code; (b) deep-read turn, 0 calls → refusal preserved with `missing_workspace_evidence`; (c) replanRequested still set in case (a).
- [ ] **3.3** `evidence-sufficiency.ts:262-267` — rewrite the insufficient message to stop scripting the user (its own `:251` comment forbids it) and stop promising budgets it doesn't grant: `"Workspace evidence was incomplete for the depth of this request (${assessment.reason}). The answer below is limited to what was actually read. Naming a specific file or directory will let me go deeper."` Update `orchestration.test.ts:351` and `evidence-sufficiency.test.ts:346` which assert the old phrase.
- [ ] **3.4** Commit: `fix(orchestration): partial-evidence synthesis with disclosure; refusal only on zero evidence (F6)`.

---

## Phase 4 — F5: make "force deep read" a real contract

**Files:** modify `server-jarvis/src/orchestration/repetition-guard.ts:103` (export the regex), `server-jarvis/src/orchestration/turn-budget.ts`, `server-jarvis/src/index.ts:1300-1350` (budget + route resolution); tests `turn-budget.test.ts`, `turn-requirements.test.ts`

- [ ] **4.1** Export `FORCE_BYPASS` from `repetition-guard.ts` as `FORCE_DEEP_READ_PATTERN` (keep the local alias). Single source of truth for the phrase.
- [ ] **4.2** `createTurnBudget(requirement, complexity, startedAt, opts?: { forcedDeepRead?: boolean })`: when forced, `turn_ms = 240_000`, `stage_ms.executor = 150_000`, and the absolute cap used by `extendStageOnProgress`/`finalStreamDeadlineAt` becomes an instance field `absolute_cap_ms = 240_000` (replace the bare `ABSOLUTE_TURN_CAP_MS` references). Test: forced budget yields 240s deadline; unforced unchanged.
- [ ] **4.3** `index.ts:1313`: pass `{ forcedDeepRead: FORCE_DEEP_READ_PATTERN.test(message) }`. In the deterministic route resolution (the code emitting `coordinator_rationale: "Deterministic full_execution route: coordinator skipped."` — grep that string), force-intent overrides the pipeline to `["executor","synthesizer"]` with rationale `"Forced deep read: direct executor route with extended budget."` — the supervision/planner tax is precisely what starved the previous attempts, and the research route is the empirically working topology (control group in the diagnosis).
- [ ] **4.4** Live-fire assertion for Phase 9: a `"force deep read"` turn must produce `conductor_runs.routing_json` containing `"Forced deep read"` and `agent_runs.duration_ms` may exceed 180_000 without a `turn_deadline` row.
- [ ] **4.5** Commit: `feat(orchestration): force-deep-read grants extended budget + direct executor route (F5)`.

---

## Phase 5 — F4 + F8: the floor must be reachable — deterministic floor-completion reads

**Files:** modify `server-jarvis/src/orchestration/pipeline.ts` (executor post-loop, after the `while` at `:941-1119`); create helper in `server-jarvis/src/orchestration/evidence-sufficiency.ts`; tests `evidence-sufficiency.test.ts`, `orchestration.test.ts`

- [ ] **5.1** New pure helper (tests first) `extractSourceReadCandidates(planText: string, listingCalls: ToolCallRecord[], workspaceRoot: string, alreadyRead: Set<string>): string[]` in `evidence-sufficiency.ts`:
  - harvest path-like tokens with `SOURCE_FILE_EXTENSIONS` from the plan/worker-instruction text;
  - harvest entries from prior `list_directory` outputs (reuse `parseListingEntryNames` — export it from `pipeline.ts:205`), joined against each call's `path` argument;
  - filter to source extensions, resolve against `workspaceRoot`, exclude `alreadyRead` (via `sourceFileKey`), dedupe, return in plan-order-first priority.
  Test with run `run_94d60dcf`'s real data: plan naming `lib/gateway/dashboard.ts` + `client.ts`, one listing of `src/app` — candidates must include `dashboard.ts` before any listing-derived file.
- [ ] **5.2** Executor floor-completion pass in `runExecutorStage`, after the turn loop ends and before the final evidence assessment: when `requiresWorkspaceEvidence && deepReadRequest` and the assessment is insufficient, read up to `DEEP_READ_MIN_CONTENT_READS − contentReads + 1` (max 4) candidates via `this.runToolCall` — same mechanics as the anchor preflight at `:900-931` (record into `toolCalls`, push `[Runtime floor-completion: read_file <path>]` messages, `onStateChange` per read), each read gated on `options.turnBudget?.stageRemainingMs("executor")` > 5_000. This converts "one read short, four times in a row" into a satisfied floor without a replan cycle.
- [ ] **5.3** Anchor alignment (F4): in the preflight anchor loop (`:901`), after reading manifests, if `contentReads` toward the floor is still 0 and the listing contains a `src`/`lib`/`app` directory, list it and read its first source file — one bounded extra read so the preflight contributes at least one floor-countable read. Keep the floor's source-only semantics (2026-07-13 lesson) — fix the reads, not the rubric.
- [ ] **5.4** Commit: `feat(orchestration): deterministic floor-completion reads from plan + listings (F4,F8)`.

---

## Phase 6 — F7: supervision diet + attribution

**Files:** modify `server-jarvis/src/orchestration/conductor.ts:31-42` (`shouldSuperviseStage`), `server-jarvis/src/self-tuning/collector.ts`; tests `conductor.test.ts`

- [ ] **6.1** `shouldSuperviseStage` — supervision inference only when there is something to supervise:

```ts
export function shouldSuperviseStage(args: {
  supervisionEnabled: boolean;
  outcome: "completed" | "failed";
  stage: StageName;
  remainingQueue: StageName[];
  consecutiveToolErrors: number;
  evidenceGap: boolean;           // executor/rewriter only, from the deterministic assessment
  supervisionCallsUsed: number;   // per-run counter, reset in setContext
}): boolean {
  if (!args.supervisionEnabled || args.remainingQueue.length === 0) return false;
  if (args.supervisionCallsUsed >= 4) return false;
  if (args.outcome === "failed") return true;
  if (args.consecutiveToolErrors > 0) return true;
  return EVIDENCE_CAPABLE_STAGES.has(args.stage) && args.evidenceGap;
}
```

  A cleanly completed planner/reviewer/synthesizer gets a deterministic `continue` — zero inference. (The 2026-07-15 "observationally inert conductor" concern stays covered: failures, tool errors, and evidence gaps still supervise.) Tests: completed-planner → no supervisor call (assert stub not invoked); 5th supervision request in one run → continue.
- [ ] **6.2** Attribute supervision: in `supervise()` after the model call resolves, record a `model_attributions` row via the collector (`stage_id: "conductor_supervision"`, duration, `was_successful: 1/0` by parse outcome) — mirror the insert shape at `self-tuning/store.ts:809`. The ~20s/run of invisible inference becomes visible in every future forensic pass.
- [ ] **6.3** Commit: `perf(orchestration): supervise only on anomaly, cap per run, attribute supervision calls (F7,F10a)`.

---

## Phase 7 — F9: failed-with-evidence pauses instead of terminating the task run

**Files:** modify `server-jarvis/src/orchestration/task-run.ts:126-144`; tests `task-run.test.ts`

- [ ] **7.1** Test first: `assessTaskRunAcceptance({ pipelineOutcome: "failed", evidenceCount: 2, … })` → `{ status: "paused", reason: "pipeline_failed_with_evidence" }`; zero-evidence failure still → `failed`. Then implement:

```ts
if (input.pipelineOutcome === "failed" || !answer) {
  return input.evidenceCount > 0
    ? { accepted: false, status: "paused", reason: "pipeline_failed_with_evidence" }
    : { accepted: false, status: "failed", reason: "pipeline_failed_or_empty" };
}
```

  `resolveTaskRunTurn` already continues from `paused` (`:95`), so "continue…" after a partial failure now inherits the real objective, workspace, depth, and evidence count instead of minting a task run whose objective is the literal word "continue".
- [ ] **7.2** Commit: `fix(orchestration): failed runs with evidence pause the task run for continuation (F9)`.

---

## Phase 8 — F10: telemetry honesty

**Files:** modify `server-jarvis/src/self-tuning/collector.ts` (+ its attribution call sites in `index.ts` ~`:2470`); locate the smoke generator (`grep -r "jarvis-orchestration-smoke" server-jarvis/ scripts/`); tests colocated

- [ ] **8.1** `first_token_ms`: `index.ts:2470` already computes `attemptFirstTokenMs`; trace the attribution write path into `collector.ts` and pass it through to the `store.ts:809` insert. Verification query below must show non-null values for new rows.
- [ ] **8.2** Empty-completion alignment: at the attribution call site, when the completion content is empty/whitespace, record `was_successful: 0, had_error: 1` so `model_attributions` stops rewarding empties that `stage_runs` marks `empty_completion` (the 2026-07-15 F1 class, still live at 13:48:07Z).
- [ ] **8.3** Smoke coverage: add a second scenario to the orchestration smoke — a deep-read prompt against a fixture repo (`"Identify all remaining gaps in <fixture> — architecture audit"`) asserting `agent_runs.outcome != 'failed'` **and** the final verdict is not `insufficient_workspace_evidence`. Today's smoke (a single file-write) passes while the deep-read path fails live; this closes that blind spot.
- [ ] **8.4** Commit: `fix(telemetry): attribute first_token_ms, stop rewarding empties, deep-read smoke scenario (F10)`.

---

## Phase 9 — Verification gate (do not deploy without all green)

- [ ] **9.1** `cd server-jarvis && bun test` — full suite green.
- [ ] **9.2** Build + deploy per the established runbook (`bun build`, ship `prompts/` beside `index.js` on the OneDrive Desktop — the running instance is `bun C:\Users\ethan\OneDrive\Desktop\index.js`); restart; confirm `curl localhost:19877/health` shows the new `source_tree_sha256`.
- [ ] **9.3** Live-fire replay, same prompts as the incident: (1) the Versutus gap-analysis request, (2) `"continue"`, (3) `"force deep read"`. Then run these against `~/.openclaw/jarvis/self-tuning.db` (all must hold for the replay window):

```sql
-- F1: no evidence-motivated planner reroutes on completed planners
SELECT COUNT(*) FROM conductor_directives WHERE directive_type='reroute'
  AND new_remaining_json LIKE '%planner%' AND reason LIKE '%evidence%'
  AND created_at > '<replay-start>';                       -- expect 0
-- F2/F3: no mislabeled turn-deadline rows before the real deadline
SELECT COUNT(*) FROM stage_runs WHERE error_message LIKE 'Total turn deadline%'
  AND created_at > '<replay-start>';                       -- expect 0 (or true turn exhaustion only)
-- F6: synthesizer ran and the run did not fail
SELECT outcome, substr(final_output,1,120) FROM agent_runs
  WHERE created_at > '<replay-start>' ORDER BY created_at; -- expect no 'failed', no 'could not gather enough evidence'
-- F7/F10: supervision visible, first_token populated
SELECT COUNT(*) FROM model_attributions WHERE stage_id='conductor_supervision' AND created_at > '<replay-start>'; -- > 0
SELECT COUNT(*) FROM model_attributions WHERE first_token_ms IS NOT NULL AND created_at > '<replay-start>';      -- > 0
```

- [ ] **9.4** Update `docs/PRIORITIES.md` and the memory index; record the replay results in the diagnosis doc's Falsifiability section.

---

## Task → finding traceability

| Finding | Tasks | Structural guarantee after landing |
|---|---|---|
| F1 planner evidence category error | 1.1–1.6, 0.2 | evidence rubric physically cannot reach planner digests; reroute admission is deterministic |
| F2 stage-window starvation | 2.1–2.2, 0.1 | budgets meter usage, not wall clock; idle/replan time is free |
| F3 mislabeled deadlines | 2.3–2.5 | distinct error type; starvation rows excluded from learning |
| F4 uncountable anchor reads | 5.3 | preflight always contributes ≥1 floor-countable read |
| F5 force-deep-read no-op | 4.1–4.4 | forced turns get 240s + direct executor route, verifiably routed |
| F6 binary fence refusals | 3.1–3.3 | refusal only at zero evidence; partial evidence always synthesizes with disclosure |
| F7 supervision tax | 6.1 | ≤4 supervision inferences/run; clean completions are free |
| F8 executor stops short | 5.1–5.2 | runtime completes the floor deterministically from plan + listings |
| F9 failed kills continuation | 7.1 | evidence-bearing failures pause; "continue" resumes the real objective |
| F10 telemetry gaps | 6.2, 8.1–8.3 | supervision attributed; empties punished; deep-read smoke exists |
