# Long context for keep96: 64k or more without losing performance

- **Date:** 2026-10-07. **Status:** design approved by the owner in conversation, section by section. Nothing has run yet. GPU runs start on the owner's go, with the owner's GPU apps closed.
- **Model:** Qwen3.6-35B-A3B keep96 (IQ2_M), llama-server 836d571, MTP 2 + n-gram speculation, as settled on 2026-10-06.
- **Goal:** a server window of at least 64k tokens. 128k or more is excellent.
- **The bar** (owner, 2026-10-07; §4): (a) short tasks are unchanged and (b) tasks at the end of a ~60k-token agent session do not do significantly worse.
- **Workload** (owner): agent sessions. Context grows turn by turn with file reads, test output and edits, and each turn repeats the session so far.
- **Not touched:** the Laya v3 run scheduled for 01:30 on 2026-10-08. Every default stays at 16k until that run has finished (§6).

## 1. Starting point

- **Today's window is 16,384** in the serve script, in both Jarvis config stores and in the benchmark harnesses. The "12k" is the largest prompt ever tested: 12,789 tokens in the speed check of 2026-10-06.
- **Most of the model holds no per-token cache** (GGUF metadata):
  - There are 40 layers plus 1 MTP layer. Every 4th layer is full attention, so 10 layers keep a KV cache; the MTP layer adds one more.
  - Each attention layer has 2 KV heads of 256 dimensions.
  - The other 30 layers are Gated DeltaNet, with a fixed-size state.
  - The native context is 262,144, so no RoPE scaling is needed.
- **The KV cache is small.** With the q8_0 cache (1.0625 bytes per value), 11 layers × 2 × 2 × 256 values come to about 11.7 KiB per token:

  | Window | KV cache | Added over 16k |
  |---|---|---|
  | 16k | 187 MiB | — |
  | 64k | 748 MiB | +561 MiB |
  | 96k | 1,122 MiB | +935 MiB |
  | 128k | 1,496 MiB | +1,309 MiB |
  | 262k | 2,992 MiB | +2,805 MiB |

  Working buffers also grow with the window. §2 measures the real total.
- **Measured at 16k** (ub 512, 2026-10-06):
  - 5,651 MiB above idle once loaded and 5,707 MiB at peak, with 199 MiB overflowing into shared system memory.
  - About 2.2 GB of the card stayed free with the Versutus gate paused.
  - With the owner's usual apps open on 2026-10-07, the desktop held 2.0 GB of the card's 8 GB.
- **Prompt reading** runs at about 2,070 tokens/s at 12.8k, so a 60k prompt takes 30 s or more.
- **Reuse across turns.** Because the DeltaNet state can't be rewound, the server reuses a previous turn only from a saved context checkpoint. The defaults are 32 per slot, at least 8,192 tokens apart. Checkpoints live in host RAM, an estimated 60 MB each; §2 measures them. `--cache-ram 0` stays.
- **Risks this design tests:**
  - quality at long context, since keep96's experts were chosen on short standard-library code at 2-bit quantization;
  - prompt time;
  - RAM: 1.5 GB was free at 12:27 on 2026-10-07.

## 2. Memory and speed check (GPU, about 45 min)

- **Tool:** extend `speed_pair.py` and `moe_sweep.run_config`, which already record:
  - GPU memory above idle, both loaded and at peak;
  - overflow into shared system memory;
  - RAM and the server's working set;
  - load time;
  - tokens per second.
- **New prompts:**
  - **Deep prompts** of about 30k, 60k and 120k tokens, built from standard-library source the same way `long15k` was. Each row runs the deepest prompt its window holds, leaving room for the reply.
  - **Follow-up probe:** send a deep prompt, then the same prompt plus one more user turn. Record the second request's time to first token and how many prompt tokens it actually processed. This shows whether checkpoints work across turns.
  - **Short prompts** (`gen`, `edit2k`) run 3 times per row, and the means are compared.
- **Grid** (cache q8_0 unless noted):

  | Row | Window | ub | Role |
  |---|---|---|---|
  | 1 | 16k | 512 | Control |
  | 2 | 32k | 512 | |
  | 3 | 64k | 512 | The goal, as the benchmarks run it |
  | 4 | 64k | 1024 | The goal, as Jarvis runs it |
  | 5 | 96k | 512 | |
  | 6 | 128k | 512 | Stretch |
  | 7 | the largest window that fits | 1024 | Jarvis's batch size at the top |
  | 8–9 | 96k, 128k with q4_0 cache | 512 | Only if rows 5–6 overflow |

