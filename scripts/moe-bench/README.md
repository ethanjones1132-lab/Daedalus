# moe-bench: MoE serving and pruning on the 8 GB RTX 4060

These are the scripts behind `docs/superpowers/specs/2026-10-04-overnight-results.md`. They are checked in here because their original home, `D:\qwen3-forge`, is on a USB drive that failed on 2026-10-04.

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

**Lessons that shaped the code**

- **Pass `--cache-ram 0` to llama-server** on this 16 GB machine.
- **VRAM near full is a trap on Windows.** The driver silently spills into system RAM, so a "fitting" placement can be slower. Probe several placements.
- **K2-Horizon needs `-ot attn_v_exps=CPU`.** Its MoVA attention experts aren't covered by `--n-cpu-moe`.
- **The Xing4.0 non-MTP GGUF needs `xing4_0.nextn_predict_layers` set to 0** before it will load.
