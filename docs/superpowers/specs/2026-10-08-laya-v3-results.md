# Laya v3: judge results, 2026-10-08

- **Pre-registered** in `2026-10-08-laya-v3-prereg.md`, pushed at commit 5548446 (12:40:35), before anything ran on the new judge set. The pre-registration includes the owner's amendment (v1's probe as a third route).
- **Runs:** GPU 12:41–21:24, then Laya's labels on the CPU until 23:21. keep96, `--load-mode none`. The Versutus gate was paused for the GPU work and restarted at 21:37, after the last GPU step (healthy at 21:38).
- **Design:** `2026-10-07-laya-v3-design.md`. **Data:** `docs/benchmarks/laya3/`, with local paths scrubbed.
- **Judge set:** `docs/benchmarks/laya-judge3/`, written by DeepSeek v4.1 Flash and sealed in a404c4b: 120 tasks, 24 per category.

## Outcome: the bar is not met, on either count

| Bar test | Result | Needed |
|---|---|---|
| Judge set: live v3 solves more than the recipe | **303** vs **306** of 360 | more ✗ |
| Exact McNemar on samples | 24 vs 27, p = 0.78 | p < 0.10 ✗ |
| Exact sign test on tasks | 14 vs 20, p = 0.39 | p < 0.10 ✗ |
| Mean model seconds no higher | **7.53** vs 10.11 | yes ✓ |
| tier2b guard: not significantly worse than the recipe | 97 vs **107** of 117: 1 vs 11 samples (p = 0.006), 0 vs 6 tasks (p = 0.031) | **fails** ✗ |

By the pre-registered rule this is a null on the judge set, and the tier2b guard fails.
- **Judge set:** v3 is 25% cheaper than the recipe at about the same accuracy.
- **tier2b:** v3 is significantly worse, as v2 was (99 vs 107).

## The configurations on the judge set (360 samples)

| Configuration | Solved | Mean model s | A / B / C / D / E (of 72) |
|---|---|---|---|
| 1 Single shot | 292 | 1.36 | 50 / 50 / 58 / 62 / 72 |
| 2 Recipe (the baseline) | **306** | 10.11 | 54 / 48 / 64 / 69 / 71 |
| v2 simulated (its calib and rule) | 300 | 10.06 | |
| v3 simulated (offline, the pre-registered rule) | 302 | 9.63 | |
| **v3 live** | 303 | **7.53** | 56 / 45 / 64 / 69 / 69 |
| 6 Hindsight best playbook per task | 325 | — | |

- **The live run matches the simulation on solves:** 303 live vs 302 simulated.
- **Its model time is lower than simulated** (7.53 vs 9.63 s). The simulation adds up the nested run's call times, which were measured under the memory pressure described below.

- **The other fixed playbooks** (from the nested runs):

  | | S | P | R | PR | R8 |
  |---|---|---|---|---|---|
  | Solved | 292 | 298 | 306 | 310 | 309 |
  | Mean secs | 1.4 | 4.4 | 10.1 | 12.8 | 23.4 |

- **Live v3's routes:** P 210, P3 150, recipe 0. The pool's lowest hidden signal set `c_probe` at 0.026, and no judge task fell below it.
  - The note was given in 104 rows and a repair was made in 68.
  - Laya fell back on no live row.
- **Live v3 minus the recipe, by category (of 72 each):** A +2 (56 vs 54), B −3 (45 vs 48), C 0 (64), D 0 (69), E −2 (69 vs 71).

## Which mechanism helped (offline, on the judge set's nested runs)

