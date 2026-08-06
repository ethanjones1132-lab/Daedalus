# Phase D: sep-CMA-ES Policy Optimization

## Context

The six prerequisites from the prior plan on this file (mid_loop_continue budget scoping, build-gate timeout, θ-governance isolation, attribution wiring, reward-evidence fingerprinting, Phase A pre-fix baseline) are **done and pushed** — `master` @ `52ba882`, verified: `tsc --noEmit` clean, 2862 TS tests / 116 Rust tests all passing. That plan is complete; this is a new one, replacing it.

Phase D is where the strategic thesis of `docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md` gets tested: can a black-box optimizer (sep-CMA-ES) tune the 43-dimension policy vector θ better than hand-tuning, using local/free-tier rollouts that cost nothing per evaluation? This is the piece that makes "trained orchestrator over a free pool" more than a slogan.

Three investigation passes (two Explore agents, one Plan agent, all findings independently spot-verified against source before writing this plan) established the ground truth below. Two genuine gaps were found that the master plan's D1-D4 sketch assumed were already solved — this plan builds them, not just the optimizer.

**User decision:** sep-CMA-ES implemented natively in TypeScript (not a Python bridge) — keeps the whole loop in one runtime, reuses `thetaToVector`/`vectorToTheta`/`BASELINE_THETA` directly.

**Step 0 (blocked by plan mode, do first on exit):** kill the stale server on :19877 — it's been running pre-fix code since before tonight's six commits landed and must not be trusted for anything, including Phase D work.

---

## Current state (verified 2026-08-06, uncommitted working tree)

A prior agent session began this plan and stopped mid-way when it ran out of usage. Verified by direct read + full suite run — `tsc --noEmit` clean, **2877 tests pass / 0 fail**, nothing left half-written:

| Step | State |
|---|---|
| **D3 — `theta-bounds.ts`, `sep-cma-es.ts` (+ both test files)** | **Complete.** Real separable CMA-ES: rank-μ covariance update, `hsig`, exponential step-size adaptation, Box-Muller sampling. No TODOs/stubs. 36 tests pass. **Do not rewrite.** |
| **D1 — `held_out.py`** | Created, matches spec (frozen, stratified). **But references 3 tasks that don't exist yet** (`find_rotation_point`, `nested_lookup`, `slugify_with_lib`) and `tasks.py` is untouched — so the D1 Step 2 assertion is not yet wired. Fix this first; it's a latent fail-loud waiting to happen. |
| **D4 — `policy-staging.ts` `patchIsEmpty`** | One-line fix already landed: it never checked `patch.theta`, so a θ-only patch (exactly what D4 Step 1 proposes) would have been silently rejected as empty. Verified correct — `patch.theta` was already merged at `:226`, the emptiness check was just blind to it. Keep. |
| **D2 — rollout runner** | **Not started.** No `src/self-tuning/rollout/` directory; `agent-pool.ts` untouched. This is the load-bearing gap — D3's optimizer has nowhere to send candidates for scoring without it. |

**Therefore the remaining work is D1 (finish) + D2 (build), then D4's small driver.** D3 needs no further work.

---

## What's already true (verified, not assumed)

