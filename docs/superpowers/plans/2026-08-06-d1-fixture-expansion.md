# Handoff — Phase D / D1 remainder: expand tier-2B fixtures to 30-50 tasks

Repo: `C:\Projects\home-base-recovered` · branch `master` · HEAD `bb34d6a`
Suite: `scripts/benchmark-tier2b/` · **currently 14 tasks, target 30-50**

## Your job

Write 16-36 new fixture tasks in `scripts/benchmark-tier2b/tasks.py`. That's it.
Everything else in Phase D is built or explicitly out of scope for this handoff.

These fixtures become the training and held-out sets for a sep-CMA-ES optimizer
that tunes a 43-dimension policy vector. **Fixture quality is the ceiling on
everything downstream** — a suite that's too small, too samey, or subtly broken
produces a "winning" policy that means nothing.

## Read first (don't re-derive)

| Path | What it holds |
|---|---|
| `docs/superpowers/plans/2026-08-06-phase-d-cma-es.md` | The full Phase D plan. §D1 has the target distribution, the bug-class guidance, and 3 worked example tasks (`quantize_with_lib`, `pkg_inventory`, `atomic_write`) you can write directly. |
| `scripts/benchmark-tier2b/tasks.py` | The 14 existing tasks — your schema reference. Match their shape exactly. |
| `scripts/benchmark-tier2b/held_out.py` | The frozen held-out name list + why it's structurally enforced. |
| `docs/MASTER_PLAN_LEARNED_ORCHESTRATION.md` | Why Phase D exists at all (strategic context, Phase A-D roadmap). |

## Current state

```
total: 14
  A: 5  merge_intervals, lru_cache, topological_sort, parse_csv_line, find_rotation_point
  B: 2  pkg_discount, pkg_auth
  C: 3  safe_divide_batch, retry_with_backoff, nested_lookup
  D: 2  load_or_create_json, run_checked
  E: 2  clamp_with_lib, slugify_with_lib
```

**Target distribution (from the plan): A≈10-14, B≈6-8, C≈6-8, D≈6-8, E≈4-6.**

Category meanings, inferred from the existing tasks — read a couple of each before writing:
- **A** — general single-file bugs (algorithms, parsing, data structures)
- **B** — package bugs where the real defect is in a `hidden_file` the agent may not edit; only `entry` is editable
- **C** — edge-case semantics (falsy values, boundary conditions, retry/exception behaviour)
- **D** — I/O and process handling (files, subprocesses, crash-safety)
- **E** — **symbol grounding.** Seeds a real helper in a subdirectory (`lib/…`), and the spec names plausible-but-fake APIs the agent must *not* use. The test asserts the fabricated names are absent from the landed source via `inspect.getsource`.

**Prioritise E.** It's the category that catches an optimizer learning to reward
fabrication-tolerant behaviour, and it currently has only 2 tasks. Under-weighting
it is the single most likely way this suite produces a misleading result.

## Schema

Each entry in `TASKS` is a dict:

```python
{
    "name": "unique_snake_case",
    "category": "A" | "B" | "C" | "D" | "E",
    "entry": "solution.py",        # the ONE file the agent is expected to edit
    "hidden_file": "rules.py",     # category B only — seeded but off-limits
    "files": {"solution.py": "...", "lib/helper.py": "..."},  # subdirs allowed
    "spec": "Describe the SYMPTOM, never the fix.",
    "test": "...assertions...\nprint('OK')\n",
}
```

Notes that are easy to get wrong:
- `files` **must** contain `entry` (a loader test asserts this).
- Subdirectory seeds work (`lib/mathutil.py`) — `seedFixtureWorkspace` creates parents.
- The graded `test` is written to `_t.py` by the harness. Don't name a seed file `_t.py`.
- Category E convention: also seed a visible `solution_t.py` helper test (see `clamp_with_lib`). It is *not* the graded test and does not match the run-gate regex — it's a hint file for the agent.

## The two checks that actually matter

Run both after every batch you write. They catch the two ways a fixture is
worthless, and they are not covered by any existing test suite:

**1. Every seeded fixture must FAIL its own test.** If the seed already passes,
there's nothing to fix and the task teaches the optimizer nothing.

