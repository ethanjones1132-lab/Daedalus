# Overnight 2026-10-05: levers for Qwen3.6 keep96 and Gemma 4 26B

**Brief (owner, 00:46):** "continue testing and comparing through the night ... several levers you can try to pull, dont waste time chasing one down. Compare thinking, effort levels, and custom adapters or LoRas for both Gemma and Qwen. Maybe try running both Gemma and Qwen partnered with Laya, maybe laya could be trained on the weakest areas for each model."

**End goal it serves:** the best-performing local model that can "one-shot this feature/build". Every lever is judged by whether it generalizes beyond benchmarks that ship grading tests.

**Common setup:**
- tier2b: 39 tasks × 3 samples = 117. Run-to-run noise is about ±4.
- Each model at its speed-lab winner, with every lever lossless:

  | Model | Config | Best sampling |
  |---|---|---|
  | Qwen keep96 | all on GPU, MTP + n-gram, 274 tok/s | temperature 0.2 |
  | Gemma 26B | 16 expert layers on CPU, MTP + n-gram, ~100 tok/s | greedy |

- Versutus gate paused for the runs.

> Status: DRAFT, written during the night. Sections marked *pending* fill in as the queue finishes.

## 1. Bottom line

*(final summary goes here once the queue drains)*

## 2. Best-of-N with self-written tests (Qwen keep96): **98 → 107**

Full write-up: `2026-10-05-bestofn-selftest.md`.
- Recipe: one answer at 0.2, two at 0.7, plus one suite of tests the model writes itself. Pick the most tests passed.
- The grading tests are never used to choose.
- 15.5% of the self-tests are wrong, yet any single suite gives the same 107.
- Three candidates are enough.

## 3. Thinking budgets ("effort levels")

| Model | Off | 512 | 1,536 | 4,096 |
|---|---|---|---|---|
| Qwen keep96 | **101** (B 6, D 20) | 94 (B 7, D 16) | **102** (B 11, D 16) | 101 (B 11, D 16) |
| Gemma 26B (greedy) | **105** (B 15, D 18) | 95 (B 10, D 18) | stopped at 14/25 (off: 19/25 on the same samples) | skipped |

- **Thinking does not raise either total on today's runtime.** A short budget (512) costs 7–10 points.
- **For Qwen, 1,536+ moves points between categories:** hidden-package tasks gain 5, file I/O tasks lose 4.
- **For Gemma, thinking produced format failures** (syntax and indentation errors at the token cap). Its 2026-09-10 gain from thinking (96 → 105) is gone because thinking-off is now 105.
- **gpt-oss-20b keep24, the model with explicit effort levels:** low = 105 (2026-10-04); medium = *pending*.

## 4. Adapters and LoRAs