| Fact | Where confirmed |
|---|---|
| θ is 43 fields, `THETA_KEYS` fixed order, `thetaToVector`/`vectorToTheta` exist and round-trip deterministically | `orchestration-policy.ts:89-133, 265-279, 360` |
| `runWithTheta(patch, fn)` scopes θ to one async context via ALS — production/global θ untouched | `orchestration-policy.ts:244-249` |
| Reward is fully computable in-memory — `computeRunReward`/`computeRunRewardFromEffects` need zero DB access | `run-reward.ts:300, 407` |
| `PipelineResult` already carries `checkResult` and `writeEffects` — no need to reach into private pipeline state | `pipeline.ts:826-827, 837` |
| `PipelineExecutor`'s collector arg is optional — a rollout never needs `LiveConductor` | `pipeline.ts:1021-1038` (constructor comment) |
| Policy-staging's candidate→shadow→canary→production lifecycle already exists, driven by live-traffic outcomes, governance thresholds now immutable (tonight's `99c54b3`) | `policy-staging.ts:264, 319, 561` |
| `PolicyPatch.theta` already accepts a θ delta; `domain` is metadata only — grepped, zero gating logic reads it | `policy-staging.ts:92`; confirmed via `patch.domain ===` grep, no hits |
| A real production incident (2026-07-13) already produced a systemic test/rollout DB-safety guard: no explicit override + `NODE_ENV=test` → safe in-memory DB | `store.ts:568-598`, comment cites the incident directly |
| Test-file naming is load-bearing: only `_t.py`/`_t[name].py`/`test_*.py`/`*_test.py` gets picked up by the check gate's "adjacent_test" priority | `run-gate.ts:10, 93-108` |

## Two real gaps (not solved by existing code — this plan builds them)

1. **No in-process orchestrator invocation exists.** `tier2b`'s `run_architecture` is HTTP-only, POSTing to a live `/chat/stream` server (`runbench2b.py:105-143`). Running dozens of rollout evaluations through live HTTP means either many concurrent server processes (port-collision risk — this exact codebase spent tonight fixing that class of bug) or a new in-process path. Building the latter.

2. **No way to force a full turn through Ollama-only.** `preferLocalForStage` (`agent-pool.ts:315-317`) only gates planner/reviewer, and even where it does apply, free-tier remote agents share `orchestrationRoutingTier === 0` with Ollama (`agent-pool.ts:361-374`, confirmed by direct read) — so "prefer local" does not mean "exclude remote." Without a real fix, Phase D's core cost premise (rollouts are ~free) is not actually guaranteed.

---

## File structure

| File | Responsibility |
|---|---|
| `scripts/benchmark-tier2b/tasks.py` | Modify — extend `TASKS` 10→30-50, add `held_out` flag |
| `scripts/benchmark-tier2b/held_out.py` | Create — canonical frozen held-out task-name list |
| `server-jarvis/src/self-tuning/rollout/fixture-tasks.ts` | Create — TS fixture loader/seeder, mirrors tier2b schema |
| `server-jarvis/src/self-tuning/rollout/noop-recorder.ts` | Create — no-op `StageRunRecorder` |
| `server-jarvis/src/self-tuning/rollout/rollout-runner.ts` | Create — one (θ, task) → reward evaluation, in-process |
| `server-jarvis/src/self-tuning/rollout/rollout-pool.ts` | Create — bounded-concurrency fan-out |
| `server-jarvis/src/orchestration/agent-pool.ts` | Modify — rollout-local-only ALS flag, enforced in `pickFor` |
| `server-jarvis/src/self-tuning/cma-es/theta-bounds.ts` | Create — per-dimension domain table + projection |
| `server-jarvis/src/self-tuning/cma-es/sep-cma-es.ts` | Create — optimizer core |
| `server-jarvis/src/self-tuning/cma-es/run-cma-es.ts` | Create — driver: fixtures + runner + optimizer + promotion |
| `server-jarvis/src/self-tuning/policy-staging.ts` | **No changes** — D4 is a caller only, confirmed sufficient as-is |

