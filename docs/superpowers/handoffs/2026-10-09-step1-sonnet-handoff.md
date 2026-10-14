# Handoff: roadmap Step 1 (choose the base), then Step 2 (2026-10-08 → 10-09)

For: Claude Sonnet 5.5, starting immediately. From: the Opus session that ran Laya v3 (2026-10-08).
Runway: tonight through the end of 2026-10-09. Step 1 runs as ONE session. Model selection follows, then Step 2.

## 0. Read first (10 minutes)

**Memory** (`~/.claude/projects/C--Projects-home-base-recovered/memory/`): start with `MEMORY.md`, then read:
- `measure-not-target-rules.md` — the owner's standing rules. They govern every decision below.
- `two-paths-single-then-swarm.md` — the roadmap and the owner's decisions of 2026-10-08.
- `iq3xxs-standard-candidate.md`, `oneshot-bench-2026-10-07.md`, `long-context-keep96-2026-10-07.md`.
- `teacher-grok-vs-deepseek-2026-10-08.md` — DeepSeek is the teacher; see its last line.
- `laya-role-bounded-decisions.md` (Laya v3's outcome) and `e-drive-restored-2026-10-07.md`.

**Repo** (worktree `C:\Projects\home-base-recovered\.claude\worktrees\micro-agent-swarm-design-929d42`, branch `claude/micro-agent-swarm-design-929d42`, public):
- `docs/superpowers/specs/2026-10-08-roadmap-draft.md` — the roadmap.
- `docs/superpowers/specs/2026-10-07-oneshot-round2-results.md` — the Ecosystem Lab results so far, and the original headroom-test spec under "Next".
- `docs/superpowers/specs/2026-10-08-laya-v3-results.md` — what happened with RAM, WSL and Laya timeouts during the last long run.

## 1. The owner's decisions (2026-10-08, ~23:45)

1. **Teacher for all role data: DeepSeek v4.1 Flash only** (OpenCode Go). Grok 4.7 is too intensive on the owner's SuperGrok subscription. Don't use it.
2. **Long context:** aim for 128k, expect to land at 64k. "Aim for higher always."
3. **Step 2 method:** prove the methodology and outcome on a smaller base that trains locally (RTX 4060, 8 GB) before renting any GPU. The owner expects results to scale with model capability, so show it on more than one size.
4. **Step 1:**
   - The four items below run in this session. When they're done, propose the base.
   - The selection is **two picks**: the most generally capable model overall, and the most capable model trainable on this system.
   - After the owner confirms, begin Step 2.

## 2. Operating rules (non-negotiable)

- **Standing rules** (memory `measure-not-target-rules.md`):
  - Benchmarks are instruments, never targets. Nothing is trained or tuned on a benchmark, its task families or its rubric.
  - Prefer mechanisms with few or no fitted parameters.
  - Laya stays as shipped plus calibration. The owner ruled that a lean int8 or ONNX Laya counts as shipped.
- **Secrets:** never print, log or commit an API key. OpenCode keys are read inside Python from `%USERPROFILE%\.local\share\opencode\auth.json` (`["opencode-go"]["key"]` for Go). `scripts/moe-bench/opencode_go.py` does this.
- **Public repo:**
  - Before every push, run `scripts/moe-bench/scrub_paths.py` on new result files.
  - Check that no committed file contains the account name. Write paths as `%USERPROFILE%` or `~` in docs.
  - Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- **Disks:** models and data live on E:. Never use D:. C: is 95% full, so put nothing big on it.
- **Downloads and installs need the owner's explicit OK first** (a pip package such as `onnxruntime`, any model weights). State what, from where and how big.
- **GPU hygiene, for every GPU run:**
  - **The Versutus gate.** Pause: `cd /c/Projects/Versutus && node gate/cli.mjs service stop`. Restore at the end, even on failure: `service start`, then poll `service status` until `lastHealthyAt` is set. Use a `trap ... EXIT` in chain scripts.
  - **One llama-server at a time.** Wait until `tasklist //FI "IMAGENAME eq llama-server.exe"` shows none.
  - **Close GPU apps first.** The owner approved closing Roblox (`RobloxPlayerBeta`). Ask before closing anything else (Discord, OneDrive).
  - **WSL.** Run `wsl --shutdown`, then keep the guard running for the session: `bash scripts/moe-bench/laya-runs/wsl_guard.sh /c/qwen3-forge-stage/logs/step1.done` (it stops when that marker exists). A background app restarts the WSL VM, about 600 MB each time.
  - **Laya runs** use the 2,048 MB RAM guard with the 1,024 MB fallback. Laya's client deadline is now 30 s.
- **Chain scripts:**
  - Trigger on marker files, never log text.
  - Pass paths into Python strings with `cygpath -w`.
  - Count rows with a helper that prints exactly one number. `grep -c` on an empty file prints "0" and exits 1, and `|| echo 0` then prints a second "0".
- **Pace:** the owner wants long unattended GPU work split into steps with sign-off between them. Step 1 is pre-approved as one session. Model selection and Step 2's training both need the owner's OK.

## 3. Close what isn't needed (start of session)

- **Archive two idle sessions**, the old scheduled-run attempts for Laya v3: `local_1e492877-ebe0-42f8-b1da-a78a763bc467` and `local_da13b47f-2cd2-48ef-9a57-4a2dcf26920d`. Use the session-management tools; ask the owner if unsure. Leave every other session alone.
- **Scheduled tasks are all disabled** (`laya-v3-overnight` has finished). Nothing to do there.
- **Check nothing of the previous work is running:** no `llama-server.exe`, no `python` running `playbook_tier2b`, `laya_partner` or `teacher_gen`, and no `grok.exe`. Grok's seed generation was paused on purpose.
- **Close Roblox if it's open.** Then `wsl --shutdown`, pause the gate, and start the WSL guard. Then measure free RAM and VRAM at idle and record them.

## 4. Item 1: the IQ3_XXS headroom test

**Model:** Qwen3.6-35B-A3B UD-IQ3_XXS, `E:\qwen3-forge\models\Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf` (14.1 GB), llama-server 836d571 (`C:\qwen3-forge-stage\tools\llama-master-836d57176`).

**Measured before** (2026-10-07, at the one-shot benchmark's 40k window, owner's apps open):
- 35–38 tok/s generation;
- prompt reading about 445 tok/s warm, about 32 tok/s on a cold first prompt while experts page in from E:;
- 7,596 MiB VRAM in use (0.6 GB spare);
- **0.4–1.0 GB RAM free while serving.**

**What to measure,** at windows **16k, 40k and 64k**, then **96k and 128k** as a stretch ("aim higher"):
1. **The fitted placement:** `--n-cpu-moe` raised until VRAM stays at or under `VRAM_CAP_MIB` (8,188 − 250 MiB, the same rule as `scripts/oneshot/oneshot_bench.py` `next_placement`). Start from `ncmoe 26`.
2. **Speed:** generation tok/s, and prompt tok/s warm and cold. Use a deep prompt filling about 85% of the window, plus a follow-up turn, like `speed_pair.py --grid` does.
3. **Memory:** VRAM in use and margin, shared-GPU-memory spill, RAM available.
4. **With the Laya worker loaded alongside**, three variants: none, fp32 (as shipped), and lean (item 2). Record RAM available at load. Then fire 20 Laya calls (classify and verify) during a generation, and record latency (p50/p95) and any timeouts.

**How:** `scripts/moe-bench/speed_pair.py --grid` already does most of this for keep96. It hardcodes `ncmoe 0` (`moe_sweep.run_config(model, 0, ...)`) and its own window grid (`GRID`). Extend it with `--ncmoe`/`--fit` and `--windows`, or write `headroom_iq3.py` reusing `moe_sweep.run_config`, `oneshot_bench.llama_args`/`next_placement`, and `playbook_tier2b.LayaClient` for the Laya load. Models load with `--load-mode none`.

**Proposed pass rule** (state it in the results doc; the owner may adjust). A window passes if:
- it serves with the fitted placement and no spill;
- generation is at least 25 tok/s;
- the deep prompt and follow-up complete;
- with Laya loaded, RAM available is at least 2,048 MB at launch (or at least 1,024 MB under the fallback);
- the 20 Laya calls answer with p95 under 5 s and no timeouts.

The largest passing window, with which Laya variant, is the answer.

## 5. Item 2: lean Laya (same session)

**Goal:** shrink the Laya worker (`scripts/moe-bench/laya_partner.py worker`, Laya 0.3.27 in `C:\qwen3-forge-stage\venv-laya`, a 421M ModernBERT) from 3.6 GB working set and 5.5 GB private memory to under about 1–1.5 GB, without changing its answers.

**Routes, in order:**
1. **No install needed:**
   - PyTorch dynamic int8 (`torch.ao.quantization.quantize_dynamic` on `nn.Linear`) applied to the loaded model inside the worker, behind a flag (e.g. `LAYA_INT8=1`).
   - Also run under `torch.inference_mode()`, and check why private memory is about 3× the fp32 weights (1.7 GB): allocator caching, duplicate checkpoints, tokenizer caches.
2. **ONNX:** Laya has a built-in backend (`laya.load(..., backend="onnx")`, `laya/onnx_agent.py`), but `onnxruntime` is NOT installed. Ask the owner before installing it.

**Acceptance** (recompute on the calibration pool, `docs/benchmarks/laya3/laya3-calib-*.jsonl`; never on a judge set):
- hidden-code AUC, library AUC and verify AUC each within 0.02 of fp32 (1.00 / 0.99 / 0.79);
- median |Δp| under 0.02;
- the v3 rule's routing identical on at least 95% of pool tasks;
- latency no worse than fp32;
- report private memory and working set.

If it passes, rerun item 1's Laya-alongside measurements with the lean worker.

## 6. Item 3: K2-Horizon's two Ecosystem Lab builds (apps closed)

```bash
PY=/c/qwen3-forge-stage/venv/Scripts/python.exe; S=scripts/oneshot; RUNS=/c/qwen3-forge-stage/logs/oneshot/runs
P=docs/benchmarks/oneshot/ecosystem-lab/params-dev.json
$PY $S/oneshot_bench.py run --model k2h --seeds 1-2 --runs $RUNS
$PY $S/oneshot_bench.py check --runs $RUNS --params $P --set dev --shots --only k2h
$PY $S/oneshot_bench.py check --runs $RUNS --params $P --set dev --assembled --only k2h
```

- **The registry entry already exists:** `k2h` uses its own build `llama-k2h-50abacf42`, `-ot attn_v_exps=CPU`, starting `ncmoe 30`.
- **It thrashed at 0.15 GB free RAM last time.** If RAM available drops under about 1 GB during the fit or generation, stop it and record that rather than let it page.

## 7. Item 4: the dense model roster on the Ecosystem Lab (3 runs each)

**Starts as soon as items 1–3 are done tonight.** Same settings as round two:
- 40k window, q8_0 cache, batch 512;
- temperature 0.2, top_p 0.95, seeds 1–3, up to 32,768 output tokens;
- thinking off (`--reasoning-budget 0`);
- MTP speculation where the GGUF has an MTP head (names contain "MTP"), otherwise `ngram-mod`.

**The runner needs one extension.** `oneshot_bench.py`'s fit step only raises `--n-cpu-moe` (MoE). For dense models, add a `-ngl` fit: start at 99 and lower it by 4 while VRAM exceeds `VRAM_CAP_MIB` or the load fails. Add registry entries for the roster below with `build="master"` unless a model's architecture needs another build.

**Score:** the 70 automated checks (`check --set dev --shots`, plus `--assembled` for the exploratory score) and "apps that run", as in round two. Blind judging is optional. If you do it, mix in a few round-two builds as anchors so your scores are comparable with the earlier judge's.

**Roster:** dense models on disk, one pick per model, highest-precision quant that fits. Run in this order:

| # | Key (suggested) | File | Size | Notes |
|---|---|---|---|---|
| 1 | `qwen38-27b` | `E:\qwen3-forge\models\Qwen3.8-27B-UD-IQ2_XXS.gguf` | 7.3 GB | 27B dense; partial offload, slow (allow ~1.5 h) |
| 2 | `gemma4-12b` | `E:\qwen3-forge\models\gemma-4-12b-it-qat-q4_0.gguf` | 7.0 GB | Google's QAT 4-bit |
| 3 | `qwen38-9b` | `E:\qwen3-forge\models\published-Q4_K_M.gguf` | 5.8 GB | Qwen3.8 9B (full-precision weights also in `...\Qwen3.8-9B-Distill\`) |
| 4 | `dsv4pro-qwen35-9b` | `E:\models\gguf\DeepSeek-V4-Pro-Qwen3.5-9B-MTP-Q5_K_M.gguf` | 6.6 GB | the ladder's previous best 9B; MTP |
| 5 | `qwen35-9b` | `E:\models\gguf\unsloth-Qwen3.5-9B-Q5_K_M.gguf` | 6.7 GB | base reference for the Qwen3.5-9B fine-tunes |
| 6 | `qwen35-9b-coder` | `E:\qwen3-forge\models\Qwen3.5-9B-Coder.Q4_K_M.gguf` | 5.8 GB | |
| 7 | `qwythos-9b` | `E:\models\gguf\Qwythos-9B-Claude-Mythos-5-1M-MTP-Q4_K_M.gguf` | 5.9 GB | MTP |
| 8 | `ornith-9b` | `E:\models\gguf\ornith-1.0-9b-Q4_K_M.gguf` | 5.6 GB | |
| 9 | `nemotron-nano-9b` | `E:\models\gguf\nvidia_NVIDIA-Nemotron-Nano-9B-v2-Q4_K_M.gguf` | 6.5 GB | arch `nemotron_h` |
| 10 | `gemma4-12b-coding` | `E:\qwen3-forge\models\gemma4-coding-Q3_K_M.gguf` | 6.1 GB | merged Gemma 4 12B coding fine-tune |
| 11 | `llama31-8b` | `E:\models\gguf\Meta-Llama-3.1-8B-Instruct-Q5_K_S.gguf` | 5.6 GB | older baseline |
| 12 | `nanbeige-3b` | `E:\models\gguf\nanbeige4.2-3b-Q6_K.gguf` | 3.4 GB | arch `nanbeige`; skip if 836d571 can't load it |
| 13 | `bonsai-27b` | `E:\models\gguf\Ternary-Bonsai-27B-Q2_0.gguf` | 7.2 GB | custom ternary quant types; run only if a build on disk loads it, else record "unsupported" |

- **Optional if time remains:** Qwen3.8-9B custom mixes (`Qwen3.8-9B-mix-ssmQ6-*`), `gemma4-v2-Q3_K_M`, Qwen3.8-27B IQ1 quants.
- **Not needed:** the uncensored and abliterated variants. They change refusals, not capability.
- **The MoEs are done** (round two), keep96 too. Don't rerun them.

## 8. Wrap-up of Step 1, and model selection

1. **Write `docs/superpowers/specs/2026-10-09-step1-results.md`:**
   - headroom per window and Laya variant, with the pass rule;
   - lean-Laya agreement and memory;
   - K2-Horizon's builds;
   - the dense roster table in round two's format;
   - deviations.

   Copy run data to `docs/benchmarks/` and scrub it. Update the gallery and memory. Push. Then `touch /c/qwen3-forge-stage/logs/step1.done` (stops the WSL guard) and restore the gate.
2. **Write `docs/superpowers/specs/2026-10-09-base-selection.md` with two picks and the evidence for each:**
   - **(A) Most generally capable overall:**
     - the Ecosystem Lab score is the main instrument;
     - plus whether it fits at 64k or more with Laya (headroom);
     - plus earlier measures as secondary (tier2b, long context), never one benchmark alone.
   - **(B) Most capable trainable on this system:**
     - a dense model that QLoRA can train on 8 GB VRAM (realistically ≤ 9B; 12B is tight).
     - Training needs full-precision weights. Only Qwen3.8-9B's are on disk (`Qwen3.8-9B-Distill`, 19.3 GB safetensors). List any downloads Pick B needs, for the owner to approve.
   - **Then ask the owner to confirm.**

## 9. Step 2 kickoff (after the owner confirms)

**Teacher data, DeepSeek only, API, no GPU.** The pipeline exists in `scripts/teacher/teacher_gen.py`:
- Seeds come from broad fields, with benchmark topics excluded and a wording check against every scored set.
- `gen` runs plan, then build from the plan, then the seed's acceptance tests, then one fix. Only passing samples count.

```bash
PY=/c/qwen3-forge-stage/venv/Scripts/python.exe
$PY scripts/teacher/teacher_gen.py seeds --out E:/AI/teacher-data/gen-v0 --backend deepseek --workers 6 --cells 280 --k 3
$PY scripts/teacher/teacher_gen.py gen --out E:/AI/teacher-data/gen-v0 --backend deepseek --workers 6
```

- **`gen-v0/seeds.jsonl` is empty.** Grok's run was paused before any cell finished, so start fresh with DeepSeek.
- **Don't run `gen` during GPU measurements.** It executes generated code, which uses CPU and RAM. Seeds are API-only.

**Design before any training:** use superpowers:brainstorming, then a spec, then a plan, with the owner's sign-off.
- **Roles:** plan, build, check/fix.
- **SFT formats** from verified `runs.jsonl` samples only.
- **Base:** QLoRA on Pick B. Also show the method on a second, smaller size, to test the owner's "scales with capability" expectation.
- **Evaluation:**
  - role metrics, plus general-capability retention on held-out measures;
  - at least two builds, one of them never used for tuning;
  - nothing trained on or tuned to a benchmark family.
- **Tools:** Unsloth Studio is installed at `E:\Unsloth`. Any pip packages (peft, bitsandbytes, ...) need the owner's OK.

## 10. Known pitfalls (from 2026-10-08)

- **A game or a WSL restart can squeeze RAM until Laya misses its deadline.** The client then stops asking Laya for the rest of that process, and rows silently lose Laya's answers. Watch for `evidence None` or `laya_dead`. `scripts/moe-bench/laya-runs/p3_redo.py` shows how rows were redone by flag.
- **Reading GGUF metadata with `gguf.GGUFReader` over E: is very slow.** Read just the header KV (a small struct parser) instead.
- **DeepSeek and some models sometimes skip the requested code fences.** `teacher_gen.extract_files` handles a reply that starts with a `file:` marker.
- **Don't run anything on `docs/benchmarks/laya-judge3/` again.** Its one look was spent by Laya v3.