- **A window passes this stage only if:**
  - it overflows into shared memory no more than the 16k control;
  - short-prompt generation speed is within 5% of the control's. This is the speed half of bar (a).
- **Also recorded per row:**
  - prompt-reading speed and generation speed at depth;
  - RAM during the deep prompt, including checkpoints;
  - the follow-up probe's numbers.
- A window that fails to load is recorded as "does not fit".

## 3. The long-session test

**Construction:** `longctx_sessions.py`, new. It runs on the CPU and is deterministic for a given seed.

- **A session is a multi-turn chat** in the model's own chat template: user turns carry files and test output, assistant turns carry code answers. That is the shape of a Jarvis session, minus the tool-call wrapping.
- **Filler comes only from the calibration pool** (`docs/benchmarks/laya-calib`, 60 tasks) **and standard-library files.** Nothing comes from tier2b, the old judge set or `laya-judge3`, and a test enforces this.
  - **Episode:** the user asks for a pool task's fix and shows its files. The assistant answers with the reference fix. The user pastes the reference's real test output, with the timings stripped. The assistant replies "Tests pass."
  - **File-read turn:** the user shows a chunk of a standard-library module "for context", and the assistant replies "Read {module} ({n} lines)."
  - Episodes and file reads are shuffled by seed until the filler reaches its token target.
- **Fillers:** 3 per target length, one per trial (seeds 1–3). The main target is about 56k tokens, so the task lands near 60k. The stretch target is about 116k.
- **Token counts:**
  - At the start of the GPU session, each filler is counted with the server's `/tokenize` and trimmed or extended until it is within 5% of its target.
  - Every run also stores the server's own prompt token count.

**Conditions, for each of the 117 tier2b task-trials:**

| Condition | What the model sees | Role |
|---|---|---|
| Short | The task turn alone | Control |
| Late | Filler *t*, then the identical task turn | **Bar (b)** |
| Early | The task turn; the assistant replies "I'll look at related code first."; then filler *t*; then the user says "Back to the first task: write the complete fixed file now." | Recall over distance; reported, not in the bar |

- **The task turn** is the recipe's candidate-0 prompt, with its sampling and seed. Short should therefore reproduce the stored single-answer results, which doubles as a check that the harness is right.
- **Single answer, not the recipe.** It isolates what the context does; picking among candidates can't produce answers the model can no longer write.
- **Cost:**
  - Late shares each filler across the 39 tasks, so the server reads it once per filler and works from a checkpoint after that: about 20 min. If §2 shows checkpoints don't work across turns, it's about 1.5 h.
  - Early can't share a prefix: about 117 × 40 s ≈ 1.3 h.
  - Short takes about 10 min.
- **Grading:** each answer is graded by its task's own test, as in tier2b.

## 4. The bar

Both parts must hold for a window to ship.

- **(a) Short tasks are unchanged.**
  - The tier2b recipe runs at the window, through `bestofn_tier2b.py` with `BON_EXTRA` (§6), on the same seeds as `docs/benchmarks/2026-10-06/tier2b-recipe-keep96-2026-10-06.jsonl` (107/117).
  - If only the window changed, the answers are expected to be identical, and the report says whether they were.
  - It fails if the per-task exact sign test favours the 16k run at p < 0.10. A task counts for the side that solved more of its 3 trials. Paired McNemar on samples is reported too.
  - Short-prompt generation speed must be within 5% of the 16k control (§2).
- **(b) Late sessions are no worse.**
  - Late against Short, per task, at the window's long target (about 60k for 64k, about 120k for 128k).
  - It fails if the exact sign test favours Short at p < 0.10. McNemar on samples is reported.
- **Reported, not in the bar:**
  - Early against Short;
  - prompt time;
  - time to first token on follow-up turns.

## 5. Picking the window

1. Run Late at about 60k first, since 64k is the goal.
2. If it passes, run Late at about 120k for the largest window that passed §2. If that window is 96k, the target is about 90k.
3. **The chosen window is the largest that passes both bars.** This is a "largest that passes" rule, not a score maximised on tier2b, so nothing is tuned on it.
4. Run bar (a) on the chosen window only.
5. **If Late fails at about 60k:**
   - Run Late at about 30k (a 32k window) to find where quality holds.
   - A check on whether pruning causes the loss means running the full 256-expert model on Late. It has 22 expert layers on the CPU, so it is slower, and RAM is tight. It runs only on the owner's go.

