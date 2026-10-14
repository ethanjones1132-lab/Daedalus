# Laya partner: pre-registration (before any judge run)

- **Committed:** 2026-10-07, before the first judge-set run of the Laya partner. Nothing of the Laya partner has run on `docs/benchmarks/laya-judge/`.
- **Design:** `2026-10-05-laya-partner-design.md` as amended by `2026-10-06-laya-v2-design.md` (the targeted probe). **Plan:** `plans/2026-10-05-laya-partner.md` (deviations 9–15) and `plans/2026-10-07-laya-v2.md`.
- **Coder:** Qwen3.6-35B-A3B keep96 (`bestofn_tier2b.CONFIGS["qwen36keep96"]`), MTP + n-gram speculation.

## What was fitted, on the calibration pool only

The data is keep96's nested runs (60 tasks × 3 trials) and Laya's labels, both copied into `docs/benchmarks/laya-partner/`.

**`calib.json`:**

| Choice | Value | Pool evidence |
|---|---|---|
| Classify wording | v1 | |
| Hidden signal | `kind_p`: P(kind = "depends on code whose source is not shown") | AUC for hidden-convention tasks **1.00** (v1 yes/no 0.44, v2 yes/no 0.74, v2 kind 0.81) |
| Verify form | rubric | AUC 0.79 (noul 0.77) |
| Verify map | Platt [0.989, −0.248] | |

**`rule.json`** (targeted form; the cutoff grid is the deciles of the 60 tasks' signal):

| Rule | c_hidden | t_hi | t_lo | Pool solved (of 180) | Mean model secs | Playbooks |
|---|---|---|---|---|---|---|
| `noverify` (configuration 3) | 0.0828 | — | — | 154 | 5.85 | P 72, R 108 |
| `verify` (configurations 4, 5) | 0.0828 | 0.5 | never | 154 | 5.92 | P 72, R 108 |

- **Pool playbooks for reference:**

  | S | P | R | PR | R8 | Hindsight best |
  |---|---|---|---|---|---|
  | 147 | 153 | 148 (6.05 s; the budget) | 154 | 149 | 160 |

- **Smoke test** (`laya-smoke-v2.jsonl`, 5 pool tasks, 1 trial): the live runner routed by the signal, verify early-stopped once, and all 5 passed. 3,329 MB stayed available with Qwen and Laya loaded.

## The bar (owner, 2026-10-06), word for word

Configuration 4 solves more judge samples than configuration 2, with exact two-sided McNemar p < 0.10 on samples AND an exact two-sided sign test p < 0.10 on tasks (a task counts for the side that solved more of its 3 trials). Its mean model seconds per task are no higher than configuration 2's. Otherwise the result is reported as a null, with which step helped or hurt.

`playbook.py report` computes both tests (`bar.mcnemar_p`, `bar.task_sign_p`) and `bar.met`.

## Known before the run, stated so it cannot be mistaken for a finding

- **Configuration 2 on the judge set is already measured.**
  - Adapters phase 1 ran keep96's recipe there with the same harness, prompts and seeds: 153/180, single shot 143.
  - The judge nested run repeats that measurement. Small differences are possible from server prompt-cache state.
- **Earlier looks at the judge set:** adapters phase 1 (keep96 vs swap108, recipe and single shot). This is the Laya partner's single look.

## Runtime

- **Every session-2 run starts llama-server with `--load-mode none`** (`BON_EXTRA='["--load-mode","none"]'`), whether nested or live, on the judge set or tier2b. On 2026-10-06 it gave byte-identical answers to the default mmap load on 8 fixed-seed prompts (`ram-check-2026-10-06.json`).
- **RAM guard:** the spec's 2,048 MB available with Qwen and Laya loaded.
  - If a live run is refused at launch, it is retried once with 1,024 MB. The owner delegated that call on 2026-10-07.
  - The report states which guard each run used.
- The Versutus gate is paused for the session and restored after it.

## Commands (GPU session 2, in this order)

```bash
X='["--load-mode","none"]'; L=/c/qwen3-forge-stage/logs; D=docs/benchmarks/laya-partner
BON_EXTRA=$X TIER2B_DIR=docs/benchmarks/laya-judge $PY $MB/playbook_tier2b.py nested --model qwen36keep96 --out $L/laya-judge-nested.jsonl
for c in "c3 on off" "c4 on on" "c5 off on"; do set -- $c
  BON_EXTRA=$X TIER2B_DIR=docs/benchmarks/laya-judge $PY $MB/playbook_tier2b.py live --model qwen36keep96 \
    --out $L/laya-judge-$1.jsonl --rule $D/rule.json --calib $D/calib.json --note $2 --verify $3
done
# the same three on tier2b (reported for continuity, never used to fit): --out $L/laya-tier2b-$1.jsonl, TIER2B_DIR=scripts/benchmark-tier2b
TIER2B_DIR=docs/benchmarks/laya-judge USE_TF=0 $LPY $MB/laya_partner.py label --runs $L/laya-judge-nested.jsonl --out $L/laya-judge-labels.jsonl
$PY $MB/playbook.py report --trials $L/laya-judge-nested.jsonl --labels $L/laya-judge-labels.jsonl --calib $D/calib.json \
  --rule $D/rule.json --live c3=$L/laya-judge-c3.jsonl --live c4=$L/laya-judge-c4.jsonl --live c5=$L/laya-judge-c5.jsonl --out $D/judge-report.json
```
