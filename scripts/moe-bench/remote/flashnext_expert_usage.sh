#!/usr/bin/env bash
# Measure expert usage of Qwen3.8-Flash-Next (ISTA GSQ-RCO Coder GGUF, 256 of 512 experts)
# on one 32 GB GPU (rented RTX 5090, 2026-10-04). On the instance:
#   curl -fsSL https://raw.githubusercontent.com/ethanjones1132-lab/Daedalus/refs/heads/claude/micro-agent-swarm-design-929d42/scripts/moe-bench/remote/flashnext_expert_usage.sh -o run.sh
#   nohup bash run.sh > /workspace/flashnext.out 2>&1 &   tail -f /workspace/flashnext.out
# Stages, each skipped when its output exists (a re-run resumes):
#   build llama.cpp (CUDA, native arch) -> download the GGUF pair (58.4 GB) -> calibration
#   transcripts from the model itself -> llama-imatrix -> expert-usage summary + results.tgz
# Env: WORK (default /workspace/flashnext), NCMOE (CPU expert layers, default 0),
#      LLAMA_REF (llama.cpp commit, default 836d57176 = the build used for every result here).
set -uo pipefail
RAW=${RAW:-https://raw.githubusercontent.com/ethanjones1132-lab/Daedalus/refs/heads/claude/micro-agent-swarm-design-929d42}
WORK=${WORK:-/workspace/flashnext}
LLAMA_REF=${LLAMA_REF:-836d57176}
NCMOE=${NCMOE:-0}
mkdir -p "$WORK" && cd "$WORK" || exit 1
say() { echo "== $(date -u +%H:%M:%S) $*"; }

say "start"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
df -h "$WORK" | tail -1
free -g | head -2

# 0. tools
if ! command -v git >/dev/null || ! command -v cmake >/dev/null; then
  say "installing git/cmake/build tools"
  (apt-get update -y && apt-get install -y git cmake build-essential curl) >/dev/null 2>&1
fi
command -v nvcc >/dev/null || export PATH=/usr/local/cuda/bin:$PATH
if ! nvcc --version | tail -2; then say "no nvcc: this needs a CUDA 12.8+ devel image (RTX 5090 = sm_120)"; exit 1; fi
python3 -m pip install -q -U "huggingface_hub[hf_xet]" gguf numpy

# 1. llama.cpp
BIN=$WORK/llama.cpp/build/bin
if [ ! -x "$BIN/llama-imatrix" ]; then
  say "building llama.cpp $LLAMA_REF"
  [ -d llama.cpp ] || git clone -q https://github.com/ggml-org/llama.cpp
  (cd llama.cpp && git fetch -q origin && git checkout -q "$LLAMA_REF" &&
   cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=native -DLLAMA_CURL=OFF -DCMAKE_BUILD_TYPE=Release > "$WORK/cmake.log" 2>&1 &&
   cmake --build build -j"$(nproc)" --target llama-server llama-imatrix llama-cli > "$WORK/build.log" 2>&1)
fi
[ -x "$BIN/llama-imatrix" ] || { say "build failed; see $WORK/cmake.log and $WORK/build.log"; tail -20 "$WORK/build.log"; exit 1; }
say "llama.cpp ready"

# 2. model
M=$WORK/model/IQ1_M/Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M-00001-of-00002.gguf
if [ ! -f "$WORK/model/.done" ]; then
  say "downloading the Coder GGUF pair (58.4 GB)"
  hf download ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF --include "IQ1_M/*" "tensor-allocation/*" "README.md" \
    --local-dir "$WORK/model" && touch "$WORK/model/.done"
fi
[ -f "$WORK/model/.done" ] || { say "download failed"; exit 1; }
say "model ready: $(du -sh "$WORK/model" | cut -f1)"

# 3. calibration transcripts (the model's own chat-format answers + raw stdlib source)
curl -fsSL "$RAW/scripts/moe-bench/remote/flashnext_calib.py" -o "$WORK/flashnext_calib.py" || exit 1
if [ ! -f "$WORK/calib/calib.txt" ]; then
  say "calibration transcripts (NCMOE=$NCMOE)"
  python3 "$WORK/flashnext_calib.py" gen --server "$BIN/llama-server" --model "$M" --out "$WORK/calib" --ncmoe "$NCMOE" ||
    { say "calibration failed; if the server ran out of VRAM, re-run with NCMOE=4"; tail -30 "$WORK/calib/server.log"; exit 1; }
fi

# 4. imatrix
if [ ! -f "$WORK/imatrix-flashnext-coder.gguf" ]; then
  say "llama-imatrix"
  "$BIN/llama-imatrix" -m "$M" -f "$WORK/calib/calib.txt" -o "$WORK/imatrix-flashnext-coder.gguf" --parse-special \
    -c 2048 -b 2048 -ngl 99 --n-cpu-moe "$NCMOE" > "$WORK/imatrix.log" 2>&1
  tail -5 "$WORK/imatrix.log"
fi
[ -f "$WORK/imatrix-flashnext-coder.gguf" ] || { say "imatrix failed"; tail -30 "$WORK/imatrix.log"; exit 1; }

# 5. summary + bundle
python3 "$WORK/flashnext_calib.py" summarize --imatrix "$WORK/imatrix-flashnext-coder.gguf" --out "$WORK/results"
cp "$WORK/imatrix-flashnext-coder.gguf" "$WORK/calib/transcripts.jsonl" "$WORK/calib/server.log" "$WORK/imatrix.log" "$WORK/results/" 2>/dev/null
cp "$WORK"/model/tensor-allocation/*.txt "$WORK/results/" 2>/dev/null
tar czf "$WORK/results.tgz" -C "$WORK" results
say "done: $WORK/results.tgz ($(du -h "$WORK/results.tgz" | cut -f1))"
