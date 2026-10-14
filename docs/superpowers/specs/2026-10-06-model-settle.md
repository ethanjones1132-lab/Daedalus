# 2026-10-06 evening: is swap108 the better local model? No; keep96 stays

- **Question (owner, 18:57):** after adapters phase 1 (swap108 beat keep96 on the sealed judge set), is swap108 still optimal in both speed and performance? Make it the settled config first, then run Laya's GPU sessions on it.
- **Runs:** 19:01–20:07. The Versutus gate was paused. A 4 GB VM outside this project held RAM all evening (2–6 GB available with no model loaded).
- **Scripts:** `scripts/moe-bench/speed_pair.py`, `pair_bestofn.py`, `settle-runs/run_settle.sh`, `settle-runs/run_add108.sh`. **Data:** `docs/benchmarks/2026-10-06/` (local paths scrubbed).

## Outcome: keep96 stays the settled model

Both expert patches lose to keep96 on tier2b with the recipe. The harness and seeds are phase 1's, and every row is paired per (task, trial).

| tier2b, 117 samples | keep96 | add108 | swap108 |
|---|---|---|---|
| Single shot | **100** | 99 (6 vs 7, p = 1.0) | 95 (6 vs 11, p = 0.33) |
| Recipe (3 candidates + 1 self-test suite) | **107** | 102 (0 vs 5, p = 0.062) | 101 (0 vs 6, p = 0.031) |
| Recipe by category, A / B / C / D / E | 36 / 11 / 21 / 21 / 18 | 36 / 9 / 20 / 21 / 16 | 35 / 9 / 20 / 20 / 17 |
| Self-tests failed by correct code | 13.1% | 8.8% | 4.7% |
| Sum of task-trial seconds | 13.2 min | 11.5 min | 10.9 min |

p is the exact two-sided McNemar test; "6 vs 7" counts samples only that model solved. keep96 reproduced its earlier tier2b scores with these seeds (single 98–101, recipe 107 for this draw).

**Everything measured on the three:**

| | keep96 | add108 | swap108 |
|---|---|---|---|
| Sealed judge set, recipe / single (of 180) | 153 / 143 | not run | **164 / 163** |
| Calibration pool, recipe / single (of 180; in-sample for both patches) | 147 / 144 | 153 / 148 | 155 / 151 |
| KL to the full model on held-out text | 0.360 | **0.353** | 0.391 |
| keep96's experts dropped | — | 0 | 360 (8.8 per layer) |
| File | 5.52 GB | 6.00 GB | 6.00 GB |

**Reading it:**
- **The patches' gain belongs to one task family.**
  - The judge set and the calibration pool were written together, and the failure-targeted imatrix came from the full model's answers on the pool.
  - The pool deliberately avoided tier2b's functions and conventions.
  - On tier2b, written separately, both patches lose the same tasks with the recipe: `pkg_inventory`, `slugify_with_lib`, `retry_with_backoff`. swap108 also loses `read_text_lines` and `roman_to_int`.
- **Dropping nothing is not enough.** add108 keeps all of keep96's experts, yet still loses 5 recipe samples. Twelve more experts per layer change what the router picks.
- **The rule was fixed before add108 ran:** `docs/benchmarks/adapters/swap108-manifest.json`. add108 needed neither its recipe nor its single shot significantly worse than keep96's on tier2b; its recipe was (p = 0.062).
- **Phase 1's result still stands as measured.** On judge-set-style tasks, especially hidden conventions (B 24 vs 16), swap108 is better. It is not a general upgrade.

## Speed and VRAM (`speed_pair.py`)

**Config:** final report §7's Qwen winner: all layers on the GPU, MTP depth 2 + n-gram lookup, ctx 16,384, q8_0 KV, ub 512. Two rounds alternate the models. Generation is greedy, so each model's repeat matches itself within 1–3%.