## 6. Run order and guard rails

- **Order:** §2, then the session build and token count, then Short, then Late at about 60k, then Early at about 60k, then Late at about 120k (if §2 allows it), then bar (a).
  - Expected GPU time is about 3.5 h, and about 5 h if checkpoints fail.
- **Start:** only on the owner's go, with the owner's GPU apps closed. The idle baseline is recorded so the report can give headroom with apps open as well.
- **Every GPU run:**
  - Jarvis's own server is stopped.
  - The Versutus gate is paused with `node gate\cli.mjs service stop`, and restored with `service start` at the end, even on failure.
  - The RAM guard runs before every server start: 2,048 MB, with a 1,024 MB fallback.
  - Runs are chained with marker files plus `gpu_free`, never log-line triggers (project memory: chain-script traps).
- **Defaults stay at 16k.** The window and cache type reach the harnesses only through `BON_EXTRA`, which appends flags after the defaults; llama-server takes the last value. No default changes before the Laya v3 run.
- **Hard stop at 01:00 on 2026-10-08:**
  - no llama-server left running;
  - every result committed and pushed;
  - a clean worktree, since the Laya v3 run commits to this branch from 01:30.
  - A run that can't finish by then is stopped and resumed after v3.

## 7. Rollout (after Laya v3 has finished, about 15:00 on 2026-10-08)

- **`scripts/moe-bench/serve-qwen36-35b.ps1`:** set `-c` to the chosen window (and the cache type, if it changed), and add the measured row to its table.
- **Jarvis:** set `llama_cpp.context_window` in both config stores, with backups beside each file:
  - `~/.openclaw/jarvis/config.json`;
  - the `llama_cpp` row of `%USERPROFILE%\.local\share\com.jarvis.desktop\jarvis.db`.

  If the window needs a batch size of 512, `batch_size` changes in both stores too. Jarvis's history trimming (`optimizeContextWindow`) already reads `context_window`.
- **Live check:**
  - Restart Jarvis.
  - Confirm the running llama-server reports the new `n_ctx` on `/props`.
  - Hold one chat past 30k tokens.
- **The benchmark harnesses stay at 16k.** Their tasks are short, and the default keeps results comparable and preserves RAM headroom for Laya.

## 8. Components

| File | Role | Change |
|---|---|---|
| `scripts/moe-bench/speed_pair.py` | Deep prompts, the follow-up probe, the grid in §2 | extend |
| `scripts/moe-bench/moe_sweep.py` | Cache-type option and per-prompt RAM in `run_config` | extend |
| `scripts/moe-bench/longctx_sessions.py` | Build fillers and sessions; run Short, Late and Early; grade; report | new |
| `scripts/moe-bench/test_longctx_sessions.py` | unittest | new |
| `scripts/moe-bench/longctx-runs/run_longctx.sh` | The chained GPU session | new |
| `docs/benchmarks/longctx/` | Runs, fillers' token counts, report | new |
| `docs/superpowers/specs/2026-10-07-long-context-results.md` | Results | new |

**Tests (written first):** the session builder:
- reaches its token target within 5%, with an injected tokenizer;
- draws only on the calibration pool and standard-library files, and never includes a tier2b or old judge set task name (`laya-judge3` is written tonight, after the filler, from a different writer);
- ends Late with exactly Short's task turn;
- produces identical output for identical seeds.

Scoring reuses `playbook.task_sign` and `pair_bestofn.py`.

## 9. Risks

- **Synthetic sessions aren't real ones.** They are plain chat without tool-call wrapping, and the filler is clean code. Real Jarvis sessions carry noisier tool output. The live check in §7 is the only real-session evidence.
- **Single-answer results don't predict the recipe at depth.** Bar (b) measures the model, and bar (a) measures the recipe only at short length.
- **Overflow into shared memory** may appear only at depth, when working buffers peak. Each row records it after the deepest prompt.
- **RAM.** Checkpoints at 60k–120k may take 0.5–1 GB of host RAM on a machine that had 1.5 GB free. The guard refuses to start a server below 1,024 MB. If a run fails for RAM, the checkpoint count is lowered (`--ctx-checkpoints`), and the run is recorded as a deviation.
- **Time.** If checkpoints fail and every Late sample reads its whole session, the session runs about 1.5 h longer. Early at about 120k is not planned for that reason.
