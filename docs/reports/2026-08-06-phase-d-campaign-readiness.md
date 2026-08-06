# Phase-D campaign readiness — preflight + smoke (2026-08-06)

Run to satisfy the Phase-D plan's own gate: "D2's rollout runner additionally
needs a **real** smoke test (not just unit tests with mocked tool calls) —
run one actual rollout against a live Ollama model and confirm the reward
computation reflects a real file change, before building D3 on top of an
unverified D2." Full console output preserved below rather than left to
scroll away.

## Preflight — `bun run campaign:preflight`

```
=== Phase-D campaign preflight ===
NODE_ENV=test
Ollama version: 0.32.6
Base URL:       http://localhost:11434
Installed:      qwythos9b-conductor:latest, qwen3.5:4b, moondream:latest, llama3.2-vision:11b, gemma4:e2b, qwen3:8b, qwen3:4b
Local stage set:qwen3.5:4b, qwythos9b-conductor:latest, qwen3:8b
Context length: 32768
Context floor:  OK (>= 16384)

Per-stage pool pick (ollamaAvailable=true):
  planner      → ollama:qwen3.5:4b [native-tools]
  executor     → opencode_zen:deepseek-v4-flash-free ⚠ NOT ollama
  reviewer     → ollama:qwen3.5:4b [native-tools]
  synthesizer  → opencode_zen:nemotron-3-ultra-free ⚠ NOT ollama
WARN: one or more stages did not resolve to ollama. Campaign will pin local via nonLocalPickFallbacks, but pool config may be wrong.

Fixtures: 31 training / 8 held-out
  training: merge_intervals, lru_cache, topological_sort, parse_csv_line, pkg_discount, ...
  held-out: pkg_auth, run_checked, clamp_with_lib, find_rotation_point, nested_lookup, slugify_with_lib, pkg_inventory, atomic_write

Preflight complete.
```

**Reading the "NOT ollama" WARN:** expected, not a fault. This diagnostic calls
`pool.pickFor` without the `runRolloutLocalOnly` ALS scope a real rollout
always wraps execution in, so it's showing what the *general* pool would
pick. The actual smoke run below confirms the real enforcement path holds
(`nonLocalPickFallbacks: 0`, all calls landed on `qwen3.5:4b`).

## Smoke — `bun run campaign:smoke`, run twice for consistency

Fixture is always `TRAINING_TASKS[0]` (`merge_intervals`, category A, no
`hiddenFile`) — the CLI doesn't take a task argument.

| | Run 1 | Run 2 |
|---|---|---|
| reward | 0 | 0 |
| hardZero | true — check N/A | true — check N/A |
| writes term | 0 | 0 |
| calls | 13 (all `qwen3.5:4b`) | 13 (all `qwen3.5:4b`) |
| emptyContentTurns | 8 | 10 |
| thinkingOnlyTurns | 0 | 0 |
| nonLocalPickFallbacks | 0 | 0 |
| truncationSuspected | 0 | 0 |
| wall time | 41.0s | 50.7s |

Full breakdown (both runs identical in shape):
```json
{
  "score": 0,
  "terms": { "writes": 0, "check": 0, "plan": 0 },
  "notes": [
    "write-required turn with zero credited content deltas",
    "check term N/A (no CheckResult on run)",
    "plan term N/A (no objective plan items)",
    "B2: write-required turn with declined/missing check — score forced to 0 (check_tier none must not be profitable)"
  ],
  "hardZero": true,
  "hardZeroReason": "B2: write-required turn with declined/missing check — score forced to 0 (check_tier none must not be profitable)"
}
```

## What this does and doesn't prove

**Confirmed working (operationally green):**
- The in-process pipeline runs end-to-end with zero crashes, zero network
  calls outside local Ollama, zero production-DB writes (`NODE_ENV=test`
  guard held).
- Local-only enforcement (D2 Step 5–7) is real: `nonLocalPickFallbacks: 0`
  across both runs — every one of the 13 calls per run actually landed on
  `qwen3.5:4b`, not a free-tier remote fallback.
- `thinkingOnlyTurns: 0` in both runs — the reasoning-channel leak
  (`local_disable_thinking`) is not recurring here; the empty-content turns
  are consistent with ordinary tool-call-only turns, not the thinking-eats-
  the-budget failure mode this fix targeted.
- Reward computation itself does not throw and produces a legible,
  correctly-structured breakdown even for a zero-credit run.

**Not yet proven — the actual exit criterion:** neither run produced a
credited write. `qwen3.5:4b` alone, carrying the full four-stage pipeline
(planner/executor/reviewer/synthesizer) under the smoke harness's default
per-call budget (`num_predict: 1024`), did not land an edit to
`solution.py` in either attempt. Reproducible across 2 runs, not a fluke.
Root cause not yet isolated — candidates, untested: turn/token budget too
tight for a 4B model handling tool-call formatting *and* code generation in
1024 tokens; the four-stage pipeline itself may need more turns than the
smoke harness allows when every stage is the same small local model instead
of a mixed pool. This is exploratory input for whoever tunes D2/D3's
per-call budgets next, not a blocker fixed in this session.

## Two reward bugs found and fixed while validating this

Both discovered by tracing today's live tier2b benchmark, where
`pkg_discount`/`pkg_auth` scored `degraded` (0.333) despite an
independently-passing fix, because the fix landed in the task's hidden
dependency file rather than its named entry file.

1. **[`dc73e3d`](../../server-jarvis/src/orchestration/effect-gate.ts)** —
   production/live reward path (`resolveTaskTargetPaths` in
   `effect-gate.ts`, called from `index.ts`). Now widens an
   already-established target set with paths the turn's own
   `read_file`/`list_directory`/`glob`/`grep`/`git_metadata` calls touched,
   via the new `collectReadToolPaths`. Cannot create a target set on its
   own — only widens one that already exists — so a turn with nothing named
   at all stays path-agnostic rather than narrowing to only what got looked
   at.
2. **[`689f64d`](../../server-jarvis/src/self-tuning/rollout/rollout-runner.ts)**
   — the offline rollout path (what this preflight/smoke actually
   exercises, and what a real CMA-ES campaign will run against). Separate
   code, separate bug: hardcoded `targetPaths: [task.entry]` with no
   widening at all. Fixed directly using the fixture's own schema —
   `targetPaths` now includes `hiddenFile` when the task declares one. No
   heuristic needed here; fixtures carry ground truth.

Without both fixes, every category-B training fixture (7 of 31) would have
scored zero on a correct fix, every time, for the entire life of a
campaign — training the optimizer to avoid exactly the behavior that
produced today's benchmark category-B win (baseline 0/6 → architecture
6/6).

## Recommendation before spending real generations

1. Investigate the qwen3.5:4b no-credited-write result above — likely a
   `num_predict`/turn-budget tuning problem, not a plumbing bug (the unit
   tests with scripted models prove the plumbing is correct end to end,
   including the hiddenFile fix — see `rollout-runner.test.ts`, "a rollout
   that lands a real write in hiddenFile credits it too").
2. Once a real rollout produces `reward > 0` with a credited write, this
   gate is genuinely satisfied and D3 generations are trustworthy to run.
