# Laya partner v2 (targeted probe): judge results, 2026-10-07

- **Pre-registered** in `2026-10-05-laya-partner-prereg.md`, pushed at commit 76a2873 (01:41:20), before any Laya run on the judge set.
- **Runs:** 01:42–05:20, keep96, `--load-mode none`, Versutus gate paused (restored and healthy at 05:21).
- **Design:** `2026-10-06-laya-v2-design.md`. **Data:** `docs/benchmarks/laya-partner/` (local paths scrubbed).

## Outcome: the bar is not met

Configuration 4 solves 158 of 180 judge samples against the recipe's 154, in 18% less model time (6.04 vs 7.39 s). Neither test is close to the bar:

| Bar test (config 4 vs config 2) | Result | Needed |
|---|---|---|
| Solves more | 158 vs 154 | yes ✓ |
| Exact McNemar on samples | 7 vs 3, p = 0.34 | p < 0.10 ✗ |
| Exact sign test on tasks | 5 vs 3, p = 0.73 | p < 0.10 ✗ |
| Mean model secs no higher | 6.04 vs 7.39 | yes ✓ |

By the pre-registered rule this is a null. On tier2b, written separately and reported for continuity, configuration 4 is significantly *worse* than the recipe: 99 vs 107, 1 vs 9 samples (p = 0.021), 0 vs 6 tasks (p = 0.031).

## The six configurations on the judge set

| # | Configuration | Solved | Mean secs | A / B / C / D / E (of 36) |
|---|---|---|---|---|
| 1 | Single shot | 140 | 0.97 | 31 / 16 / 27 / 33 / 33 |
| 2 | Recipe (baseline) | 154 | 7.39 | 34 / 17 / 34 / 36 / 33 |
| 3 | Laya rule + note | 158 | 5.90 | 33 / **21** / 34 / 36 / 34 |
| 4 | 3 + verify | 158 | 6.04 | 33 / **21** / 34 / 36 / 34 |
| 5 | 4 without the note | 154 | 6.29 | 34 / 18 / 33 / 35 / 34 |
| 6 | Hindsight best playbook per task | 167 | — | |

- **The other fixed playbooks** (from the nested runs):

  | | S | P | R | PR | R8 |
  |---|---|---|---|---|---|
  | Solved | 140 | 156 | 154 | 160 | 160 |
  | Mean secs | 0.97 | 2.86 | 7.39 | 8.94 | 15.96 |

- **Reproducibility:** configurations 1 and 2 reproduce phase 1's measurements on the same seeds closely (single 140 vs 143, recipe 154 vs 153).

## Which step helped

| Step | Judge set | tier2b |
|---|---|---|
| Classify and route (3 vs 2) | +4 solved: hidden conventions 17 → 21; others −1, +1 | 98 vs 107 (−9) |
| Verify (4 vs 3) | ±0 solved, +0.14 s; 44 early stops, 0 escalations | 99 vs 98 |
| Note to Qwen (4 vs 5) | +4: hidden conventions 21 vs 18 | **−3** (99 vs 102) |

## Laya

- **The hidden-code signal transfers.**
  - It ranked the judge set's 12 hidden-convention tasks at AUC **0.98** (pool 1.00), and tier2b's 7 at **0.89**.
  - Every hidden-convention task was probed on both sets.
- **The cutoff probes too much.**
  - c_hidden = 0.0828 probed 27 of 60 judge tasks (A 6, B 12, C 5, D 4, E 0) and 22 of 39 tier2b tasks (A 6, B 7, C 1, D 3, **E 5 of 6**).
  - On tier2b, Laya rated the library tasks as hidden code, and probing them is what cost points there (E 16–17 vs 18), as on 2026-10-05.
- **Verify** separated right from wrong candidates at AUC 0.65 on the judge set (pool 0.79).
- **The diagnostics script** (`laya_calibrate.py report`) scored only the v1 yes/no "unseen" question (AUC 0.36 on the judge set), not the kind signal the rule used.
  - Fixed at 05:45: the report now leads with `hidden` for the committed signal.
  - `laya-judge-diagnostics.json` was regenerated and gives AUC 0.981, matching the live rows.