| Prompt (tokens in → out) | keep96 tok/s | swap108 tok/s |
|---|---|---|
| gen (73 → 400) | 160.9 / 159.9 | 125.9 / 127.6 |
| edit2k (3,321 → 500) | 364.4 / 356.2 | 599.5 / 598.2 |
| long10k (8,801 → 300) | 383.5 / 379.8 | 203.3 / 204.1 |
| long15k (12,789 → 200) | 445.1 / 450.6 | 204.5 / 205.9 |
| Mean of the speed lab's three prompts | 302.9 / 298.6 | 309.5 / 310.0 |
| Draft acceptance | 0.857 | 0.73 |
| Prefill, 2k–13k prompts | 2,062–2,080 | 2,001–2,017 (−3%) |
| VRAM above idle, loaded / peak (MiB) | 5,651 / 5,707 | 6,105 / 6,163 |

- **Compute per token is the same.** llama-bench decode, no speculation: swap108 81.8 vs keep96 78.4 tok/s. Prefill is 3% slower with 108 experts.
- **Speculative speed follows the answer's content.** On long10k keep96 copies class names from the prompt (99% of drafts accepted), while swap108 writes its own descriptions (64%).
- **VRAM:** swap108 needs 454 MiB more and leaves about 1.8 GB free with the gate paused. The 12.8k-token prompt ran clean.
  - Phase 1's one out-of-memory error came from a steering run (a control vector on layers 10–29), not from this config.
- **RAM:** the server's working set is 2.5–3.9 GB, mostly the memory-mapped model file, whose clean pages Windows can drop. Loading with `--load-mode none` may free enough for Laya's live runs (2 GB guard); untested.

## Incidents (both fixed)

1. **A chain trigger fired early.**
   - Laya session 1 waited for a settle-log line ending in " done", and "speed_pair already done" matched at 19:10:31.
   - Two swap108 servers then shared port 8093 for about 4 minutes. RAM fell to 0.1 GB and task-trials took 53–73 s instead of 5–9.
   - No storage, NTFS or WHEA events followed.
   - Both partial runs were moved to `logs/void-2026-10-06/` and rerun.
   - **Fix:** chains now wait on marker files, and every model run first waits until no llama-server is running.
2. **A RAM check always failed.** A Git Bash path inside a Python string never resolves on Windows Python. Caught before any step was skipped; fixed with `cygpath -w`.

## State after this

- **Defaults:** keep96 everywhere (`bestofn_tier2b`, `probe_tier2b`, `repair_tier2b`, `playbook_tier2b`, `serve-qwen36-35b.ps1`). `qwen36swap108` and `qwen36add108` are configs and serve variants.
- **On C: (97 GB free):** add108's file. swap108's file was removed by the owner's choice to keep C: above 10% free. The rebuild command and checksum are in `swap108-manifest.json`, and a copy is on the Modal volume `distill`.
- **Laya:** `playbook_tier2b.py` gained `--model`, and each row records its GGUF. Laya's plan stays on keep96 (deviation 9). GPU session 1 started on keep96 at 20:09; 23 earlier swap108 rows are set aside.
- **Not done:** a judge-set look at add108. It would be its own pre-registered comparison, and tier2b already rules add108 out as the default.

## Recounted per task (added 21:15)

Each task's 3 trials are correlated, so the honest unit is the task. An exact sign test counts the tasks where each model solved more trials:

| Comparison | Per sample | Per task |
|---|---|---|
| Judge, swap108 vs keep96, recipe | 16 vs 5, p = 0.027 | 8 vs 3, p = 0.23 |
| Judge, swap108 vs keep96, single shot | 23 vs 3 | **12 vs 1, p = 0.003** (all five categories) |
| tier2b, swap108 vs keep96, recipe | 0 vs 6, p = 0.031 | 0 vs 5, p = 0.06 |
| tier2b, add108 vs keep96, recipe | 0 vs 5, p = 0.062 | 0 vs 3, p = 0.25 |
| Calibration pool, every patch and LoRA | p 0.12–1.0 | p 0.69–1.0 |

- **Only one effect is solid at the task level:** swap108's single-shot gain on the same-writer judge set.
- **keep96's recipe misses are mostly hidden-convention tasks:** 10 of 10 on tier2b, 26 of 33 on the pool, 20 of 27 on the judge set.

## Next (owner, 21:30)

1. Configure and conclude the symbiotic Laya architecture first.
2. Then rebuild and re-test training, distillation and expert patching with a new approach. It will use DeepSeek v4.1 Flash on OpenCode Go as the only teacher (no more extensive Modal runs), designed around what failed here and a review of published methods that worked.
