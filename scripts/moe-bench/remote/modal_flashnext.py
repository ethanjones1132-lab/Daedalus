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
vol = modal.Volume.from_name("flashnext", create_if_missing=True)
app = modal.App("flashnext-expert-usage", image=image)


def sh(cmd, log=None):
    print("$", " ".join(cmd), flush=True)
    if log:
        with open(log, "w") as f:
            r = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT)
        print("".join(open(log).readlines()[-15:]), flush=True)
        if r.returncode:
            raise RuntimeError(f"{cmd[0]} exited {r.returncode}; see {log}")
    else:
        subprocess.run(cmd, check=True)


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


@app.local_entrypoint()
def main(prompts: int = 96, parallel: int = 4):
    print(json.dumps(measure.remote(prompts, parallel), indent=1))