- **No Laya fallbacks** in any run.

## RAM

- With Qwen and Laya loaded, 1,715 MB was available at the launch of judge configurations 3 and 4, against the spec's 2,048 MB guard. Both were refused and rerun with the pre-registered 1,024 MB fallback.
- Configuration 5 and all three tier2b runs passed the 2,048 MB guard.
- No storage errors.

## Hindsight on the judge set (not a result; it informs the next design only)

Probing the top-k tasks by Laya's signal, with the recipe elsewhere:

| k | P on probed | PR on probed |
|---|---|---|
| 6 | 154 (tasks 1 vs 2) | 153 |
| 12 | 158 (tasks 5 vs 2, p = 0.45) | 156 |
| 18 | 157 | 156 |
| 27 | 156 | 155 |

No cutoff would have passed.

## Reading it

1. **Laya's classification works and generalizes.** One question's probability finds hidden-code tasks at AUC 0.89–1.00 across three task sets, zero-shot, with no training.
2. **The lever it routes to is weak.** One probe plus one fix solves 20 of 36 hidden-convention samples on the judge set, against the recipe's 17, so perfect routing to it adds about 3–4 samples. The judge set's other categories are near ceiling.
3. **Probing non-hidden tasks costs.** On tier2b the signal also flags library tasks, and the probe replaces the recipe's self-test selection there. That is where both of the night's significant results came from, and both are losses.
4. **The judge set's one Laya look is spent.** Any further Laya iteration needs a fresh held-out set, preferably from a different writer than the pool, per the 2026-10-06 lesson.

**For the next design:**
- Strengthen the probe itself, for example probe output in every recipe candidate and suite, two probes, or probe then repair. It is the only lever that moves hidden-convention tasks.
- Keep probes off library tasks with a second signal: P(kind = library) had pool AUC 0.99.
- Judge the next design on more and independent tasks.

## Why the probe is weak (from the stored probe transcripts, added 05:40)

Hidden-convention task-trials (36 per set), by probe state and whether probe-then-fix (P) passed:

| | Probe crashed | Probe ran, P failed | Probe ran, P passed |
|---|---|---|---|
| Calibration pool | 12 (5 still passed) | 12 | 12 |
| Judge set | 8 (4 still passed) | 12 | 16 |

Two failure modes, seen in the transcripts:

1. **The probe asks the wrong question.**
   - It often calls the buggy entry function instead of the hidden helper, or calls the helper with inputs it does not accept.
   - `j_weight_grams`: the probe printed `total_kg(['book', 'mug']) = 800` (grams) from the entry function and never called `catalog.weight`. The fix missed the unit (P 0/3, though single shot solved 2/3).
   - `j_basis_points`: it guessed a product id, and the probe crashed on `KeyError: 1000`.
   - `j_iso_weekday`: it passed day names to a helper that wants ISO dates. The fix ignored the "Invalid isoformat string" errors and rewrote the function around names.
2. **The fix does not check itself against the requirement's own example.**
   - `j_utc_offset_west`: the probe showed `offset_minutes('new_york') = 300` and `local_hour(12, 'new_york') = 17`.
   - The requirement says noon UTC is 7 in the morning in New York, yet the fix still returned 17.
   - Running that one example after the fix would have caught it.

**What that suggests for a stronger probe** (owner's call; nothing here is tested):
- A probe prompt that calls the *hidden helper* directly, with inputs taken from how the entry file uses it, and prints its return value and type.
- One retry with the error when the probe crashes.
- Then a check of the fix against the requirement's concrete examples, with one repair round on failure.

## Files

- **Runs:** `laya-judge-nested.jsonl`, `laya-judge-labels.jsonl`, `laya-judge-c{3,4,5}.jsonl`, `laya-tier2b-c{3,4,5}.jsonl`.
- **Reports:** `judge-report.json` (`playbook.py report`), `laya-judge-diagnostics.json`.
- **Scripts:** `scripts/moe-bench/laya-runs/run_session2.sh`, `run_fit.sh`, `ram_check.py`.
