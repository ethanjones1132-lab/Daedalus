# Laya partner v3: a stronger probe and three more Laya–Qwen roles

- **Date:** 2026-10-07. **Status:** design approved by the owner in conversation, section by section; nothing built yet.
- **Builds on:** `2026-10-06-laya-v2-design.md` and its results, `2026-10-07-laya-partner-results.md`.
- **Coder:** Qwen3.6 keep96, as in v2.
- **Laya:** used as shipped plus calibration; no training.
- **Two sub-projects, built in order:**
  1. A new judge set, written by DeepSeek (§2). It is sealed before anything in v3 is fitted.
  2. The v3 system (§3–§6).

## 1. Why, in numbers (v2's runs)

- **Laya's routing signal works.** P(kind = hidden code) found every hidden-convention task on three sets (AUC 1.00 / 0.98 / 0.89).
- **What it routes to is weak.**
  - One probe plus one fix solved 20 of 36 hidden-convention samples on the judge set, against the recipe's 17.
  - Probes crashed on 22–33% of those trials.
  - When a probe did run, the fix still failed in about half the cases. The probe often called the buggy entry function instead of the hidden helper, and the fix was never checked against the requirement's own example.
- **The probe also hit library tasks.** On tier2b, 5 of 6 library tasks were probed, and probing them is what cost v2 its significant tier2b loss.
- **The recipe's failures are missing answers, not wrong picks.** A correct candidate went unpicked in only 2 of 32 failures on the pool and 4 of 26 on the judge set. Gains therefore have to create correct answers.
- **Self-tests are wrong 16–18% of the time,** which threatens any repair loop.
- **Most failing answers are wrong logic** (AssertionError). SyntaxErrors (36 of the judge set's failing candidates) and wrong imports (19) follow.

## 2. Sub-project 1: the judge set, written by DeepSeek

- **Writer:** DeepSeek v4 Flash through the OpenCode Go chat API (`https://opencode.ai/zen/go/v1`, model `deepseek-v4-flash`). The exact version is confirmed from the endpoint's model list at build time.
  - The key is read at run time from OpenCode's `auth.json` (provider `opencode-go`) and never printed or logged.
- **Size:** 120 tasks, 24 per category (A algorithms, B hidden convention, C bad input, D files and processes, E library helpers), × 3 trials = 360 samples.
- **Format:** exactly the existing tier2b format: `dict(name, category, entry, files, spec, test, reference)`, with `hidden_file` for B (the helper ships as bytecode only) and a `lib/` helper for E.
- **Keeping the writer different:** DeepSeek gets the category definitions, the schema, the rules and one schematic example. It never sees a real task from tier2b, the pool or the old judge set.
- **Pipeline (`judgeset_writer.py`):**
  1. Over-generate about 200 candidates across the categories.
  2. Validate each with `validate_tasks.py`: the buggy file fails its test and the reference passes. For B, also check the helper is bytecode-only.
  3. Check disjointness from tier2b, the pool and the old judge set: no shared function names, `lib/` files or task names.
  4. Select the first 24 valid tasks per category in a fixed seeded order. **No filtering on keep96's performance.**
  5. Write `docs/benchmarks/laya-judge3/` and **seal** it with a commit before anything runs on it.

## 3. Sub-project 2: the v3 flow per task

```
classify (one Laya call, wording v1) -> hidden = P(kind = hidden code), library = P(kind = library)
hidden >= c_hidden and library < c_lib  -> probe path         (library gate)
otherwise, or no card                   -> recipe path
```

**Probe path:**
1. **Probe v3.** Qwen writes a short script that imports the named hidden helper, calls it directly with inputs copied from how the entry file calls it, and prints `repr(result)` and `type(result).__name__` for each call. It runs in the task's package, capped at 2,000 characters and 10 s, as before.
2. **Retry.** If the output contains a traceback, Qwen gets the script and the error and writes one corrected probe.
3. **A, the evidence reader.**
   - Laya answers one `choice` question on a plain-text state: the requirement, the probe script, and the output.
   - Options: units or scale differ / sign or direction differs / counting starts at a different number / order differs / type or format differs / missing values are signalled differently / nothing unexpected.
   - If the top option is not "nothing unexpected" and its probability is at least `c_note`, the fix prompt starts with one line: "Note: the probe output suggests the helper's {option} differs from what the entry file assumes."
4. **Fix.** One fix that sees the probe output and, if given, the note.
5. **Example check.**
   - Qwen writes asserts taken only from concrete examples stated in the requirement. These are not general tests.
   - The asserts run against the fix in the seeded workspace, with the grading test removed. If the requirement states no example, the step yields no asserts and is skipped.
6. **B, the repair gate.**
   - For each failing assert, Laya answers whether the check tests exactly what the requirement states (`noul` form, plain-text state: requirement + assert).
   - If any failing assert has P(valid) ≥ `c_valid`, Qwen repairs once. It gets its file, every failing assert with its error, and v1's repair instruction ("a check can itself be wrong; fix the file only where the requirement supports the check").
   - Otherwise the fix stands.

**Recipe path:**
1. Candidate 0 and one self-test suite. Verify early-stops when candidate 0 passes every self-test and its P(correct) ≥ `t_hi`, as in v2.
2. Otherwise candidates 1–2 are generated and the most self-tests passed wins, with P(correct) as the tie-break.
3. **C, compute reallocation.** If the pick's P(correct) < `t_lo`, or it fails any of its own self-tests, add 5 candidates and a second suite (R8), then pick among all 8. The time verify's early stops save pays for this.

**Unchanged from v2:**
- v2's generic note is dropped; A replaces it.
- Fallbacks follow spec §7: a dead or late Laya means the recipe, and a failed Laya question means its step is skipped.

## 4. Calibration and fitting (calibration pool only)

**Pool session (GPU, about 1.6 h).** The extended nested runner (§5) runs on the 60-task pool. Laya's evidence answers are computed live because they shape a generation; every other Laya answer is labelled afterwards on the CPU.

**Labels:**
- Verify P(correct) for every candidate.
- Laya's P(valid) for every assert.
- **An assert's true validity is whether the task's reference fix passes it.** The reference is correct by construction, so the repair gate is calibrated on real labels.

**Fitted parameters and grids:**

| Parameter | Grid |
|---|---|
| `c_hidden`, `c_lib` | deciles of the pool's per-task signals, plus never |
| `c_note`, `c_valid` | {0.3, 0.5, 0.7, never} |
| `t_hi` | {0.5, 0.6, 0.7, 0.8, 0.9, never} |
| `t_lo` | {never, 0.2, 0.4, 0.6} |

- The objective is v2's: the most tasks solved with mean model seconds at most the recipe's, and ties go to fewer seconds.
- `c_note` is fitted by outcome only. The pool's 12 hidden-convention tasks are too few to calibrate a 7-way choice.
- The fit reports the pool score of every ablation next to the full fit.

**Pre-registration.** `calib.json`, `rule.json`, the bar and the judge commands are committed and pushed before the judge session.

## 5. The extended nested run (one per task set)

Per task-trial it records:
- **r8:** 8 candidates and 2 self-test suites (as now; this gives S, R and R8, and C's escalation).
- **pr:** v1's probe with 3 candidates and its suite (as now; this gives v2's playbooks and the old-probe ablation).
- **p3:**
  - probe v3 and its retry;
  - Laya's evidence answer;
  - fix 0 without a note, and fix 1 with Laya's note;
    - fix 1 is generated whenever Laya's top option names a mismatch, whatever its probability, so `c_note` can be applied offline;
  - the example asserts and their results on both fixes;
  - one repair per fix that fails any assert, generated whatever the gate says, so `c_valid` can be applied offline (the repair is used only where the gate passes).
- **Time per call.** The cost is model seconds: Qwen generation, probe execution and Laya calls, as in v1.

Every configuration and ablation in §6 is computed offline from these rows plus the labels. Only the full system also runs live.

## 6. Evaluation

**Judge session (about 5.5 GPU h, one night):**
1. The extended nested runs on the new judge set give:
   - configuration 1 (single shot), 2 (the recipe) and the hindsight best;
   - v2 (simulated);
   - v3 (simulated);
   - offline ablations: v3 without A, without B, without C, without the library gate, and with v1's probe in place of probe v3.
2. **Full v3 live, end to end, on the judge set.** The bar is scored on this run.
3. Full v3 live on tier2b, against the recipe's 107 on the same seeds (`docs/benchmarks/2026-10-06/tier2b-recipe-keep96-2026-10-06.jsonl`).
4. Labels, then the report.

**The bar** (owner, 2026-10-07). Live v3 passes only if all of these hold:
1. On the new judge set, against the recipe:
   - it solves more;
   - exact McNemar p < 0.10 on samples;
   - exact sign test p < 0.10 on tasks (a task counts for the side that solved more of its 3 trials);
   - mean model seconds no higher.
2. **The tier2b guard:** v3 is not significantly worse than the recipe on tier2b. It fails if the per-task sign test favours the recipe at p < 0.10.

**The hard rule:** nothing is fitted on tier2b or on the new judge set.

## 7. Components

| File | Role | Change |
|---|---|---|
| `scripts/moe-bench/judgeset_writer.py` | DeepSeek task writer: generate, validate, check disjointness, select, write | new |
| `docs/benchmarks/laya-judge3/` | The sealed 120-task judge set | new |
| `scripts/moe-bench/probe_v3.py` | Prompts: helper-directed probe, retry, fix with note, example asserts, repair; plus running asserts | new (`probe_tier2b.py` unchanged) |
| `scripts/moe-bench/laya_partner.py` | Questions `evidence` (choice) and `valid` (noul); worker ops; labeller rows for `valid` | extend |
| `scripts/moe-bench/playbook.py` | v3 rule form (library gate), `outcome_v3` (probe path, gate, repair, escalation), `fit_v3`, ablations, tier2b guard in the bar | extend |
| `scripts/moe-bench/playbook_tier2b.py` | `nested --v3` (the extended record) and `live --v3` (the full system) | extend |
| `scripts/moe-bench/laya_calibrate.py` | Calibration and report for `valid`; hidden and library AUCs | extend |

All logic is test-first (`unittest`). The pure functions in `playbook.py` are tested on synthetic records, as in v1 and v2.

## 8. Risks

- **DeepSeek task quality.** The validator rejects broken tasks, but not easy ones. If the new set is easier, there is less headroom for any method; the report gives the recipe's score there.
- **Six fitted parameters on 60 pool tasks.** Coarse grids, ablations and the out-of-writer judge set are the checks.
- **The evidence reader is zero-shot.** If its answers are noise, the without-A ablation will match full v3, and the report says so.
- **RAM.** Laya runs live during nested runs. With `--load-mode none`, 1.7–3.3 GB stayed available on 2026-10-07. The live guard keeps the pre-registered 2,048 MB, with a 1,024 MB retry.
- **Runtime.** About 32 s per judge task-trial in the nested run, roughly 3.2 h of the session's 5.5.
