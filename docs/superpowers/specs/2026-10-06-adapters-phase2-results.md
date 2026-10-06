# Adapters phase 2: results so far

- **Run:** 2026-10-06, 01:33–02:46, after phase 1 concluded (owner: "start phase 2 if phase 1 concludes").
- **Plan:** `plans/2026-10-06-adapters-phase2.md`. **Data:** `docs/benchmarks/adapters/phase2/`.

## Outcome, 16:21: no phase-2 patch. The LoRA does not beat its student on the pool

- **Every gate passes:** 2.4 under the owner's recalibrated bar, and 2.5 / 2.6 with the served LoRA reproducing its 20 overfit targets.
- **The rule (Task 6) stopped it:** the patched recipe must beat the student's own pool recipe, and it did not. There is no phase-2 pre-registration and no phase-2 judge run.
- **The student changed mid-phase:** phase 1's swap108 met its judge bar at 15:56, so swap108 replaced keep96.

| Student | LoRA | Pool recipe (of 180) | Single shot | Recipe by category A / B / C / D / E |
|---|---|---|---|---|
| keep96 | none | 147 | 144 | 36 / 10 / 34 / 31 / 36 |
| keep96 | v1, rank 16 | 146 | 145 | 36 / **17** / 33 / 28 / 32 |
| swap108 | none | **155** | 151 | 34 / 23 / 32 / 30 / 36 |
| swap108 | v2, rank 8 | 151 | 153 | 36 / 20 / 33 / 26 / 36 |

- **Hidden conventions (B).** Distillation from Flash-Next gave keep96 +7 there, the teacher's strongest category. swap108's experts already capture that gain (10 → 23), and on top of swap108 the LoRA costs 3.
- **File I/O (D) fell both times** (−3, −4). Next suspect: the teacher's file-I/O answers. For example, v1 counted lines as `count("\n") + 1`, which is wrong for files that end in a newline.
- **Library use (E):** v1 lost 4 there. The cause was the generated tasks' shape:
  - their buggy files already imported from `lib.<module>`, so v1 learned to keep the import path;
  - `train_tasks/rewrite_e.py` fixed it for v2 (36 → 36).
- **Rank:** v2 on swap108 is rank 8, as the spec sets for a 108-expert student, which keeps the total within +0.5 GB.

### Spend (container-time estimates; Modal's dashboard is authoritative)

| Step | About |
|---|---|
| Teacher test | $2.55 |
| Gates: parity ×2, noise floor ×2, names, overfit | $2.40 |
| Task writer, two runs (1,800 candidates → 896 tasks) | $5.30 |
| Teacher data: 896 answers + 300 regularizer continuations; E redo | $2.70 |
| Training: v1, v2 on keep96, v2 on swap108 | $6.60 |
| Rebuilding the keep24 slice on the volume (space on C:) | $0.07 |
| **Total** | **about $19.6 of $30** |

The volume `distill` holds:
- the stash, as moved off C: (restore commands in `moved-off-c.json`);
- both students;
- the teacher data and the LoRAs.

Storage there may count against the monthly credit.

### Next, if phase 2 is revisited

- Audit the teacher's file-I/O answers, or train without family D.
- Grow the hidden-convention family. It is where the teacher leads, but swap108 has already taken most of that gap.
- A per-task LoRA chosen by Laya's classification (spec 4.5's optional arm) would not help on swap108 by these pool numbers.

## Update, 08:45: the owner recalibrated gate 2.4

- **New bar:** top-1 agreement at least llama.cpp's own CPU-vs-CUDA agreement, and perplexity within 1%.
- **Result:** gate 2.4 passes (97.26% float32, 96.92% bf16, against 95.89%; perplexity 1.912 / 1.905 against 1.917).
- **Next:** phase 2 continues with gates 2.5 and 2.6.
- **Also:** C: is being freed for phase 1's expert arm, which runs first because its winner is the phase-2 student.

## Status at 02:46: stopped at gate 2.4, pending the owner

- **Teacher test:** done; Flash-Next Coder qualifies.
- **Gates:** three of four checks pass. Load parity misses its 99% bar.
- **Why it stopped:** spec §6 stops phase 2 when a gate fails, before training spend.
- **Diagnosis:** the bar sits above the numerical noise floor. llama.cpp's own CPU backend agrees with its CUDA backend less often than transformers does.
- **Recommendation:** at the end.

## Task 1: teacher test (§4.1)

Single shot on the 60-task calibration pool (180 samples). The bar is keep96's recipe (147) plus 8, so 155.

