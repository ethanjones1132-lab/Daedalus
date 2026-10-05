"""tier2b for gpt-oss-20b keep24 at a given reasoning effort (2026-10-05). It is a wrapper so the JSON
arguments reach tier2b_llama.py intact: queued `cmd /c` lines lose their quote marks.
Config: the speed-lab winner (ncmoe 7, ngram-mod depth 16) at greedy, its best sampling (105 at effort low).
usage: effort_run.py medium|high"""
import json
import subprocess
import sys

effort = sys.argv[1]
S = r"C:\qwen3-forge-stage"
cmd = [S + r"\venv\Scripts\python.exe", S + r"\scripts\tier2b_llama.py",
       "--model", S + r"\models\prune-gptoss20b\gpt-oss-20b-MXFP4-keep24-selfgen.gguf",
       "--server", S + r"\tools\llama-master-836d57176\llama-server.exe",
       "--ncmoe", "7", "--mtp", "16", "--spec-type", "ngram-mod", "--budget", "-1",
       "--chat-kwargs", json.dumps({"reasoning_effort": effort}), "--sampling", json.dumps({"temperature": 0.0}),
       "--out", S + rf"\logs\tier2b-gptoss20b-keep24-effort-{effort}-2026-10-05.jsonl"]
sys.exit(subprocess.run(cmd).returncode)
