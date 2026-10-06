# Adapters that patch keep96's general weak spots

- **Date:** 2026-10-05
- **Status:** design. Approved in conversation section by section; nothing in it is built or measured yet, except where tagged [measured here].
- **Sub-project B of two.** Sub-project A, Laya as Qwen's partner, is `2026-10-05-laya-partner-design.md`. B reuses A's task sets, harness and judge-set baseline.
- **Builds on:** `2026-10-05-overnight-levers.md` (the measurements), `2026-10-05-bestofn-selftest.md` (the recipe), `2026-10-02-micro-agent-swarm-design.md` §11 (why training hasn't paid off, and the fixed recipe).

**The brief (owner, 2026-10-05):** "We can also explore new and inventive ideas for adapters to maybe patch general capability where its lacking specifically rather than being used as a specialized case." Later: "I was thinking about the potential of distilling qwen 3.6 keep96 with qwen flash next for an additional potential gain."

**Decisions made in conversation:**

| Question | Owner's answer |
|---|---|
| Where may adapters be built? | Training-free local patches first (phase 1), then cloud distillation (phase 2) |
| Which weak spots? | Unseen-code reasoning, pruning loss in general, output discipline. Not self-test quality |
| VRAM budget | At most +0.5 GB over keep96, about 12 experts. Phase 2's LoRA counts against the same budget |
| How are patches judged? | Chosen only on the 60-task calibration pool and on closeness to the full model. Scored once, pre-registered, on the sealed judge set; tier2b for continuity |
| Phase 2 spend | Within Modal's $30 monthly free credit. Each paid run waits for the owner's go, with an estimate |
| Phase 1 shape | Expert patch first (swap / add) plus one steering vector. Expert merging is a stretch variant |
| Distill keep96 from Qwen3.8-Flash-Next? | Yes for phase 2, behind a teacher test against the full Qwen3.6 and keep96's own system |
| Coming shortly after this | Training Laya, and multi-file features |

## 1. Starting point

**Qwen3.6-35B-A3B keep96** (96 of 256 experts; IQ2_M; all on the GPU; MTP + n-gram speculation; 274 tok/s):

| Configuration | tier2b (117) | Fresh hidden-package tasks (36) |
|---|---|---|
| Single shot | 98–101 (hidden-package B 6/21) | 11 |
| Recipe: 3 candidates + 1 self-test suite | 103–107 | 10 |
| Probe, then fix | 90–95 | 13–16 |
| Full 256-expert model, same quant (22 expert layers on the CPU) | 94 (B 9/21) | not measured |
| Qwen3.8-Flash-Next Coder, thinking off (Modal) | 97 | not measured |

**The three targets, as measured:**
- **Unseen-code reasoning:** keep96's largest gap. Pruning took tier2b B from 9 to 6, and on fresh tasks keep96 misreads hidden conventions (units, ordering, return values).
- **Pruning loss in general:** whatever the 160 dropped experts carried. tier2b totals don't show it, and B does. A broad measure is needed (§3.3).
- **Output discipline:** in multi-step prompts, keep96 sometimes returned a script instead of the file, or copied a failed probe's imports.

**Facts this design rests on** [measured here, 2026-10-05]:

| Fact | Value |
|---|---|
| keep96 size | 5.5 GB file; about 5.4 GB of VRAM serving. Headroom about 1.8 GB on the 8 GB card with the Versutus gate paused |
| One expert slot (all 40 layers) | about 40 MB (full 11.9 GB vs keep96 5.5 GB over 160 slots) |
| Tokenizers | Qwen3.6 and Qwen3.8-Flash-Next are identical: 248,320 tokens, same token-list hash `367770562c79ea9e`; only the padding id differs. Token-level distillation is possible |
| Runtime adapters (llama.cpp 836d571) | `--lora`, `--lora-scaled`, `--lora-init-without-apply` with a per-request `lora` field; `--control-vector`, `--control-vector-scaled`, `--control-vector-layer-range` (load-time only) |
| Closeness tool | `llama-perplexity --kl-divergence-base / --kl-divergence`. The reference file holds about 0.5 MB per scored token at this vocabulary |
| Steering tool | `llama-cvector-generator --positive-file --negative-file --method {pca,mean}` |
| Neither tool | is in today's build; both build from the same 836d571 source |

## 2. Residents

- **Qwen keep96**, or a patched variant, on the GPU, configured as today.
- **The full 256-expert Qwen3.6 IQ2_M**, phase 1 only, for measuring. It needs 22 expert layers on the CPU, so it runs only with the Versutus gate paused and other apps quiet: 16 GB of RAM is tight.
- **No second coder.** Phase 2's teacher runs on Modal, or locally during data generation only.

## 3. Phase 1: training-free patches

### 3.1 Find what keep96 lost, where it matters

- **Calibration text, about 200k tokens.** The full model answers the 60 calibration-pool tasks in its own chat format: single shot and probe-then-fix, so the probe prompt, its script, its output and the fix are all included.
  - Hidden-package tasks and probe-then-fix transcripts are counted twice.
  - About 20% general text (standard-library source slices) is added.
  - Nothing from the held-out closeness text (§3.3), tier2b or the judge set.
- **Energies.** `llama-imatrix` with the full model on that text gives every expert's activation energy (`ffn_down_exps` input sum of squares), including the 160 keep96 dropped.

### 3.2 Three variants

GGUF needs one expert count in every layer, so every choice is made per layer. The combined ranking is the slicer's existing rule: each imatrix normalized per layer, then summed. It combines the new failure-targeted imatrix with the code imatrix that built keep96 (`imatrix-qwen36-code.gguf`).

| Variant | Experts | Size vs keep96 | How chosen |
|---|---|---|---|
| keep96 (baseline) | 96 | — | code imatrix (2026-10-04) |
| swap96 | 96 | ±0 | top 96 by the combined ranking |
| add108 | 108 | about +0.45 GB | keep96's 96, plus each layer's 12 highest dropped experts by the new energy |
| swap108 | 108 | about +0.45 GB | top 108 by the combined ranking |

Each variant is sliced with the existing `slice_experts.py` and a written keep list. Its tok/s and VRAM are measured at once, and any variant over +0.5 GB, spilling off the GPU, or more than 5% slower is dropped.

### 3.3 Choose by closeness, then by tasks

1. **Closeness.**
   - The reference is the full model's logits on a fixed held-out file of 6 chunks × 2,048 tokens. About 6,100 tokens are scored, and the reference file is about 3 GB.
   - The file holds standard-library source from modules no task set or calibration text uses, plus English technical prose. It is committed as `docs/benchmarks/adapters/heldout.txt`.
   - Every variant gets mean KL, 99th-percentile KL and top-token agreement against the full model.
2. **Tasks.** The two variants with the lowest mean KL run single shot plus the recipe on the calibration pool (60 tasks × 3 trials). They are paired against keep96's pool results from sub-project A's calibration runs, which are run here if A hasn't run them yet.
3. **Winner.** The most recipe samples solved on the pool; ties go to single-shot solved, then lower mean KL, then the smaller size. If no variant beats keep96's recipe on the pool, the expert arm is null and keep96 stays the base for §3.4.

### 3.4 Steering vector for output discipline

- **Pairs.** About 100. Each is the same prompt followed by a disciplined start (the complete file in a code block, with the entry's own imports) or an undisciplined one (a probe or test script, prose, rewritten imports).
  - Sources: real probe-then-fix transcripts from the pool (both models), plus templated negatives made by rewriting a positive's start.
- **Build.** `llama-cvector-generator`, methods `mean` and `pca`, over all layers and over the middle half (`--control-vector-layer-range`).
- **Discipline failure,** measured on every fix answer. Its extracted code fails to compile, lacks a top-level function or class the original entry defines, or drops one of the original entry's import lines. The last clause can also flag a legitimate cleanup, so it is reported as a proxy.
- **Sweep.** Scales 0.25, 0.5 and 1.0 on top of §3.3's winner, or keep96 if the expert arm is null. The pool's probe-then-fix runs measure discipline failures, and single shot and the recipe check for harm.
- **Keep rule.** Kept only if discipline failures drop and neither single-shot nor recipe solved falls. A control vector applies to every request on the server, so it must do no harm anywhere.
- **If both arms are null,** phase 1 ends with a null report and no judge run.

### 3.5 Stretch: expert merging

Only if add108's KL to the full model is still far from zero and the pool gap persists. Each dropped expert would be folded into its most similar kept one, weighted by usage, at zero growth. It needs a dequantize → merge → re-quantize pipeline and gets its own design pass.

## 4. Phase 2: distillation (Modal, within $30)

Phase 2 starts after phase 1 is judged. Every paid step waits for the owner's go with its estimate, and every Modal function has a hard timeout, so a run cannot overspend.

### 4.1 Teacher test (about $3)

All scored single shot on the calibration pool (180 samples), never on tier2b or the judge set:

| Teacher | Where | Modes |
|---|---|---|
| Qwen3.8-Flash-Next Coder (ISTA GSQ-RCO, 256 experts) | Modal L40S, last night's image and app | thinking off; thinking at a 2,048-token budget |
| Full 256-expert Qwen3.6 | local, free | thinking off |
| keep96's own system (recipe, probe) | local, free; sub-project A's calibration runs | as measured |

- **Qualifies** if its single shot beats keep96's recipe by at least 8 of 180 pool samples. If more than one qualifies, the highest wins; ties go to the cheaper.
- **If none qualifies,** self-distillation from keep96's verified recipe/probe answers, provided that system beats keep96's single shot by at least 8 on the pool. Otherwise phase 2 stops.

### 4.2 Data, disjoint from everything scored

- **About 1,000 new training tasks** from generators in the calibration-pool format: hidden-convention families, standard-library bug-fixes with tests against the original function, file I/O, bad input, library use.
  - Each passes `validate_tasks.py` (buggy fails, reference passes).
  - Each passes a disjointness check against tier2b, the pool and the judge set: no shared names, functions or conventions.
- **Teacher answers.** With thinking, the teacher thinks, but only the final answer is kept.
  - Only answers that pass the task's test become training targets.
  - The teacher's top-20 token probabilities on its answer tokens (llama-server `n_probs`) are stored for a token-level KL target.
- **Regularizer.** About 300k tokens of teacher continuations of held-out code prefixes, used for KL only, against the broad pruning loss. The prefixes never come from §3.3's held-out file.

### 4.3 Student and training

- **Student.** keep96 plus the phase-1 patch, **dequantized from the exact served GGUF**, so the adapter learns on the weights it will run on.
  - It is reverse-mapped into transformers' `Qwen3_5Moe` text layout, with the phase-1 expert count.
  - About 14.9B parameters for keep96, about 30 GB in bf16.
- **LoRA.** Targets the full-attention projections, the linear-attention (DeltaNet) projections and the shared expert. Not the routed experts (llama.cpp's LoRA support on stacked expert tensors is uncertain) and not the router.
  - Rank 16; rank 8 if phase 1 picked a 108-expert variant, so the total stays within +0.5 GB.
- **Loss.** Cross-entropy on verified answer tokens, plus KL to the teacher's top-20 probabilities (the rest of the mass lumped), plus KL-only regularizer batches.
- **Run.** 2 epochs, sequences up to 2,048 tokens, bf16, gradient checkpointing, one A100 80 GB (or RTX PRO 6000 96 GB if memory is tight).
- **Kernels.** `flash-linear-attention` (Triton) is installed. `causal-conv1d` comes only as a prebuilt wheel, or is skipped for transformers' PyTorch fallback: compiling it on Modal's image builder would crawl, as llama.cpp's CUDA build did.

### 4.4 Gates before training spend

Each gate is cheap, and a failure stops phase 2:

1. **Round trip.** The reverse-mapped tensors, run back through llama.cpp's own forward converter (`Qwen3_5MoeTextModel`), reproduce the served tensors exactly. The converter reorders some linear-attention tensors, and this is where mapping bugs would hide.
2. **Load parity.** The dequantized model in PyTorch picks the same top token as llama.cpp's served model on at least 99% of 2,000 positions. llama.cpp's top tokens are recorded locally and compared offline.
3. **Toolchain.** The DeltaNet path trains, and `convert_lora_to_gguf.py` produces a GGUF LoRA that llama.cpp loads.
4. **Overfit test.** A LoRA trained on 20 examples reproduces at least 95% of them, both in PyTorch and in the served GGUF.

**Fallback if the round trip cannot be made exact:** the official bf16 weights (`Qwen/Qwen3.6-35B-A3B`, about 67 GB, downloaded inside Modal), pruned to the same experts. That accepts a train/serve mismatch and is judged on the served model only.

### 4.5 Serving

The LoRA loads with `--lora` and is always on. tok/s must stay within 5%. If it doesn't, merge and re-quantize as a fallback, then re-check KL and the pool scores. Selecting the LoRA per task through Laya's classification (per-request `lora` field) is an optional extra arm, not the default.

### 4.6 Modal feasibility [measured here, 2026-10-05]

| Step | Runs on | Verified |
|---|---|---|
| Teacher test and teacher data (Flash-Next) | L40S 48 GB, $0.000542/s | Last night's job ran this model there (30 min, $1.45); `n_probs` returns top-N token probabilities |
| Full Qwen3.6 or self-system teacher | local | same tokenizer, same API |
| Dequantize the served keep96 | CPU container ($0.0000131/core/s, $0.00000222/GiB/s) | `gguf-py` has exact NumPy dequantization for all 11 quant types in the file (Q5_K, IQ2_XXS, IQ3_XXS, Q6_K, IQ4_XS, Q8_0, IQ2_S, Q2_K, BF16, Q4_K, Q3_K) |
| Training | A100 80 GB, $0.000694/s; RTX PRO 6000, $0.000842/s; H100, $0.001097/s | transformers supports `qwen3_5_moe` (config built with 4.57.1) |
| LoRA → GGUF | same container | `convert_lora_to_gguf.py` reuses the registered `Qwen3_5MoeForCausalLM` converter |

**Budget:**

| Item | Estimate |
|---|---|
| Teacher test | about $3 |
| Gates | about $2 |
| Teacher data | about $3 (thinking off) to $12 (thinking on) |
| Training | about $5 |
| **Total** | **about $13–22 of the $30** |

## 5. Evaluation

**Hard rule:** nothing is chosen or fitted on tier2b or the judge set. That covers variants, scales, layer ranges, teachers and hyperparameters.

**Pre-registration.** Before any judge run, `docs/superpowers/specs/<date>-adapters-prereg.md` is committed, recording:
- the chosen patch: the variant and the steering vector (method, layer range, scale) or none;
- the bar;
- the baseline source.

Phase 2 commits its own pre-registration before its judge run.

**Judge runs.** The patched model runs single shot and the recipe on the sealed judge set (60 tasks × 3 trials), with sub-project A's harness, prompts and seeds. Plain keep96's judge-set results come from A's judge runs, measured once and paired per sample, whichever project runs first. tier2b is reported for continuity only.

**The bar** (each phase):
- the patched recipe solves more judge samples than the reference recipe in a paired McNemar test (p < 0.10). The reference is keep96 for phase 1, and the phase-1 model for phase 2;
- tok/s within 5% of the reference;
- fully on the GPU, at most +0.5 GB total;
- no category drops by more than 3 of its 36 samples.

Otherwise the result is a null, reported with which patch helped or hurt.

**Measured and reported:**
- samples solved per category, single shot and recipe;
- tok/s and VRAM;
- mean and 99th-percentile KL and top-token agreement against the full model;
- discipline failures in probe-then-fix;
- for phase 2: the teacher-test table, gate results, training curves and actual spend per step.

## 6. Failure handling

| Failure | Behaviour |
|---|---|
| A variant is over +0.5 GB, spills to system RAM, or is more than 5% slower | Rejected before any task scoring; recorded |
| Less than 10% free on C: before writing a variant or the 3 GB KL reference | Refuse; delete scored variants first; settle 3 minutes after every multi-GB write |
| RAM pressure while the full model runs (under 1 GB available) | Pause and wait; never run alongside other GPU or RAM-heavy work |
| `llama-cvector-generator` fails to build or run on this architecture | The steering arm is dropped and noted |
| A Modal step fails or times out | Resumable from the volume; each paid step logs its actual cost; no automatic retry that spends |
| Any phase-2 gate fails | Phase 2 stops and reports which gate, before training spend |

## 7. Components

New files in `scripts/moe-bench/`:

| File | What it does | Depends on |
|---|---|---|
| `patch_calib.py` | Builds the failure-targeted calibration text from the full model's answers on the pool (§3.1) | `bestofn_tier2b`, `probe_tier2b` helpers, the pool |
| `expert_patch.py` | Combines imatrix energies and writes per-layer keep lists for swap96 / add108 / swap108; calls `slice_experts.py`. Selection logic is pure and unit-tested | `slice_experts.py`, numpy, `gguf-py` |
| `kl_eval.py` | Builds the KL reference once; runs `llama-perplexity --kl-divergence` per variant; parses mean / p99 KL and top-token agreement to JSON; checks free disk | `llama-perplexity` |
| `steer.py` | Builds the contrastive discipline pairs; runs `llama-cvector-generator`; drives the scale sweep | `llama-cvector-generator`, the pool runs |
| `remote/modal_distill.py` | Phase 2: teacher test, teacher data, dequantize + round trip, parity, training (with an overfit mode), LoRA conversion. One resumable Modal app with a hard timeout per function | Modal, the llama.cpp full-cuda image, torch, transformers, peft, `flash-linear-attention` |
| `train_tasks/` | The ~1,000 training-task generators, validation and the disjointness check | `validate_tasks.py` |

**Changes to existing code:**
- sub-project A's `playbook_tier2b.py` gets a `--gguf` and a `--control-vector` override, so every variant runs through the same harness. It stays backward compatible.
- `llama-perplexity` and `llama-cvector-generator` are added to the 836d571 build.

**Results:**
- `docs/benchmarks/adapters/` for keep lists, KL tables, pool results, the pre-registrations and reports. Local temp paths are scrubbed with `scrub_paths.py`.
- Big binaries stay in `C:\qwen3-forge-stage\models\adapters\` and are never committed: imatrix files, variant GGUFs, the KL reference.

## 8. Order of work

1. Build `llama-perplexity` and `llama-cvector-generator`. Unit tests for `expert_patch.py` selection and `kl_eval.py` parsing.
2. The full model's calibration answers on the pool, then the full-model imatrix (about 1 GPU hour).
3. The KL reference on the held-out file.
4. Slice the three variants; KL for each; the two closest on the pool.
5. The steering-vector sweep on the pool winner.
6. Pre-register phase 1, then judge runs (the owner confirms before the Versutus gate is paused), then the report `docs/superpowers/specs/<date>-adapters-phase1-results.md`.
7. Phase 2, each paid step on the owner's go:
   1. training tasks;
   2. Modal gates (about $2);
   3. teacher test (about $3);
   4. teacher data and training (about $8–17);
   5. local served evaluation on the pool;
   6. pre-registration, judge runs, report.

Phase 1 is about 4–5 local GPU hours, so no spend.

**Plans.** One implementation plan per phase. Phase 2's plan is written after phase 1's report, because its student (the phase-1 winner) and its LoRA rank depend on that result.

## 9. Out of scope

- **Coming shortly after (owner, 2026-10-05):** training Laya, and multi-file features.
- **A second coder model,** which does not fit alongside Qwen.
- **Self-test quality,** which was not chosen as a target. It improves indirectly if unseen-code reasoning does.
- **LoRA on routed experts or the router,** pending llama.cpp support on stacked expert tensors.

## 10. Risks

- **Expert patches are capped by the full model,** which scored only 9/21 on tier2b's hidden-package tasks. Much of the pruning loss may lie outside tier2b's view. KL measures it, and tasks decide.
- **Activation energy is not causal importance.** Energy builds the candidates, but tasks choose the winner.
- **Steering vectors on a hybrid DeltaNet MoE are untested here.** The arm may be dropped. Because it is server-wide, it must not harm any request type.
- **The full model's CPU offload on 16 GB of RAM** risks paging and slow runs. Phase-1 measuring runs only on a quiet machine with the gate paused.
- **Phase 2:**
  - reverse-mapping errors (the round-trip and parity gates catch them);
  - slow MoE and DeltaNet training in transformers;
  - a LoRA on IQ2_M-level weights may move little;
  - no teacher may qualify (then self-distillation, or a stop);
  - the teacher's thinking-mode answers are conditioned on reasoning the student never sees.
- **Two looks at the judge set,** one per phase. Each is a single pre-registered comparison, and the report gives both p-values. Sub-project A also scores there once. Nothing is ever fitted on it.
- **The C: NVMe** (it bugchecked under heavy write and read-back on 2026-10-04). Variant GGUFs of 5.5–6 GB each and the 3 GB reference mean settle pauses, deleting variants after scoring, and keeping at least 10% free.