- **Published LoRAs exist for both bases, but none is for code.** They cover legal text, Slovenian, tool calls, fiction, uncensoring, poker and similar. Those trained on the full models would also mismatch keep96's pruned experts wherever they touch the experts.
- **Training our own needs about 20 GB** for 4-bit 35B weights, so it is not possible on 8 GB. On the cloud it needs spend approval and a dataset.
- **Control vectors** (llama.cpp's cheap local adapter): the generator isn't in the 836d571 build, and they are a style lever with little expected effect on correctness. Not run.
- **Laya, the trainable piece at 421M:** the `laya` package ships calibration fitting (temperatures, abstention thresholds) but no training loop. Fine-tuning lives in an external notebook. Calibration on disjoint labelled decisions is the cheap path, and it was not needed for the results below.

## 5. Laya partnership: Laya decides about each task, then routes it

Laya makes bounded decisions about one input with calibrated probabilities. The input is the tier2b prompt exactly as the coder sees it. All results are zero-shot, with rules fixed before scoring.

**How well each Laya question separates its category (root checkpoint):**

| Laya question | Category | Separation (AUC) |
|---|---|---|
| Depends on code that isn't shown? | B | **0.96** |
| Reads or writes files? | D | **0.92** |
| Handles bad input? | C | 0.79 |
| Depends on the standard library? | E | 0.20 (inverted; the wording misses what these tasks are) |

The `kind` answer is "local" for all 7 B tasks and "logic" for all 32 others.

**The two models are complementary:**

| Model | A | B hidden-package | C | D | E |
|---|---|---|---|---|---|
| Qwen keep96 | **36/36** | 6/21 | 21 | **20/21** | 18 |
| Gemma 26B | 33/36 | **15/21** | 21 | 18/21 | 18 |

**Routing results:**

| Configuration | tier2b |
|---|---|
| Qwen single shot / best-of-N / Gemma greedy | 101 / 107 / 105 |
| **Laya: unseen-code tasks → Gemma, the rest → Qwen single shot** | **110** |
| **Laya: unseen-code tasks → Gemma, the rest → Qwen best-of-N** | **111** |
| Hindsight oracle (best configuration per task) | 113 |

**Caveats:**
- Laya's decisions are zero-shot.
- Which model gets which kind of task is a design choice made here, on tier2b's 7 B tasks (21 samples). It needs confirming on disjoint tasks.
- *(pending: final routing with Gemma best-of-N, probe and repair results)*

## 6. Probe-then-fix (the weak area: hidden-package tasks)

The model runs one script in the task's package before fixing. The hidden module is there only as a sourceless `.pyc`, so it can be run but not read.

| | A | B | C | D | E | Total |
|---|---|---|---|---|---|---|
| Qwen single shot | 36 | 6 | 21 | 20 | 18 | 101 |
| Qwen probe-then-fix | 35 | **9** | 20 | 19 | **12** | 95 |
| Gemma single shot (greedy) | 33 | 15 | 21 | 18 | 18 | 105 |
| Gemma probe-then-fix | 33 | **12** | 21 | **21** | 16 | 103 |

- **Probing helps different categories in each model.** Qwen gains on hidden-package tasks (+3). Gemma gains on file I/O (+3) and loses on hidden-package tasks (−3). Both lose on library tasks.
- **Qwen's library failures:** sometimes the model answers with another script instead of the file. Sometimes it copies a wrong import from a probe that failed.
- **Gemma's hidden-package failures** show observations misleading a model. On `pkg_discount` its plain answer reasoned from the bug report and passed 3/3. With a probe it anchored on the hidden module's observed boundary values and wrote a different, wrong fix (0/3).
- **Probing is a per-model, per-task-type lever, not a default,** which is exactly the kind of decision Laya routes. Laya detects file I/O tasks at AUC 0.92.

## 7. Repair with self-test feedback

The script is `repair_tier2b.py`. The loop:
1. One fix and one self-written suite.
2. If any self-test fails, the model gets back its file and each failing test's source and error, with the instruction "a check can itself be wrong; fix the file only where the requirement supports the check".
3. Up to 2 rounds. The grading test only scores.

| Model | Single shot | After repair | Entered repair | Fixed | **Broke** | Stayed right | Stayed wrong |
|---|---|---|---|---|---|---|---|
| Qwen keep96 | 99 (B 6) | **102** (B 9) | 47 of 117 | 5 | **2** | 31 | 9 |
| Gemma 26B | *pending* | | | | | | |

- **Repair is cheaper than best-of-N** (extra calls only where a self-test fails) **but gains less** for Qwen: +3 against +9.
- **This is the clearest reading of the verifier risk.** In 31 of 47 entries the self-test was wrong about correct code and the model kept its code. In 2 it gave in and broke correct code, about 6% of the correct entries.

## 8. Gemma best-of-N and the mixed Qwen + Gemma pool

**Gemma best-of-N** (N=4: candidate 0 greedy, three at 0.7; two self-test suites):

| Selection | tier2b |
|---|---|
| Greedy single shot | 104 |
| Self-test pick | 105 |
| Oracle | 105 |

Unlike Qwen (single 98, oracle 109), re-sampling Gemma at 0.7 never produced a correct fix it lacked. Its tasks are either solved every time or never, so extra samples don't help Gemma. Job time 65 min.

**Mixed pool, Qwen's 3 + Gemma's 4 candidates** (`bestofn_mix.py`, from stored rows). Each candidate is checked against all four suites, two from each model.

| Policy | Total | A | B | C | D | E |
|---|---|---|---|---|---|---|
| Qwen single shot (candidate 0) | 98 | 36 | 6 | 21 | 19 | 16 |
| **Most self-tests passed** | **108** | 35 | 14 | 21 | 20 | 18 |
| CodeT agreement | 105 | 36 | 10 | 21 | 20 | 18 |
| Oracle | **113** | 36 | **17** | 21 | 21 | 18 |

- The mixed pool is the best single pipeline so far: 108 by self-tests, with an oracle of 113 against 109 for Qwen alone and 105 for Gemma alone.
- Self-tests are wrong 13.5% of the time.
- In 8 task-trials a correct candidate existed but wasn't picked. That is the remaining selection headroom.
- Laya routing (unseen-code tasks → Gemma, the rest → Qwen best-of-N, 111) still beats the pool's 108. Routing those tasks to Gemma is a better decision than asking self-tests to choose there.

## 9. Incidents and fixes

- **The best-of-N runner missed `unittest.TestCase` suites,** a third of the model's suites. Fixed, and every stored candidate re-checked offline.
- **At temperature 0.2 the best-of-N candidates were near-copies:** oracle = single shot on the first 26 task-trials. Fixed by sampling the alternatives at 0.7.
- **Expired Monitors left `tail -F | grep` pipelines running** (22 processes). They held log files open, so the overnight chain's PowerShell log writes failed silently. Chain 1's "done" marker was written by hand, and monitors now poll instead.
- **The thinking sweep was stopped early for Gemma** (negative trend) to free about 3 GPU hours for the levers above.
