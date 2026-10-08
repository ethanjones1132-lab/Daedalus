# Laya v3: pre-registration (before any judge run)

- **Committed:** 2026-10-08 12:40 (5548446), before the first run of anything on `docs/benchmarks/laya-judge3/`. Nothing has run on the new judge set: it was sealed in a404c4b (DeepSeek-written, validated with `validate_tasks.py`, 120/120 well-formed) and has not been opened by a model since.
- **Design:** `2026-10-07-laya-v3-design.md`, with the owner's amendment of 2026-10-08 (the v1 probe as a third route; below). **Plan:** `plans/2026-10-08-laya-v3.md` (deviations below).
- **Coder:** Qwen3.6-35B-A3B keep96 (`bestofn_tier2b.CONFIGS["qwen36keep96"]`), MTP + n-gram speculation, llama-server 836d571.
- **Laya:** 0.3.27 on the CPU, as in v2.

## The new judge set (sub-project 1)

| | |
|---|---|
| Writer | `deepseek-v4.1-flash` on OpenCode Go (not a Qwen model, so the judge set is not written by the coder's family) |
| Prompts | 40 per family (A–E), 200 in all; 179 produced a valid task |
| Selection | the first 24 valid tasks per family in id order (fixed before any task was seen run) |
| Checks | `train_tasks/make.py`'s rules: each buggy entry file fails its test and each reference passes (`make.validate`); disjoint from tier2b, the pool and the old judge set by task name, identifiers, hidden-file name and spec wording (word Jaccard < 0.5). No filtering on any model's performance |
| Seal | a404c4b, pushed 2026-10-08 08:15 |

## What was fitted, on the calibration pool only

The data is the pool session's extended nested runs (60 tasks × 3 trials, the 2026-10-06 r8/pr rows plus probe v3's p3 block) and Laya's labels. Both are copied into `docs/benchmarks/laya3/`.

**`calib.json`:**

