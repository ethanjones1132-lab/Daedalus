# Forensic Diagnosis — Orchestration Runtime, Supervision-Loop Starvation

**Date:** 2026-07-16 (afternoon pass, session window 09:40–09:50 EDT / 13:40–13:50Z)
**Build under observation:** `d8c505f` + dirty working tree (deployed 09:37 EDT, `source_tree_sha256 E48CB41F…`), running as `bun C:\Users\ethan\OneDrive\Desktop\index.js`, port 19877.
**Evidence source:** `C:\Users\ethan\.openclaw\jarvis\self-tuning.db` (`agent_runs`, `stage_runs`, `model_attributions`, `conductor_directives`, `replan_events`, `trajectory_snapshots`), cross-correlated with source in `server-jarvis/src`.
**Target incidents:** session `a074271b-6345-4059-9327-ddd4b75a8870` — run `run_5283dd64` ("Identify all remaining gaps in the repo…", **failed**, 142s) and run `run_94d60dcf` ("continue, force deep read", **failed**, 153s). Control group: session `d865a836` (08:15–08:44 EDT, research route, same workspace, mixed success/partial).

---

## Executive summary

Both failed runs had **zero model failures**. Every planner/executor/reviewer inference succeeded quickly (nemotron ~4–17s, deepseek-v4-pro ~2–15s, flash ~24s, no fallbacks). The turn budget was consumed by the orchestration layer itself: the live conductor holds the **planner** to a workspace-evidence rubric the planner cannot satisfy (it has no tools), reroutes it up to 3× per segment, and thereby exhausts the planner's one-shot wall-clock stage window — after which every replan re-entry dies in ~1.3s with a **mislabeled** "Total turn deadline (180000ms) exceeded" while ~90s of real budget remains. The evidence fence then discards the two genuine file reads the executor did produce and ships a canned refusal that tells the user to say "force deep read" — a hatch that resolves to a no-op for requests already classified deep. The user received nothing of value from ~5 minutes and ~40 model inferences.

The executor **model** is not the weak link. In the same hour, on the supervision-free research route (`executor→synthesizer`), the same deepseek-v4-pro ran 7-turn segments, issued 6 parallel `list_directory` calls in a single turn, and read multiple real source files. Under full_execution it received ~23s of a 142s turn (~16%).

---

## Where the 142 seconds of run_5283dd64 went

| Consumer | Time | Notes |
|---|---|---|
| Planner inference ×4 (all "successful") | ~50s | 1 initial + 3 conductor reroutes, 754/782/21/749 output tokens |
| Conductor supervision inferences ×15 | ~20s | ~1.1–1.6s each; **not attributed** in model_attributions |
| Replan inferences ×2 | ~10s | coherent rationales, both segments ended "degraded" |
| Reviewer (1 full + 1 starved) | ~32s | second attempt killed at 8.86s by dead stage window |
| Doomed post-replan planner attempts ×8 | ~11s | each ~1.1–1.9s: `canStart` throw + supervision call |
| Executor (incl. duplicated preflights) | ~23s | net product: 3 `list_directory`, 2 anchor reads that count as zero |
| Synthesizer | 0s | never ran — evidence fence returned fatal error |

---

## Findings (ranked)

### F1 — Conductor supervises the planner against an executor evidence rubric (category error) — CONFIRMED
`afterConductorStage("planner", …)` passes **no evidence object** (`pipeline.ts:702`), so `LiveConductor.afterStage` computes `assessWorkspaceEvidence(undefined, "", undefined)` → always `{sufficient:false, reason:"no successful workspace tool result"}` (`conductor.ts:105`). That verdict is embedded in the supervision digest after **every planner completion**. The qwen-class supervisor overrides conductor.md's "default to continue" and emits `reroute → ["re-enter:planner"]` — live: 8 planner-completed→reroute directives across the two runs, reasons like *"Planner completed but failed to gather any workspace evidence; must re-run planner"*. 1 initial + 3 reroutes = the observed 4 planner inferences (~50s) before the executor ever starts.
**Fix direction:** stage-aware evidence expectations — never feed a planner digest through the workspace-evidence rubric; deterministically reject `re-enter:planner` reroutes whose trigger is evidence-insufficiency on a completed planner; pass `request`/`workspaceRoot` so the assessment is at least computed on real inputs.

