# Fitting Qwen3.8-Flash-Next on 8 GB: pruning, custom quantization, QAT and distillation

- **Date:** 2026-10-03
- **Status:** plan. Nothing in it has been run yet.
- **Companion to:** `2026-10-02-micro-agent-swarm-design.md` (rev 2)

**How numbers are tagged**

| Tag | Meaning |
|---|---|
| [card] | The publisher's own measurement |
| [on disk] | Read from this machine or from the published files |
| [measured here] | Measured on this machine |
| [estimate] | My arithmetic; to be checked |

---

## 1. Why this model

Qwen3.8-Flash-Next is a 125B mixture-of-experts with **6B active parameters**. It also has a 51B n-gram lookup table on top. On its own card it beats the project's target, Qwen3.8-27B [card]:

| | Flash-Next | Qwen3.8-27B |
|---|---|---|
| SWE-bench Pro | 62.5 | 61.7 |
| DeepSWE 1.1 | 58.7 | 42.2 |
| SWE-bench Multilingual | 81.0 | 73.8 |
| LiveCodeBench v6 | 91.9 | 90.3 |

If a compressed copy keeps most of that, it reaches the target on this machine. No other model on the table does that on paper.

## 2. Facts the plan rests on

**Architecture** [on disk: config.json]
- 48 layers; 512 experts per layer; each token uses 10 of them plus 1 shared expert.
- Each expert has 3 × 2,560 × 640 ≈ **4.92M** parameters.
- The experts total about 120.8B of the 125B. The rest is attention, the shared experts and embeddings.

**Original weights** [on disk: safetensors headers]
- 360 GB in BF16, across 131 files.
- Each layer stores its experts stacked expert-first: `gate_up_proj` is [512, 1280, 2560] and `down_proj` is [512, 2560, 640].
- So **each expert is one contiguous byte range**, 9.83 MB per expert per layer. We can download any subset of experts with HTTP range requests.

**The n-gram table** [card: ISTA-DASLab]
- 51.2B parameters, read sparsely at one row per token.
- ISTA ships it at 4.5 bits as a separate 28.8 GB file that can stay on disk.
- Our llama.cpp build (b10809) already supports Flash-Next (`qwen4exp`) and on-demand reading of this table (`--lazy-mode`) [on disk].

