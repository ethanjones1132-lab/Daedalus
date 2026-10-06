# Adapters phase 1: results

- **Run:** 2026-10-06, 00:05–01:30, unattended (`scripts/moe-bench/adapters-runs/run_phase1.ps1`).
- **Spec:** `2026-10-05-adapters-design.md`. **Plan:** `plans/2026-10-05-adapters-phase1.md`.
- **Data:** `docs/benchmarks/adapters/` (`decisions.json`, `runs/`, `steer-units.json`). Local paths scrubbed.

## Outcome: null

| Arm | What happened |
|---|---|
| Steering vector | Ran. No configuration cut discipline failures at the screening scale, so by §3.4's rule the arm is null. |
| Expert patch | Did not run: C: had 7.9% free, and §6 forbids writing a variant or the KL reference under 10%. |

With both arms null:
- there is no pre-registration and no judge run;
- the sealed judge set is untouched.

## Measured

| What | Result |
|---|---|
| Full Qwen3.6's answers on the 60-task pool (calibration text) | 575,308 characters; probe-then-fix 48/60, single shot 50/60 (trial 0) |
| keep96 on the pool: recipe (3 candidates + 1 self-test suite) | **147/180** |
| keep96 on the pool: single shot (candidate 0) | **144/180** |
| keep96 on the pool: probe-then-fix (v1) | **152/180** (A 36, B 16, C 33, D 32, E 35 of 36) |
| keep96 decode speed (llama-bench, no speculation, all on the GPU) | 78.4 tok/s, 5.52 GB file |

The pool is near keep96's ceiling. Single shot solves 80% and the recipe adds only 3 samples. The full model's single shot beats keep96's by 1 of 60, so on this pool the pruning loss is small.

### Steering screen

All runs are probe-then-fix on the pool's first two trials (120 samples), with the vector at relative scale 0.5:

| Configuration | Applied scale | Discipline failures | Solved |
|---|---|---|---|
| none | — | 24 | 101 |
| mean, all layers | 0.025 | 25 | 100 |
| mean, layers 10–29 | 0.025 | 25 | 100 |
| PCA, all layers | 0.1 | 29 | 96 |
| PCA, layers 10–29 | 0.1 | 25 | 95 |

## Fixed during the run

All fixes are committed.

1. **Variable clash.** PowerShell names ignore case, so the chain's loop variable `$m` overwrote the models folder `$M`, and every steering step went to the wrong folder. Renamed to `$meth`.
2. **Layer count.** `llama-cvector-generator` assumes it captures n_layer − 1 layer outputs. On qwen35moe it captures all 40.
   - Patched to count them on a probe prompt: `scripts/moe-bench/patches/cvector-generator-nextn.patch`, against 836d571.
   - The vectors cover directions 1–40.
3. **Pairing.** `steer.py pairs` matched positives and negatives by list position, so most pairs came from different prompts. The difference vector would have encoded task content.
   - `make_pairs` now pairs within one prompt, and is unit-tested.
   - Each disciplined opening is paired against a script opening and against itself without imports.
   - Each failed opening is paired against a disciplined opening of the same task.
   - Result: 201 pairs.
4. **Micro-batch split.** A prompt split across micro-batches is not captured. So the generator runs one 2,048-token micro-batch, and pairs are capped at 4,000 characters (this text runs about 2.3 characters per token).
5. **Scale units.** The generator writes unit-norm directions, and at scale 0.5 keep96's output became token salad.
   - The spec's 0.25 / 0.5 / 1.0 now act as relative scales, multiplied by a per-method unit. The unit is the largest scale that stayed coherent on all layers, on one toy prompt, with no task scoring: mean 0.05 (it broke at 0.1), PCA 0.2 (it broke at 0.4).
   - Recorded in `steer-units.json`.
6. **Path scrubbing.** `scrub_paths.py` missed account paths inside a repr inside JSON, where the backslashes are doubled twice. It now hides the account name at any escaping depth.

## Caveats

- **PCA's sign is arbitrary.**
  - The cosine between the PCA and mean directions is about 0 at most layers and −0.93 at layer 20.
  - So the PCA rows test directions that may oppose discipline. Their extra failures (29) fit that.
  - The mean rows are the clean test: no effect (25 vs 24 failures).
- **The coherent window is narrow.** The mean vector breaks output at 0.1 on all layers. Scales strong enough to move behaviour may also break it.
- **The discipline proxy is noisy.** 24 of 120 fix answers fail it while 101 of 120 pass their tests: a cleanup can drop an unused import.

## Not run, and what it needs

- **Expert arm:**
  - 10% of C: is 93 GB.
  - The arm writes 3 GB of KL reference and 16.4 GB of slices before its last free-space check, so it needs about 107 GB free at the start: about 35 GB more than tonight.
  - Then rerun `run_phase1.ps1`. It decides once and runs the arm whole: full-model imatrix, KL reference, three slices, KL, the pool.
- **A steering retest** would need sign-aligned PCA and a mean scale between 0.025 and 0.1. Under §3.4 that is a new screen on the pool, not a rescue of this one.