### F2 — Stage windows are wall-clock anchored at first entry and never re-arm across reroutes/replans (structural starvation) — CONFIRMED
`turn-budget.ts` `beginStage`: "first begin wins"; `stageRemainingMs = stage_ms − (now − firstBegin)`. The T1.1 anti-re-arm fix (correct for intra-stage retries) starves every **replan segment**: a planner window opened at 13:44:56 is dead by 13:45:56 regardless of usage. Numeric confirmation: reviewer re-entry killed at **8,862ms** = 60,000ms − ~51s wall-clock since first reviewer entry; executor re-entry killed at the 90s extension-ceiling boundary (`extendStageOnProgress` ceiling) measured from first executor entry; all post-replan planner attempts die in ~1.1–1.9s.
**Fix direction:** re-arm per replan/reroute segment with a fresh (deliberately smaller) allocation, or account cumulative stage *usage* instead of wall-clock since first entry.

### F3 — Deadline errors misattribute their cause (telemetry lies) — CONFIRMED
`canStart` failure throws `TurnDeadlineExceededError` which prints "Total turn deadline (180000ms) exceeded" (`index.ts:1849-1850`, `stream-liveness.ts:101`) — observed at 88s elapsed with 92s remaining. Stage aborts print the **configured** budget ("Stage deadline exceeded (60000ms)" after 8.9s) not the effective one. These rows are recorded `had_error=1` against the stage and poison the self-tuner: nemotron/north-mini take blame for orchestration starvation (same failure-reinforcement class as the 2026-07-15 F1).
**Fix direction:** distinct error types/messages for stage-window-exhausted vs turn-deadline; record effective budget and elapsed in the row; exclude runtime-starvation rows from model attribution learning.

### F4 — The runtime's own preflight anchor reads cannot satisfy the deep-read floor it serves — CONFIRMED
The deep-read preflight reads anchors like `README.md`/`package.json` (`pipeline.ts:900-923`), but the floor counts only `SOURCE_FILE_EXTENSIONS` targets (`evidence-sufficiency.ts:33`), which exclude `.md`/`.json`. Live: replan #1 rationale explicitly cites "package.json and README confirm an Expo/RN project" while the verdict says "got **0** content reads". The runtime spends preflight time on reads its own fence scores as zero.
**Fix direction:** either make anchors target plan-named source files, or count manifest/README reads toward the floor for architecture/gap-analysis intents (they are genuine content evidence for such requests).

### F5 — "force deep read" hatch is still a behavioral no-op; the refusal scripts it anyway — CONFIRMED
`depth` is wired (`index.ts:1345`), but for a request already matching `DEEP_READ_MARKERS` (both did: "repo", "deep read") force-intent changes nothing: same 180s cap, same stage windows, same ≥3 floor. Run 2 ("continue, force deep read") failed identically to run 1 and emitted the same refusal telling the user to *say "force deep read"*. `evidence-sufficiency.ts:266` scripts the user's next message verbatim, violating the rule documented 15 lines above it (`:251`, the 2026-07-12 loop lesson).
**Fix direction:** force intent must visibly change the contract — e.g. route to the research topology (executor+synthesizer, no supervision loop), grant an extended absolute cap, and degrade the floor to best-effort-with-disclosure. Remove the scripted phrase from the refusal.

### F6 — Binary evidence fence discards partial evidence; no synthesizer fallback — CONFIRMED
`pipeline.ts:2013-2031`: insufficient → `synthesizerFatalError`, empty answer, synthesizer skipped. Run 2 had **2 distinct source reads** (`_layout.tsx`, `client.ts`) + 4 listings + two coherent plans + replan rationales — one read short of the floor, four separate times across the session — and the user got a canned refusal each time. With the replan cap (2/turn) and F2, a full_execution deep read now **structurally terminates in refusal** whenever the executor model doesn't hit 3 source reads in its first starved segment.
**Fix direction:** below-floor with nonzero evidence should synthesize a partial, explicitly-caveated answer; reserve refusal for zero-evidence turns.

### F7 — Supervision tax dominates full_execution turns — CONFIRMED
~15 supervisory inferences + 2 replan inferences per run, none attributed in `model_attributions`, each inserted serially between stages. Control group (same hour, same workspace, same executor model, research route without planner/reviewer/supervision): 7-turn executor segments, parallel listings, multiple real reads, outcomes success/partial. deepseek-v4-pro executor: 140 calls since 07-15, 94% success, 6.4s avg — the model is healthy.
**Fix direction:** deterministic short-circuit — only invoke the supervisor model on failure, tool-error threshold, or executor-evidence gap (the deterministic cases already handled); cap supervisory inferences per turn; attribute supervision/replan calls so their cost is visible.

