# moe-bench: MoE serving and pruning on the 8 GB RTX 4060

These are the scripts behind `docs/superpowers/specs/2026-10-04-overnight-results.md`, `2026-10-04-final-report.md`, `2026-10-05-bestofn-selftest.md` and `2026-10-05-overnight-levers.md`. They are checked in here because their original home, `D:\qwen3-forge`, is on a USB drive that failed on 2026-10-04.

**Layout.** Paths are absolute and assume this layout on C:.

| Path | What it holds |
|---|---|
| `C:\qwen3-forge-stage\venv` | Python 3.12 with `huggingface_hub`, `hf_xet`, `gguf`, `numpy` |
| `C:\qwen3-forge-stage\tools\llama-<label>-<sha>` | llama.cpp builds (`build_llama.ps1`) |
| `C:\qwen3-forge-stage\models\<name>` | Staged GGUFs |
| `C:\qwen3-forge-stage\logs` | Logs and results |
| `C:\cuda\13.4.2` | CUDA build components (`fetch_cuda.py`; no installer, no admin) |
| `C:\build\llama.cpp` (+ `wt-*` worktrees) | llama.cpp source, plus PR and fork branches |

**Scripts**

| Script | What it does |
|---|---|
| `model_pipeline.py` | One model at a time, smallest first: build if needed (overlaps the download, never a run), download and verify sha256, apply metadata fixes, find the expert placement, run tier2b. Restart-safe: it skips models with results and reuses earlier placement probes. |
| `moe_sweep.py` | Speed probe for one llama-server config: warm-up pass, then timed short-generation, 2k-token edit and 10k-token context prompts. Records VRAM delta, RAM and shared-GPU-memory spill. |
| `tier2b_llama.py` | The tier2b suite (39 tasks × 3 samples) against llama-server. Resumable; restarts a dead server and retries the sample; keeps raw answers. |
| `slice_experts.py` | Keep the top-N routed experts per layer in a MoE GGUF, ranked by imatrix activation energy. Slices the expert tensors and router exactly. |
| `prune_experiment.py`, `prune_more.py` | The Qwen3.6-35B-A3B pruning pilot: 256 → 192/128/96/64 experts. |
| `serve-qwen36-35b.ps1` | Serve the full model or the keep96/swap108/add108/keep64 slices with the measured settings. keep96 is the default and the settled model (2026-10-06 check). |
| `speed_pair.py` | Paired speed and VRAM probe for several GGUFs at the Qwen speed-lab winner, alternating the models over rounds; adds a near-full 15k-token prompt for VRAM headroom. |
| `speed_pair.py --grid` | Long-context memory and speed grid (2026-10-07): windows 16k–128k with deep prompts, overflow into shared memory, a follow-up-turn probe, and a verdict per window. |
| `longctx_build.py` | Builds long agent sessions from the calibration pool and stdlib files; tier2b and judge-set names are blocked. |
| `longctx_sessions.py` | Short / Late / Early runs at a window, graded by tier2b's tests; the report with bar (b), the chain's queries, and bar (a). |
| `longctx-runs/run_longctx.sh` | The long-context GPU chain: grid, 64k, the largest window, bar (a), Early; a watchdog stops it before 01:00. |
| `pair_bestofn.py` | Paired comparison of two `bestofn_tier2b` runs on the same tasks and seeds: single shot and recipe totals by category, discordant samples, exact McNemar p, the tasks that differ. |
| `settle-runs/run_settle.sh`, `settle-runs/run_add108.sh` | The 2026-10-06 model check: the paired probe of swap108 against keep96, tier2b with the recipe harness on swap108, keep96 and add108. |
| `laya-runs/run_session1.sh`, `run_fit.sh`, `run_session2.sh` | The Laya partner's chains: GPU session 1 (the calibration pool's nested runs and Laya's labels), the calibration and rule fits, and GPU session 2 (judge nested runs, configurations 3–5 on the judge set and tier2b, labels, the report). Results: `docs/superpowers/specs/2026-10-07-laya-partner-results.md`. |
| `laya-runs/ram_check.py` | Available RAM with Qwen and the Laya worker loaded, under the default mmap load and `--load-mode none`, and whether both loads give identical answers. |
| `playbook.py`, `laya_calibrate.py`, `laya_partner.py`, `playbook_tier2b.py` | The Laya partner: the rule, selection, offline simulation and fitting; Laya's calibration; the Laya worker and labeller; the nested and live runners. v2 (2026-10-06) adds the targeted probe form and the hidden-code signal. |
| `laya_v3_text.py`, `probe_v3.py` | Laya v3 (2026-10-08): the evidence options, note phrases and Laya states shared by both venvs; probe v3, its retry, the noted fix, the example-assert and repair prompts, and running the asserts. `playbook.py` gains v3 routing (the library gate), outcome simulation, fitting, ablations and `report-v3`; `playbook_tier2b.py` gains `nested --v3` and `live --v3`; `laya_partner.py` gains the `evidence` and `valid` questions. |
| `opencode_go.py`, `judgeset_writer.py` | The v3 judge set: a minimal OpenCode Go client (the key is read from OpenCode's auth.json and never printed), and DeepSeek v4.1 Flash writing tier2b-format tasks that `train_tasks/make.py` normalizes, checks for disjointness and validates (`docs/benchmarks/laya-judge3/`). |
| `laya-runs/run_v3_pool.sh`, `run_v3_judge.sh` | The v3 GPU chains: the pool session (probe v3 added to the 2026-10-06 rows, Laya's valid labels) and the judge session (nested and live on the new judge set, live on tier2b, labels, report). Both restore the Versutus gate on exit. Results: `docs/superpowers/specs/2026-10-08-laya-v3-results.md`. |
| `build_llama.ps1` | Build one llama.cpp branch with CUDA 13.4 for sm_89 using VS 2026 + Ninja. |
| `after_*.ps1` | Detached chains that run the next step when the previous process exits, so they survive Claude restarts. |
| `prune_gptoss.py`, `make_keep24.py` | gpt-oss-20b pruning. Calibrates on the full model's own chat-format transcripts, then slices to 16/24 of 32 experts and probes and benchmarks each slice. `slice_experts.py` now also slices expert and router biases, and combines several imatrix files. |
| `speedlab.py` | Per model: base placement, then one runtime lever at a time, then the best lossless combination. Levers: threads, priority, KV f16, speculation depth, n-gram lookup on its own and stacked, no speculation, fewer experts, ubatch. |
| `gptoss_speedlab.py` | The earlier gpt-oss-only speed lab (full MXFP4 model with its EAGLE3 draft). `speedlab.py` replaced it for the run. |
| `sampling_sweep.py` | tier2b at each speed-lab winner under current / model-card / greedy sampling (`tier2b_llama.py --sampling`). |
| `report_tables.py` | Markdown tables from all of the above. |
| `run_rest.ps1` | The sequential, restart-safe chain that ran the speed lab and sampling sweeps. |
| `drive-rescue/` | The SSD and D: diagnostics: SMART, openSeaChest self-test, chkdsk and Repair-Volume runs, the NVMe temperature logger and the guard, plus the read-only sector copy taken before any repair (`d_copy.py`). |
| `remote/modal_flashnext.py`, `remote/flashnext_calib.py` | Qwen3.8-Flash-Next Coder expert usage on a Modal L40S: own-answer calibration (4 parallel slots), llama-imatrix, per-layer energy and routing summary. Results: `docs/superpowers/specs/2026-10-04-flashnext-expert-usage.md`. |
| `thinking_sweep.py` | tier2b at thinking budgets of 512, 1,536 and 4,096 tokens for Qwen keep96 and Gemma 26B, each at its speed-lab winner and best sampling. |
| `bestofn_tier2b.py` | Best-of-N with a verifier that never sees the grading test: N candidate fixes, chosen by compile, import and the model's own tests. |
| `bestofn_mix.py`, `bestofn_ablate.py` | No generation, from stored best-of-N runs: a mixed Qwen + Gemma candidate pool, and selection by which self-tests exist and by N. |
| `probe_tier2b.py` | Probe-then-fix: before fixing, the model writes one short script, runs it in the task's package (the hidden module is bytecode only) and sees its output. `--prompt-v 2` is the revised probe prompt. |
| `repair_tier2b.py` | Repair: the model's failing self-tests and their errors go back to it for up to `--rounds` corrections. |
| `laya_router.py` | Laya (convaiinnovations/laya), zero-shot, labels each task (depends on unseen code? effort? kind?) and a fixed rule routes it to a model and config. |
| `scrub_paths.py` | Replaces local temp paths, which carry the account name, with `<tmp>` in result files before they're committed. |
| `overnight-2026-10-04/`, `overnight-2026-10-05/` | Each night's status notes and runners. 2026-10-05: the chain (`overnight_2026-10-05.ps1`), the restart-safe queue runner (`night_queue.ps1` reading `night-queue.txt`) and the gpt-oss effort wrapper (`effort_run.py`). |

**Lessons that shaped the code**

- **Pass `--cache-ram 0` to llama-server** on this 16 GB machine.
- **VRAM near full is a trap on Windows.** The driver silently spills into system RAM, so a "fitting" placement can be slower. Probe several placements.
- **K2-Horizon needs `-ot attn_v_exps=CPU`.** Its MoVA attention experts aren't covered by `--n-cpu-moe`.
- **The Xing4.0 non-MTP GGUF needs `xing4_0.nextn_predict_layers` set to 0** before it will load.
- **Stack n-gram lookup on the model's own MTP head:** `--spec-type draft-mtp,ngram-mod`. That's 2.1–2.2× on Gemma and Qwen.
- **For gpt-oss, drop the EAGLE3 draft and use `ngram-mod` alone.** The draft's VRAM forces extra expert layers onto single-channel RAM.
- **Pruning gpt-oss: calibrate on its own transcripts.** Raw code removes the experts its reasoning needs.
- **llama.cpp 836d571 has no `--no-mmap`.** Use `--load-mode none`. The old flag exits with "invalid argument", which looks like a load failure.
- **PyPI `gguf` can't read ISTA's Flash-Next GGUFs** (Q2_0 = type 42). Put llama.cpp's own `gguf-py` first on `PYTHONPATH`.
- **Energy kept is the pruning headroom test.** Already-pruned pools (ISTA's 256-of-512 Coder) are flat: 90% of energy needs 59% of the experts, against 35% for raw Qwen3.6.
- **Run model-written tests as `unittest` classes too.** About a third of the self-test suites were `TestCase` classes, which the first best-of-N runner never ran.
- **Queued `cmd /c` lines lose their quote marks.** Pass JSON arguments through a wrapper script (`effort_run.py`).
- **C:'s NVMe faults under heavy load.** Pause after multi-GB writes, keep RAM free so expert pages aren't re-read from it, and watch its temperature (`drive-rescue/ssd_watch.ps1`).
