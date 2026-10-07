# Laya partner v2: the targeted probe

- **Date:** 2026-10-06 evening. **Status:** design approved by the owner in conversation; nothing in it is built yet.
- **Amends:** `2026-10-05-laya-partner-design.md` (v1) and its plan `plans/2026-10-05-laya-partner.md`. Everything not named here stays as in v1.
- **Coder:** Qwen3.6 keep96 (plan deviation 9; `2026-10-06-model-settle.md`).
- **Judge set:** still sealed. Every number below comes from the calibration pool (60 tasks × 3 trials, keep96's nested runs and Laya's labels of 2026-10-06).

## 1. Why v1 is being changed before its judge run

v1's fitted rule ran single shot on 132 task-trials and the recipe on 48, and never probed. On the pool it solved 149 of 180 against the recipe's 148, while probing every task solved 153 at half the recipe's time. Two causes:

1. **The fit could not reach the probe.**
   - Platt calibration put P(unseen) for the hidden-convention tasks at 0.20–0.26.
   - The cutoff grid started at 0.3.
2. **The fit used a weak signal and ignored a strong one.**
   - `laya_calibrate.py fit` picked the wording by the summed AUC of three quantities: v2 won 0.74 + 0.53 + 0.34 against v1's 0.44 + 0.45 + 0.47.
   - The yes/no "unseen" question rates library tasks *above* hidden-convention tasks (B vs E AUC 0.35 in v2, 0.19 in v1). Their helpers are also "code that is not shown".
   - Laya's probability for the kind option "depends on code whose source is not shown" was never considered. Under wording v1 it ranks the pool's 12 hidden-convention tasks above all 48 others: AUC **1.00**.
   - Its argmax is "library" for almost every task, which is why the kind accuracy (25%) looked useless.

Where the gain is (pool, playbook against single shot):
- Probing gains 6 trials on hidden-convention tasks (4 tasks up, 0 down), 1 on file tasks, and loses 1 on library tasks.
- On tier2b, probing every task cost 6 points on 2026-10-05, mostly library tasks (E 18 → 12).

## 2. The rule

```
card missing (Laya failed or timed out)   -> R   (recipe; spec §7, unchanged)
card["hidden"] >= c_hidden                -> P   (probe, then one fix that sees its output)
otherwise                                 -> R
```

- **`card["hidden"]`** is Laya's raw probability for the hidden-code option of the chosen wording's `kind` question. It is used by rank, so it needs no calibration map; the report still gives its AUC.
- **One cutoff, `c_hidden`.** The candidates are the 0th, 10th, …, 90th percentile values of `hidden` over the pool's 60 tasks (one value per task, not per trial), plus "never". The fit maximizes tasks solved with mean model seconds at most the recipe's; ties go to fewer seconds.
- **Not P→PR.** PR (probe, then the recipe) did worse than P on hidden-convention tasks (16 vs 17 of 36) at 8.4 s, so a flagged task gets P.
- **Pool fit, for reference:** c_hidden = 0.083 probes 24 tasks, all 12 hidden-convention ones among them, and solves 154 at 4.7 s mean (recipe: 148 at 6.05 s). On 12 positives the AUC of 1.00 is optimistic; the judge set says how well it holds.

## 3. Choosing the signal (replaces v1's wording choice)

- The candidates are every task signal Laya gives: for each wording (v1, v2), the yes/no "unseen" probability and the kind-option probability for hidden code.
- The one with the highest AUC for hidden-convention tasks on the pool is chosen, and `calib.json` records it as `classify_wording` plus `hidden_signal` (`kind_p` or `noul`).
- No new wordings are written. With a pool AUC of 1.00 already, more candidates would only add selection bias.
- The effort quantities are still fitted and reported, but nothing reads them.

## 4. Verify (configurations 4 and 5)

Unchanged from v1, with t_hi and t_lo fitted inside the same budget:
- **Tie-break:** Laya's P(correct) (rubric form, pool AUC 0.79).
- **Early stop:** on R, when candidate 0 passes every self-test and P(correct) ≥ t_hi.
- **Escalation:** one probe-then-fix candidate added to an R task whose best candidate has P(correct) < t_lo. This is also the second chance for a hidden-convention task the signal misses.

## 5. The note to Qwen (configurations 3 and 4)

- Only tasks routed to P get the note "Note: the fix depends on code whose source isn't shown."; other tasks get none. Under wording v1 the top kind is "library" for nearly every task, so v1's per-kind notes would mislead.
- Configuration 5 is configuration 4 without the note, as in v1.

## 6. Unchanged

- The six configurations.
- **The hard rule:** nothing is fitted on tier2b or the judge set.
- The nested runs, Laya's labels, the fallbacks, and pre-registration before the judge run.
- **The bar, as set by the owner on 2026-10-06:** configuration 4 solves more judge samples than configuration 2, with exact McNemar p < 0.10 on samples AND an exact sign test p < 0.10 on tasks, and mean model seconds no higher.

## 7. Runtime

- **Judge-set and tier2b runs in GPU session 2** (nested and live) start llama-server with `--load-mode none` (`BON_EXTRA`).
  - On 2026-10-06 it gave byte-identical answers to the default mmap load on 8 fixed-seed prompts.
  - It left 2.8 GB available with Qwen alone (mmap: 0.24 GB) and loads in 12 s instead of 38.
- **RAM guard:** with Qwen and Laya both loaded, 1.2 GB was available against the spec's 2 GB guard, because a 4 GB VM outside this project held RAM. Before the live runs, the owner either frees that memory or sets the guard for this run. The runner enforces whatever value is set.

## 8. Components

| File | Change | Tests |
|---|---|---|
| `laya_calibrate.py` | `calibrate_card` adds `hidden` from the signal named in the calib (default `noul`, so old calib files still work); `fit` chooses the signal as in §3 | card keys and both signals; signal choice on synthetic labels |
| `playbook.py` | `choose` gains `form: "targeted"` (§2), with v1's form kept for old rule files; `fit` takes the targeted form and its decile grid, and `rule.json` records the grid | targeted routing, fallback, decile grid, tie to fewer seconds |
| `laya_partner.py` | the worker passes `hidden_signal` to `calibrate_card` | covered through `calibrate_card` |
| `playbook_tier2b.py` | the note comes from a small `note_for(card, play, rule)` (§5) | the note rule for both forms |

Plan deviations 10–14 record these changes: the decile grid, the signal choice, the targeted form, the note rule, and `--load-mode none`.

## 9. Risks

- **Same writer.** The pool and the judge set were written together, so a signal that ranks the pool perfectly may rank the judge set well for the same reason. tier2b (configurations 3–5 there, reported only) is the out-of-family check.
- **Small pool.** 12 hidden-convention tasks. One cutoff keeps the fit coarse.
- **Misranked tasks.** A hidden-convention task below the cutoff gets the recipe, which rarely solves those. Verify's escalation is the fallback.