Execution order is strict: D1 → D2 → D3 → D4. Each depends on the previous. Each should get its own TDD pass (tests first, per this codebase's established practice) rather than building all four in one sitting — this is a multi-session phase, not an afternoon.

---

## D1 — Fixture suite (10 → 30-50 tasks)

**Current state**, confirmed by direct read of `tasks.py`: 10 tasks, `K=3` samples/task. Categories: A=4 (general bugs), B=2 (hidden-file package bugs), C=2 (edge-case semantics), D=2 (I/O/process), E=1 (`clamp_with_lib` — symbol-grounding, asserts no fabricated API names land in the solution).

**Target distribution:** A≈10-14, B≈6-8, C≈6-8, D≈6-8, E≈4-6. E is the most load-bearing category for Phase D specifically — it's the one that would catch a CMA-ES that learns to reward fabrication-tolerant behavior — and it currently has exactly one task. Do not skip expanding it.

### Held-out split — structural enforcement, not a convention

- [ ] **Step 1: Create `held_out.py`**

```python
"""Canonical held-out task names for Phase D. Frozen at design time — not
randomized per run, so results are comparable across the whole CMA-ES
campaign. Every name here must exist in tasks.py's TASKS (tasks.py asserts
this on import and fails loud on drift/typo)."""

HELD_OUT_NAMES: frozenset[str] = frozenset({
    "clamp_with_lib",       # category E — keep the existing symbol-grounding task held out
    "pkg_auth",              # category B
    "run_checked",           # category D
    # ... fill to ~20% of final task count, stratified across A-E
})
```

- [ ] **Step 2: `tasks.py` imports and asserts against it**

```python
from held_out import HELD_OUT_NAMES

# after TASKS is fully defined:
_names = {t["name"] for t in TASKS}
_missing = HELD_OUT_NAMES - _names
assert not _missing, f"held_out.py names not in TASKS: {_missing}"
```

- [ ] **Step 3: Add 3 concrete new tasks** (full schema, matching existing pattern exactly — `{name, category, entry, files, spec, test, hidden_file?}`)

**`quantize_with_lib`** (category E) — mirrors `clamp_with_lib`'s shape:
```python
{
    "name": "quantize_with_lib",
    "category": "E",
    "entry": "solution.py",
    "files": {
        "lib/quantutil.py": (
            "def quantize_step(value, step):\n"
            "    if step <= 0:\n"
            "        raise ValueError('step must be positive')\n"
            "    return round(value / step) * step\n"
        ),
        "solution.py": "# implement snap_to_grid(value, step) using lib.quantutil.quantize_step\n",
    },
    "spec": (
        "Implement snap_to_grid(value: float, step: float) -> float in solution.py. "
        "It must use the existing quantize_step helper in lib/quantutil.py — do not "
        "reimplement quantization logic or invent a different library function name."
    ),
    "test": (
        "import solution\n"
        "assert solution.snap_to_grid(7.3, 2) == 8\n"
        "assert solution.snap_to_grid(-1.2, 0.5) == -1.0\n"
        "print('OK')\n"
    ),
}
```

**`pkg_inventory`** (category B) — hidden-file boundary bug, mirrors `pkg_discount`'s shape but a different domain so CMA-ES can't pattern-match on vocabulary:
```python
{
    "name": "pkg_inventory",
    "category": "B",
    "entry": "stock.py",
    "hidden_file": "warehouse.py",
    "files": {
        "warehouse.py": (
            "def available(sku_count, reserved):\n"
            "    # BUG: off-by-one — reserved == sku_count should mean 0 available, not -1\n"
            "    return sku_count - reserved - 1\n"
        ),
        "stock.py": "from warehouse import available\n\ndef check(sku_count, reserved):\n    return available(sku_count, reserved)\n",
    },
    "spec": (
        "check(sku_count, reserved) in stock.py returns available inventory. "
        "Bug report: check(5, 5) returns -1, should return 0. Fix the root cause "
        "(you may only edit stock.py — warehouse.py is a vendored dependency)."
    ),
    "test": (
        "import stock\n"
        "assert stock.check(5, 5) == 0\n"
        "assert stock.check(10, 3) == 7\n"
        "assert stock.check(0, 0) == 0\n"
        "print('OK')\n"
    ),
}
```

**`atomic_write`** (category D) — crash-safety, new bug class not yet represented:
```python
{
    "name": "atomic_write",
    "category": "D",
    "entry": "persist.py",
    "files": {
        "persist.py": (
            "def save_state(path, data):\n"
            "    # BUG: partial writes corrupt state if interrupted mid-write\n"
            "    with open(path, 'w') as f:\n"
            "        f.write(data)\n"
        ),
    },
    "spec": (
        "save_state(path, data) in persist.py must be crash-safe: a process kill "
        "mid-write must never leave path with partial/corrupt content. The prior "
        "content (or no file) must survive an interruption. Write via a temp file "
        "then atomic rename."
    ),
    "test": (
        "import os, persist\n"
        "path = '_state.txt'\n"
        "if os.path.exists(path): os.remove(path)\n"
        "persist.save_state(path, 'first')\n"
        "assert open(path).read() == 'first'\n"
        "persist.save_state(path, 'second')\n"
        "assert open(path).read() == 'second'\n"
        "print('OK')\n"
    ),
}
```

- [ ] **Step 4: Write 17-37 more tasks following the pattern** to reach the 30-50 target and the category distribution above. Each: 15-40 line reference solution with one seeded bug, spec describing symptom not fix, test with 3-5 assertions plus a final `print('OK')`. Vary bug class per task (boundary condition, mutation-during-iteration, type coercion, exception-swallowing, resource leak) so tasks don't collapse into near-duplicates an optimizer could memorize rather than generalize from.

- [ ] **Step 5: Run the dry-run harness to confirm no crashes across the full expanded suite**

```bash
python scripts/benchmark-tier2b/runbench2b.py --arm both --k 1
```
Expected: all tasks show `SKIP (0.0s) not run` (dry-run, no `--live`) with no traceback — confirms `held_out.py`'s assertion passes and every new task's schema is well-formed before spending any inference on it.

---

## D2 — Rollout runner

### Fixture loading and seeding

- [ ] **Step 1: `fixture-tasks.ts`** — either mirror `tasks.py`'s schema in TS directly, or shell out to Python once at startup to dump `TASKS`/`HELD_OUT_NAMES` as JSON and load that (simpler, avoids maintaining two copies of 30-50 task definitions by hand — recommended). Export:
```ts
export interface FixtureTask {
  name: string;
  category: "A" | "B" | "C" | "D" | "E";
  entry: string;
  files: Record<string, string>;
  spec: string;
  test: string;
  hiddenFile?: string;
}
export const TRAINING_TASKS: readonly FixtureTask[];
export const HELD_OUT_TASKS: readonly FixtureTask[];
export function seedFixtureWorkspace(task: FixtureTask): Promise<string>; // returns temp dir path
```
`seedFixtureWorkspace` mirrors `runbench2b.py`'s `seed()`/`run_test()` (`:50-56, 34-47`): write `task.files` into a fresh temp dir, write `task.test` to `_t.py` **at the workspace root** — this exact naming is required for `run-gate.ts`'s `TEST_FILE` regex to match via "adjacent_test" priority (`run-gate.ts:10, 93-108`). Getting this wrong silently zeros every rollout's check-reward term with no error.

**Critical, structural (not runtime) enforcement of the held-out split:** `TRAINING_TASKS` and `HELD_OUT_TASKS` are the only two exports. D3's fitness function signature takes `FixtureTask[]` as a parameter but its only caller passes `TRAINING_TASKS` — there is no code path by which `HELD_OUT_TASKS` can reach `ask()`/`tell()`. The held-out scorer is a separately-exported function, called exactly once, after the optimizer loop terminates.

### DB safety — two guards, not one

- [ ] **Step 2: `noop-recorder.ts`**
```ts
import type { StageRunRecorder } from "../../orchestration/pipeline";
export const noopRecorder: StageRunRecorder = {
  recordStageRun: () => {},
  recordDirective: () => {},
  recordModelAttribution: () => {},
};
```
Passed as `PipelineExecutor`'s 4th constructor arg instead of the default `outcomeCollector`.

- [ ] **Step 3: rollout entrypoint sets `process.env.NODE_ENV = "test"`** before any rollout runs. This is not redundant with Step 2 — it catches lazily-constructed module-singleton stores a rollout doesn't explicitly wire (e.g. `delegate-model-select.ts`'s `scoreboardStore = new SelfTuningStore()`, built the first time the delegate path fires). `store.ts:568-598`'s guard (confirmed live, built after a real 2026-07-13 incident where tests polluted production `self-tuning.db`) makes any such singleton use a safe in-memory DB instead, with zero per-call-site changes needed.

