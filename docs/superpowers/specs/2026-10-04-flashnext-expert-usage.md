# Qwen3.8-Flash-Next Coder: expert usage, and what fits on this PC (2026-10-04)

**Question.** The Qwen family took expert pruning well: Qwen3.6 kept 96 of 256 experts and still scored 99/117. Could an optimal prune, config and quant put Qwen3.8-Flash-Next on 8 GB VRAM + 16 GB RAM?

**Short answer.** Not by pruning on 16 GB of RAM. ISTA's Coder release already removed the redundant half of the experts, and the 256 that remain are all in steady use. Fitting 16 GB needs about 112 or fewer, which keeps only 82% of expert energy, below the level where gpt-oss collapsed. With a second 16 GB stick (32 GB, dual channel), 224 of 256 experts fit (98.5% of the energy), so the Coder would run at essentially full quality.

## What was measured

| | |
|---|---|
| Model | `ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF`: 256 of 512 experts kept by RCO; 48 layers; top-10 routing plus 1 shared expert |
| Hardware | Modal L40S 48 GB, `scripts/moe-bench/remote/modal_flashnext.py` |
| Runtime | llama.cpp official `full-cuda` image b11382, one WebGPU-only commit after the local 836d571 |
| Calibration | The model's own chat-format answers to 96 coding prompts (fix / implement / tests, built from stdlib functions, half with thinking), plus 20 KB slices of 20 stdlib modules |
| Calibration size | 821 KB of text, 107 imatrix chunks of 2,048 tokens. PPL 1.36 |
| Run | 30 min end to end. Download 4.3 min, answers 12.5 min at about 150 tok/s total over 4 slots, imatrix 13 min. Cost about $1.45 |
| Metric | Energy per expert = `ffn_down_exps` input sum of squares (same as the gpt-oss and Qwen3.6 rounds); routing counts from the same imatrix |

## Shard 1 layout (29.6 GB; the 28.8 GB n-gram shard can stay on disk)

| Part | Size | Types |
|---|---|---|
| Routed experts | 25.15 GB, **98.2 MB per expert** across 48 layers | gate/up IQ2_S, IQ3_XXS, IQ3_S; down IQ4_NL (9.2 GB) or Q2_0 |
| Dense (attention, linear attention, hyper-connections, output, embeddings, shared expert, router) | 4.45 GB | Q6_K 1.88, BF16 1.47 (hyper-connection matrices 1.26), IQ4_XS 0.51, Q5_K 0.35, Q4_K 0.20 |

Shard 1 at N experts ≈ 4.45 GB + 0.098 GB × N. The model has 2 KV heads and n_embd 2560, so the KV cache is tiny. It has no MTP block.

## Expert usage

| Experts kept | Shard 1 | Energy kept, mean | Worst layer | Routings covered |
|---|---|---|---|---|
| 224 | 26.4 GB | 0.985 | 0.970 | 97.4% |
| 192 | 23.3 GB | 0.955 | 0.916 | 92.6% |
| 160 | 20.2 GB | 0.912 | 0.852 | 86.3% |
| 128 | 17.0 GB | 0.853 | 0.770 | 78.2% |
| 112 | 15.5 GB | 0.817 | 0.721 | |
| 96 | 13.9 GB | 0.775 | 0.665 | 68.2% |
| 64 | 10.7 GB | 0.664 | 0.528 | 55.2% |

"Routings covered" uses the set chosen by energy, which is what `slice_experts.py` keeps. Layers 10 and 13 are the flattest. 39, 31 and 47 are the most concentrated.

**Against the models already pruned and scored here** (same metric, same tier2b):

| Prune | Energy kept, mean (worst layer) | tier2b | Experts needed per layer for 90% energy |
|---|---|---|---|
| gpt-oss-20b keep24 / 32 | 0.957 (0.901) | 105–107 vs 108 full | 19.7 of 32 (62%) |
| gpt-oss-20b keep16 / 32 | 0.836 (0.739) | **77, collapsed** | |
| Qwen3.6-35B keep96 / 256 | 0.907 (0.670) | 99 | 88.9 of 256 (35%) |
| **Flash-Next Coder / 256** | | | **149.9 of 256 (59%)** |

