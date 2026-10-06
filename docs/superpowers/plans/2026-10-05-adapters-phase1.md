# Adapters Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** build, choose and judge phase 1 of `docs/superpowers/specs/2026-10-05-adapters-design.md`. That is a failure-targeted expert patch (swap96 / add108 / swap108) and an output-discipline steering vector for Qwen3.6 keep96, all training-free and within +0.5 GB.

**Architecture:**
- Pure selection logic in `expert_patch.py` and output parsing in `kl_eval.py`, both unit-tested.
- Measuring runs reuse the tier2b harnesses. `bestofn_tier2b.start_server` gains env overrides (`BON_GGUF`, `BON_EXTRA`) so every variant runs through the same code.
- Everything after the code is one detached, restart-safe chain (`adapters-runs/run_phase1.ps1`). It applies the spec's decision rules automatically, because the owner asked for an unattended overnight run that saves usage.

**Tech stack:**
- Python 3.12 in `C:\qwen3-forge-stage\venv`, `unittest` only.
- llama.cpp 836d571: `llama-server`, `llama-imatrix`, plus `llama-perplexity` and `llama-cvector-generator` added to the build.
- `gguf-py` from `C:\build\llama.cpp\gguf-py`.

**Compact by request.** The owner asked to conserve usage. Code lives in the files named below, which are the source of truth. This plan gives each file's contract, its tests, the commands and the decision rules, and does not repeat the code.

---

## Deviations from the spec, and why

1. **Pool baseline.** keep96's calibration-pool scores come from `bestofn_tier2b.py run` (3 candidates, 1 suite, the recipe's seeds) in this plan, not from sub-project A's nested runs, which have not run. Same seeds and prompts, so A can reuse them as the first three candidates and the first suite.
2. **Choosing the steering configuration.** Method and layer range are picked on discipline failures from probe-then-fix runs (cheap). Only the winning configuration then gets the full recipe check (spec §3.4), to fit the night.
3. **Judge set first.** The judge runs may happen before sub-project A's. The spec allows "whichever project runs first", and A's fitting stays automated on the pool only.

## Files

