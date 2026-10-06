# Adapters Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A LoRA on keep96 (full attention, DeltaNet, shared expert) distilled from the teacher §4.1 picks. It loads with `--lora` and is judged once on the sealed set.

**Architecture:**
- **Modal** runs everything heavy: one app (`scripts/moe-bench/remote/modal_distill.py`), the resumable volume `distill`, a hard timeout per function, and the actual cost logged per step.
- **Locally:** task generation, the served evaluation and the judge runs.
- **Mapping:** the GGUF→HF reverse mapping is a pure module, checked against llama.cpp's own forward converter.

**Tech Stack:**
- llama.cpp 836d571 locally, and b11382 on Modal (WebGPU-only difference);
- gguf-py;
- torch, transformers (`qwen3_5_moe`), peft and flash-linear-attention;
- Modal.

**Spec:** `docs/superpowers/specs/2026-10-05-adapters-design.md` §4, §5, §6. **Phase 1:** `specs/2026-10-05-adapters-phase1-results.md`.

---

## Where phase 1 left it

- **Phase-1 patch:** none (null). The student is plain keep96, 96 experts, LoRA rank 16 (§4.3).
- **Expert arm:** deferred for disk. If it later wins, the student changes and Task 5 is rerun (about $5).

## Order, changed from spec §8.7

Teacher test, gates, training tasks, teacher data, training, served evaluation, judge.

- **Why the teacher test moved first:** it is the cheapest step and the one that can stop phase 2 (§4.1). The pool showed keep96 near its ceiling: single shot 144/180, recipe 147, probe-then-fix 152.
- **Why the gates come before the task generators:** a gate failure stops phase 2 before the generators' work.

## Task 1: Teacher test (§4.1). Done 2026-10-06

**Files:** `remote/modal_distill.py::teacher` (Flash-Next, L40S), local grading of the full model's calibration answers.

| Teacher | Single shot on the pool (of 180) | Qualifies (at least 155) |
|---|---|---|
| Flash-Next Coder, thinking off | see the phase-2 results | |
| Flash-Next Coder, 2,048-token budget | see the phase-2 results | |
| Full Qwen3.6, thinking off | 50/60 on trial 0, about 150/180 | no; the other 120 samples were not run, because tonight's full-model run put available RAM at 0.3 GB, against §6's rule |
| keep96's probe-then-fix (self-distillation) | 152, against its single shot 144: +8 | the fallback qualifies (at least 8) |

**Rule:**
- The highest qualifying teacher wins; ties go to the cheaper.
- If no teacher qualifies, the target is self-distillation: keep96's own verified probe-then-fix answers.

## Task 2: Gates (§4.4). Modal, about $2, each a stop

**Files:**
- Create: `scripts/moe-bench/distill/reverse_map.py`. A pure GGUF→HF mapping for qwen35moe: names, the transposes, expert unstacking, and the inverse of each converter transform (below).
- Create: `scripts/moe-bench/distill/test_reverse_map.py`. A toy round trip through llama.cpp's own `conversion.qwen.Qwen3_5MoeTextModel.modify_tensors`.
- Modify: `scripts/moe-bench/remote/modal_distill.py`. Add `build_keep96`, `dequant`, `roundtrip`, `parity`, `toolchain`, `overfit`.

**The converter's transforms** (`C:\build\wt-master\conversion\qwen.py`, 836d571), and their inverses:

| Forward (HF → GGUF) | Inverse |
|---|---|
| `A_log` → `-exp(A_log)` | `log(-x)` |
| `dt_bias` → `dt_proj.bias` | rename |
| `conv1d` squeezed | unsqueeze to `[C, 1, K]` |
| `*norm.weight` + 1, except `linear_attn.norm` | − 1 |
| V heads grouped → tiled (num_k_heads ≠ num_v_heads): in_proj_qkv's V rows, in_proj_z rows, in_proj_a/b rows, A_log / dt_bias, conv1d's V channels, out_proj columns | the inverse permutation: reshape `[v_per_k, k_heads, d]`, swap, flatten |
| experts: `gate_up_proj` split, or per-expert stacked | re-stack to the layout the transformers version expects |
| `mtp.*` → layer 40 nextn | dropped (not trained, not used by the forward) |

**Steps:**