### F8 — Executor behavioral profile: ~1 tool call per turn, terse, stops after first nudge — CONFIRMED (secondary)
Loop exits when a turn emits no tool calls and no nudge was sent (`pipeline.ts:1083`); nudges cap at 2 and the second requires new evidence since the first. deepseek-v4-pro reliably emits one call per turn with 0–62 output tokens and stops volunteering after 1–2 calls under full_execution (maxTurns 8 never reached). Replans re-enter with the plan naming concrete files (replan #3 lists `dashboard.ts`, `client.ts`) yet the fresh segment restarts discovery (`list src/app`).
**Fix direction:** when the floor is unmet and the model stops, deterministically read the plan-named files (plan-aware extension of the anchor preflight) instead of replanning the whole pipeline; make worker instructions batch-read explicit ("read these N files now").

### F9 — A failed run kills task-run continuation; "continue" starts a garbage objective — CONFIRMED
`assessTaskRunAcceptance` marks the run `failed`; `resolveTaskRunTurn` treats `failed` as non-continuable, so "continue, force deep read" created a **new** task run whose objective is literally "continue, force deep read" (planner context degraded, `evidenceCount` reset). Failed-with-accumulating-evidence should pause (resumable), not terminate.

### F10 — Telemetry gaps — CONFIRMED
(a) supervision + replan inferences have no `model_attributions` rows; (b) `first_token_ms` is NULL on every row (new column unpopulated); (c) the 13:48:07 planner `empty_completion` stage row coexists with `was_successful=1` in model_attributions — the stage/attribution disagreement persists in the new build; (d) the 13:40 smoke run passes because it's a single-write task — smoke coverage does not exercise the deep-read/full_execution path that fails live.

---

## Priority order for remediation

1. **F1** deterministic guard (stop planner evidence reroutes) — removes ~60s of waste and the reroute storm at its source.
2. **F2** stage-window re-arm per segment — makes replans viable at all.
3. **F6** partial-evidence synthesis fallback — converts refusals into grounded partial answers immediately, even before F1/F2 land.
4. **F5** wire force-deep-read to a real contract change + unscript the refusal.
5. **F4** count/target anchors correctly.
6. **F3/F10** honest deadline errors + attribute supervision; stop tuner poisoning.
7. **F8** plan-aware deterministic reads; **F7** supervision short-circuit; **F9** pause-not-fail continuation.

## Falsifiability

Each finding predicts a specific observable: after F1, `conductor_directives` must show zero `re-enter:planner` reroutes with evidence-rubric reasons on completed planners; after F2, a post-replan reviewer entry at t+110s must receive a fresh window rather than dying at `60s − elapsed`; after F6, a 2-read deep-read turn must produce a caveated synthesis rather than `insufficient_workspace_evidence`. Re-run the same Versutus gap-analysis prompt to verify end-to-end.

### Structural remediation status (2026-07-16 evening wrap-up)

Implementation plan: `docs/superpowers/plans/2026-07-16-supervision-starvation-remediation.md` (Phases 0–8 landed on `master`; Phase 9.1 unit suite green at **1220/1220** `server-jarvis` bun tests).

| Finding | Structural fix landed | Unit / fixture falsifier |
|---|---|---|
| F1 planner evidence category error | Stage-aware digests + `rejectReroute` | `incident-20260716.test.ts`, `reroute-policy.test.ts` |
| F2 stage-window starvation | Usage-based `beginStage`/`endStage` budgets | `turn-budget.test.ts`, incident F2 fixtures |
| F3 mislabeled deadlines | `StageBudgetExhaustedError` + starvation learning exclusions | `orchestration.test.ts` describePipelineError; analyzer tests |
| F4 uncountable anchor reads | Preflight dips into `src`/`lib`/`app` for ≥1 source read | pipeline preflight path + floor tests |
| F5 force-deep-read no-op | 240s/150s budget + direct executor route | `turn-budget.test.ts`, `route-normalization.test.ts` |
| F6 binary fence refusals | Partial evidence synthesizes with disclosure | `pipeline-telemetry.test.ts` F6/F10 |
| F7 supervision tax | Diet to anomaly + cap 4/run + attributions | `conductor.test.ts` F7 |
| F8 executor stops short | Deterministic floor-completion reads | `extractSourceReadCandidates` + F8 telemetry |
| F9 failed kills continuation | Failed-with-evidence → task-run `paused` | `task-run.test.ts` F9 |
| F10 telemetry gaps | `first_token_ms` fallback, no empty reward, deep-read smoke | `conductor-learning.test.ts` F10; `scripts/smoke-jarvis-runtime.ps1 -DeepReadSmoke` |

**Still open (operator):** Phase 9.2 deploy (`build-and-deploy.ps1` / Desktop `index.js` + `prompts/`) and Phase 9.3 live-fire SQL against `~/.openclaw/jarvis/self-tuning.db` after replaying Versutus gap-analysis / `continue` / `force deep read`.