| Teacher | Solved | A / B / C / D / E (of 36) | Qualifies |
|---|---|---|---|
| **Flash-Next Coder, thinking off** | **163** | 36 / 25 / 36 / 36 / 30 | **yes** |
| Flash-Next Coder, 2,048-token budget | 106 | 29 / 15 / 36 / 21 / 5 | no: answers cut off at the budget |
| Full Qwen3.6, thinking off | 50/60 on trial 0, about 150 | | no. The other 120 samples were not run: tonight's full-model run put available RAM at 0.3 GB, against §6's RAM rule |
| keep96 probe-then-fix (self-distillation) | 152, against its single shot 144 (+8) | | yes, as the fallback |

- **Decision:** the teacher is Flash-Next Coder with thinking off.
- **Hidden-package tasks (B):** Flash-Next solves 25/36, against 16/36 for keep96's probe-then-fix. That is where distillation has the most to give.
- **Cost:** one L40S job, 54 minutes, about $2.55.

## Task 2: gates (§4.4)

| Gate | Result |
|---|---|
| 2.1 Student on Modal | The served keep96 was uploaded (5,522,700,576 bytes, matching the local file). It could not be rebuilt from Hugging Face: the local Qwen3.6 UD-IQ2_M is not any revision of unsloth's file, about 360 MB larger, most likely with the MTP layer merged in. |
| 2.2 Names | **Pass.** transformers 5.18.0 builds `Qwen3_5MoeForCausalLM` with 693 parameters. `distill/reverse_map.py` produces exactly those names and shapes: none missing, none extra. |
| 2.3 Round trip | **Pass.** All 733 tensors go through llama.cpp's own forward converter. 717 come back bitwise equal; the other 16 are all `ssm_a` (exp/log), at most 6.8e-8 relative. |
| 2.4 Load parity | **Below its bar (99%).** Top-1 agreement with llama.cpp CUDA on 2,046 held-out positions: 97.26% in float32, 96.92% in bf16. Details below. |
| 2.5 Toolchain, 2.6 Overfit | **Not run** (the stop rule). Ready: `modal_distill.py::gate_overfit`, then `distill/served_lora_check.py`. |

### Why 2.4's bar is the problem, not the mapping

| Pair, same tokens and positions | Top-1 agreement | Perplexity |
|---|---|---|
| llama.cpp CUDA vs llama.cpp CPU (the GPU hidden) | **95.89%** (84 disagreements) | 1.917 vs 1.915 |
| transformers float32 vs llama.cpp CUDA | **97.26%** (56) | 1.912 vs 1.917 |
| transformers bf16 vs llama.cpp CUDA | 96.92% (63) | 1.905 vs 1.917 |

- **Two correct implementations already disagree.** llama.cpp's CPU and CUDA backends compute the same quantized model and agree on only 95.9%. The 99% bar cannot be met by any correct implementation, and transformers on the reverse-mapped weights beats that floor.
- **The disagreements are near-ties.**
  - Where llama.cpp's own top-1 margin is at least 0.5 nats, float32 agreement is 99.47%.
  - The median gap at a disagreement is 0.21 nats, by llama.cpp's own log-probs.
  - The largest gap (2.57 nats) is at the same position for the CPU pair and for transformers: CUDA is the odd one out there.
- **A mapping error would show.** It would move perplexity, for example a wrong V-head order in the DeltaNet layers. Perplexity matches within 0.3%, and the round trip is exact.

## Spend (estimates from container seconds; Modal's dashboard is authoritative)

| Step | About |
|---|---|
| Teacher test (L40S) | $2.55 |
| Parity, bf16 | $0.45 |
| Parity, float32 + bf16 | $0.48 |
| Noise floor, twice (the first `-ngl 0` pass still ran on the GPU through op offload) | $0.29 |
| Names check, CPU, and image builds | under $0.10 |
| **Total** | **about $3.9 of $30** |

## Recommendation (the owner's decision)

1. **Recalibrate gate 2.4.** Pass it when transformers agrees with llama.cpp CUDA at least as often as llama.cpp's own CPU backend does (95.9% here), and perplexity is within 1%. It passes on both counts, in float32 and bf16.
2. **Then run gates 2.5 and 2.6.** Overfit plus the LoRA conversion: one A100 run, about $0.60. Then the local served check with `--lora`.
3. **Then Task 3,** the training-task generators: local, no spend.

The student is plain keep96, because phase 1's patch is null. If the expert arm later wins, training reruns on the new student (about $5).
