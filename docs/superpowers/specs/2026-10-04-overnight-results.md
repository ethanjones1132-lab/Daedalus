# Overnight results, 2026-10-03/04

**Machine:** RTX 4060 8 GB, 16 GB RAM, Windows 11.

**Method, for every number below:**
- the tier2b suite: 39 tasks × 3 samples, temperature 0.2, scored by running the tests;
- thinking off unless noted;
- the best expert placement found inside the project's 7,168 MiB VRAM cap;
- llama.cpp built from source with CUDA 13.4: master `836d571` for most models, and branch builds for Xing4.0 (PR #29012) and K2-Horizon (PR #29535).

Scripts, logs and raw results: `C:\qwen3-forge-stage\{scripts,logs}`.

---

## 1. Headlines

1. **gpt-oss-20b is the best model on tier2b: 109/117**, in 22.6 minutes. It can't fully switch reasoning off, so it ran at its lowest reasoning effort. That's not strictly comparable with the thinking-off runs, but it beats every thinking run too (Gemma 104, Qwen3.6 102).
2. **Expert pruning works on our tasks, and it unlocks all-GPU speed.**
   - Qwen3.6-35B-A3B keeping 96 of 256 experts (chosen by usage on Python code) scores **99/117 vs 94 for the full model**.
   - It runs **entirely on the GPU at 132 tok/s, vs 58**, from a 5.5 GB file instead of 11.9 GB.
   - Even 64 experts, the 25% ratio Flash-Next needs, scores 92: within noise.
3. **Gemma 4 QAT (4-bit) ≈ Gemma 2-bit:** 102 vs 101 with thinking off, at a similar ~40 tok/s.
4. **Xing4.0 (56/117) and Tiel-Coder (83/117) underperform here** despite strong published numbers. See section 3 for what we know and don't.
5. **The D: drive is failing.** Section 2.

## 2. Urgent: D: (Seagate USB drive) is failing

- At 8:25 PM Windows logged **bad blocks and hardware I/O errors**. After the 2:04 AM restart and a reconnect, it logged them again at the same sectors (LBA 0x600800 and 0x600810).
- **The volume no longer mounts:** size 0, status Unknown.
- **What lived there:**
  - `D:\qwen3-forge`: the repo, its Python environment, the old llama.cpp builds, the archived models, all logs before tonight;
  - the jev-swarm checkout and worktrees;
  - your SteamLibrary.
- **Advice:**
  - Keep it unplugged until you're ready to recover from it.
  - Don't run `chkdsk /f` on it.
  - If anything on it isn't pushed or backed up, image it first with `ddrescue` (through WSL) onto a healthy drive, then recover from the image.
  - Models and games can be re-downloaded.
- **Everything tonight ran on C: instead:**
  - a new Python environment: `C:\qwen3-forge-stage\venv`;
  - fresh llama.cpp builds: `C:\qwen3-forge-stage\tools`;
  - CUDA 13.4 unpacked from NVIDIA's zips: `C:\cuda\13.4.2`;
  - scripts recreated: `C:\qwen3-forge-stage\scripts`.
- **Still safe on C:** your proven Gemma 2-bit and Qwen3.6 IQ2_M files, in `C:\qwen3-forge-stage`.

## 3. Model results

**Tonight (all on the same harness):**

| Model | File | CPU expert layers / draft head | Speed (tok/s) | VRAM (MiB) | tier2b | Median answer tokens |
|---|---|---|---|---|---|---|
| **gpt-oss-20b MXFP4 + EAGLE3 draft** (reasoning: low) | 13.0 GB | 15 / draft 3 | 22.5 | 6,584 | **109/117** | 242 |
| Gemma 4 26B-A4B QAT Q4_K_XL + MTP | 14.5 GB | 22 / MTP 2 | 41.0 | 5,869 | 102/117 | 74 |
| Tiel-Coder-35B-A3B IQ3_XXS (MTP) | 13.6 GB | 24 / MTP 2 | 49.7 | 7,121 | 83/117 | 59 |
| Xing4.0-29B-A4B IQ3_XXS (metadata-fixed) | 11.6 GB | 22 / none | 32.4 | 6,446 | 56/117 | 69 |
| K2-Horizon-MoVA-36B-A4B IQ3_XXS (attention experts on CPU) | 14.6 GB | 30 / none | 16.8 | 7,017 | 93/117 | 47 |

**From 2026-10-03, same tier2b runner, older build b10809:**

| Model | Thinking off | Thinking budget 1,536 |
|---|---|---|
| Gemma 26B-A4B IQ2_M | 101 | 104 |
| Qwen3.6-35B-A3B IQ2_M | 90 (94 on tonight's build) | 102 |
| Qwen3.6-35B-A3B IQ3_XXS | 100 | — |

**Notes**
- **gpt-oss** is the only model whose answers are long (median 242 tokens). That's partly its reasoning text and partly complete files. Its EAGLE3 draft worked out of the box.
- **Xing4.0:**
  - the published non-MTP file fails to load ("wrong number of tensors; expected 953, got 947") because its metadata still declares an MTP layer. Setting `xing4_0.nextn_predict_layers` to 0 fixes it.
  - 16 of its 61 failures are NameError/AttributeError, which fits incomplete files or wrong API use.
  - Its card's numbers use thinking mode and agent harnesses; a thinking-on run is the fair next test.
- **Tiel** is a fine-tune of Qwen3.6-35B-A3B but scores below stock Qwen3.6 (83 vs 94–100). Most failures are wrong logic. Answer length is **not** the explanation: stock Qwen's median is 58 tokens too.
- **K2-Horizon:** needed `-ot attn_v_exps=CPU` (see section 5). It gives the shortest answers of all (median 47 tokens) yet scores 93, more evidence that answer length isn't what separates these models.
- **Raw answers:** the runner keeps them as of the K2-Horizon run. Earlier runs have only pass/fail and error type.

## 4. Pruning pilot: Qwen3.6-35B-A3B IQ2_M

**Method.**
1. `llama-imatrix` measured each expert's activation energy on about 800 KB of Python standard-library source. It took 4 minutes, and none of that text is from tier2b.
2. `slice_experts.py` kept the top N experts per layer and sliced the router to match. It also handles the built-in MTP draft layer, which the measuring pass doesn't exercise (its experts are ranked by router weight instead).
3. Each slice went through a placement probe plus a full tier2b run on the same build as the baseline.

| Experts kept | File | Activation energy kept | CPU expert layers | Speed (tok/s) | VRAM (MiB) | tier2b |
|---|---|---|---|---|---|---|
| 256 (full) | 11.9 GB | 100% | 22 | 57.9 | 6,777 | 94/117 |
| 192 | 9.3 GB | 98.2% | 16 | 69.0 | 6,631 | **99/117** |
| 128 | 6.8 GB | 93.7% | 4 | 104.3 | 6,458 | 95/117 (scored at 16 CPU layers) |
| **96** | **5.5 GB** | 89.4% | **0 (all on GPU)** | **132.2** | 5,696 | **99/117** |
| 64 (= Flash-Next's 512→128 ratio) | 4.3 GB | 82.2% | 0 (all on GPU) | 136.6 | 4,480 | 92/117 |

All rows use MTP draft depth 2 and the same build, prompts and sampling. Speed is the mean over three prompts (short generation, 2k-token edit, 10k-token context).

**Reading it.**
- **Noise:** about ±4. The same full model scored 90 on build b10809 and 94 on master, and each run is only 117 samples.
- **On tier2b, removing up to 75% of the experts shows no measurable loss.** 92–99 vs 94 for the full model.
- **Below ~6 GB the model fits entirely on the GPU** and runs **2.3× faster** (132–137 vs 58 tok/s).
- **Practical pick: the 96-expert slice.** 5.5 GB, 132 tok/s, 99/117, with 1.5 GB of VRAM to spare for longer context.
- **The cliff isn't visible yet at 25% kept,** though activation energy kept is starting to drop faster (89% → 82%). A 48- or 32-expert slice would find where it falls.

**What this means for the Flash-Next plan.**
- Pruning Flash-Next 512 → 128 experts is the same 25% ratio. On this model and suite it costs nothing measurable.
- The cheap tool chain needs no gradients and no cloud: an imatrix pass on code (4 minutes), `slice_experts.py` (2 minutes), then tier2b.
- So track A of `2026-10-03-fit-flash-next-plan.md` is worth running as soon as disk space allows.

**Caution.**
- tier2b is small single-file fixes. Pruning by code usage presumably removes general knowledge; that wasn't measured.
- Long agentic tasks tolerate capacity loss less well. ISTA's own 50% Flash-Next prune kept 98.7% on LiveCodeBench but only 91.3% on SWE-bench Verified.
- The next check is a longer, multi-step benchmark: the patch tasks, or SWE-style tasks.

## 5. Fixes and findings from tonight

- **llama-server's 8 GB host prompt cache starves a 16 GB machine.** It grew one server to 13.7 GB private memory, and a server crashed mid-run at ~0.5 GB free. All scripts now pass `--cache-ram 0`; with it, the same server sat at 6.6 GB.
- **Windows sysmem fallback.** When VRAM is nearly full, the NVIDIA driver spills into system RAM instead of failing. Xing4.0 at 18 CPU expert layers ran 2.6× slower than at 22 (12.2 vs 32.4 tok/s). The speed probe now records shared-GPU-memory growth.
  - There's a driver setting, "CUDA – Sysmem Fallback Policy: Prefer No Sysmem Fallback", which makes overflows fail loudly instead. It's your call; I haven't changed system settings.
- **K2-Horizon's attention experts** (`attn_v_exps`, 2.9 GB) aren't moved by `--n-cpu-moe`. They need `-ot attn_v_exps=CPU`: 17 tok/s instead of 7.
- **The tier2b runner** now restarts a dead server and retries the sample. Before, one crash turned 105 samples into instant failures.
- **The download pipeline** runs smallest model first, verifies checksums with Hugging Face's API, reuses already-staged files, never runs a build alongside a benchmark, and evicts already-benchmarked models from C: only when space is needed.

## 6. State of C: this morning

- **Free space:** 40 GB.
- **Kept:**
  - the proven Gemma 26B-A4B IQ2_M + MTP draft head and Qwen3.6 IQ2_M (`C:\qwen3-forge-stage`);
  - the 96- and 64-expert slices plus the imatrix (`models\prune-qwen36`);
  - llama.cpp builds: master, Xing4.0, K2-Horizon.
- **Removed to make room (all re-downloadable or re-creatable in minutes):**
  - the benchmarked Xing4.0, gpt-oss-20b, Tiel-Coder, Gemma 4 QAT and K2-Horizon files;
  - the 192- and 128-expert slices.
- **To serve the fast pruned model:** `scripts/moe-bench/serve-qwen36-35b.ps1` (default: keep96).
- **Scripts and raw results** are committed under `scripts/moe-bench/` and `docs/benchmarks/2026-10-04/`.

## 7. Not done, and next

- **Flash-Next Coder:** not downloaded. Its two shards (58.4 GB) don't fit on C: alongside the models we care about while D: is down.
  - The pruning pilot says the Flash-Next plan (prune to fit 16 GB) is promising.
  - Options: a new drive, 32 GB of RAM, or freeing C:.
- **Gemma 4 QAT:** probe 18–20 CPU expert layers. It used only 5.9 GB of VRAM at 22, so it may be faster.
- **Xing4.0 with thinking on;** re-check Tiel with its recommended sampling settings.
- **Next pruning steps:**
  - 48- and 32-expert slices, to find the quality cliff;
  - score the slices on a longer, multi-step benchmark, not just tier2b;
  - then healing (re-fit the router per layer) and the experts-vs-bits sweep, per `2026-10-03-fit-flash-next-plan.md`.
- **Combine the two wins:** prune Qwen3.6 (or Flash-Next) **and** give it a 1,536-token thinking budget. The full model went from 90 to 102 with thinking.