**ISTA-DASLab "Coder" build** [card]
- Keeps 256 of 512 experts per layer. They were chosen by RCO (ISTA's optimizer), which minimises the change in output (KL divergence) on code, agentic and vision data.
- The kept weights are quantized with GSQ (ISTA's quantizer) at 3.5 bits per weight.
- The weights file is 29.6 GB and must be held in memory. The n-gram file is 28.8 GB and can stay on disk.
- **SWE-bench Verified 75.6** vs 82.8 for the full BF16 model (91.3% kept). **LiveCodeBench v6 86.3** vs 87.4 (98.7%). Both measured at xhigh reasoning effort.
- Its allocation file lists **every kept expert by its original index**. So the same selection can be re-applied to the BF16 weights [on disk].

**This machine**
- About 7 GB of usable VRAM, plus about 9 GB of free RAM once other apps are closed. That's about **16 GB that can be held in memory**.
- Today's tests show models whose expert weights spill past that run off the disk and slow down sharply [measured here: Qwen3.6 IQ3_XXS].

**Other relevant work**
- REAP measured that removing about 50% of experts keeps coding performance close to the original. Merging experts did worse than removing them [card].
- No one has published results for pruning beyond 50%.

## 3. The fit problem

The budget is about 16 GB held in memory, with the n-gram table on disk.

The Coder build's weights file is 29.6 GB. About 95% of it is experts, ≈ 28.1 GB, or 2.29 MB per expert per layer at its 3.5-bit mix.

If we keep the same per-weight precision, the weights file shrinks with the number of experts kept [estimate]:

| Experts kept per layer | Weights file | Fits in 16 GB? |
|---|---|---|
| 256 (ISTA Coder) | 29.6 GB | no (pages from disk) |
| 192 | ~22.6 GB | no |
| 160 | ~19.1 GB | borderline |
| **128** | **~15.6 GB** | **yes** |
| 96 | ~12.0 GB | yes, with room for context |

The other lever is fewer bits per expert. At about 2.5 bits per weight, 160–192 experts would fit in the same ~16 GB. That's the trade the custom-quantization track (C) explores.

**Speed** [estimate]: 6B active is twice Qwen3.6's 3B, which measured 58.5 tok/s here. Fully held in memory, a fitted Flash-Next should land roughly at **25–40 tok/s**.

## 4. Tracks

### A. Prune further from the ISTA Coder file

No extra download is needed beyond the Coder files already queued.

1. Run `llama-imatrix` with the Coder model on **our** coding data: the tier2b prompts, patch-task contexts, and code from the 13 repos. This records how often each of the 256 experts is used, per layer.
2. Keep the top N experts per layer, N ∈ {192, 160, 128, 96}.
3. Write a new GGUF with a small `gguf-py` script, about 150 lines:
   - slice `ffn_gate_exps`, `ffn_up_exps` and `ffn_down_exps` along the expert axis (the quantized blocks sit within rows, so slicing is safe);
   - slice the router (`ffn_gate_inp` rows, plus the expert bias if present);
   - set the expert count to N;
   - keep the shared expert untouched;
   - pair the result with the unchanged n-gram file. Both files carry the same tensor count, so the two-file metadata still lines up.
4. Score each N on speed (`moe_sweep.py`) and quality (`tier2b_llama.py`, then the patch tasks).

- **Kill rule:** if the largest N that fits scores below Qwen3.6-35B-A3B IQ2_M with a thinking budget on tier2b (102/117 [measured here]), pruning alone isn't enough. Move to B and C.
- **Effort:** about a day, plus the imatrix run. The imatrix run streams expert weights from disk, so it's slow but a one-off.

### B. Healing by distillation, one layer at a time

Pruning removes experts that some tokens wanted. Healing teaches what's left to cover for them. It fits on 8 GB because it works on one MoE layer at a time.

1. **Capture each MoE layer's inputs** on our calibration data while running the 256-expert Coder model. This needs a small patch to llama.cpp's tensor-dump callback, or a modified `llama-imatrix`.
2. **For each layer**, build that layer in PyTorch from weights read back out of the GGUF:
   - teacher: the 256-expert layer;
   - student: the pruned layer.

   Train only:
   - the router (2,560 × N weights plus bias);
   - one output gain per kept expert,

   so that the student's output matches the teacher's (MSE on the layer output). That's a few hundred thousand trainable parameters per layer. Expert weights stay frozen.
3. Write the new router and gains back into the GGUF. Fold the gains into each expert's down-projection weights, or keep them as a small F32 tensor if the runtime supports one.

- **Why it should help:** after pruning, the router still spreads probability as if all 256 experts were there. Re-fitting it is the cheapest correction available.
- **Kill rule:** if healed N=128 doesn't beat unhealed N=128 on tier2b and the patch tasks, by a paired comparison, drop B.
- **Effort:** 2–4 days. Most of it is the activation-capture plumbing.

### C. Custom quantization from the original BF16 weights

This uses targeted downloads of only the experts we keep.

1. Take ISTA's kept-expert list (or a subset of it from track A). Download **only those experts' byte ranges** from the BF16 files, plus every non-expert tensor:
   - about 16 GB of non-expert weights (excluding the n-gram table, which comes from ISTA's file);
   - plus 9.83 MB per kept expert per layer: about 60 GB for 128 experts, or about 91 GB for 192.
2. Write a pruned Hugging Face checkpoint (config with N experts, sliced router), convert it with `convert_hf_to_gguf.py`, and compute an imatrix on our data.
3. Quantize with **mixed per-tensor types** (`llama-quantize --tensor-type …`), guided by a sensitivity sweep. This is a home-made version of RCO's idea: spend bits where the output is most sensitive.
4. Map the trade-off between number of experts and bits per expert at a fixed ~16 GB, for example 128 experts at 3.5 bits vs 160 at 2.8 vs 192 at 2.4.

- **Caveat:** ISTA's GSQ beats plain `llama-quantize` at equal bits [card]. So C only wins if keeping more experts matters more than the better quantizer. That's exactly what the sweep measures.
- **Optional:** run GSQ itself on a rented H100 for the winning configuration. GSQ's code runs one layer at a time, but it wants 80 GB GPUs [card].
- **Effort:** 1–2 days of tooling, plus a 3–4.5 hour download.

### D. QAT (quantization-aware training)

**D1. Google's Gemma 4 QAT checkpoint (quick test).**
- `unsloth/gemma-4-26B-A4B-it-qat-GGUF`, file `gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf` (14.25 GB), plus its MTP draft head (0.25 GB). Google trained this model to survive 4-bit quantization.
- Compare it with our 2-bit Gemma (101/117 thinking off [measured here]), using the same scripts.
- It needs about 3.5 GB more memory than our current Gemma, so expect a slower decode. The question is whether the quality gain is worth the speed.
- **Also try:** re-quantize the QAT model down to about 3 bits, to see whether training for 4-bit also protects it at lower bit-widths.

**D2. Local QAT-lite: re-fit quantization scales one layer at a time.**
- Using the BF16 expert weights from track C, re-fit each layer's quantization scales (optionally the rounding too). The goal is that the quantized layer's output matches the BF16 layer's on calibration inputs. This follows EfficientQAT's block-by-block step.
- One layer's kept experts in BF16 is about 1.3 GB at N=128, so it fits on the GPU.
- The hard part is exporting learned scales back into GGUF's fixed block formats. GSQ does this for K-quants; we'd have to rebuild that step.
- **Only worth doing if** C shows that quantization error, not pruning, is the main loss.

**D3. GSQ refinement on rented GPUs.** GSQ can take a public GGUF and refine it in place [card]. It's the fallback if D2 is too much engineering.

### E. Distillation into the small rungs

Once a fitted Flash-Next exists, it's the strongest local teacher we have.

1. Overnight, it writes fixes for training tasks.
2. The grader keeps only fixes the tests prove correct.
3. Those train the 0.5–3B heads and the 9B. This is rev 2's "teacher labels" plan, with a far stronger teacher.

Its slowness doesn't matter for this job.

### F. Running it unpruned (alternatives to pruning)

- **Expert streaming:** llama.cpp PRs #25294 (stream experts from SSD with a GPU-side cache) and #26414 (pin the most-used experts in RAM).
  - #26414 is recent. #25294 was last synced with master on Jul 5, before Flash-Next support existed, so it has to be merged forward first.
  - [estimate] 5–10 tok/s for the full 256-expert Coder build.
- **32 GB of RAM:** the 29.6 GB weights file then fits as-is. [estimate] 25–35 tok/s with no quality loss from extra pruning. This remains the cheapest real fix.

## 5. Order of work

| Step | What | Needs | Decides |
|---|---|---|---|
| 1 | Run the Coder build as-is: weights file on C:, n-gram file on D: via `--lazy-mode`, experts paged from disk | Coder download (queued) | Baseline speed and quality of the unpruned target |
| 2 | Imatrix on our coding data; slices N = 192/160/128/96; speed + tier2b + patch tasks | Slicer script | The speed–quality curve from pruning alone (A) |
| 3 | Gemma QAT Q4_K_XL vs our 2-bit Gemma | 14.5 GB download (not yet approved) | Whether QAT is worth its memory (D1) |
| 4 | Router + gain healing on the best slice | Activation capture + healing trainer | Whether layer-local distillation recovers pruning loss (B) |
| 5 | BF16 targeted download; experts-vs-bits sweep | ~76–107 GB download (not yet approved) | Whether more experts at fewer bits beats fewer at 3.5 (C) |
| 6 | Teacher labels from the best fitted model | Steps 2/4 | Distillation into the small rungs (E) |
| 7 | Streaming PR builds, for unpruned speed | CUDA builds (in progress) | The alternative to pruning (F) |

## 6. Tools to build

1. **`slice_experts.py`:** keep N experts per layer in a GGUF, slicing every expert tensor and the router, and update the metadata. Uses `gguf-py`, which is in the forge virtualenv.
2. **`fetch_expert_ranges.py`:** targeted BF16 download using `safetensors` headers and HTTP range requests. Writes a pruned Hugging Face checkpoint.
3. **Layer-input dump:** a llama.cpp patch or tool that saves the inputs to each MoE layer for a sample of tokens.
4. **`heal_router.py`:** PyTorch, one layer at a time. Teacher and student are rebuilt from GGUF weights read back as full-precision tensors. Trains the router and per-expert gains.
5. **Score with the existing scripts:** `moe_sweep.py` (speed) and `tier2b_llama.py` (quality, with resume), plus the patch-task grader for the final comparison.

## 7. Risks and unknowns

- **Pruning past 50% is unpublished.** At N=128 (75% of the original 512) quality could fall off a cliff. Track A finds out cheaply.
- **Our calibration data is narrow.** Pruning by coding usage alone drops experts for anything else; ISTA saw this with vision. That's acceptable for a coding rung, but keep a general sanity check.
- **Slicing quantized tensors** must respect each GGUF type's block layout. Expert slices are whole rows, so this is safe; verify by round-trip loading.
- **Two-file GGUF metadata:** our new weights file has to pair with ISTA's n-gram file. If that pairing fails, rebuild a single combined file.
- **Licence:** Flash-Next uses "qwen-community-1.0". Check its terms before any distribution; local use is the plan.
- **RAM and disk:** C: has about 44 GB free. Stage only the model being tested. D: (USB) has dropped twice; keep logs and active work on C:.