| Choice | Value | Pool evidence |
|---|---|---|
| Classify wording | v1 | |
| Hidden signal | `kind_p` (P(kind = depends on code whose source is not shown)) | AUC for hidden-convention tasks **1.00** (v1 yes/no 0.44, v2 yes/no 0.74, v2 kind 0.81), as in v2 |
| Library signal | `kind_p["library"]` | AUC for library tasks (category E) **0.99** (v2 wording 0.99) |
| Verify form | rubric | AUC 0.79 (noul 0.77); Platt [0.989, −0.248], unchanged from v2 (same labels) |
| Valid map (B's gate) | Platt [0.525, 1.091] | AUC **0.67** on 606 example asserts (498 pass the reference fix); ECE 0.12 raw, 0.02 calibrated |

**`rule.json`** (v3 form; the routing grids are the deciles of the 60 pool tasks' signals, plus never):

| Parameter | Value | Grid |
|---|---|---|
| `c_hidden` (P3 when the hidden signal is at least this) | 0.0747 | deciles 0.026 … 0.1708, never |
| `c_lib` (and the library signal below this) | 0.6181 | deciles 0.2853 … 0.8436, never |
| `c_probe` (else v1's probe P when the hidden signal is at least this; the amendment) | 0.026 | `c_hidden`'s grid |
| `c_note` (A: the note when Laya's top mismatch has at least this probability) | 0.3 | 0.3, 0.5, 0.7, never |
| `c_valid` (B: repair when a failing assert's P(valid) is at least this) | 0.5 | 0.3, 0.5, 0.7, never |
| `t_hi` (recipe early stop) | 0.5 | 0.5 … 0.9, never |
| `t_lo` (C: escalate when the pick's P(correct) is below this) | never | never, 0.2, 0.4, 0.6 |
| `e_fail` (C: escalate when the pick fails its own self-test) | off | on, off |

- **Pool score:** 159 of 180 solved, mean model seconds **5.42** against the recipe's budget of **6.05**. The hindsight best is 160.
- **Routes on the pool:** P3 72 records (24 tasks), v1's probe P 108 (36 tasks), the recipe 0. The pool's lowest hidden signal is 0.026, so every pool task clears `c_probe`. Judge tasks below it take the recipe.
- **By category on the pool** (v3 / recipe / P, of 36 each): A 36/36/36, **B 22/11/17**, C 34/35/33, D 32/30/32, E 35/36/35. E (library) tasks all take P through the library gate.
- **Pool playbooks for reference:**

  | S | P | R (the budget) | PR | R8 | v2's rule | Hindsight best |
  |---|---|---|---|---|---|---|
  | 147 | 153 (2.99 s) | 148 (6.05 s) | 154 | 149 | 154 (5.92 s) | 160 |

- The recipe settings (`t_hi`, `t_lo`, `e_fail`) change no pool record's outcome under this rule, since no pool record takes the recipe. Exact ties go to the setting that scores best on its own over the whole pool (most solved, then fewer seconds), not to the loop order. That is why `e_fail` is off: on the pool's own recipe runs it only adds seconds.
- These are 8 parameters fitted on 60 tasks, so the pool score is optimistic.

**Ablations on the pool** (the same rule with one mechanism changed):

| Ablation | Solved (of 180) | Mean model s |
|---|---|---|
| **Full v3 (the rule)** | **159** | **5.42** |
| No A (no evidence note) | 155 | 5.73 |
| No B gate (repair whenever an assert fails) | 159 | 5.36 |
| No check (no example asserts, no repair) | 156 | 4.66 |
| No C (no escalation) | 159 | 5.42 |
| No library gate | 158 | 6.12 |
| v1's probe in place of probe v3 | 153 | 4.13 |
| No v1 route (v3 as first specified, same parameters) | 157 | 7.18 |

On the pool, A, the asserts and probe v3 each add solves. B's gate adds nothing over always repairing: 159 either way, and the gate's Laya calls cost 0.06 s more. C has no effect because no pool record takes the recipe.

## The bar (owner, 2026-10-07), word for word from spec v3 §6

Live v3 passes only if all of these hold:
1. On the new judge set, against the recipe:
   - it solves more;
   - exact McNemar p < 0.10 on samples;
   - exact sign test p < 0.10 on tasks (a task counts for the side that solved more of its 3 trials);
   - mean model seconds no higher.
2. **The tier2b guard:** v3 is not significantly worse than the recipe on tier2b. It fails if the per-task sign test favours the recipe at p < 0.10.

**The hard rule:** nothing is fitted on tier2b or on the new judge set.

`playbook.py report-v3` computes both tests and the guard; the report states whether the bar is met.

## Known before the run, stated so it cannot be mistaken for a finding

- **The recipe on tier2b is already measured:** 107/117 on the same seeds (`docs/benchmarks/2026-10-06/tier2b-recipe-keep96-2026-10-06.jsonl`). The tier2b guard compares live v3 against that file.
- **tier2b has been looked at many times** (it is the guard, never fitted on).
- **The new judge set has had no look.** The recipe's score there is unknown; the judge nested run measures it.

## The amendment (owner, 2026-10-08, before any judge run)

The plan's fit (`playbook.py fit --form v3`) found **no v3 rule within the recipe's 6.05 s budget** on the pool:

| v3 as first specified (P3 or the recipe) | Solved | Mean model s |
|---|---|---|
| Cheapest all-recipe setting (verify, plus 1.15 s of classification per task) | 147 | 7.36 |
| All P3 (note and repair gate) | 156 | 7.15 |

v2 met the same budget only by routing 72 records to v1's cheap probe P (2.99 s a task). In v3 that route became P3. Every mix of P3 and the recipe costs more than 7.1 s, so v3 as specified would fail the bar's seconds clause by construction.

The owner was offered three choices: amend (add v1's probe as a third route), record the null, or drop the seconds cap. The owner chose the amendment:
- **Routing:** P3 when the hidden signal is at least `c_hidden` and the library signal is below `c_lib`; else P when the hidden signal is at least `c_probe`; else the recipe.
- **P** is v1's probe and one fix with no note, the same prompts and seeds as the nested run's pr candidate 0 (`playbook.outcome(rec, "P")` offline, `live_trial_v3`'s P branch live).
- **Fitting:** `c_probe` is fitted on the pool with the others, on `c_hidden`'s grid.
- **Unchanged:** the bar and the hard rule. One ablation (`no_v1_route`) is added.
- Tests: `test_route_v1_probe_band`, `test_v1_route_outcome_and_ablation`, `test_fit_takes_the_v1_route_when_only_it_fits` (61 tests pass).

## Deviations from the plan (all decided before the judge set was run)

1. **Run inline, not as the scheduled run.** The 01:30 scheduled session died when the app closed, then a retry sat on a permission prompt. The owner asked for it to be fixed; the plan ran inline in an interactive session from about 07:50 on 2026-10-08, with the same operating rules.
2. **OpenCode Go client:** `max_tokens` 16,384 and a 600 s timeout, not 4,096 and 180 s. DeepSeek v4.1 Flash reasons before answering; at the plan's cap the first prompt came back empty after 173 s.
3. **`example_prompt` shows the current entry file**, labelled as buggy and "use it only for the names to call". In the pool smoke run, the text alone made Qwen guess function names, and every example assert failed with ImportError, even on the reference fix. Expected values still come only from the text. Test: `test_example_prompt_shows_the_names_to_call`.
4. **`fit_v3` takes the probe outcome only for rows that have a p3 block,** and the recipe otherwise. Every pool row has one, so this does not change the pool fit; it keeps the fit defined if a judge row lacks one.
5. **C's escalation has two triggers, both fitted:** `t_lo` (the pick's P(correct) is low) and `e_fail` (the pick fails one of its own self-tests). `e_fail` is a fitted on/off parameter, not fixed on.
6. **The fit's exact ties** go to the probe and recipe settings that score best on their own over the whole pool, not to the loop order (see `rule.json` above). Without this, the loop order set `e_fail` on, a setting with no pool evidence behind it that would have added seconds to any judge task taking the recipe.
7. **The amendment** above.

## Runtime

- **Every GPU run starts llama-server with `--load-mode none`** (`BON_EXTRA='["--load-mode","none"]'`), as in v2.
- **RAM guard:** 2,048 MB available with Qwen and Laya loaded, checked at launch. If a run is refused at launch, its chain retries at the pre-registered 1,024 MB (`run_v3_judge.sh`'s `step` helper). The report states the guard each run used.
  - The pool session launched with 2,897 MB available.
  - A WSL utility VM restarts itself within about a minute of `wsl --shutdown` (about 600 MB; the trigger is a background app, not this code). `wsl --shutdown` is run immediately before the judge launch.
- The Versutus gate is paused for the session and restored by the chain's exit trap, even on failure.

## Commands (judge session, in this order; `scripts/moe-bench/laya-runs/run_v3_judge.sh`)

```bash
export BON_EXTRA='["--load-mode","none"]'; L=/c/qwen3-forge-stage/logs; V=docs/benchmarks/laya3; J=docs/benchmarks/laya-judge3
# each runner: up to 3 tries until its row count, guard 2048 MB then 1024 MB
TIER2B_DIR=$J $PY $MB/playbook_tier2b.py nested --v3 --model qwen36keep96 --calib $V/calib.json --out $L/laya3-judge-nested.jsonl          # 360 rows
TIER2B_DIR=$J $PY $MB/playbook_tier2b.py live --v3 --model qwen36keep96 --rule $V/rule.json --calib $V/calib.json --out $L/laya3-judge-live.jsonl   # 360 rows
TIER2B_DIR=scripts/benchmark-tier2b $PY $MB/playbook_tier2b.py live --v3 --model qwen36keep96 --rule $V/rule.json --calib $V/calib.json \
  --out $L/laya3-tier2b-live.jsonl                                                                                                    # 117 rows
TIER2B_DIR=$J USE_TF=0 $LPY $MB/laya_partner.py label --v3 --runs $L/laya3-judge-nested.jsonl --out $L/laya3-judge-labels.jsonl
$PY $MB/playbook.py report-v3 --trials $L/laya3-judge-nested.jsonl --labels $L/laya3-judge-labels.jsonl \
  --calib $V/calib.json --rule $V/rule.json --live $L/laya3-judge-live.jsonl --tier2b-live $L/laya3-tier2b-live.jsonl \
  --tier2b-recipe docs/benchmarks/2026-10-06/tier2b-recipe-keep96-2026-10-06.jsonl \
  --v2-calib docs/benchmarks/laya-partner/calib.json --v2-rule docs/benchmarks/laya-partner/rule.json \
  --out $L/laya3-judge-report.json
$PY $MB/laya_calibrate.py report --trials $L/laya3-judge-nested.jsonl --labels $L/laya3-judge-labels.jsonl \
  --calib $V/calib.json --out $L/laya3-judge-diagnostics.json
```