| File | Responsibility |
|---|---|
| `scripts/moe-bench/build_llama.ps1` (modify) | `-Targets` parameter (default unchanged) |
| `scripts/moe-bench/bestofn_tier2b.py` (modify) | `server_args()` split out of `start_server`; env `BON_GGUF` replaces the model, env `BON_EXTRA` (JSON list) appends server flags; new `CONFIGS["qwen36full"]` (full 256-expert model, 22 expert layers on the CPU, MTP + n-gram) |
| `scripts/moe-bench/slice_experts.py` (modify) | `--keep-list FILE`: explicit per-layer expert indices (JSON `{layer: [idx]}`) instead of `--keep N` |
| `scripts/moe-bench/expert_patch.py` | `energy(path)`, `combine(*energies)`, `variants(keep96, new, code, n_extra=12)` → `{name: {layer: sorted indices}}`; CLI writes keep lists |
| `scripts/moe-bench/patch_calib.py` | Full model's single-shot and probe-then-fix answers on the pool → `calib.txt` (B tasks and probe transcripts doubled, ~20% stdlib source) |
| `scripts/moe-bench/kl_eval.py` | `heldout` (writes the fixed held-out file), `ref`, `score` (→ JSON); `parse()` for llama-perplexity output |
| `scripts/moe-bench/steer.py` | `pairs` (contrastive files from probe-then-fix rows), `discipline(task, code)` (the spec's failure definition), `build` (`llama-cvector-generator`) |
| `scripts/moe-bench/phase1_decide.py` | Applies the spec's rules to the KL and pool results: closest two, winner, steering keep rule, pre-registration draft |
| `scripts/moe-bench/test_expert_patch.py` | Tests for `expert_patch`, `kl_eval.parse`, `steer.discipline`, `slice_experts --keep-list` (on a tiny synthetic GGUF) |
| `scripts/moe-bench/adapters-runs/run_phase1.ps1` | The detached chain (Task 9) |
| `docs/benchmarks/adapters/` | Keep lists, `heldout.txt`, KL tables, pool summaries, the pre-registration, the report |

## Tasks

### Task 1: Tools
- [ ] Add `-Targets` to `build_llama.ps1`.
- [ ] Build `llama-perplexity llama-cvector-generator` on branch `master`, label `master`, into `tools\llama-master-836d57176`.
- [ ] Expected: both `.exe` files exist and `--help` exits 0.
- [ ] Commit.

### Task 2: Harness overrides
- [ ] `server_args()` returns today's list exactly when no env override is set. A test compares the args for `qwen36keep96` with and without overrides.
- [ ] `qwen36full` config: path `C:\qwen3-forge-stage\Qwen3.6-35B-A3B-UD-IQ2_M.gguf`, ncmoe 22, `draft-mtp,ngram-mod` depth 2, temperature 0.2.
- [ ] Commit.

### Task 3: `slice_experts.py --keep-list`
- [ ] Test first: write a 2-layer × 4-expert GGUF with gguf-py (`ffn_{gate,up,down}_exps`, `ffn_gate_inp`, plus a non-expert tensor). Slice with keep list `{0: [1, 3], 1: [0, 2]}`, read it back, and check the expert axis holds exactly those slabs, the router rows match, and `expert_count` = 2.
- [ ] Implement: `--keep-list` excludes `--keep`. The count must be the same in every layer, and indices must be unique and in range.
- [ ] Commit.

### Task 4: `expert_patch.py`
- [ ] Tests first:
  - `combine` normalizes each layer to sum 1, then adds.
  - `swap96` = top 96 of the combined ranking.
  - `add108` = keep96 ∪ the 12 highest *dropped* experts by the new energy.
  - `swap108` = top 108 of the combined ranking.
  - Every list is sorted, unique, the same length in every layer, and a subset of 0..255.
- [ ] Implement; CLI `expert_patch.py --keep96 keep96.json --new IMX --code IMX --out DIR` writes `swap96.json`, `add108.json`, `swap108.json`.
- [ ] Commit.

### Task 5: Calibration text (`patch_calib.py`)
- [ ] Per pool task, trial 0 only: single shot (temperature 0.2), plus probe-then-fix v1 (probe prompt → run the probe → fix prompt), from `qwen36full`.
- [ ] Each answer is written in the model's chat format (`/apply-template` plus the answer plus `<|im_end|>`).
- [ ] Category B and the probe transcripts appear twice. Standard-library source slices are added up to ~20% of the text.
- [ ] Output: `models\adapters\calib.txt` and `docs\benchmarks\adapters\calib-answers.jsonl`.
- [ ] Commit.

### Task 6: `kl_eval.py`
- [ ] Test `parse()` on a captured llama-perplexity KL output block: mean KLD, 99.0% KLD, "Same top p".
- [ ] `heldout` writes `docs/benchmarks/adapters/heldout.txt`: source of `wave`, `sched`, `graphlib`, `netrc`, `plistlib` and `mailbox`, plus prose from `pydoc_data.topics`. These modules are not used by any task set or calibration text.
- [ ] `ref` runs `llama-perplexity -m FULL -f heldout.txt -c 2048 --chunks 6 --kl-divergence-base REF` (22 expert layers on the CPU), refusing if C: has under 10% free. Then it settles 3 minutes.
- [ ] `score` runs `-m VARIANT --kl-divergence-base REF --kl-divergence` and writes JSON.
- [ ] Commit.

### Task 7: `steer.py`
- [ ] Test `discipline()`: a complete file passes; a probe script, missing functions, or a dropped import fails.
- [ ] `pairs`:
  - positives are fix answers from pool probe-then-fix rows that pass `discipline` (keep96 and full model);
  - negatives are those that fail, plus templated rewrites of positives (a script opening; a dropped import);
  - written in `llama-cvector-generator`'s positive/negative file format.
- [ ] `build` runs the generator with `--method mean|pca` and writes `models\adapters\cv-<method>.gguf`.
- [ ] Commit.

### Task 8: `phase1_decide.py`
- [ ] Encodes the spec's rules:
  - drop variants over +0.5 GB or more than 5% slower;
  - the two lowest mean KL go to the pool;
  - the winner has the most recipe-solved, then single-shot-solved, then lower KL, then smaller;
  - the winner must beat keep96's recipe, else the expert arm is null;
  - the steering keep rule (discipline failures drop; single shot and recipe don't fall);
  - both arms null means no judge run.
- [ ] It writes `docs/superpowers/specs/2026-10-05-adapters-prereg.md`: the chosen patch, the bar and the baseline source.
- [ ] Commit.

### Task 9: The chain (`adapters-runs/run_phase1.ps1`)

Detached and restart-safe; each step is skipped when its output exists. It reuses the Laya runner's UTF-8 `Step`, retrying `Say` and the `selftest` pattern. It pauses the Versutus gate before the first GPU step and restores it at the end, or at 08:15 at the latest.

| Step | What runs |
|---|---|
| 1 | `patch_calib.py`, then `llama-imatrix` on `calib.txt` with the full model, giving `imatrix-failure.gguf` |
| 2 | `kl_eval.py heldout`, then `ref` |
| 3 | `expert_patch.py`, then slice the three variants (settle 3 minutes after each), measure tok/s and VRAM, then `kl_eval.py score` for keep96 and each variant |
| 4 | The decision for the two closest, then `bestofn_tier2b.py run --n 3 --suites 1 --trials 3 --temp-alt 0.7` on `laya-calib` for keep96 and each of the two (env `BON_GGUF`) |
| 5 | Winner (or keep96), then probe-then-fix runs for steering configurations (mean/pca × all/middle layers, at scale 0.5), then the best configuration at 0.25 / 0.5 / 1.0, then the recipe check at the chosen scale |
| 6 | `phase1_decide.py`. Then **commit and push the pre-registration**, then the judge runs (recipe on `laya-judge` for keep96 and the patch), then the report data |

Deleting variant GGUFs that are no longer needed keeps C: above 10% free.

### Task 10: Report
- [ ] `docs/superpowers/specs/2026-10-05-adapters-phase1-results.md` covers:
  - KL table, pool and judge tables, the McNemar p, tok/s, VRAM;
  - the steering sweep, the discipline-failure rates;
  - what helped or hurt.
- [ ] Scrub, commit, push.

## Self-review

- **Spec coverage:** §3.1 (Task 5, Task 9 step 1), §3.2 (Tasks 3, 4), §3.3 (Tasks 6, 8, Task 9 steps 3–4), §3.4 (Tasks 7, 8, Task 9 step 5), §5 (Task 8, Task 9 step 6, Task 10), §6 (the chain's guards). Expert merging (§3.5) is the stretch, so it is not in this plan.
- **Names used across tasks:** `server_args`, `BON_GGUF`, `BON_EXTRA`, `qwen36full`, `--keep-list`, `variants`, `discipline`, `parse`.