```bash
cd scripts/benchmark-tier2b
python - <<'EOF'
import subprocess, sys, tempfile, pathlib
from tasks import TASKS
bad = []
for t in TASKS:
    with tempfile.TemporaryDirectory() as d:
        root = pathlib.Path(d)
        for name, content in t["files"].items():
            p = root / name; p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content, encoding="utf-8")
        (root / "_t.py").write_text(t["test"], encoding="utf-8")
        r = subprocess.run([sys.executable, "_t.py"], cwd=root,
                           capture_output=True, text=True, timeout=20)
        if r.returncode == 0: bad.append(t["name"])
        print(f"  {t['name']:24s} {t['category']}  {'PASSES(!!)' if r.returncode==0 else 'fails-as-expected'}")
print("\nBROKEN (seed already passes):", bad or "none")
EOF
```

**2. Every new fixture must be SOLVABLE.** Write the correct fix yourself and
confirm the test passes. A test that can't be satisfied is as useless as one
that's already satisfied — and much harder to notice later.

Adapt the `FIXES` dict pattern: seed the workspace, overwrite `entry` with your
known-good solution, run `_t.py`, assert exit 0. I verified all 3 tasks I added
this way; do the same for yours.

## Held-out split

`held_out.py` is the single source of truth. `tasks.py` asserts on import that
every held-out name exists in `TASKS`, so a typo fails loud rather than silently
shrinking the held-out set.

Currently 6 of 14 held out. **As you grow the suite, add to `HELD_OUT_NAMES` to
keep roughly 20%, stratified across all five categories.** Don't let any category
end up entirely absent from either split — a held-out set with no E task can't
detect the failure mode E exists to catch.

## Guidance on writing good fixtures

From the plan, and worth taking seriously:

- **15-40 line reference solution, ONE seeded bug.** Not a puzzle, not a rewrite.
- **Spec describes the symptom, not the fix.** `pkg_discount` is the model: *"Customers report that two exact boundary totals are charged full price"* — no mention of the off-by-one.
- **3-5 assertions plus a final `print('OK')`.**
- **Vary the bug class.** Already represented: off-by-one, falsy-value confusion,
  boundary condition, non-dict traversal, missing sort, LRU recency, whitespace
  collapse. Reach for others — mutation-during-iteration, type coercion,
  exception swallowing, resource leaks, integer division, mutable default args,
  shadowed builtins, encoding assumptions.
- **Vary domain vocabulary.** `pkg_inventory` in the plan is deliberately a
  different domain from `pkg_discount` despite the same bug shape, so the
  optimizer can't pattern-match on words instead of structure.
- **Vary `entry` filenames.** Currently only 5 distinct names across 14 tasks
  (`solution.py` dominates). More variety is better.

## Verify before you finish

```bash
cd scripts/benchmark-tier2b
python -c "import tasks; print(len(tasks.TASKS), 'tasks')"   # assertion passes on import
python ../../scripts/benchmark-tier2b/runbench2b.py --arm both --k 1   # dry run, no inference
```

Dry run must show every task `SKIP (0.0s) not run` with no traceback. It costs
nothing — no `--live` flag means no model calls.

Then, from `server-jarvis/`:
```bash
bun run typecheck && bun test
```
The TS side loads these fixtures through a Python bridge
(`src/self-tuning/rollout/fixture-tasks.ts`), and `fixture-tasks.test.ts` asserts
the splits are disjoint, non-trivial, and structurally complete. Currently 2898
tests pass — keep it there.

## Scope boundaries

**Do not** touch: `server-jarvis/src/self-tuning/rollout/`,
`server-jarvis/src/self-tuning/cma-es/`, `agent-pool.ts`, or `policy-staging.ts`.
Those are D2/D3/D4 and are done or deliberately deferred.

**Do not** run `--live` benchmarks. That spends real inference and isn't needed
to validate fixtures.

**Don't reformat `tasks.py`.** It has an existing mojibake character in
`clamp_with_lib`'s spec (a mangled em-dash) — leave it; rewriting the file to
"fix" encoding will produce a huge noisy diff.

## Suggested skills

- `superpowers:verification-before-completion` — the two fixture checks above are exactly this discipline; run them, don't assume.
- `superpowers:test-driven-development` — each fixture *is* a test; the fail-then-fix cycle is the natural way to write one.