| Ablation (the rule with one mechanism changed) | Solved | Mean model s | vs full | On the pool |
|---|---|---|---|---|
| **Full v3 (simulated)** | **302** | **9.63** | | 159 |
| No A (no evidence note) | 304 | 9.46 | **+2**: the note hurt | 155 (the note helped, +4) |
| No B gate (repair whenever a check fails) | 302 | 9.46 | ±0 | 159 |
| No check (no example checks, no repair) | 291 | 8.35 | **−11**: checks + repair helped | 156 (+3) |
| No C (no escalation) | 302 | 9.63 | ±0 (no row took the recipe) | 159 |
| No library gate | 301 | 10.15 | −1 | 158 |
| v1's probe in place of probe v3 | 298 | 6.10 | −4 | 153 (−6) |
| No v1 route (v3 as first specified) | 307 | 13.53 | +5 at 34% more time than the recipe | 157 at 7.18 s |

- **Only the example checks and repair help clearly,** +11 on the judge set and +3 on the pool.
- **The note reversed sign** (+4 on the pool, −2 here).
- **The repair gate adds nothing over always repairing,** on either set.
- **v3 as first specified would have solved 307,** one more than the recipe, but at 13.5 s against the recipe's 10.1. That is why the amendment was needed to meet the time budget.

**Probe v3's own pieces** (on every row, whatever the route):

| Piece | Judge set |
|---|---|
| Fix without the note (fix 0) | 290 of 360 |
| Fix with the note, when Laya named a mismatch | the note fixed 10 rows and broke 22, of 315 |
| Repair after a failing example check (fix 0) | fixed 20 wrong fixes, broke 11 right ones, of 191 rows that failed a check |
| Example checks Qwen wrote from the spec | 1,870, of which **69%** pass on the reference fix; 132 of the 290 correct fix 0s fail at least one (wrong) check |

## Pool vs judge set: what did not transfer

| | Pool (fitted) | Judge set |
|---|---|---|
| v3 vs recipe | 159 vs 148 (simulated) | 303 vs 306 (live) |
| Hidden conventions (B): v3 / recipe / v1 probe | 22 / 11 / 17 of 36 | 45 / 48 / 41 of 72 |
| Evidence note (A) | +4 | −12 net (10 fixed, 22 broken) |
| Laya's evidence answer "type" | 146 of 180 (81%) | 296 of 360 (82%) |

- **The pool's gain came almost entirely from category B,** where the recipe was weak: 11 of 36.
  - DeepSeek's B tasks are much easier for the recipe (48 of 72), and neither probe beats it there.
  - The note's +4 on the pool was fitted on 12 hidden-convention tasks and reversed on the judge set.
- **Laya's evidence answer is close to a constant.** Part of the cause is our design: probe v3 tells Qwen to print `type(result).__name__` for every call, so every probe output Laya reads is full of type names.

## tier2b (the guard)

- **Routes:** P 57, P3 57, recipe 3 (one task below `c_probe`).
- **By category (v3 vs recipe):** A 31 vs 36, B 9 vs 11, C 20 vs 21, D 19 vs 21, E 18 vs 18.
- **Losses (rows the recipe solved and v3 did not):**
  - `running_sum`, 3 trials, P3
  - `parse_csv_line`, 2 trials, P3
  - `pkg_rate_limit`, 2 trials, P
  - `pkg_inventory`, P3
  - `read_text_lines`, P3
  - `retry_with_backoff`, P
  - `atomic_write`, P
- Most losses are P3 on tasks the recipe solves reliably. The note and the repair after a wrong example check change a correct fix into a wrong one. The repair broke 11 right fixes on the judge set as well.

## Laya

| Laya question | What it drives | Pool AUC | Judge-set AUC |
|---|---|---|---|
| Hidden code (`kind_p`, v1 wording) | routing to P3 | 1.00 | **0.97** |
| Library task (`kind_p["library"]`) | the library gate | 0.99 | **0.95** |
| Verify (rubric): is this candidate correct? | the recipe's early stop and pick | 0.79 | 0.58 |
| Valid: is this example check right? | B's repair gate | 0.67 | **0.42** (below chance) |

