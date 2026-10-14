"""Closeness to the full 256-expert model (adapters spec §3.3, 2026-10-05).

  heldout  write the fixed held-out file: stdlib modules no task set or calibration text uses, then prose
  ref      llama-perplexity on the full model -> the KL reference (about 0.5 MB per scored token here)
  score    llama-perplexity --kl-divergence on a variant -> JSON (mean KL, 99th-percentile KL, top-token agreement)

usage: kl_eval.py heldout --out heldout.txt
       kl_eval.py ref --model FULL.gguf --text heldout.txt --ref REF.bin
       kl_eval.py score --model VARIANT.gguf --text heldout.txt --ref REF.bin --out KL.json [--ncmoe 0] [--extra JSON]
"""
import argparse
import importlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import time

TOOLS = pathlib.Path(r"C:\qwen3-forge-stage\tools\llama-master-836d57176")
HELDOUT_MODULES = ["wave", "sched", "graphlib", "netrc", "plistlib"]
COMMON = ["-c", "2048", "--chunks", "6", "-ngl", "99", "-b", "2048", "-ub", "512"]
PATTERNS = {"mean_kld": r"Mean\s+KLD:\s+(-?[\d.]+)", "p99_kld": r"99\.0%\s+KLD:\s+(-?[\d.]+)",
            "same_top_p": r"Same top p:\s+([\d.]+)"}


def parse(text):
    out = {}
    for key, pat in PATTERNS.items():
        m = re.search(pat, text)
        out[key] = float(m.group(1)) if m else None
    return out


def heldout(a):
    code = []
    for name in HELDOUT_MODULES:
        code.append(pathlib.Path(importlib.import_module(name).__file__).read_text(encoding="utf-8"))
    from pydoc_data.topics import topics
    prose = "\n\n".join(topics[k] for k in sorted(topics))
    text = "\n".join(code)[:30000] + "\n\n" + prose[:17000]
    pathlib.Path(a.out).write_text(text, encoding="utf-8")
    print(f"held-out text: {len(text)} chars ({len(text) - 17000} code, 17000 prose)")


def free_fraction(path):
    u = shutil.disk_usage(pathlib.Path(path).anchor)
    return u.free / u.total


def run(model, text, extra, ncmoe):
    cmd = [str(TOOLS / "llama-perplexity.exe"), "-m", model, "-f", text, "--n-cpu-moe", str(ncmoe)] + COMMON + extra
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return p.returncode, p.stdout + p.stderr


def ref(a):
    if free_fraction(a.ref) < 0.10:
        sys.exit("refused: under 10% free on the reference's drive")
    code, out = run(a.model, a.text, ["--kl-divergence-base", a.ref], a.ncmoe)
    pathlib.Path(a.ref + ".log").write_text(out, encoding="utf-8")
    if code:
        sys.exit(f"llama-perplexity exited {code}; see {a.ref}.log")
    print(f"reference written ({pathlib.Path(a.ref).stat().st_size / 1e9:.2f} GB); settling 3 minutes")
    time.sleep(180)


def score(a):
    extra = ["--kl-divergence-base", a.ref, "--kl-divergence"] + json.loads(a.extra)
    code, out = run(a.model, a.text, extra, a.ncmoe)
    res = {"model": pathlib.Path(a.model).name, "exit": code, **parse(out)}
    pathlib.Path(a.out).write_text(json.dumps(res, indent=1))
    pathlib.Path(a.out + ".log").write_text(out, encoding="utf-8")
    print(json.dumps(res))


def bench(a):
    """Decode tok/s (llama-bench, 128 tokens, 3 reps, all on the GPU) and file size: the spec's speed and size
    limits. A spill to system RAM shows up as a large slowdown."""
    cmd = [str(TOOLS / "llama-bench.exe"), "-m", a.model, "-ngl", "99", "-fa", "1", "-p", "0", "-n", "128", "-r", "3",
           "-o", "json"]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    try:
        tps = float(json.loads(p.stdout)[0]["avg_ts"])
    except (ValueError, IndexError, KeyError):
        tps = 0.0
    res = {"model": pathlib.Path(a.model).name, "bytes": pathlib.Path(a.model).stat().st_size, "tps": tps}
    pathlib.Path(a.out).write_text(json.dumps(res))
    print(json.dumps(res))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    h = sub.add_parser("heldout")
    h.add_argument("--out", required=True)
    bn = sub.add_parser("bench")
    bn.add_argument("--model", required=True)
    bn.add_argument("--out", required=True)
    r = sub.add_parser("ref")
    s = sub.add_parser("score")
    for p in (r, s):
        p.add_argument("--model", required=True)
        p.add_argument("--text", required=True)
        p.add_argument("--ref", required=True)
        p.add_argument("--ncmoe", type=int, default=22 if p is r else 0)
    s.add_argument("--out", required=True)
    s.add_argument("--extra", default="[]")
    a = ap.parse_args()
    {"heldout": heldout, "ref": ref, "score": score, "bench": bench}[a.cmd](a)


if __name__ == "__main__":
    main()