### In-process pipeline invocation

- [ ] **Step 4: `rollout-runner.ts`**
```ts
export interface RolloutSpec {
  theta: OrchestrationTheta;
  task: FixtureTask;
  seed: number;
}
export interface RolloutOutcome {
  reward: number; // RunRewardBreakdown.score
  breakdown: RunRewardBreakdown;
}
export async function runOneRollout(spec: RolloutSpec): Promise<RolloutOutcome>
```
Body: `seedFixtureWorkspace(spec.task)` → build a narrow `ToolRuntime` via `createToolRuntime()` + only `registerFilesystemBundle`, `registerShellBundle`, `registerTaskBundle`, `registerMetaBundle` (deliberately **not** `registerStandardBundles` — skip `registerWebBundle`/`registerMcpClientBundle`/`registerInteractiveBundle`; a rollout must make no outbound network calls) → construct `PipelineExecutor(callModel, runtime, ctx, noopRecorder)` → run the whole body inside `runWithTheta(spec.theta, () => runRolloutLocalOnly(() => executor.execute(...)))` (both ALS scopes composed; `runRolloutLocalOnly` from Step 6 below) → on return, call `computeRunRewardFromEffects({ effects: result.writeEffects ?? [], check: result.checkResult ?? null, targetPaths: [spec.task.entry], writeRequired: true })`.

