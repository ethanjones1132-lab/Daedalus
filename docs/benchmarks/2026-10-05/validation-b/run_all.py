"""Run the fresh hidden-package validation set (12 tasks x 3 samples) through the same harnesses and
speed-lab configs as tier2b: Qwen3.6 keep96 single shot (0.2), Gemma 26B greedy single shot, and the
Qwen best-of-N recipe (3 candidates, 1 self-test suite). TIER2B_DIR points the harnesses here."""
import json
import os
import subprocess
import sys

S = r"C:\qwen3-forge-stage"
MB = r"C:\Projects\home-base-recovered\.claude\worktrees\micro-agent-swarm-design-929d42\scripts\moe-bench"
PY = S + r"\venv\Scripts\python.exe"
SERVER = S + r"\tools\llama-master-836d57176\llama-server.exe"
env = {**os.environ, "TIER2B_DIR": S + r"\validation-b"}
best = json.load(open(S + r"\logs\speedlab-best-2026-10-04.json"))
jobs = [
    [PY, MB + r"\tier2b_llama.py", "--model", S + r"\models\prune-qwen36\Qwen3.6-35B-A3B-UD-IQ2_M-keep96.gguf",
     "--server", SERVER, "--ncmoe", "0", "--mtp", "2", "--spec-type", "draft-mtp,ngram-mod", "--budget", "0",
     "--sampling", json.dumps({"temperature": 0.2, "top_p": 0.95}),
     "--out", S + r"\logs\valb-qwen36keep96-single-2026-10-05.jsonl"],
    [PY, MB + r"\tier2b_llama.py", "--model", S + r"\google_gemma-4-26B-A4B-it-IQ2_M.gguf",
     "--server", SERVER, "--ncmoe", str(best["gemma26b"]["ncmoe"]), "--mtp", "2", "--spec-type", "draft-mtp,ngram-mod",
     "--draft-model", best["gemma26b"]["draft"], "--budget", "0", "--sampling", json.dumps({"temperature": 0.0}),
     "--out", S + r"\logs\valb-gemma26b-greedy-2026-10-05.jsonl"],
    [PY, MB + r"\bestofn_tier2b.py", "run", "--model", "qwen36keep96", "--n", "3", "--suites", "1", "--trials", "3",
     "--temp-alt", "0.7", "--out", S + r"\logs\valb-bestofn-keep96-recipe-2026-10-05.jsonl"],
]
code = 0
for cmd in jobs:
    print("$", " ".join(cmd[1:3]), cmd[-1], flush=True)
    code |= subprocess.run(cmd, env=env).returncode
sys.exit(code)
