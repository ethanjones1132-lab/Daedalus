# Phase D — Fix the measurement, then tune: seeded rollouts + paired held-out verdicts

> **Provenance:** Copied into the repo from the Kimi Code session plan  
> `~/.kimi-code/sessions/.../plans/longshot-donna-troy-donna-troy.md`  
> (session `7f5ff3b9-fcec-47b4-a208-3a28e0702573`, codename Donna Troy).  
> Implemented 2026-08-08; this file is the archival source of truth for that plan.

## Thesis

The handoff's §3.3 says every verdict so far is uninterpretable: `BASELINE_THETA` over the same
8 held-out fixtures scored **0.75 / 0.875 / 0.625 / 0.4375** on four occasions — spread wider than
every winner-vs-baseline gap measured. The root cause is visible in code, not just statistics:

- `rollout-runner.ts:33` — `RolloutSpec.seed` is documented as *"Reserved for future seeded
  sampling; recorded on the outcome."* **It never reaches the model.** Every rollout samples at
  temperature 0.2, unseeded (`local-call-model.ts:221`).
- `run-cma-es.ts:107` — `scoreHeldOut` takes exactly **one** stochastic sample per fixture and
  `improved` is a bare `>` on two single-sample means.

The unlock is **not** brute-force N-repeats (rollouts are 40–70s each; that's the whole budget).
It's wiring the dormant seed through to Ollama's sampler, which buys three variance reductions for
one plumbing change:

1. **Determinism** — same (θ, task, seed) ⇒ same rollout. Re-measurement stops being noise.
2. **Paired comparison (common random numbers)** — winner and baseline evaluated on the *same*
   (task, seed) matrix; the verdict is a CI on the *paired differences*, cancelling shared variance.
3. **CRN fitness evaluation** — all candidates within a generation share one (task, seed) matrix,
   so CMA-ES rank comparisons stop being dominated by sampling noise. The handoff only flagged the
   *held-out verdict*; the *training gradient* has the same disease and this fixes both.

Everything else in this plan (Heretic directive, `--explain`, docstring cleanup) is small and rides
on top of this foundation.

## Process rules (from handoff §6 — non-negotiable)

- **TDD**: RED test, verified failing for the right reason, before every implementation step.
- **Never commit.** Leave the working tree dirty; the user commits explicitly.
- Verify with real command output before reporting anything.
- Current dirty state (the `initialD` fix) is verified green — preserve it; do not revert.

---

## Phase 1 — Wire `RolloutSpec.seed` to the sampler (the unlock)

**RED tests (write first, verify failure):**

- `src/self-tuning/rollout/ollama-local-transport.test.ts` — new test mirroring the existing
  temperature test (line ~114): when `CallOllamaChatOptions.seed` is set, the request body's
  `options` block contains that `seed`. Fails today (field doesn't exist).
- `src/self-tuning/rollout/local-call-model.test.ts` (or nearest existing test file) — seed passed
  in `CallModelFn` options reaches `callOllamaChat` options. Fails today.
- `src/self-tuning/rollout/rollout-runner.test.ts` — a spy `CallModelFn` records the `seed` option
  it receives; `runOneRollout({ seed: 7 })` results in every model call carrying `seed: 7`.
  Fails today.

**Implementation (4 small edits, no pipeline changes):**

1. `src/orchestration/coordinator.ts:34-40` — add `seed?: number` to the `CallModelFn` options type.
2. `src/self-tuning/rollout/ollama-local-transport.ts:65-78` — add `seed?: number` to
   `CallOllamaChatOptions`; include it in the request `options` block (~line 265, next to
   `temperature`).
3. `src/self-tuning/rollout/local-call-model.ts:217-231` — forward `seed: options?.seed`.
4. `src/self-tuning/rollout/rollout-runner.ts:84` — wrap the incoming `callModel` with seed
   injection: `(messages, opts) => callModel(messages, { ...opts, seed: spec.seed })`; the
   `PipelineExecutor` receives the wrapper. Update the stale "Reserved for future seeded sampling"
   comment on `RolloutSpec.seed` to describe what it now does.

**GREEN + `bun run typecheck`.**

Note: Ollama's `/api/chat` honors `options.seed`. Determinism is asserted empirically in Phase 6,
not assumed — if the daemon ignores it, the Phase 6 determinism check will show it and we reassess.

## Phase 2 — Paired, seeded, repeated held-out verdicts

Replace single-sample `>` with a paired confidence interval on per-(task, seed) deltas.

**RED tests (`src/self-tuning/cma-es/run-cma-es.test.ts`):**

- Winner and baseline are evaluated with **identical** seed lists per fixture (fake `callModel`
  records (task, seed) pairs; assert the two matrices match).
- Decision rule: `improved` iff the lower bound of a paired 95% t-CI on per-pair deltas is > 0.
  Test the adversarial case: tiny positive mean delta with high spread ⇒ `improved: false`
  (today's bare `>` says true).
- Degenerate case: all deltas identical and positive (zero variance) ⇒ `improved: true`, no NaN CI.

**Implementation (`src/self-tuning/cma-es/run-cma-es.ts`):**

- `scoreHeldOut(theta, callModel, concurrency, seeds)` — one `runRolloutBatch` call with one
  candidate per seed over `HELD_OUT_TASKS`; returns the per-(task, seed) reward matrix plus mean.
- New `compareHeldOut(winner, baseline, seeds, callModel, concurrency)` — **one** batch containing
  both θs × the same seed list (interleaved jobs share daemon conditions), then pairs by
  (task, seed): `delta_i = winner_i − baseline_i`. Returns `{ winnerMean, baselineMean, meanDelta,
  ciHalfWidth, pairCount, improved }`.
- `CampaignResult` keeps `winnerHeldOut` / `baselineHeldOut` (now means over S seeds — back-compat
  for CLI/artifact consumers) and gains a `heldOutComparison` object with the paired stats.
- `improved` is computed from the CI, not bare `>`.
- `proposeCampaignWinner` rationale gains `meanDelta ± ciHalfWidth over N pairs` — the staging
  record should carry the strength of evidence, not just two means.

**CLI (`campaign-cli.ts`):** `--heldout-repeats N` (default 3 ⇒ 8 fixtures × 3 seeds × 2 θs =
48 rollouts, ≈ +35–55 min vs today's 16 — configurable because it's budget) and a deterministic
seed base derived from `--seed` (e.g. `100_000 + seed`) so a seeded campaign is fully reproducible
end-to-end. Print the paired comparison block in the result output.

## Phase 3 — Common random numbers for training fitness

`evaluateFitness` currently evaluates every candidate on `seed: 0` — and (post-Phase-1) that seed
is now *real*, so without care every candidate would still get different implicit draws via
different prompts. The variance-reduction move: **all candidates in a generation share the same
(task, seed) matrix.**

**RED test:** fake `callModel` records seeds per candidate within one generation; assert all 15
candidates saw the identical (task → seed) assignment.

**Implementation:**

- `run-cma-es.ts` generation loop: `generationSeed = campaignSeedBase + gen`; candidate slot k gets
  `seed: generationSeed` (same for every candidate in that generation).
- `rollout-pool.ts` worker: derive the per-task seed deterministically as
  `candidate.seed * 1000 + taskIndex` (documented; replaces "same seed for every task"). Add/adjust
  a rollout-pool test asserting distinct, deterministic per-task seeds.
- Training fitness across generations intentionally uses *different* seeds per generation — this
  is standard CRN practice (kills within-generation ranking noise without locking the optimizer to
  one lucky sample path).

## Phase 4 — Heretic verify-before-claim directive

Evidence-backed (handoff §3.4): overclaiming was Heretic's dominant failure mode, and Qwythos's
directive already carries the fix line while Heretic's doesn't.

**RED test:** `directiveForModel("qwen3.5-9b-heretic:latest")` contains a distinctive substring of
the new line (e.g. `"read its real output"` / `"not report success from reasoning or confidence alone"`).

**Implementation (`src/orchestration/local-model-directives.ts:21-25`):** append to the Heretic
entry: *"After editing, run the adjacent test and read its real output. Do not report success from
reasoning or confidence alone."* Keep under the ≤600-char soft target (current entry ~300 chars;
addition ~110).

## Phase 5 — Cleanup + promote the diagnostic to `--explain`

- **Docstring**: rewrite the stale `DEFAULT_INITIAL_SIGMA` note (`run-cma-es.ts:70-80`) — the
  "Until per-dimension scaling is added" limitation it describes is now fixed by `initialD:
  thetaBoundWidths()`. Also fix the stale pointer at `sep-cma-es.ts:30`.
- **Delete `scratchpad-diagnose-heldout.ts`** (repo root, hardcoded winner θ) and replace with a
  real CLI mode: `--explain --theta-file <path.json>` where the JSON is a θ diff (same shape
  `thetaDiff` prints). Runs baseline vs θ over held-out fixtures with the Phase-2 seeded harness
  and prints the per-task breakdown table (reward, hardZero, overclaim, notes) the scratchpad
  printed — but deterministic and parameterized. Reuses `compareHeldOut` internals; ~60 lines in
  `campaign-cli.ts`.
- Copy the diagnostic log from the temp dir
  (`C:\Users\ethan\AppData\Local\Temp\claude\...\diagnose-heldout.log`) into `docs/reports/` only
  if the user wants it preserved — flag in final report, don't decide unilaterally.

## Phase 6 — Empirical validation (proof before claims)

1. `bun run typecheck` — clean.
2. `bun test src/self-tuning/` — 203 existing + all new tests green.
3. **Determinism acceptance test**: run `--explain` (or scoreHeldOut via a tiny script) twice for
   BASELINE at fixed seeds against `qwen3.5-9b-heretic:latest` ⇒ per-task rewards **identical**
   across the two runs. This is the direct refutation of the §3.3 spread. If not identical, Ollama
   is not honoring `seed` — stop and reassess before any campaign.
4. **Pilot campaign**: `--generations 2 --tasks 3 --seed 42 --heldout-repeats 3 --model
   qwen3.5-9b-heretic:latest`, background + log file per handoff §5. Report the paired CI, not a
   bare improved flag. Sanity: BASELINE-vs-BASELINE delta CI should bracket 0.
5. Full Heretic → Qwythos → Ornith campaign sequence is the user's budget call afterward — present
   pilot results + rollout-cost arithmetic first.

## Explicitly out of scope (noted in handoff, deliberately deferred)

- `pruneSkillCandidates` deleting promoted skills (`skill-store.ts:113-125`) — real bug, separate
  concern, separate change.
- B2 hard-zero as an *optimizer gradient* question — load-bearing anti-gaming rule; read
  `docs/PHASE_B_RUN_REWARD_ANTI_GAMING.md` before ever touching; not now.
- Generation-count/dimensionality budget experiments — meaningless until the signal is
  trustworthy; revisit after Phase 6.
- Updating the published results artifact (claude.ai URL) — after pilot results exist.

## Rollout-cost honesty (handoff §5)

- Pilot campaign: 2 gens × 15 pop × 3 tasks = 90 training + 48 held-out ≈ 138 rollouts ≈
  **1.5–2.5 h** at 40–70s each, concurrency 4 bounded by GPU. Launch in background, log to file,
  check liveness via `curl -s http://localhost:11434/api/ps` (`expires_at` advancing).

## File-touch summary

| File | Change |
|---|---|
| `src/orchestration/coordinator.ts` | `seed?: number` in CallModelFn options |
| `src/self-tuning/rollout/ollama-local-transport.ts` | `seed` in options + request body |
| `src/self-tuning/rollout/local-call-model.ts` | forward seed |
| `src/self-tuning/rollout/rollout-runner.ts` | seed-injecting wrapper; comment update |
| `src/self-tuning/rollout/rollout-pool.ts` | deterministic per-task seed derivation |
| `src/self-tuning/cma-es/run-cma-es.ts` | seeded fitness, `compareHeldOut`, CI verdict, docstring |
| `src/self-tuning/cma-es/campaign-cli.ts` | `--heldout-repeats`, `--explain`, result output |
| `src/orchestration/local-model-directives.ts` | Heretic verify-before-claim line |
| tests (4 files above) | RED-first coverage for all of it |
| `scratchpad-diagnose-heldout.ts` | deleted (superseded by `--explain`) |
