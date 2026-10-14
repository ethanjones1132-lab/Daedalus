# Laya as Qwen's partner: classify, pick the approach, verify

- **Date:** 2026-10-05
- **Status:** design. Approved in conversation section by section; nothing in it is built or measured yet, except where tagged [measured here].
- **Builds on:** `2026-10-05-overnight-levers.md` (the measurements), `2026-10-05-bestofn-selftest.md` (the recipe), `2026-10-02-micro-agent-swarm-design.md` rev 2 (Laya as the decision plane).
- **Sub-project A of two.** Sub-project B, adapters that patch general capability where keep96 is weak, gets its own spec.

**The brief (owner, 2026-10-05):** "I feel like we have the config down pat, qwen 3.6 keep 96 with best of N is still twice as fast as Gemma with almost no downsides. Your usage case for Laya is thoughtful for the jev swarm and supports our micro agent swarm, however nothing else will fit alongside qwen 3.6 in RAM. For this use case Laya should be able to tell the model that it is supporting what kind of problem it is looking at, help it make a decision on what to implement, and verify if the code is correct."

**Decisions made in conversation:**

| Question | Owner's answer |
|---|---|
| What does "help it decide what to implement" mean? | Laya picks the approach (the playbook) from a fixed menu before Qwen writes anything |
| What does the system optimize? | Accuracy, at no more than today's recipe's average cost per task |
| How does Laya learn its decisions? | As shipped, plus calibration on labelled tasks. No Laya training |

## 1. Starting point

**Qwen keep96** (all layers on the GPU, MTP + n-gram speculation, 274 tok/s):

| Configuration | tier2b (117) | Fresh hidden-package tasks (36) |
|---|---|---|
| Single shot, temperature 0.2 | 98–101 | 11 |
| Recipe: 3 candidates + 1 self-test suite, pick by passes | 103–107 | 10 (oracle 13) |
| Probe, then fix (v1) | 95 | **16** |

- Probing pays on tasks that depend on unseen code and costs 6–11 points on tier2b when run on every task.
- Longer thinking never raised a total.
- The recipe gains nothing when the model lacks information, because its self-tests encode the same misreading.

**Laya** (`convaiinnovations/laya`, 421M ModernBERT, package 0.3.27):
- On disk: the English checkpoint (512 tokens) and `typed-decisions` (1,024 tokens). The multilingual checkpoint (up to 8k tokens) is not downloaded.
- The package ships a rubric grader (`LayaEvaluator`), temperature fitting (`fit_temperatures`) and abstention thresholds (`fit_abstention_thresholds`). It has no training loop.
- About 0.7 s per decision on the CPU.
- **Verification inputs fit** [measured here]: requirement + candidate file is at most 512 tokens for 924 of last night's 936 stored candidates, and at most 1,024 for 932. Median 135 tokens.
- **Zero-shot task signals on tier2b** (2026-10-05): "depends on unseen code" separates hidden-package tasks at AUC 0.96, "reads or writes files" 0.92, "handles bad input" 0.79, "depends on the standard library" 0.20 (inverted wording).
- **Its weakness last night:** P(depends on unseen code) was 0.85–1.0 on every fresh task. It ranks well but needs calibrating before a cutoff means anything.

**How to ask Laya** (jev-swarm `eval/ladder/LAYA-L1N.md`, 2026-09-25):
- Short native options work. Long, rule-laden question texts fail.
- A plain-text, email-style state works. Machine JSON is the wrong shape.
- A fitted calibrator was needed; temperature alone was not enough when the gates are fixed levels.
- Laya's README warns that `noul` questions can follow the label's wording and run overconfident.

## 2. Residents

- **Qwen keep96** on the GPU, configured as today: `--spec-type draft-mtp,ngram-mod`, `--cache-ram 0`, temperature 0.2 for the first candidate and 0.7 for the rest.
- **Laya** on the CPU in its own process (its own venv), loaded once per run.
- **No second coder.** Gemma does not fit alongside Qwen.
- **RAM guard:** with both loaded, Windows must still report at least 2 GB available. The runner measures this before starting and refuses to run below it.

## 3. Per-task flow

### 3.1 Classify

**State:** the requirement and the visible file, as plain text.

**Questions** (short native wording; the final wording is chosen on the calibration pool only):

| Name | Type | Options |
|---|---|---|
| `kind` | choice | algorithm / bad input / files or processes / library use / depends on unseen code |
| `unseen` | noul | the fix depends on code whose source is not shown |
| `effort` | score | little / some / a lot |

The five `kind` options match tier2b's categories A–E.

**The note to Qwen.** The calibrated answer becomes one fixed, descriptive line at the top of Qwen's prompt, one template per `kind`. For example:
- unseen code: "Note: the fix depends on code whose source isn't shown."
- bad input: "Note: this is about handling bad or missing input."

The note is an on/off arm in the evaluation (configuration 5), because a wrong note can mislead. Last night Gemma anchored on misleading probe output.

### 3.2 Pick the approach

**Menu:**

