# One-shot build benchmark, round two: every MoE tested on tier2b, 2026-10-07

- **Owner's request:** run each MoE we tested and ruled out on tier2b through Ecosystem Lab 3 times. Include the full model and only the top slice per base. Models that did poorly on tier2b might do well here.
- **Round one** is in `2026-10-07-oneshot-results.md`: keep96 ×5 and DeepSeek v4.1 Flash ×5.
- **Benchmark:** `docs/benchmarks/oneshot/ecosystem-lab/`, 70 hidden checks over 10 areas, dev parameter set. **Runs:** `docs/benchmarks/oneshot/runs/`. **Gallery:** `docs/benchmarks/oneshot/gallery.md`.
- **Setup:**
  - llama-server 836d571, or the Xing4/K2-Horizon branch builds;
  - a 40k window, the q8_0 cache, batch 512;
  - temperature 0.2, top_p 0.95, seeds 1–3, up to 32,768 output tokens (owner's choice, so 3 builds differ);
  - each model's 2026-10-04 tuned placement and speculation;
  - thinking off, except gpt-oss at reasoning effort low, its best on tier2b;
  - the owner's apps open: 1.4 GB of the card in use at idle.
- **Runs:** 19:43–23:28. The machine restarted at about 19:50, and the chain resumed per build.

## Results

| Model (file) | Builds | Check score, mean (sd) | Per build (of 70) | Apps that run | tier2b (2026-10-04/06) |
|---|---|---|---|---|---|
| DeepSeek v4.1 Flash, API (ceiling, round one) | 5 | **1.000** (0) | 70, 70, 70, 70, 70 | 5/5 | — |
| **Qwen3.6-35B-A3B full, UD-IQ3_XXS** (14.1 GB) | 3 | **0.419** (0.30) | 33, **46**, 5 | 2/3 | not measured |
| Qwen3.6-35B-A3B full, UD-IQ2_M (11.9 GB) | 3 | 0.230 (0.17) | 11, 8, 30 | 1/3 | 94 |
| Tiel-Coder-35B-A3B IQ3_XXS | 3 | 0.110 (0.03) | 7, 10, 5 | 0/3 | 83 |
| Gemma 4 26B-A4B IQ2_M + MTP head | 3 | 0.087 (0.08) | 3, 2, 13 | 0/3 | 105 |
| gpt-oss-20b MXFP4, full | 3 | 0.053 (0.05) | 0, 5, 5 | 0/3 | **108** |
| gpt-oss-20b keep24 (top slice) | 3 | 0.053 (0.05) | 0, 5, 5 | 0/3 | 105 |
| Qwen3.6 keep96 (top slice; round one) | 5 | 0.031 (0.03) | 1, 4, 4, 0, 1 | 0/5 | 101 single / 107 recipe |
| LFM2.5-8B-A1B Q4_K_M (never on tier2b) | 3 | 0.014 (0) | 1, 1, 1 | 0/3 | — |
| Xing4.0-29B-A4B IQ3_XXS | 2 (owner stopped the third) | 0.000 | 0, 0 | 0/2 | 56 |
| K2-Horizon-MoVA-36B-A4B IQ3_XXS | 0 (stopped; see below) | — | — | — | 93 |

- **What "apps that run" means:** the app loads without a script error and runs its simulation. The strict and the exploratory assembled scores are identical for every round-two build.
- **The 0.08 floor.** A page whose markup is right but whose script never runs earns 5 checks, about 0.08: slider ranges, labels, tab order, focus ring, canvas width. That is gpt-oss's 5/70.

## What it shows

1. **tier2b doesn't predict this benchmark.**
   - gpt-oss-20b was the best local model on tier2b (108/117) and is near the floor here.
   - Gemma, at 105 on tier2b, is below Tiel at 83.
   - Full Qwen IQ2_M scored lowest of the three Qwen variants on tier2b (94), and is second here.
   - Small single-file fixes and holding a ~1,000-line build together are different skills.
2. **For Qwen3.6, every compression step roughly halves the score.** It's the same base and the same prompt:

   | Variant | Mean score |
   |---|---|
   | full IQ3_XXS | 0.42 |
   | full IQ2_M | 0.23 |
   | keep96 IQ2_M (pruned to 96 of 256 experts) | 0.03 |

   - Pruning costs the most. The experts dropped were chosen as unimportant on short Python code, and they apparently carry long-output coherence.
   - Two-bit quantization costs about half again.
3. **The best local build runs.** Qwen IQ3_XXS build 2 scored 46/70: simulation, canvas, chart, counters, controls and CSV all work.
   - Its world state differs from the spec's: 691 rabbits and 89 foxes at tick 200, where the spec gives 521 and 106. So it scores 0.25 on the exact algorithm checks.
   - The layout doesn't reflow at phone width, and presets barely work.
   - Its siblings scored 33/70 (it runs) and 5/70 (it crashes on load: a canvas lookup returns null, the same id/data-testid mix-up keep96 makes).
4. **The failure modes vary by model:**

   | Model | How it failed |
   |---|---|
   | **gpt-oss** at effort low | Gives up. Build 1 wrote only the plan; its whole reasoning was "Due to time, produce concise." Builds 2–3 are short (about 5k tokens) and have JS syntax errors. The setting that won on tier2b is wrong for a large build. |
   | **Xing4.0** | Both builds ran to the 32k cap and score 0. |
   | **LFM2.5-8B-A1B** | About 1B active parameters, 1/70 on every build. |
   | **Tiel and Gemma** | Complete-looking files of about 10k tokens that crash on load. |
   | **keep96** (round one) | Loops: repeated HTML/JS blocks and a 67 KB CSS loop. |

5. **The local ceiling here** is Qwen3.6 full IQ3_XXS, at about 37 tok/s with 26 expert layers on the CPU. At 2-bit, keep96 is 7× faster but 13× worse on this benchmark.

## Not run, or not finished

- **K2-Horizon.** It loaded (30 CPU expert layers, `-ot attn_v_exps=CPU`), but with the owner's apps open only 0.15 GB of RAM was free. Its CPU experts thrashed between RAM, E: and the pagefile, and it read the prompt at 3.2 tok/s (16.8 tok/s from C: on 10-04). The owner stopped it at 23:27. It reruns after the Laya v3 run, ideally with heavy apps closed.
- **Xing4.0's third build:** stopped by the owner after two builds, both at the 32k cap.
- **Flash-Next Coder (ISTA)** doesn't fit in 16 GB of RAM. It was only ever tested on Modal.
- **Other Qwen slices** (keep192, swap108, add108) were left out by the owner's rule: only the top slice per base, and that is keep96.
- **Sealed set and blind judging.** Round two used dev checks only. The sealed set stays closed until a verdict needs it, and no blind judging was done for round two. Screenshots of every build are in the gallery.

## Deviations

1. **The fit step** raises a model's CPU expert layers when VRAM use goes over 7,938 MiB (the cap includes the desktop). No model needed it: every one loaded at its 10-04 placement within the cap.
2. **Window and budget:** a 40k window with 32,768 output tokens, against keep96's 64k in round one. No model's prompt and output exceeded 40k.
3. **Thinking off,** except gpt-oss at reasoning effort low, as tuned. gpt-oss at higher effort is untested and is the obvious next run for it.
4. **The gpt-oss keep24 slice was rebuilt** from the newly downloaded full file with its original imatrix. It is identical to the 2026-10-04 slice: the expert lists match exactly (`keep24-report.json`).
5. **Xing4.0** needed `xing4_0.nextn_predict_layers` changed from 1 to 0, as on 10-04.

## Files

`docs/benchmarks/oneshot/runs/<model>/<seed>/`, for the models `qwen36full`, `qwen36full-iq3xxs`, `gemma26b`, `tiel`, `gptoss20b`, `gptoss20b-keep24`, `lfm25-8b-a1b` and `xing4`. Each holds `response.md`, `plan.md`, `app.html`, `app-assembled.html`, `meta.json` (with the fit record), `static.json`, `checks-dev.json`, `checks-dev-assembled.json` and `shots/`, plus `reasoning.md` for gpt-oss. Also in `docs/benchmarks/oneshot/`: `round2.log`, `keep24-report.json` and `gallery.md`.

## Next (owner, 2026-10-07 23:35)

**Owner's view:** Qwen3.6 full IQ3_XXS is the most capable local model. It should become the standard for local testing **if it leaves enough headroom**, so a headroom test comes first. keep96 stays the default for fast loops (Laya, tier2b) and Jarvis until then.

**Measured tonight:**
- 35–38 tok/s generation;
- prompt reading about 445 tok/s warm, and about 32 tok/s on the first prompt while its experts page in from E:;
- 7,596 MiB of VRAM in use at a 40k window with the desktop's 1.4 GB, about 0.6 GB spare;
- **0.4–1.0 GB of RAM free while serving**, below the Laya worker's 2 GB guard.

**The headroom test,** after the Laya v3 run (about 1.5 GPU hours), with the owner's usual apps open:
1. **tier2b recipe** on IQ3_XXS (3 candidates + 1 suite, the 2026-10-06 seeds) against keep96's 107/117.
2. **Speed and memory** at 16k, 40k and 64k windows, each with the fitted placement:
   - generation and prompt speed (warm and cold);
   - VRAM margin;
   - RAM free.
3. **The Laya worker loaded alongside it:** does RAM stay at or above the 1,024 MB fallback guard?
4. **K2-Horizon's two one-shot builds,** with heavy apps closed.

**The real fixes, if headroom fails:**
- **More RAM:** a second 16 GB stick.
- **A lighter-pruned 3-bit slice** (for example keep192 from IQ3_XXS). This belongs to the expert-patching work sequenced after Laya.
