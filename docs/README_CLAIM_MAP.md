# README claim map — "Three systems worth reading"

Audit of `README.md:29-71` (Phase 4). Each numbered claim is tied to current
source lines and tests so it can be corrected, not trusted. Counts and stale
figures are tracked separately by the other Phase 4 backlog items; this map does
not edit README.

## System 1 — Runtime-owned verification (`README.md:31-39`)

| README line | Claim | Source | Named tests |
|---|---|---|---|
| 33 | Runtime executes a real check and reads its exit code; model success claim is not an input | `server-jarvis/src/orchestration/check-runner.ts:35-46` (`applyCheckHonestyGate`) | `check-runner.test.ts` — `applyCheckHonestyGate` ("demotes success to degraded when an independent check failed", "leaves success alone when the check passed", "leaves success alone when no check ran or is missing"); honesty-gate regression describes |
| 35 | Tiered check-runner: project tests, then language-appropriate build/syntax check, then model-authored check; tri-state `CheckOutcome`: `clean`/`failed`/`not_applicable` | `server-jarvis/src/orchestration/check-runner.ts:5-19` (`CheckTier`, `CheckResult`); `server-jarvis/src/orchestration/build-check.ts:22-25` (`CheckOutcome`) | `check-runner.test.ts` — `check-runner tier mapping`, `mergeToCheckResult (build tri-state)`, `runVerificationCheck (build)`; `build-check.test.ts` — `runBuildCheck` |
| 37 | Detector registry (`cargo`/`cmake`/`go`/`node`/`make`, Python syntax fallback) returns `not_applicable` when no build system; recorded honestly as `none`, not vacuous green | `server-jarvis/src/orchestration/build-check.ts:121-122` (`PROJECT_DETECTORS`); `build-check.ts:295` (no-build-system return); `check-runner.ts:75-132` (`mergeToCheckResult`, `no_code_written` → `none`) | `build-check.test.ts` — `detector registry`; `check-runner.test.ts` — `CheckResult explains a none tier`, `mergeToCheckResult (build tri-state)` |
| 39 | Write-intent run is `success` only when its TaskPlan is drained **and** an authoritative check ran and passed; `check_tier=none` produces `partial` and keeps the run resumable | `server-jarvis/src/orchestration/completion-policy.ts:36-41` (`requiresVerification`); `completion-policy.ts:57-59` (`isAuthoritativelyGreen`); `completion-policy.ts:82-117` (`decideCompletion`, `task_plan_open`/`write_unverified`) | `completion-policy.test.ts` — `decideCompletion`, `isAuthoritativelyGreen`, `verification requirement is evidence-keyed, not flag-keyed` |

## System 2 — Offline trace replay (`README.md:41-55`)

| README line | Claim | Source | Named tests |
|---|---|---|---|
| 43 | Every orchestrated turn written to `self-tuning.db`; replay turns it into a standing gate | `server-jarvis/src/eval/conductor-replay.ts:473-483` (`checkReplayInvariants`); `server-jarvis/src/self-tuning/store.ts` (rows) | `conductor-replay.test.ts` — invariant describes: `conductor replay — repeated nudge invariant`, `placeholder note invariant`, `stage deadline invariant`, `no-op executor turn invariant`, `turn cap saturation invariant`, plus `reporting` and `stored tool-call evidence decoder` |
| 45 | Two July defects were already in the database; a query would surface them | `server-jarvis/src/eval/conductor-replay.ts:6-22` (scope/history comment) | `conductor-replay.test.ts` — invariant/reporting describes above; no corpus-size assertion |
| 47 | `conductor-replay.ts` replays stored traces against five invariants | `server-jarvis/src/eval/conductor-replay.ts:66-78` (`ReplayRule` union, 11 variants total; README names the five core rules); `conductor-replay.ts:473-483` (`checkReplayInvariants`) | `conductor-replay.test.ts` — `conductor replay — repeated nudge/placeholder note/stage deadline/no-op executor/turn cap saturation` invariant describes; 43 passing in current Mac run |
| 47 | CLI flags `--limit`/`--since`/`--db`/`--json` | `server-jarvis/scripts/replay-conductor.ts:25-36` (arg parsing) | `conductor-replay.test.ts` — `conductor replay CLI limit and since filters`: `--limit returns only the newest requested runs`, `--since includes runs on or after the boundary and preserves read-only SQLite`, `--limit and --since compose without changing DB contents` |
| 50 | Offline invariant/regression checking over recorded traces, not a counterfactual simulator | `server-jarvis/src/eval/conductor-replay.ts:26` (scope note) | `conductor-replay.test.ts` — invariant/reporting describes above |
| 53 | First run over 500 stored runs: 117 violations across 68 runs (14%), worst hand-diagnosed run hit all five rules | Historical measurement from a 2026-07-31 instrumented build; no commit SHA recorded in the repository. Treat as an archived observation, not a reproducible current-corpus result. The backing SHA/entry, if recoverable, must be recorded before restating the figure (see README-correction Phase 4 item). | `conductor-replay.test.ts` (replay rules only; no corpus-size assertion) |