- **Evidence answers on the judge set:** type 296, none 45, missing 12, order 3, scale 2, base 2.
- **Kind accuracy:** 0.43.
- **No Laya fallback in any live row.** After the redo, every nested row has an evidence answer.
- **The pattern from v2 holds:**
  - Classifying the task from its text transfers to a fresh set written by a different model.
  - Judgments about code do not: whether a candidate is correct, whether a check is right, which mismatch the probe output shows.
  - The repair gate's signal fell below chance on the fresh set.

## RAM guard and what happened during the run

- **Nested run (12:41–17:48):** launched at 2,797 MB available under the 2,048 MB guard.
- **A game was opened during the run.** It squeezed RAM until the paged-out Laya worker missed the client's 5 s deadline, about row 150. By design, the client then stopped asking Laya for the rest of the run, so 212 of 360 nested rows had no evidence answer.
  - Their r8 and pr parts are unaffected, because Laya isn't called there.
  - The original chain was stopped with its nested runner still going. `run_v3_judge_rest.sh` took over.
- **The rest chain** (committed in fd50e72 at 19:43, before any live run):
  - It waited until no game was running.
  - It regenerated the p3 block of those 212 rows with the same seeds (`nested --v3 --base`), and merged them. The pre-redo file (12.6 MB, identical apart from those p3 blocks) is kept locally as `C:\qwen3-forge-stage\logs\laya3-judge-nested.jsonl.orig`, not in the repo.
  - It removed any live row that ran after Laya died, so the row is rerun. Rows are chosen by that failure flag only, never by outcome. None were needed.
- **Laya's deadline is now 30 s (was 5 s).** A slow answer still counts in model seconds.
- **The WSL VM restarted itself every few minutes** (about 600 MB) and is started from inside the WSL service. `wsl_guard.sh` shut it down while the session ran.
- **Final state:**
  - After the redo, all 360 nested rows have an evidence answer. One row's Laya error was cured on the second pass.
  - The judge live run launched at 2,916 MB under the 2,048 MB guard.
  - The tier2b live run was refused at 1,801 MB under 2,048 MB. It ran on retry under the pre-registered 1,024 MB fallback, launching at 2,628 MB.
- **A small chain bug:** an empty file's row count read as "0 0", so the redo loop ran a third, empty pass. It loaded the models, found nothing to do and merged an identical file.

## Reading

- **v3 is a null with a cost benefit.**
  - On a fresh judge set written by a different model, it solves about as many as the recipe (303 vs 306) in 25% less model time.
  - On tier2b it is significantly worse, for the same reason as v2: the probe routes replace a recipe that is already strong.
- **Fitting on the 60-task pool overfit.** The 8 thresholds and the note's effect did not transfer. This is the lesson behind the owner's standing rules (2026-10-08): benchmarks are instruments, prefer mechanisms with few or no fitted parameters, and no training or tuning on benchmark families or rubrics.
- **There is little headroom on bug-fix task sets.** The recipe solves 85% of the judge set, and the hindsight best adds only 19 samples. Any helper fights for scraps there. Large builds (the Ecosystem Lab) have the headroom: keep96 scored 0.03, the best local model 0.42.
- **One v3 mechanism clearly helped: the example checks with repair** (+11 on the judge set, +3 on the pool).
  - It works by execution: the model's own checks, taken from the spec, are run against its fix.
  - Laya's gate on it added nothing, and its check-validity signal fell below chance.
  - That points to execution-driven checking without a learned gate, which is relevant to the staged build harness.
- **What Laya is good at transfers; what it is bad at does not.**
  - Strong: task-level classification from the text, such as hidden code and library tasks.
  - Weak: reading code behaviour (evidence answers, check validity, correctness).
  - Next designs should break hard judgments into easy, observable questions, test each question for signal before building on it, and let execution supply facts in a short loop.

## Next

See `2026-10-08-roadmap-draft.md`. The next step is the Qwen3.6 full IQ3_XXS headroom test, then a broad test set to pick the base model, then the Laya-on-builds staged harness. Each step is its own session.
