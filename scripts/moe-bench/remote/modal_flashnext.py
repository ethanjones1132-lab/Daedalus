"""Modal app: measure Qwen3.8-Flash-Next (ISTA GSQ-RCO Coder, 256 of 512 experts) expert usage
on an L40S 48 GB (2026-10-04; Novita had no GPUs, and Modal offers no RTX 5090).

    python -m modal run --detach scripts/moe-bench/remote/modal_flashnext.py
    python -m modal volume get flashnext results <local dir>

- Image: llama.cpp's official full-cuda image, b11382 (CUDA 12.8), pinned by digest. It is
  one commit after 836d57176 = b11381, the build behind every local result, and that commit
  only touches the WebGPU backend. Compiling 836d57176 on Modal's image builder ran at about
  2% a minute (~50 min), so the prebuilt image replaced it.
- The Coder GGUF pair (58.4 GB) downloads to the container's local disk on each run. The
  volume "flashnext" keeps the work: calib/ (transcripts, resumable), the imatrix, and
  results/ (expert-usage-summary.json and friends).
- The 28.8 GB n-gram (PLE) table is an input tensor, so llama.cpp keeps it in CPU memory
  even with -ngl 99. "--load-mode none --lazy-mode off" reads it into RAM once instead of
  faulting rows in per token; the 29.6 GB transformer shard goes to the GPU.
  (This build has no --no-mmap; --load-mode none replaced it.)
- Cost at list price: L40S $1.95/h + 8 cores $0.38/h + 64 GiB $0.51/h, about $2.85/h.
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time

import modal

REPO = "ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF"
# ghcr.io/ggml-org/llama.cpp:full-cuda as of 2026-10-04, linux/amd64 manifest (b11382, rev 11fe02151)
LLAMA_IMAGE = "ghcr.io/ggml-org/llama.cpp@sha256:3e57be4957bb34ab46a7a5e18165177d1356ac5ffb7b9a553f5b74b1788d17a5"
HERE = pathlib.Path(__file__).parent
W = "/vol"
MD = "/model"
M = f"{MD}/IQ1_M/Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M-00001-of-00002.gguf"
BIN = "/app"
RESIDENT = "--load-mode none --lazy-mode off"

image = (
    modal.Image.from_registry(LLAMA_IMAGE, add_python="3.12")  # 3.12: same prompt set as the local test
    .entrypoint([])
    .pip_install("huggingface_hub[hf_xet]", "gguf", "numpy")
    .env({"HF_XET_HIGH_PERFORMANCE": "1", "HF_HUB_DISABLE_PROGRESS_BARS": "1", "LD_LIBRARY_PATH": "/app"})
    .add_local_file(HERE / "flashnext_calib.py", "/opt/flashnext_calib.py")
)
# tier2b on the L40S: the slicer, the harness and the benchmark itself (stdlib-only tests)
bench_image = (
    image.add_local_file(HERE.parent / "slice_experts.py", "/opt/slice_experts.py")
    .add_local_file(HERE.parent / "tier2b_llama.py", "/opt/tier2b_llama.py")
    .add_local_dir(HERE.parents[1] / "benchmark-tier2b", "/opt/benchmark-tier2b")
)
vol = modal.Volume.from_name("flashnext", create_if_missing=True)
app = modal.App("flashnext-expert-usage", image=image)


def sh(cmd, log=None, env=None):
    print("$", " ".join(cmd), flush=True)
    env = {**os.environ, **(env or {})}
    if log:
        with open(log, "w") as f:
            r = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT, env=env)
        print("".join(open(log).readlines()[-15:]), flush=True)
        if r.returncode:
            raise RuntimeError(f"{cmd[0]} exited {r.returncode}; see {log}")
    else:
        subprocess.run(cmd, check=True, env=env)


def rows(path):
    return sum(1 for l in open(path) if l.strip()) if os.path.exists(path) else 0


@app.function(gpu="L40S", volumes={W: vol}, timeout=2 * 3600, cpu=8, memory=64 * 1024)
def measure(prompts: int = 96, parallel: int = 4):
    from huggingface_hub import snapshot_download

    t0 = time.time()
    sh(["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"])
    snapshot_download(REPO, allow_patterns=["IQ1_M/*", "tensor-allocation/*", "README.md"], local_dir=MD, max_workers=16)
    print(f"model downloaded in {time.time() - t0:.0f} s", flush=True)

    calib = f"{W}/calib"
    if not (os.path.exists(f"{calib}/calib.txt") and rows(f"{calib}/transcripts.jsonl") >= prompts):
        try:
            sh([sys.executable, "/opt/flashnext_calib.py", "gen", "--server", f"{BIN}/llama-server", "--model", M,
                "--out", calib, "--prompts", str(prompts), "--parallel", str(parallel), f"--server-args={RESIDENT}"])
        except Exception:
            print("".join(open(f"{calib}/server.log").readlines()[-40:]), flush=True)
            raise
        finally:
            vol.commit()
    print(f"calibration ready at {time.time() - t0:.0f} s ({rows(f'{calib}/transcripts.jsonl')} transcripts)", flush=True)

    imx = f"{W}/imatrix-flashnext-coder.gguf"
    if not os.path.exists(imx):
        try:
            sh([f"{BIN}/llama-imatrix", "-m", M, "-f", f"{calib}/calib.txt", "-o", imx, "--parse-special",
                "-c", "2048", "-b", "2048", "-ngl", "99"] + RESIDENT.split(), log=f"{W}/imatrix.log")
        finally:
            vol.commit()
    print(f"imatrix ready at {time.time() - t0:.0f} s", flush=True)

    res = f"{W}/results"
    sh([sys.executable, "/opt/flashnext_calib.py", "summarize", "--imatrix", imx, "--out", res])
    for f in [imx, f"{W}/imatrix.log", f"{calib}/transcripts.jsonl", f"{calib}/server.log",
              *map(str, pathlib.Path(f"{MD}/tensor-allocation").glob("*"))]:
        if os.path.isfile(f):
            shutil.copy(f, f"{res}/")
    vol.commit()
    s = json.load(open(f"{res}/expert-usage-summary.json"))
    return {"minutes": round((time.time() - t0) / 60, 1), "experts_per_layer": s["experts_per_layer"],
            "layers": s["layers"], "energy_kept": s["energy_kept"]}


@app.function(gpu="L40S", volumes={W: vol}, timeout=2 * 3600, cpu=8, memory=64 * 1024, image=bench_image)
def tier2b(keep: int):
    """Slice to `keep` experts (256 = the release as is) and score it on tier2b: 39 tasks x 3 samples,
    temperature 0.2 / top-p 0.95, thinking off, no speculation (the model has no MTP head)."""
    from huggingface_hub import snapshot_download

    t0 = time.time()
    tag = f"keep{keep}"
    snapshot_download(REPO, allow_patterns=["IQ1_M/*"], local_dir=MD, max_workers=16)
    print(f"[{tag}] model downloaded in {time.time() - t0:.0f} s", flush=True)
    res = f"{W}/tier2b"
    os.makedirs(res, exist_ok=True)
    model = M
    if keep < 256:  # the slice keeps the split name, next to a link to the untouched n-gram shard
        d = f"/work/{tag}"
        os.makedirs(d, exist_ok=True)
        model = f"{d}/{os.path.basename(M)}"
        shard2 = M.replace("00001-of-00002", "00002-of-00002")
        if not os.path.exists(f"{d}/{os.path.basename(shard2)}"):
            os.symlink(shard2, f"{d}/{os.path.basename(shard2)}")
        sh([sys.executable, "/opt/slice_experts.py", M, model, "--keep", str(keep),
            "--imatrix", f"{W}/imatrix-flashnext-coder.gguf", "--report", f"{res}/{tag}-experts.json"],
           env={"PYTHONPATH": "/app/gguf-py"})  # PyPI gguf lacks Q2_0
        print(f"[{tag}] sliced to {os.path.getsize(model) / 1e9:.2f} GB at {time.time() - t0:.0f} s", flush=True)
    out = f"{res}/flashnext-coder-{tag}.jsonl"
    try:
        sh([sys.executable, "/opt/tier2b_llama.py", "--model", model, "--server", f"{BIN}/llama-server",
            "--ncmoe", "0", "--mtp", "0", "--extra-args", json.dumps(RESIDENT.split()), "--out", out],
           env={"TIER2B_DIR": "/opt/benchmark-tier2b"})
    finally:
        vol.commit()
    rows = [json.loads(l) for l in open(out) if l.strip()]
    s = [r for r in rows if r.get("summary")][-1]
    by_cat = {}
    for r in rows:
        if "task" in r:
            c = by_cat.setdefault(r["category"], [0, 0])
            c[0] += r["ok"]
            c[1] += 1
    gen = [r for r in rows if r.get("gen_n")]
    tps = sum(r["gen_n"] for r in gen) / max(sum(r["secs"] for r in gen), 1e-9)
    return {"keep": keep, "passed": s["passed"], "total": s["total"], "minutes": s["minutes"],
            "by_category": {k: f"{v[0]}/{v[1]}" for k, v in sorted(by_cat.items())},
            "tok_s_incl_tests": round(tps, 1), "job_minutes": round((time.time() - t0) / 60, 1)}


@app.local_entrypoint()
def main(prompts: int = 96, parallel: int = 4):
    print(json.dumps(measure.remote(prompts, parallel), indent=1))


@app.local_entrypoint()
def bench(keeps: str = "96,256"):
    """python -m modal run --detach modal_flashnext.py::bench   (one L40S container per expert count)"""
    for r in tier2b.map([int(k) for k in keeps.split(",")], return_exceptions=True):
        print(json.dumps(r) if isinstance(r, dict) else f"FAILED: {r!r}", flush=True)