Qwen3.6's raw pool is peaked: 35% of its experts hold 90% of the energy, which is why keep96 was nearly free. Flash-Next's already-pruned pool is as flat as gpt-oss's 32-expert pool. No expert went unused on this calibration. The hottest takes 3.3% of a layer's routings, against 0.39% if usage were uniform. RCO's KL search already took the easy half, so each further cut costs real capability. The Qwen3.6 keep96 level (0.91) is N = 160 here, and gpt-oss's lossless keep24 level (0.955) is N = 192.

## What fits on this PC

The dense 4.45 GB, KV, compute buffers and the desktop take about 6 GB of the RTX 4060's 8 GB, leaving about 2 GB for experts. Windows and apps take about 5 GB of the 16 GB RAM, leaving about 9–10 GB for experts plus the n-gram table's page cache.

| RAM | Max experts that fit | Energy kept | Outlook |
|---|---|---|---|
| 16 GB, single channel (now) | about 112 (15.5 GB) | 0.82 | Below gpt-oss's collapse point (0.84). Expect clear damage. Only a test can say how much |
| 32 GB, dual channel (one more 16 GB DDR5-5200 stick) | 224 (26.4 GB) | 0.985 | Essentially the full Coder. Dual channel also doubles CPU-expert bandwidth |

**Speed estimate with 32 GB (not measured).** Each token reads the dense 4.45 GB on the GPU (about 16 ms) plus 10 experts × 48 layers × 2.05 MB ≈ 1 GB of experts, mostly from RAM (about 15 ms dual-channel, about 30 ms single). That gives about 30 tok/s before n-gram speculation, which roughly doubled code throughput on Gemma and Qwen here.

**Levers that do not close the 16 GB gap:**
- *Requantize the dense part* (BF16 hyper-connection matrices to Q8_0, Q6_K to Q5_K/Q4_K). Saves about 0.6–1.2 GB, roughly 6–12 experts.
- *Requantize the IQ4_NL down-projections to IQ3_XXS* with this imatrix. Saves about 11% per expert (98 → 87 MB, so about 123 fit). But it stacks standard quantization error on GSQ-learned grids, and ISTA kept down-projections at 4.5 bpw for a reason.
- *Keep all 256 and page cold experts from the SSD.* With the top 128 resident, about 20% of routings miss. That is about 200 MB per token from the NV2, a few tok/s at best, on the drive that already bugchecked under heavy I/O.
- *Heal a deeper prune by distillation.* This needs training passes over a 177B-parameter model, which is out of scope here.

## Next steps

1. **Recommended:** add a second 16 GB DDR5 stick, then slice keep224 (or keep192 for more headroom). Run it locally with `--n-cpu-moe` plus n-gram speculation, and score it on tier2b.
2. **If a 16 GB answer is wanted first:** slice keep112 and keep160 on Modal (CPU container, about 30 GB download each) and run tier2b on the L40S. That measures the actual quality cliff instead of inferring it from energy. Estimated cost $2–3. It needs `gguf-py` from the llama.cpp tree, because PyPI `gguf` lacks Q2_0 (type 42).

## Files

- `docs/benchmarks/2026-10-04/flashnext/`: `expert-usage-summary.json` (per-layer energy and counts, top-N expert lists), `transcripts.jsonl`, `calib.txt`, `server.log`, `imatrix.log`
- The 283 MB imatrix is not committed. It is in `C:\qwen3-forge-stage\flashnext-results\results\` and in the Modal volume `flashnext`.
- ISTA's per-tensor and per-expert allocation (`...rco-allocation.txt`) is in the same local folder. It is also downloadable from the model repo.
- Scripts: `scripts/moe-bench/remote/modal_flashnext.py`, `flashnext_calib.py`
