# Roadmap (draft, 2026-10-08)

A draft to keep direction, not a schedule. Each step is its own session, and the owner signs off before the next one starts. No long chained GPU runs.

## The goal

The most capable general coding-agent deployment on an 8 GB GPU. Benchmarks measure where it falls short; they are never the target.

## Standing rules

1. **Benchmarks are instruments.** A fix targets the general capability behind a deficit, never the benchmark.
2. **No training or tuning on a benchmark, its task families or its rubric.** Selection happens only on data never used for the final score.
3. **Prefer mechanisms with few or no fitted parameters.** A gain counts only once it shows on fresh, unseen measures.
4. **Judge models by general capability.** A model with a lower tier2b score can still be the better standard.
5. **Laya stays as shipped plus calibration, with no fine-tuning.** It is used where its as-shipped signal is strong and general, or in loops where it chooses a check and execution supplies the facts.

Why: keep96 was chosen on tier2b-style measures and excels there, but scored 0.03 on the Ecosystem Lab build. Laya v3's thresholds, fitted on 60 pool tasks, did not transfer to a fresh judge set (`2026-10-08-laya-v3-results.md`).

## Two paths to the goal

1. **One large model plus Laya, using the whole GPU** (the work so far). It ends by picking the most capable single model that fits.
2. **A swarm:** three role specialists derived from path 1's winner, coordinated by Laya. It probably has the higher ceiling, but it is a new architecture.

Path 1's answer is path 2's starting point.

## The roadmap (owner, 2026-10-08)

### 1. The best base

- **For now:** Qwen3.6-35B-A3B IQ3_XXS, the most capable local model on the Ecosystem Lab (0.42 vs keep96's 0.03).
- **Later:** the dense model roster also gets Ecosystem Lab runs.
- **Gate:** the headroom test. Speed and memory at 16k/40k/64k, with the Laya worker alongside, plus K2-Horizon's 2 builds with apps closed.
  - IQ3_XXS leaves 0.4–1.0 GB of RAM free, and the Laya worker grew to 5.5 GB private memory on 2026-10-08.
  - Test a lean Laya (int8 / ONNX, likely under 1 GB) in the same session. The owner ruled that it counts as "as shipped". It may decide whether IQ3_XXS and Laya fit together.

### 2. Role specialization with adapters

- **Redetermine the adapter training approach** so it targets specialization by role: plan, build, check/fix. The roles come from the architecture, never from benchmark families.
- **Redo distillation on the base,** with DeepSeek v4.1 Flash (OpenCode Go) as the teacher.
- **The aim is more general capability within each role, not bound by content.**
  - Each role's data is DeepSeek doing that role across broad, varied sources (languages, frameworks, project types).
  - Every benchmark family is excluded.
- **Each adapter is judged on its role and on keeping general capability.** The last distillation (Flash-Next into a LoRA on keep96) passed every gate and still scored below the model without it.
- **Training compute (the owner is looking into it).**
  - **On this machine:**
    - Teacher data from DeepSeek through the API, filtered by executing it.
    - Method work by QLoRA on a 4–8B dense proxy, on the 4060.
  - **Not on this machine:** training the 35B base. Even 4-bit weights are about 19–20 GB, against 8 GB VRAM and 16 GB RAM.
  - **Final role adapters:** small rented runs on one L40S or A100, an estimated $5–20 each. Train on the dequantized served IQ3_XXS weights (`distill/reverse_map.py` maps GGUF to transformers exactly), so each adapter matches the model it runs on, then check it served (`distill/served_lora_check.py`).
  - **Training-free options, fully on this machine:**
    - Role-specific imatrix quants (a reload per role switch).
    - Role demonstrations retrieved into the 64k–128k context.

### 3. The Laya relationship

- **Learn from v2/v3's failures.**
  - We limited Laya's answers with narrow option sets and single passes.
  - Its inputs were cluttered (probe output full of type names).
  - Thresholds were fitted to 60 tasks and overfit.
- **The goal:** low-latency, well-calibrated decisions at frontier quality.
  - Break each judgment into questions within a 421M encoder's reach.
  - Test every question for real signal on fresh data before building on it.
  - Let Laya take several turns: it picks a check, the harness executes it, Laya reads the new result. It stops when confident or at a cap, then hands one clear finding to Qwen.
- **Final step: train Qwen to use Laya, its System 1, organically.** Qwen learns when to ask Laya and how to use the answer.
  - This waits until the Laya interface is stable.
  - Training data is successful Qwen-plus-Laya runs on broad, benchmark-free tasks.

### The shared foundation, needed by steps 2 and 3

- **A broad test set:** bug fixes, at least 2 builds (the Ecosystem Lab and a held-out second), and long agent sessions. Every set is held out from tuning.
- **A staged, model-swappable harness:** plan, build, check and fix stages with Laya deciding between them.
  - In path 1 one model runs every stage. In path 2 each stage swaps in its role adapter, and the single-model staged harness is the baseline the swarm must beat.
  - Its per-stage measurements show which role is the real bottleneck.
- **Can start early:** step 3's training-free parts (lean Laya, question audits, the multi-turn loop) need no GPU training, so they can run while step 2's compute question is settled.

## Lessons carried forward

- From jev-swarm: it tuned stations that weren't the bottleneck, so measure the bottleneck before building for it.
- From Laya v3: test each Laya question for real signal first. A near-constant answer, like "type" for 82% of rows, can't help.
- From long context: 128k fits with GPU apps closed. The rollout (128k or 64k) waits for the owner's choice.

## Status (2026-10-09)

Step 1 ran overnight: results in `2026-10-09-step1-results.md`, the two-pick proposal in `2026-10-09-base-selection.md` (A: Qwen3.6-35B-A3B IQ3_XXS at 64k with a lean Laya; B: Qwen3.5-9B with Qwen3.5-4B as the second size). Step 2 starts after the owner confirms the picks.