| Playbook | Steps | Generations |
|---|---|---|
| S | One fix at temperature 0.2 | 1 |
| P | One probe script (run in the task's package; output capped at 2,000 characters; 10 s), then one fix that sees its output | 2 |
| R | Recipe: 3 candidates (0.2 / 0.7 / 0.7) + 1 self-test suite; pick by self-tests passed | 4 |
| PR | Probe, then R, with the probe output in every candidate and suite prompt | 5 |
| R8 | 8 candidates + 2 suites | 10 |

**Rule.** Its form is fixed here. Only the cutoffs `c_u`, `c_easy` and `c_hard` are fitted, on the calibration pool:
1. If P(`unseen`) ≥ `c_u`: P when the most likely `effort` level is little, otherwise PR.
2. Otherwise, if P(`effort` = little) ≥ `c_easy`: S.
3. Otherwise, if P(`effort` = a lot) ≥ `c_hard`: R8.
4. Otherwise: R.

**Fitting.** Every playbook runs on every calibration task (§4, nested runs), so any setting of the cutoffs can be scored offline. The cutoffs maximize tasks solved, subject to mean end-to-end wall time per task (Laya included) being at most the recipe's. The cutoffs and the rule are committed before any judge run.

### 3.3 Verify

- **Input:** the requirement and one candidate file.
- **Output:** Laya's calibrated P(correct). It comes from either the rubric grader or a `noul` question ("this file meets the requirement"), whichever separates right from wrong better on the calibration pool, zero-shot.
- **Uses:**
  1. **Tie-break.** Among candidates with equal self-test passes, the higher P(correct) wins. Today the first candidate wins ties.
  2. **Early stop** (R and R8). Candidate 0 and the first suite are generated first. If candidate 0 passes every self-test and P(correct) ≥ `t_hi`, the rest is skipped and the time is saved.
  3. **Escalate.** If the chosen playbook had no probe and its best candidate has P(correct) < `t_lo`, run P once as one more candidate. Then pick among all candidates by self-tests passed, then P(correct).
  4. **Report.** The final answer carries its P(correct). On real features without grading tests, this is the ship-or-don't signal.
- `t_hi` and `t_lo` are fitted on the calibration pool, inside the same wall-time budget as the cutoffs. Early stop and escalation can be simulated offline from the calibration runs, because every candidate and suite is stored.

## 4. Data

**Hard rule:** nothing is fitted on tier2b or on the judge set. That covers question wording, cutoffs, thresholds and temperatures.

**Calibration pool, for fitting only:**
- 60 tasks, 12 per category: last night's 12 fresh hidden-package tasks (`docs/benchmarks/2026-10-05/validation-b/`) plus 48 new ones for A, C, D and E.
- Every playbook × 3 trials per task. The logs give the labels: which playbook solves each task, which candidates are right, and each playbook's wall time.

**Nested runs.** Two runs per task and trial give all five playbooks:
- **One 8-candidate run** at the recipe's temperatures and seeds, with 2 suites: S is candidate 0, R is candidates 0–2 with suite 1, and R8 is all of it.
- **One probe run:** the probe, then 3 candidates and 1 suite that all see its output. P is the probe with candidate 0; PR is all of it.
- Every call's wall time is logged, so each playbook's wall time is the sum of its calls.
- Last night's ablations already read the 3-candidate recipe out of the 8-candidate runs this way.

**Judge set, for scoring only:**
- 60 new tasks, 12 per category, 3 trials each (180 samples).
- Committed before anything runs on them. Git history shows the rule, cutoffs and thresholds were committed before the first judge result.

**Task rules** (both sets):
- tier2b's format: "Fix `<entry>`", the visible files, a one-line requirement, and a grading test that never enters a prompt, a probe or a selection.
- Each task is checked with `validate.py`: the buggy file fails its test, and a reference fix passes.
- Hidden-package tasks hinge on an unseen convention. The helper module is present only as compiled bytecode, so it can be run but not read.
- No near-copies of tier2b tasks: different functions and different conventions.

## 5. Evaluation

**Configurations,** run on the judge set and reported on tier2b for continuity:

| # | Configuration |
|---|---|
| 1 | Qwen single shot |
| 2 | Today's recipe (the baseline) |
| 3 | Laya classifies and picks the approach, with the note |
| 4 | 3 plus verify |
| 5 | 4 without the note |
| 6 | Hindsight best playbook per task (the ceiling) |

The two nested runs give configurations 1, 2 and 6 (without the note). Configurations 3–5 run end to end through the runner.

**Measured:**
- Tasks solved (the main number), per category.
- Mean end-to-end wall time per task (Laya included), mean generations, and generated tokens.
- For Laya: separation (AUC) and calibration error (ECE) per question, before and after fitting; abstention rate; fallback count.
- For verify: false accepts (wrong code with P(correct) ≥ `t_hi`) and false rejects (right code with P(correct) < `t_lo`).
- **Zero-shot baseline, reported once:** Laya's task questions on tier2b's 39 tasks, and verify on the 936 stored tier2b candidates. These numbers are not used to tune anything.

**The bar,** committed before the judge run: configuration 4 solves more judge samples than configuration 2 in a paired test (McNemar, p < 0.10), with mean wall time per task no higher than configuration 2's. Otherwise the result is reported as a null, with which step (classify, approach, verify) helped or hurt.

## 6. Components

New files in `scripts/moe-bench/`:

| File | What it does | Depends on |
|---|---|---|
| `laya_partner.py` | `classify(task) -> card` and `verify(task, file) -> p`, plus applying `calib.json`. A long-lived worker in Laya's venv, speaking JSON lines over stdin/stdout. A batch CLI for the zero-shot baseline and the calibration labels | `laya` |
| `playbook.py` | The rule (card → playbook), cutoff and threshold fitting under the wall-time budget, and the offline simulation of early stop and escalation. Pure functions, no models, with unit tests | standard library |
| `laya_calibrate.py` | Fits Laya's probabilities on calibration labels with `fit_temperatures` and `fit_abstention_thresholds`. Adds a sigmoid with an offset if temperature alone is not enough. Writes `calib.json` | `laya` |
| `playbook_tier2b.py` | The runner. Per task: ask Laya, pick the playbook, run it, grade afterwards. Holds the five note templates and the suite prompt that sees probe output (PR). Logs every Laya answer, call time and fallback. Resumable per (task, trial) | `bestofn_tier2b` (`chat`, `check`, `pick`, `test_prompt`), `probe_tier2b` (`probe_prompt`, `fix_prompt`, `run_probe`), `playbook`, the Laya worker |

The existing scripts stay unchanged, so last night's results remain reproducible.

New task sets, run through the existing `TIER2B_DIR` switch:
- `docs/benchmarks/laya-calib/tasks.py` (48 new; imports the 12 validation-b tasks)
- `docs/benchmarks/laya-judge/tasks.py` (60 new)
- each with a `validate.py`, reusing validation-b's

## 7. Failure handling

| Failure | Behaviour |
|---|---|
| The Laya worker fails to start, crashes, or takes over 5 s on a call | That task runs the recipe; the row records `fallback: laya_error` |
| Laya abstains (below the fitted abstention threshold) | Recipe; `fallback: abstain` |
| A verify input is over 512 tokens | The 1,024-token checkpoint; over that, no P(correct) for that candidate, and selection uses self-tests alone |
| Under 2 GB of RAM available with both models loaded | The runner refuses to start |
| A probe hangs or floods its output | The existing 10 s limit and 2,000-character cap |

## 8. Order of work

1. Write and validate the 48 calibration tasks and the 60 judge tasks. Commit the judge set.
2. Build `playbook.py` test-first, then `laya_partner.py`, `laya_calibrate.py` and `playbook_tier2b.py`.
3. Zero-shot baseline on tier2b (CPU only, no GPU).
4. Measure RAM with Qwen and Laya both loaded.
5. Calibration runs: the two nested runs × 3 trials on the 60 calibration tasks (about 1.5 GPU hours), plus Laya on every task and candidate (about 25 minutes of CPU).
6. Fit the wording, temperatures, cutoffs and thresholds. Commit the rule, `calib.json` and the bar.
7. Judge runs: the two nested runs, then configurations 3–5 end to end (about 2.5 GPU hours). Then configurations 3–5 on tier2b (about 40 minutes), whose other configurations come from last night's runs.
8. Report: `docs/superpowers/specs/<date of the judge run>-laya-partner-results.md`.

**GPU estimates** are scaled from last night's keep96 runs on 117 samples: 8 candidates + 2 suites took 34.0 min, the recipe 12.9 min, and probing 2.1–7.5 min. The total is about 4.5 GPU hours, one overnight run.

The Versutus gate is paused during GPU runs and restored afterwards. The owner confirms before it is paused.

## 9. Out of scope

- **Training or fine-tuning Laya** (the owner chose as shipped plus calibration).
- **A second coder model,** which does not fit alongside Qwen.
- **Laya scoring Qwen's readings of the requirement** (the "pick the interpretation" option). Parked.
- **Wiring into the Daedalus or swarm runtime, and multi-file features.** These come after the bar is met. Downloading the multilingual 8k checkpoint is decided then, if real inputs exceed 1,024 tokens.
- **Adapters:** sub-project B, with its own spec.

## 10. Risks

- **Zero-shot verify may not separate right from wrong code** (AUC near 0.5). Then verify adds nothing, configuration 3 still tests classify plus approach, and the report says so.
- **60 calibration tasks is small** for fitting three cutoffs and two thresholds. The fit uses a coarse grid, and the report gives the fitted values with their calibration-pool scores.
- **Hand-written tasks are not real feature work.** The judge set is the same kind of task as the calibration pool. Transfer to real features is not shown here.
- **Wall time is noisy.** Each configuration runs in one block on an otherwise idle machine, and generated tokens are reported next to it.
- **RAM on 16 GB.** Laya on the CPU in WSL once took 8.5 GB in batched predict. This design runs Laya on Windows, one input at a time, and measures RAM before any run.