**Test:** run one rollout against a trivial fixture with `BASELINE_THETA` and a real Ollama model, assert `reward.score` is computable and the seeded temp workspace shows the expected file change — this is the smoke test proving the whole in-process path actually works end to end before building the optimizer on top of it.

### Local-only routing enforcement

- [ ] **Step 5: `agent-pool.ts`** — add the ALS flag, same pattern as `thetaAls`:
```ts
const rolloutLocalOnlyAls = new AsyncLocalStorage<boolean>();
export function runRolloutLocalOnly<T>(fn: () => T): T {
  return rolloutLocalOnlyAls.run(true, fn);
}
function isRolloutLocalOnly(): boolean {
  return rolloutLocalOnlyAls.getStore() === true;
}
```

- [ ] **Step 6: widen `preferLocalForStage`** (`agent-pool.ts:315-317`):
```ts
export function preferLocalForStage(stage: string): boolean {
  if (isRolloutLocalOnly()) return true;
  return stage === "planner" || stage === "reviewer";
}
```

- [ ] **Step 7: the actual enforcement — filter in `pickFor`**, immediately after tier filtering (`agent-pool.ts:498-499`, after `tierCandidates` is computed):
```ts
if (isRolloutLocalOnly()) {
  tierCandidates = tierCandidates.filter((a) => a.provider === "ollama");
}
```
This is necessary because Step 6 alone only widens the M1b *preference* injection — free-tier remote agents share `orchestrationRoutingTier() === 0` with Ollama (confirmed, `agent-pool.ts:361-374`), so without this filter they remain eligible in the general ranking path even when "local is preferred."

**Test:** under `runRolloutLocalOnly`, call `pickFor("executor", ...)` and `pickFor("synthesizer", ...)` with a pool containing both Ollama and free-tier remote agents; assert only Ollama agents are ever returned. Also assert that *outside* `runRolloutLocalOnly`, behavior is byte-identical to before this change (existing `agent-pool.test.ts` cases should not need modification).

### Parallelism

