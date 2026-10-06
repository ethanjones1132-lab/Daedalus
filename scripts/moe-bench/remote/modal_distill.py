"""Adapters phase 2 on Modal (spec docs/superpowers/specs/2026-10-05-adapters-design.md section 4).

First piece, the teacher test (section 4.1): Qwen3.8-Flash-Next Coder (ISTA GSQ-RCO IQ1_M, all 256 experts)
answers the calibration pool single shot (60 tasks x 3 samples, temperature 0.2 / top-p 0.95, the sample index as
seed), thinking off and then at a 2,048-token budget, in one L40S container so the 58 GB model downloads once.

    python -m modal run --detach scripts/moe-bench/remote/modal_distill.py::teacher_test
    python -m modal volume get distill teacher <local dir>

- Same image, model files and server settings as modal_flashnext.py's tier2b run (b11382, one commit after the
  local 836d571 and WebGPU-only; the n-gram table held resident with --load-mode none --lazy-mode off).
- The pool's loaders find their files by relative path (tasks.py loads validation-b's B tasks, runbench2b.py loads
  tier2b's harness), so the container mirrors the repo layout under /opt/repo.
- Qualifies (spec 4.1) if single shot beats keep96's pool recipe by at least 8 of 180: 147 measured 2026-10-06,
  so at least 155.
- Cost: L40S $0.000542/s + 8 cores + 64 GiB, about $2.84/h. The 2 h timeout caps a run at about $5.70.
"""
import json
import os
import pathlib
import subprocess
import sys
import time

import modal

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent.parent.parent  # the repo (not parents[2]: the container re-imports this file from /root)
REPO = "ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF"
LLAMA_IMAGE = "ghcr.io/ggml-org/llama.cpp@sha256:3e57be4957bb34ab46a7a5e18165177d1356ac5ffb7b9a553f5b74b1788d17a5"
W, MD, BIN, R = "/vol", "/model", "/app", "/opt/repo"
M = f"{MD}/IQ1_M/Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M-00001-of-00002.gguf"
RESIDENT = ["--load-mode", "none", "--lazy-mode", "off"]
RATE = 0.000542 + 8 * 0.0000131 + 64 * 0.00000222  # $/s: L40S + 8 cores + 64 GiB
POOL = f"{R}/docs/benchmarks/laya-calib"

image = (
    modal.Image.from_registry(LLAMA_IMAGE, add_python="3.12")
    .entrypoint([])
    .pip_install("huggingface_hub[hf_xet]", "numpy")
    .env({"HF_XET_HIGH_PERFORMANCE": "1", "HF_HUB_DISABLE_PROGRESS_BARS": "1", "LD_LIBRARY_PATH": "/app"})
    .add_local_file(HERE.parent / "tier2b_llama.py", "/opt/tier2b_llama.py")
    .add_local_file(ROOT / "scripts" / "benchmark-tier2b" / "runbench2b.py", f"{R}/scripts/benchmark-tier2b/runbench2b.py")
    .add_local_file(ROOT / "docs" / "benchmarks" / "2026-10-05" / "validation-b" / "tasks.py",
                    f"{R}/docs/benchmarks/2026-10-05/validation-b/tasks.py")
    .add_local_dir(ROOT / "docs" / "benchmarks" / "laya-calib", POOL)
)
vol = modal.Volume.from_name("distill", create_if_missing=True)
app = modal.App("adapters-distill", image=image)


def summarize(path):
    rows = [json.loads(l) for l in open(path) if l.strip()] if os.path.exists(path) else []
    by = {}
    for r in rows:
        if "task" in r:
            c = by.setdefault(r["category"], [0, 0])
            c[0] += r["ok"]
            c[1] += 1
    return {"passed": sum(v[0] for v in by.values()), "samples": sum(v[1] for v in by.values()),
            "by_category": {k: f"{v[0]}/{v[1]}" for k, v in sorted(by.items())}}


@app.function(gpu="L40S", volumes={W: vol}, timeout=2 * 3600, cpu=8, memory=64 * 1024)
def teacher(budgets: list):
    from huggingface_hub import snapshot_download

    t0 = time.time()
    snapshot_download(REPO, allow_patterns=["IQ1_M/*"], local_dir=MD, max_workers=16)
    print(f"model downloaded in {time.time() - t0:.0f} s", flush=True)
    res = f"{W}/teacher"
    os.makedirs(res, exist_ok=True)
    out = {}
    for b in budgets:
        path = f"{res}/flashnext-pool-budget{b}.jsonl"
        t1 = time.time()
        r = subprocess.run([sys.executable, "/opt/tier2b_llama.py", "--model", M, "--server", f"{BIN}/llama-server",
                            "--ncmoe", "0", "--mtp", "0", "--budget", str(b), "--extra-args", json.dumps(RESIDENT),
                            "--out", path], env={**os.environ, "TIER2B_DIR": POOL})
        vol.commit()
        out[str(b)] = {"exit": r.returncode, "minutes": round((time.time() - t1) / 60, 1), **summarize(path)}
        print(json.dumps({str(b): out[str(b)]}), flush=True)
    secs = time.time() - t0
    return {"results": out, "job_minutes": round(secs / 60, 1), "cost_usd_est": round(secs * RATE, 2)}


@app.local_entrypoint()
def teacher_test(budgets: str = "0,2048"):
    print(json.dumps(teacher.remote([int(b) for b in budgets.split(",")]), indent=1))
