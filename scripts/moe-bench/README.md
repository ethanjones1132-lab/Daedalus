# moe-bench: MoE serving and pruning on the 8 GB RTX 4060

These are the scripts behind `docs/superpowers/specs/2026-10-04-overnight-results.md` and `2026-10-04-final-report.md`. They are checked in here because their original home, `D:\qwen3-forge`, is on a USB drive that failed on 2026-10-04.

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
| `serve-qwen36-35b.ps1` | Serve the full model or the keep96/keep64 slices with the measured settings. |
| `build_llama.ps1` | Build one llama.cpp branch with CUDA 13.4 for sm_89 using VS 2026 + Ninja. |
| `after_*.ps1` | Detached chains that run the next step when the previous process exits, so they survive Claude restarts. |
| `prune_gptoss.py`, `make_keep24.py` | gpt-oss-20b pruning. Calibrates on the full model's own chat-format transcripts, then slices to 16/24 of 32 experts and probes and benchmarks each slice. `slice_experts.py` now also slices expert and router biases, and combines several imatrix files. |
| `speedlab.py` | Per model: base placement, then one runtime lever at a time, then the best lossless combination. Levers: threads, priority, KV f16, speculation depth, n-gram lookup on its own and stacked, no speculation, fewer experts, ubatch. |
| `sampling_sweep.py` | tier2b at each speed-lab winner under current / model-card / greedy sampling (`tier2b_llama.py --sampling`). |
| `report_tables.py` | Markdown tables from all of the above. |
| `run_rest.ps1` | The sequential, restart-safe chain that ran the speed lab and sampling sweeps. |
| `drive-rescue/` | The SSD and D: diagnostics: SMART, openSeaChest self-test, chkdsk and Repair-Volume runs, the NVMe temperature logger and the guard. |
| `remote/modal_flashnext.py`, `remote/flashnext_calib.py` | Qwen3.8-Flash-Next Coder expert usage on a Modal L40S: own-answer calibration (4 parallel slots), llama-imatrix, per-layer energy and routing summary. Results: `docs/superpowers/specs/2026-10-04-flashnext-expert-usage.md`. |

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
- **C:'s NVMe faults under heavy load.** Pause after multi-GB writes, keep RAM free so expert pages aren't re-read from it, and watch its temperature (`drive-rescue/ssd_watch.ps1`).