Stale size/test count at `README.md:47` (`server-jarvis/src/eval/conductor-replay.ts` is 529 lines, not 282, and `conductor-replay.test.ts` passes 43 tests, not 17) is tracked by the separate Phase 4 correction item; this map records current evidence.

## System 3 — Phase D policy optimization (`README.md:57-71`)

| README line | Claim | Source | Named tests |
|---|---|---|---|
| 59 | Orchestrator behavior parameterized as policy vector θ (Phase C) tuned as a black box in Phase D | `server-jarvis/src/orchestration/orchestration-policy.ts:21-86` (`OrchestrationTheta`); `orchestration-policy.ts:139-189` (`BASELINE_THETA`) | `orchestration-policy.test.ts` — `OrchestrationTheta (Phase C)`, `C3 reproducible rollouts` |
| 61 | sep-CMA-ES core + fixture held-out split + rollout-local-only routing | `server-jarvis/src/self-tuning/cma-es/sep-cma-es.ts:37` (`SepCmaEs`); `server-jarvis/src/self-tuning/rollout/fixture-tasks.ts:43` (`held_out` property) and `:53-106` (`heldOut` partition); `server-jarvis/src/self-tuning/rollout/rollout-runner.ts` (local routing) | `sep-cma-es.test.ts` (`SepCmaEs.ask`, `SepCmaEs.tell`, `SepCmaEs convergence`); `fixture-tasks.test.ts` (`fixture loading`, `seedFixtureWorkspace`) |
| 63 | In-process rollout runner + bounded-concurrency pool | `server-jarvis/src/self-tuning/rollout/rollout-runner.ts:376` (`buildRolloutRuntime`); `server-jarvis/src/self-tuning/rollout/rollout-pool.ts` (concurrency pool) | `rollout-runner.test.ts` (`buildFixtureRolloutRequest`, `rollout tool boundary`, `runOneRollout`, `runGradedFixtureCheck`); `rollout-pool.test.ts` (`runRolloutBatch`, `meanReward`) |
| 65 | CMA-ES campaign driver + policy-staging proposal | `server-jarvis/src/self-tuning/cma-es/run-cma-es.ts:446` (`proposeCampaignWinner`, campaign flow); `server-jarvis/src/self-tuning/policy-staging.ts:302` (`proposePolicy`, policy staging) | `run-cma-es.test.ts` (`runCmaEsCampaign`, `proposeCampaignWinner`, `compareHeldOut`); `policy-staging.test.ts` (`propose → eligible → shadow → canary → promote`, `qualification provenance`, `policy staging thresholds`) |
| 67 | Fixture suite expansion 11 → 39 | `server-jarvis/src/self-tuning/rollout/fixture-tasks.ts` (fixture set); commit `0143a51` (historical) | `fixture-tasks.test.ts` (`fixture loading`) |
| 67 | Offline write-effect reward corrections (hidden-file writes; read-then-fixed files outside target set) | `server-jarvis/src/orchestration/run-reward.ts:15-20` (B2 hard rules); `run-reward.ts:312` (`computeRunReward`); `server-jarvis/src/orchestration/effect-gate.ts` | `run-reward.test.ts` (`computeRunReward B1 composition`, `B2 anti-gaming`, `B3 calibration (overclaim)`) |
| 69 | Rollouts run against local models through dedicated Ollama transport (`ollama-local-transport.ts`); costs compute, not API spend | `server-jarvis/src/self-tuning/rollout/ollama-local-transport.ts:123` (`resolveLocalTarget`); `ollama-local-transport.ts:341` (`callOllamaChat`) | `ollama-local-transport.test.ts` (`resolveLocalTarget`, `callOllamaChat`, `readOllamaLoadedContextLength`) |
| 71 | Reward grounded in executed check result; `synth` tier is runtime-authored and earns 0 check term | `server-jarvis/src/orchestration/run-reward.ts:61-64` (`INDEPENDENT_CHECK_TIERS`); `run-reward.ts:252-285` (`computeCheckTerm`) | `run-reward.test.ts` (`B2 anti-gaming`, `B3 calibration (overclaim)`) |
## Invariants preserved by these systems

- `TaskPlan` drained before success and `check_tier=none` → `partial`/resumable (`completion-policy.ts:82-117`).
- Offline replay is invariant/regression checking only; never a counterfactual simulator (`conductor-replay.ts:26`).
- Held-out fixtures are structurally separated from training fixtures (`fixture-tasks.ts:108-128`).
- Rollouts run local-only through the dedicated Ollama transport (`ollama-local-transport.ts`).
- Reward check term accepts only `existing`/`builtin` tiers; `synth` earns 0 (`run-reward.ts:61-64`).