- [ ] **Step 8: `rollout-pool.ts`**
```ts
export async function runRolloutBatch(
  candidates: { theta: OrchestrationTheta; seed: number }[],
  tasks: readonly FixtureTask[],
  opts: { concurrency: number },
): Promise<RolloutOutcome[][]> // outer: candidates, inner: tasks
```
Bounded-concurrency map (not unbounded `Promise.all` — a local Ollama daemon serializes on GPU regardless of caller count, so unbounded fan-out just adds queueing latency without real parallelism). `AsyncLocalStorage` isolates per-async-context by construction, so concurrent rollouts each get their own θ and local-only scope with no cross-talk — same guarantee the codebase already relies on for `runWithTheta` elsewhere.

**Flagged uncertain — do not treat as settled:** the concurrency cap is an empirical property of the local Ollama daemon's GPU contention, not derivable from source. Start at 4-8, measure actual throughput during D2's own smoke testing, adjust before D3 depends on it.

---

## D3 — sep-CMA-ES

- [ ] **Step 1: `theta-bounds.ts`** — one entry per `THETA_KEYS` member:
```ts
export interface ThetaBound { min: number; max: number; kind: "integer" | "ratio01" | "ms" | "count"; }
export const THETA_BOUNDS: Record<keyof OrchestrationTheta, ThetaBound>;
export function projectToBounds(vector: number[]): number[]; // clamp + round, THETA_KEYS order
```
Ratios (`no_tool_ratio_ceiling`, `mid_loop_endgame_turn_ratio`, `repetition_similarity_threshold`, etc.) clamp to `[0,1]`. Integer counts (`max_quality_pushes`, `max_directives_per_turn`, etc.) round and floor at 1. Millisecond budgets floor above a real minimum (e.g. `routing_timeout_ms >= 1000`) — a 0 or negative timeout would crash a rollout outright, not just underperform. **Flagged uncertain:** exact per-field bounds need a dimension-by-dimension pass against `BASELINE_THETA`'s actual values (`orchestration-policy.ts:139-190`), not a generic rule — this is real work, budget time for it, don't rubber-stamp a formula across all 43 fields.

This is the fix for the confirmed gap that `mergeTheta`/`vectorToTheta` only check `Number.isFinite` (`orchestration-policy.ts:228, 274`) — implemented as the optimizer's own bounds-handling feature (every real box-constrained CMA-ES needs this anyway), not a separate upstream validation task.

**Test:** feed `projectToBounds` a vector with a negative timeout, a ratio of 2, and a non-integer count; assert the output is valid on every dimension and `vectorToTheta` of the projected output never produces a value `mergeTheta` would reject.

- [ ] **Step 2: `sep-cma-es.ts`**
```ts
export class SepCmaEs {
  constructor(opts: {
    dim: number;
    initialMean: number[];
    initialSigma: number;
    bounds: (v: number[]) => number[];
    popSize?: number; // default 4 + floor(3*ln(dim)) ≈ 15 for dim=43
  });
  ask(): number[][];                          // λ raw samples, already bounds-projected
  tell(samples: number[][], fitness: number[]): void; // rank + update mean/sigma/diagonal-covariance
  get mean(): number[];
  get sigma(): number;
}
```
Standard separable CMA-ES: diagonal covariance only (not full O(n²) matrix) — appropriate given 43 dimensions with very different natural scales (e.g. `mid_loop_endgame_budget_ms` ~45000 vs `no_tool_ratio_ceiling` ~0.5) and no assumed cross-dimension correlation structure. `initialMean = thetaToVector(BASELINE_THETA)` — start at the known-good point, not a random draw; the fixture suite (30-50 tasks) is small enough that early wild exploration wastes budget that should go toward refinement.

