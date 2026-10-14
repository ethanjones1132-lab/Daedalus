# Base selection proposal: two picks (2026-10-09)

Written at the end of Step 1 (`2026-10-09-step1-results.md`). The owner asked for two picks: **(A)** the most generally capable model overall, and **(B)** the most capable model trainable on this machine. **Nothing in Step 2 has started.** This needs the owner's confirmation.

## Pick A: Qwen3.6-35B-A3B UD-IQ3_XXS, 64k window, lean Laya

| Evidence | Result |
|---|---|
| Main instrument: Ecosystem Lab (70 checks, 3 builds) | **0.419** (33, 46 and 5 of 70; 2 of 3 apps run). No other local model comes close: the 12 dense models in Step 1 average 0.000 to 0.109 and none of their 36 builds passed more than 17 checks; round two's runner-up on this machine, the same model at IQ2_M, got 0.230; keep96 0.031; K2-Horizon cannot run. |
| Headroom (16 GB RAM, 8 GB VRAM) | Fits at `--n-cpu-moe 26` up to 64k with Laya alongside (lean or fp32): fresh-code generation about 33 tok/s, edits 47 to 67, a 58k-token prompt read in 6 minutes, follow-up turns re-read about 28 tokens. **96k collapses** and 128k was not run: RAM is the wall, not VRAM. |
| Laya beside it | The lean worker (weight-only int8, passes acceptance: AUC deltas under 0.006, routing identical on 57 of 60 pool tasks) answered 20 of 20 calls at p95 about 1.3 s at 64k, at 0.5 GB working set. Generation slows while it answers (about 19 to 34 tok/s). |
| Not measured | tier2b on IQ3_XXS (the old plan had it; this handoff did not). A second, held-out build, and the broad test set (bug fixes, two builds, long agent sessions) are the next roadmap step, so this pick rests on one main instrument with a wide spread (sd 0.30). |

**Costs and caveats:** 0.3 to 1.0 GB of RAM free while serving; the 40k window's first read is slow (53 tok/s) until the experts are paged in from E:. **The cheapest fix for every limit above is more RAM** (a second 16 GB stick): it is the first thing to try for 96k and 128k, and a precondition for any model bigger than this one.

**Window to roll out:** 64k (the owner expected to land there). The long-context rollout (`-c 65536`, batch 512, `context_window` in both Jarvis config stores) still waits on the owner's go-ahead.

## Pick B: Qwen3.5-9B, with Qwen3.5-4B as the second size

| Evidence | Result |
|---|---|
| Best dense model measured | **Qwen3.5-9B 0.109** (17, 3 and 2 of 70; the only dense build that ran its simulation). Others: Gemma 4 12B 0.089, Nanbeige 3B 0.081, Ornith 9B 0.057, Qwen3.8-9B 0.056, Nemotron Nano 9B 0.048, Qwythos 9B 0.048, Gemma 4 12B coding 0.045, Llama 3.1 8B 0.025, Qwen3.8-27B IQ2_XXS 0.021, DeepSeek-V4-Pro-9B 0.018, Qwen3.5-9B Coder 0.000. Differences among these are inside the noise (n = 3), so the pick rests on the next three points more than on the ranking. |
| No fine-tune beat the base | The Qwen3.8-9B distill (named `Qwen/Qwen3.5-9B` as its base on Hugging Face), Qwythos, DeepSeek-V4-Pro-9B and the Coder variant, all `qwen35` models, scored equal or lower. Step 2's adapters have to be judged against this: they must beat the base on the roles without losing general capability. |
| Same family as pick A | Qwen3.5 comes in 0.8B, 2B, 4B, 9B and 27B dense and a 35B-A3B MoE (`qwen3_5` / `qwen3_5_moe`, gated-deltanet hybrid), all Apache-2.0, with base variants of 0.8B to 9B and the 35B-A3B. Qwen3.6-35B-A3B (pick A) is that MoE line's successor: its GGUF architecture is `qwen35moe`, with the same gated-deltanet settings as the dense `qwen35` GGUFs (conv kernel 4, state size 128, group count 16). A recipe proven on 9B and 4B is the one most likely to carry over to the final role adapters on A, and the sizes give the owner's "does it scale with capability" ladder on one architecture. |
| Fit on the RTX 4060 | **Not measured.** 4-bit weights plus LoRA at sequence length 2 to 4k with gradient checkpointing should fit 8 GB for 9B (tight) and comfortably for 4B. Step 2's first task is a memory smoke test on each. |

**Downloads this pick needs** (pre-authorized by the owner's message; I will start them only after the picks are confirmed): `Qwen/Qwen3.5-9B` (about 19 GB bf16), `Qwen/Qwen3.5-4B` (about 9 GB), optionally `Qwen/Qwen3.5-2B` (about 4.5 GB) for a quick method check, all to E: (150 GB free). The base variants (`-Base`) exist for 0.8B to 9B; whether to train on the instruct or the base weights is a Step 2 design question. A training environment is also needed (the benchmark venv has no torch): either a new venv on E: with torch (CUDA), transformers, peft, bitsandbytes and trl, or Unsloth Studio (installed at `E:\Unsloth`, not yet checked for this architecture). The 18 GB `Qwen3.8-9B-Distill` weights already on disk are a distill of Qwen3.5-9B; keep them as a comparison, not the base.

**Alternatives considered:**

- **Nanbeige 3B (0.081)** is the strongest result per parameter and trains cheaply, but its architecture is unrelated to pick A, so a recipe proven on it says less about A.
- **Gemma 4 12B (0.089)** needs a tight QLoRA fit and ran at 12 tok/s here.
- **Llama 3.1 8B (0.025)** is the weakest and also has no family tie to A.
- **Qwen3.5-27B** would need roughly 17 GB or more for QLoRA: it does not train on this machine (estimate).

**Risks:** dense models are near the floor on builds, so Step 2's gain will be read against its own base and on role metrics, not on Ecosystem Lab scores (which would also break the standing rule against tuning on that benchmark). Qwen3.5's gated-deltanet layers may train slowly on Windows without the fast kernels; the smoke test will show it.

## What I need from the owner

1. **Confirm pick A** (Qwen3.6-35B-A3B IQ3_XXS at 64k with the lean Laya), or choose the IQ2_M slice if more RAM headroom matters more than capability (its headroom was not measured).
2. **Confirm pick B** (Qwen3.5-9B, second size Qwen3.5-4B, optional 2B), and say whether to start the downloads and set up the training environment on E:.
3. **Adjust the headroom pass rule?** I suggest dropping the "2 GB RAM free" clause (see Step 1 results, "Reading").
4. **Order of the next steps:** the roadmap's broad test set (tier2b on IQ3_XXS, a second held-out build) can run before or alongside Step 2; I would run it first only if you want pick A confirmed on more than one instrument.

## Step 2, once confirmed

Per the handoff, section 9: DeepSeek v4.1 Flash is the only teacher (never Grok). `teacher_gen.py seeds` is API-only and can start immediately (seeds from broad fields, benchmark topics excluded, wording check against every scored set); `gen` executes generated code and waits until the GPU measurements are over. Before any training: a spec and a plan through the brainstorming skill, with the owner's sign-off, covering roles (plan, build, check/fix), the SFT formats from verified samples only, QLoRA on pick B and on the second size, and an evaluation that includes retention on held-out measures and at least two builds, one never used for tuning. No pip package or model download beyond the list above.
