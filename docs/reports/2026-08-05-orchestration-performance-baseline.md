# Orchestration performance baseline — 2026-08-05

Recorded after implementing
`docs/superpowers/plans/2026-08-05-orchestration-performance-broad-plan.md`
(Tasks 1–8). **Whole-window numbers are dominated by historical rows** and will
not drop until date-sliced post-deploy measurement (plan Task 9 step 4).

## Tooling

- Suite: `bun test` in `server-jarvis` — **2780 pass / 0 fail**, `tsc --noEmit` clean
- Benchmark: `bun scripts/benchmark-conductor-completion.ts --limit 500`
- Replay: `bun scripts/replay-conductor.ts --limit 200` (historical violations expected)

## Benchmark (last 500 runs, whole store)

| Metric | Value | Gate |
|---|---:|---|
| Executor no-tool ratio | 42.6% (1126/2641) | max 10% — FAIL |
| Delegate write-land rate | 89.4% (246 runs) | min 80% — PASS |
| Unverified successes | 93 | max 0 — FAIL |
| **Unchecked writes** (new) | **93** (93/180 write successes) | max 0 — FAIL |
| False-complete runs | 27 | max 0 — FAIL |
| Duplicate write-pressure | 13 | max 0 — FAIL |
| Writes landed / run | 1.07 | min 0.5 — PASS |
| Avg run wall-clock | 2.17 min | — |
| Round-trips / run | 9.09 | — |
| Time to first visible token | 2.12 min | — |

## Commits in this plan

| Task | SHA | Summary |
|---|---|---|
| 1 | `c0fa91d` | `stage_run_id` on model_attributions |
| 2 | `dcab4c3` | `failure_detail` on typed stage failures |
| 3 | `108cb7e` | `check_declined_reason` / CheckResult.declinedReason |
| 4 | `6ea5502` | unchecked_write_ratio release gate |
| 5 | `f5f1084` | demote executor models by no-tool rate |
| 6 | `f3c05cd` | bench models by error rate |
| 7 | `b78a2a9` | infra failures do not bench delegate for the run |
| 8 | `8bd4da7` | DirectiveBudget (24/turn) |

## Post-deploy measurement recipe

```bash
# After restart on the new build and at least one full_execution live turn:
cd server-jarvis
bun scripts/benchmark-conductor-completion.ts --since 2026-08-06T00:00:00Z --limit 200
bun scripts/replay-conductor.ts --limit 200
```

Compare date-sliced no-tool ratio, unchecked writes, and directive volume to the
whole-window table above. Improvements will only show on the slice.
