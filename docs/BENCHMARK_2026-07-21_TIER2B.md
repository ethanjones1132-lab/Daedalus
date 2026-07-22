# Jarvis Architecture vs. Model Baseline — Tier-2B

## Status

The Tier-2B fixture and runner are implemented in
`scripts/benchmark-tier2b/`. The prior Tier-2 artifacts were temporary and
were not part of the repository, so this report makes the corrected suite
reproducible before recording a new live score.

No live K=3 measurement is claimed in this commit. Live mode is intentionally
opt-in because the suite makes 60 inference calls at K=3 (10 tasks × 3 × 2
arms), which is not appropriate for an unbounded default validation run.

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
