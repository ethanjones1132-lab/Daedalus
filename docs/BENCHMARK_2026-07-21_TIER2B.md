# Jarvis Architecture vs. Model Baseline — Tier-2B

## Status

The Tier-2B fixture and runner are implemented in
`scripts/benchmark-tier2b/`. A live K=3 measurement was completed on
2026-07-22 against the deployed server release `186613af6e4c3ac4afc233d3cd8842353127cb1d`.
The generated result is preserved in
`scripts/benchmark-tier2b/results-tier2b.json` (ignored by source control).

Live mode remains intentionally opt-in because the suite makes 60 inference
calls at K=3 (10 tasks × 3 × 2 arms).

## Live K=3 result (2026-07-22)

| Arm | Passes | Rate |
| --- | ---: | ---: |
| Baseline | 18/30 | 60.0% |
| Architecture | 20/30 | 66.7% |

The architecture arm produced a net lift of 2 passes (+6.7 percentage points).
The category breakdown shows where the lift came from:

| Category | Baseline | Architecture |
| --- | ---: | ---: |
| A — matched-information logic | 6/12 | 8/12 |
| B — multi-file exploration | 0/6 | 3/6 |
| C — iteration-required | 6/6 | 5/6 |
| D — execution-required | 6/6 | 4/6 |

Per-task results:

| Task | Baseline | Architecture |
| --- | ---: | ---: |
| `merge_intervals` | 2/3 | 2/3 |
| `lru_cache` | 3/3 | 2/3 |
| `topological_sort` | 1/3 | 2/3 |
| `parse_csv_line` | 0/3 | 2/3 |
| `pkg_discount` | 0/3 | 1/3 |
| `pkg_auth` | 0/3 | 2/3 |
| `safe_divide_batch` | 3/3 | 2/3 |
| `retry_with_backoff` | 3/3 | 3/3 |
| `load_or_create_json` | 3/3 | 2/3 |
| `run_checked` | 3/3 | 2/3 |

The result supports the intended architecture hypothesis for tasks requiring
repository context and cross-file reasoning, especially categories A and B.
It also shows that the current orchestration path can regress on already
solved utility tasks; the next improvement should target regression control,
not simply add more context.

## Fixture corrections

- `topological_sort` now seeds only the intended missing cycle-state bug; the
  accidental `order[::-1]` defect is removed.
- `pkg_discount` reports only the boundary symptom. The exact numeric discount
  schedule is no longer leaked to the model; the test remains the oracle.
- `load_or_create_json` requires a persisted default and nested-directory
  creation, so a read-only response cannot pass.
- `run_checked` requires a real subprocess invocation, trimmed stdout, and
  stderr-preserving failure behavior.

## Method

The suite has 10 tasks: 4 matched-information logic tasks, 2 multi-file
exploration tasks, 2 existing iteration-required tasks, and 2 new
execution-required tasks. Each arm is run at K=3. The baseline gets a single
completion and only the entry file; the architecture gets a live
`/chat/stream` turn, a writable temporary workspace, and the adjacent `_t.py`
oracle discovered by the run gate.

Run a bounded dry check with:

```powershell
scripts/run-tier2b-benchmark.ps1
```

Run the full measurement only when explicitly authorized for the current
usage budget:

```powershell
scripts/run-tier2b-benchmark.ps1 -Arm both -K 3 -Live
```

The result artifact is written to `scripts/benchmark-tier2b/results-tier2b.json`
and is intentionally ignored by source control.