- [ ] **2.1 Rebuild keep96 on Modal, so nothing is uploaded.**
  - Download the same UD-IQ2_M GGUF from Hugging Face.
  - Slice it with `models/prune-qwen36/keep96.json` (`slice_experts.py --keep-list`).
  - Check its sha256 against the local served file. Stop if they differ.
- [ ] **2.2 Dequantize and reverse-map.**
  - Dequantize tensor by tensor with gguf-py (all 11 quant types).
  - Reverse-map to bf16 safetensors plus `config.json` (`num_experts` 96).
  - Keep a float32 copy of each tensor for 2.3.
- [ ] **2.3 Round trip.**
  - Run llama.cpp's forward `modify_tensors` on the reverse-mapped float32 tensors.
  - Compare against the dequantized served tensors.
  - Pass: bitwise equal for permutation-only tensors, and at most 1e-6 relative where the converter does arithmetic (`exp`, `+1`).
- [ ] **2.4 Load parity.**
  - Record llama.cpp's top-1 tokens locally on 2,000 positions of `docs/benchmarks/adapters/heldout.txt` (llama-server `n_probs`, keep96, no speculation). This file is never used for training.
  - Run the transformers forward on the same tokens.
  - Pass: at least 99% agreement.
- [ ] **2.5 Toolchain.**
  - Put a peft LoRA at r=16 on the full-attention q/k/v/o, DeltaNet in_proj_qkv, in_proj_z, in_proj_a, in_proj_b and out_proj, and the shared expert's gate/up/down. Not the routed experts, not the router.
  - Run one training step.
  - `convert_lora_to_gguf.py`.
  - The local llama-server loads it with `--lora`, and the output changes against no LoRA.
- [ ] **2.6 Overfit.**
  - 20 pool-format examples, about 30 steps.
  - Pass: at least 95% of target tokens reproduced greedily, both in PyTorch and in the served GGUF.

**Fallback (§4.4):** if 2.3 cannot be made exact, use the official bf16 weights (`Qwen/Qwen3.6-35B-A3B`, about 67 GB, downloaded inside Modal), pruned to keep96's experts.

**Cost cap:** CPU container for 2.1–2.3; one A100 80 GB for 2.4–2.6. Timeouts of 1 h each. Each function returns its seconds and dollars, which go into the results.

## Task 3: Training tasks (§4.2). Local

**Files:**
- Create: `scripts/moe-bench/train_tasks/` with one generator per family, `make.py` and `disjoint.py`. The families are hidden-convention, stdlib bug-fix with tests against the original function, file I/O, bad input, and library use.

**Steps:**
- [ ] About 1,000 tasks in the calibration-pool format.
- [ ] Each passes `validate_tasks.py`: the buggy version fails, the reference passes.
- [ ] `disjoint.py` refuses any shared task name, function name or convention with tier2b, the pool or the judge set.

## Task 4: Teacher data (§4.2)

- [ ] **With Flash-Next as teacher:** Modal L40S, thinking as Task 1 picked, top-20 `n_probs` on the answer tokens.
- [ ] **With self-distillation:** local keep96 probe-then-fix on the training tasks, no probabilities, so the loss is CE only.
- [ ] Keep only answers that pass their task's test.
- [ ] Regularizer, KL only, when a teacher gives probabilities: about 300k tokens of continuations of held-out code prefixes, never from `heldout.txt`.

## Task 5: Training (§4.3). One A100 80 GB, about $5

- [ ] 2 epochs, sequences up to 2,048 tokens, bf16, gradient checkpointing.
- [ ] CE on verified answer tokens, plus KL to the top-20 when there is a teacher.
- [ ] `convert_lora_to_gguf.py`, then download the LoRA.

## Task 6: Served evaluation, locally on the pool

- [ ] keep96 with `--lora`: recipe and single shot on the pool, and tok/s against 78.4 (llama-bench) and against serving speed.
- [ ] Continue only if the recipe beats 147.

## Task 7: Pre-registration, judge, report (§5)

- [ ] Commit `specs/<date>-adapters-phase2-prereg.md` before any judge run.
- [ ] Judge runs: keep96 and keep96 + LoRA on the sealed set. The bar is §5's.
- [ ] Report `specs/<date>-adapters-phase2-results.md`, with the spend per step.
