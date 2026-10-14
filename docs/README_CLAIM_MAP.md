# README claim map — "Three systems worth reading"

Audit of `README.md:29-54` (Phase 4). Each numbered claim is tied to current
source lines and tests so it can be corrected, not trusted. Counts and stale
figures are tracked separately by the other Phase 4 backlog items; this map does
not edit README.

## System 1 — Runtime-owned verification (`README.md:31-39`)

| README line | Claim | Source | Named tests |
|---|---|---|---|
| 33 | Runtime executes a real check and reads its exit code; model success claim is not an input | `server-jarvis/src/orchestration/check-runner.ts:35-73` (`applyCheckHonestyGate`) | `check-runner.test.ts` |
| 35 | Tiered check-runner: project tests, then language-appropriate build/syntax check, then model-authored check; tri-state `CheckOutcome`: `clean`/`failed`/`not_applicable` | `server-jarvis/src/orchestration/check-runner.ts:5-29` (`CheckTier`, `CheckResult`); `server-jarvis/src/orchestration/build-check.ts:22-25` (`CheckOutcome`) | `check-runner.test.ts`, `build-check.test.ts` |
| 37 | Detector registry (`cargo`/`cmake`/`go`/`node`/`make`, Python syntax fallback) returns `not_applicable` when no build system; recorded honestly as `none`, not vacuous green | `server-jarvis/src/orchestration/build-check.ts:121-122` (`PROJECT_DETECTORS`); `build-check.ts:295` (no-build-system return); `check-runner.ts:75-118` (`mergeToCheckResult`, `no_code_written` → `none`) | `build-check.test.ts`, `check-runner.test.ts` |
| 39 | Write-intent run is `success` only when its TaskPlan is drained **and** an authoritative check ran and passed; `check_tier=none` produces `partial` and keeps the run resumable | `server-jarvis/src/orchestration/completion-policy.ts:36-42` (`requiresVerification`); `completion-policy.ts:57-61` (`isAuthoritativelyGreen`); `completion-policy.ts:82-118` (`decideCompletion`, `task_plan_open`/`write_unverified`) | `completion-policy.test.ts` |

## System 2 — Offline trace replay (`README.md:41-55`)

| README line | Claim | Source | Named tests |
|---|---|---|---|
| 43 | Every orchestrated turn written to `self-tuning.db`; replay turns it into a standing gate | `server-jarvis/src/eval/conductor-replay.ts:473-476` (`checkReplayInvariants`); `server-jarvis/src/self-tuning/store.ts` (rows) | `conductor-replay.test.ts` |
| 45 | Two July defects were already in the database; a query would surface them | `server-jarvis/src/eval/conductor-replay.ts:1-46` (scope/history comment) | `conductor-replay.test.ts` |
| 47 | `conductor-replay.ts` replays stored traces against five invariants | `server-jarvis/src/eval/conductor-replay.ts:66-71` (`ReplayRule` union); `conductor-replay.ts:473` (`checkReplayInvariants`) | `conductor-replay.test.ts` (43 passing in current Mac run) |
| 47 | CLI flags `--limit`/`--since`/`--db`/`--json` | `server-jarvis/scripts/replay-conductor.ts:28-36` (arg parsing) | `conductor-replay.test.ts` |
| 50 | Offline invariant/regression checking over recorded traces, not a counterfactual simulator | `server-jarvis/src/eval/conductor-replay.ts:40-46` (scope note) | `conductor-replay.test.ts` |
| 53 | First run over 500 stored runs: 117 violations across 68 runs (14%), worst hand-diagnosed run hit all five rules | Historical measurement from a 2026-07-31 instrumented build; no commit SHA recorded in the repository. Treat as an archived observation, not a reproducible current-corpus result. The backing SHA/entry, if recoverable, must be recorded before restating the figure (see README-correction Phase 4 item). | `conductor-replay.test.ts` (replay rules only; no corpus-size assertion) |

Stale size/test count at `README.md:47` (`server-jarvis/src/eval/conductor-replay.ts` is 529 lines, not 282, and `conductor-replay.test.ts` passes 43 tests, not 17) is tracked by the separate Phase 4 correction item; this map records current evidence.

## System 3 — Phase D policy optimization (`README.md:57-71`)

| README line | Claim | Source | Named tests |
|---|---|---|---|
| 59 | Orchestrator behavior parameterized as policy vector θ (Phase C) tuned as a black box in Phase D | `server-jarvis/src/orchestration/orchestration-policy.ts:2-136` (`OrchestrationTheta`, baseline θ) | `orchestration-policy.test.ts` |
| 61 | sep-CMA-ES core + fixture held-out split + rollout-local-only routing | `server-jarvis/src/self-tuning/cma-es/sep-cma-es.ts:37` (`SepCmaEs`); `server-jarvis/src/self-tuning/rollout/fixture-tasks.ts:43-125` (`held_out`/`heldOut` partition); `server-jarvis/src/self-tuning/rollout/rollout-runner.ts` (local routing) | `sep-cma-es.test.ts`, `fixture-tasks.test.ts`, `rollout-runner.test.ts` |
| 63 | In-process rollout runner + bounded-concurrency pool | `server-jarvis/src/self-tuning/rollout/rollout-runner.ts:376` (`buildRolloutRuntime`); `server-jarvis/src/self-tuning/rollout/rollout-pool.ts` (concurrency pool) | `rollout-runner.test.ts`, `rollout-pool.test.ts` |
| 65 | CMA-ES campaign driver + policy-staging proposal | `server-jarvis/src/self-tuning/cma-es/run-cma-es.ts` (`proposeCampaignWinner`, campaign flow); `server-jarvis/src/self-tuning/policy-staging.ts:302` (`proposePolicy`, policy staging) | `run-cma-es.test.ts`, `policy-staging.test.ts` |
| 67 | Fixture suite expansion 11 → 39 | `server-jarvis/src/self-tuning/rollout/fixture-tasks.ts` (fixture set); commit `0143a51` (historical) | `fixture-tasks.test.ts` |
| 67 | Offline write-effect reward corrections (hidden-file writes; read-then-fixed files outside target set) | `server-jarvis/src/orchestration/run-reward.ts:15-20` (B2 hard rules); `run-reward.ts:312` (`computeRunReward`); `server-jarvis/src/orchestration/effect-gate.ts` | `run-reward.test.ts` |
| 69 | Rollouts run against local models through dedicated Ollama transport (`ollama-local-transport.ts`); costs compute, not API spend | `server-jarvis/src/self-tuning/rollout/ollama-local-transport.ts:123` (`resolveLocalTarget`); `ollama-local-transport.ts:341` (`callOllamaChat`) | `ollama-local-transport.test.ts` |
| 71 | Reward grounded in executed check result; `synth` tier is runtime-authored and earns 0 check term | `server-jarvis/src/orchestration/run-reward.ts:61-64` (`INDEPENDENT_CHECK_TIERS`); `run-reward.ts:250-270` (check term logic) | `run-reward.test.ts` |

## Invariants preserved by these systems

- `TaskPlan` drained before success and `check_tier=none` → `partial`/resumable (`completion-policy.ts:82-118`).
- Offline replay is invariant/regression checking only; never a counterfactual simulator (`conductor-replay.ts:40-46`).
- Held-out fixtures are structurally separated from training fixtures (`fixture-tasks.ts:116-125`).
- Rollouts run local-only through the dedicated Ollama transport (`ollama-local-transport.ts`).
- Reward check term accepts only `existing`/`builtin` tiers; `synth` earns 0 (`run-reward.ts:61-64`).