- [ ] **Step 3: `run-cma-es.ts`** — driver wiring D1+D2+D3:
```ts
async function evaluateFitness(theta: OrchestrationTheta): Promise<number> {
  const outcomes = await runRolloutBatch(
    [{ theta, seed: RUN_SEED }],
    TRAINING_TASKS, // never HELD_OUT_TASKS — see D2 Step 1
    { concurrency: ROLLOUT_CONCURRENCY },
  );
  return mean(outcomes[0].map((o) => o.reward));
}
```
Reuse tier2b's `K=3` samples/task convention for variance reduction across the training loop, not just held-out scoring. **Flagged uncertain, explicit recommendation:** whether to blend cost (wall-clock/token count) into the fitness scalar is a real design choice this codebase gives no existing signal on. Recommend starting **reward-only** and treating cost as a secondary tie-break, not a blended term — keeps the optimizer's objective legible, and a mis-weighted cost penalty could silently teach θ to prefer fast-wrong over slow-right.

Termination: fixed generation budget (near-zero marginal cost means the real constraint is wall-clock/GPU-contention, not spend) plus a sigma-convergence stop.

---

## D4 — Promotion

Confirmed: **no changes to `policy-staging.ts`** — it already accepts exactly this shape.

- [ ] **Step 1: after optimizer termination, score held-out once, then propose**
```ts
const winner = vectorToTheta(cma.mean, BASELINE_THETA);
const heldOutScore = await scoreHeldOut(winner);   // HELD_OUT_TASKS, called exactly once
const baselineHeldOutScore = await scoreHeldOut(BASELINE_THETA);

if (heldOutScore <= baselineHeldOutScore) {
  console.log(`Phase D: no improvement (${heldOutScore} vs ${baselineHeldOutScore}); not proposing`);
} else {
  const diff: ThetaPatch = {};
  for (const key of THETA_KEYS) if (winner[key] !== BASELINE_THETA[key]) diff[key] = winner[key];
  proposePolicy(
    { domain: "budget", theta: diff },
    `Phase D sep-CMA-ES: held-out mean reward ${heldOutScore.toFixed(4)} vs baseline ${baselineHeldOutScore.toFixed(4)} over ${HELD_OUT_TASKS.length} fixtures`,
  );
}
```
`domain: "budget"` matches the one existing precedent (`policy-staging.test.ts:39`); confirmed by grep that `domain` gates nothing, so this choice only needs to be consistent, not perfectly principled.

From here, `recordEligibleOutcome`/`recordCanaryOutcome` (`policy-staging.ts:319, 561`) drive candidate→shadow→canary→production against real live traffic, entirely unchanged — this was the whole point of fixing the θ-governance leak tonight: the machinery that vets a promoted candidate cannot be tuned by the candidate itself.

**A regression check that must not be skipped:** if `heldOutScore <= baselineHeldOutScore`, do not propose. An optimizer that fails to beat the hand-tuned baseline on held-out data is a valid, useful result (it tells you the signal isn't there, or the fixture suite needs work) — it is not license to ship a losing candidate anyway.

---

## Verification (every step of D1-D4)

```bash
cd server-jarvis
bun run typecheck
bun test
```
Zero failures required before considering any step done — this suite (2862 tests as of tonight) has repeatedly caught exactly this class of plumbing gap earlier in this session.

D2's rollout runner additionally needs a **real** smoke test (not just unit tests with mocked tool calls) — run one actual rollout against a live Ollama model and confirm the reward computation reflects a real file change, before building D3 on top of an unverified D2.

## Explicitly flagged, not silently assumed

1. Rollout concurrency cap (D2) — empirical, needs measurement, not derivable from code.
2. Cost-normalization of fitness (D3) — no existing precedent either way; recommend reward-only to start.
3. Per-dimension θ bounds (D3) — needs a real dimension-by-dimension pass against `BASELINE_THETA`, not a generic formula.
4. `.worktrees/orchestration-review-items-5-8`'s `policy-rollout.ts` is **not reusable** for D2 — it deterministically replays synthetic decision inputs, not real fixture execution with reward scoring. Do not attempt to merge/adapt it; it solves a different, smaller problem (proving θ-plumbing is deterministic) than D2 needs (actually running fixtures and scoring them).
