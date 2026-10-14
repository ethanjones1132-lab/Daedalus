# Best-of-N with self-written tests on Qwen3.6 keep96 (2026-10-05)

**Question.** Qwen3.6 keep96 runs tier2b in 1.7 minutes. Does sampling several fixes and choosing one beat single-shot? The rule for choosing: use only signals that exist for any feature or build, never the benchmark's grading tests. The owner's concern: such gains depend on a verifier that "will not be clean on all content."

**Answer.** Yes. **98 → 107/117** with eight candidates and tests the model wrote itself, which matches gpt-oss-20b's 108 within noise at Qwen keep96's 274 tok/s. The cheap recipe (three candidates, one suite) gave 107 and 103 in two independent runs; see "Replication" below. The gain survives a noisy verifier: 15.5% of the self-tests are wrong, and selection still recovers 9 of the 11 points the oracle could gain.

## Setup

`scripts/moe-bench/bestofn_tier2b.py` ran on Qwen3.6 keep96 locally. Config: all on GPU, MTP + n-gram speculation, thinking off, Versutus gate paused. tier2b is 39 tasks × 3 trials = 117 task-trials. Run time was 34 min for everything below.

**Per task-trial:**
- **8 candidate fixes** with the tier2b prompt. Candidate 0 uses temperature 0.2 and the tier2b seed, so it is the plain single-shot answer. Candidates 1–7 use temperature 0.7: at 0.2 the eight were near-copies, and on the first 26 task-trials the oracle equalled single shot.
- **2 self-test suites,** written by the model from the same visible information as the fix (the requirement and the visible file), at temperatures 0.2 and 0.7. Test functions and `unittest.TestCase` methods are both run. A third of the suites are TestCase classes even when functions are requested; the first runner missed them, and all stored candidates were re-checked after the fix.
- **Checks on every candidate,** in a seeded workspace with the grading test deleted: it compiles, its module imports, and the pass/fail result of every self-test.
- **Grading test,** run afterwards only to score the chosen candidate, plus per-candidate grading for the diagnostics.

## Results (N = 8)

| Policy | Score | A algorithmic | B hidden-package | C robustness | D file I/O | E library |
|---|---|---|---|---|---|---|
| Single shot (candidate 0) | 98 | 36 | 6 | 21 | 19 | 16 |
| Average temperature-0.7 candidate | 94.3 | 33.9 | 6.7 | 19.3 | 18.3 | 16.1 |
| First that compiles and imports | 98 | 36 | 6 | 21 | 19 | 16 |
| **Most self-tests passed** (ties: largest same-pattern group) | **107** | 36 | **11** | 21 | **21** | **18** |
| CodeT (group size × tests passed) | 104 | 36 | 8 | 21 | 21 | 18 |
| Oracle (any candidate passes grading) | 109 | 36 | 13 | 21 | 21 | 18 |

Single shot here is 98, against 101 in the 2026-10-04 sampling sweep, which is within the ±4 run-to-run noise.

## How much depends on the verifier

**Verifier error modes** (CodeT policy, 117 task-trials):

| Case | Count |
|---|---|
| Self-tests cannot tell candidates apart | 77 (mostly all candidates right, or all wrong the same way) |
| No correct candidate existed | 8 |
| Missed a correct candidate | 5 |
| Picked a candidate that passes every self-test yet fails grading | 3 |
| Self-tests failed by grading-correct candidates (wrong or over-specified tests) | 1,671 of 10,769 (**15.5%**) |

**Ablations** (`scripts/moe-bench/bestofn_ablate.py`, from stored rows):

| Verifier gets | Score |
|---|---|
| Suite 0 only (temp 0.2) | 107 |
| Suite 1 only (temp 0.7) | 107 |
| Both suites | 107 |

| Candidates N | 1 | 2 | 3 | 4 | 6 | 8 |
|---|---|---|---|---|---|---|
| Self-test selection | 98 | 103 | **107** | 107 | 107 | 107 |
| Oracle | 98 | 103 | 107 | 108 | 108 | 109 |

**Replication** (05:22, fresh seeds for every alternative candidate and suite, the cheap recipe of 3 candidates and 1 suite):

| Selection | Score |
|---|---|
| Single shot | 98 |
| Self-test pick | **103** |
| CodeT | 100 |
| Oracle | 105 |

The N=3 rows of the ablation below are a subset of the main run, and that draw was good. Across the two runs the cheap recipe gains +5 to +9. The variance sits in the 21 hidden-package samples (8 against 11).

**Reading the ablations:**
- **Compile and import checks add nothing here.** keep96 almost always writes code that parses. On other models or bigger features, this layer may matter more.
- **The gain comes entirely from the model's own tests.** Any single suite is enough, and the tests' 15.5% error rate does not stop them ranking candidates, because selection is relative.
- **Agreement-weighted selection (CodeT) is worse than counting passes.** On hidden-package tasks (B), the majority of candidates are often wrong the same way, so agreement backs the wrong group.
- **Three candidates are enough.** N=3 reaches the oracle's N=3 ceiling exactly. More candidates raise the oracle only to 109 and the selection not at all.
- **Answers are short** (mean 99 tokens), so the practical recipe costs about 4× a single shot: candidates at 0.2, 0.7, 0.7, plus one test suite.

## What this means for "one-shot this feature/build"

All three layers exist for real features:
- the build or parse succeeds;
- the module or app starts;
- the model writes acceptance checks from the request.

The 15.5% wrong-test rate is the honest cost: on content where self-tests are unreliable, the gain shrinks, but it did not turn negative anywhere here. What it cannot fix is a task where no candidate is right: 8 task-trials, all in B (inferring an unseen module's API). That needs better information-gathering, such as probing the hidden module by running it, rather than more samples.

## Files

- `docs/benchmarks/2026-10-05/bestofn-keep96-t07.jsonl`: every candidate, suite, check and grade.
- `docs/benchmarks/2026-10-05/bestofn-keep96-t02-partial.recheck.jsonl`: the temperature-0.2 control, 26 task-trials.
- Scripts: `scripts/moe-bench/bestofn_tier2b.py` (run / analyze / recheck) and `bestofn_ablate.py`.
