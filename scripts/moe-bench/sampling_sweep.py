"""Sampling sweep on tier2b for gpt-oss-20b, Gemma 4 26B-A4B and Qwen3.6 keep96 (2026-10-04).

Each model runs at its speed-lab winner (logs/speedlab-best-<day>.json; every lever in it
is lossless, so speed settings cannot move the score) under:
  base   - temperature 0.2 / top_p 0.95, the t5_tier2b convention used for every run so far
  card   - the model card's recommended sampling
  greedy - temperature 0
Qwen also runs the card settings without presence_penalty (code repeats identifiers).
tier2b is 39 tasks x 3 samples; run-to-run noise is about +-4, so per-category results are
kept with every row. Rows: logs/sampling-results-<day>.jsonl.
usage: sampling_sweep.py [model ...]
"""
import json
import pathlib
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import model_pipeline as mp  # noqa: E402
from speedlab import BEST, MODELS  # noqa: E402

OUT = mp.LOGS / f"sampling-results-{mp.DAY}.jsonl"
BASE = {"temperature": 0.2, "top_p": 0.95}
GREEDY = {"temperature": 0.0}
PLANS = {
    "gptoss20b": dict(budget=-1, chat_kwargs={"reasoning_effort": "low"}, configs={
        "base": BASE, "card": {"temperature": 1.0, "top_p": 1.0}, "greedy": GREEDY}),
    "gemma26b": dict(budget=0, chat_kwargs={}, configs={
        "base": BASE, "card": {"temperature": 1.0, "top_p": 0.95, "top_k": 64}, "greedy": GREEDY}),
    "qwen36keep96": dict(budget=0, chat_kwargs={}, configs={
        "base": BASE,
        "card": {"temperature": 0.7, "top_p": 0.8, "top_k": 20, "min_p": 0.0, "presence_penalty": 1.5},
        "card-nopp": {"temperature": 0.7, "top_p": 0.8, "top_k": 20, "min_p": 0.0},
        "greedy": GREEDY}),
    "gptoss20b-keep24": dict(budget=-1, chat_kwargs={"reasoning_effort": "low"}, configs={
        "base": BASE, "card": {"temperature": 1.0, "top_p": 1.0}, "greedy": GREEDY}),
}


def by_category(path):
    cats = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        r = json.loads(line) if line.strip() else {}
        if "task" in r:
            p, n = cats.get(r["category"], (0, 0))
            cats[r["category"]] = (p + r["ok"], n + 1)
    return {c: f"{p}/{n}" for c, (p, n) in sorted(cats.items())}


def main():
    best = json.loads(BEST.read_text())
    done = set()
    if OUT.exists():
        done = {(json.loads(l)["model"], json.loads(l)["label"]) for l in OUT.read_text(encoding="utf-8").splitlines() if l.strip()}
    server = mp.server_for("master")
    names = [a for a in sys.argv[1:] if a in PLANS] or list(PLANS)
    for name in names:
        if name not in best:
            mp.log(f"  sampling {name}: no speed-lab winner, skipped")
            continue
        w, plan, m = best[name], PLANS[name], MODELS[name]
        for label, sampling in plan["configs"].items():
            if (name, label) in done:
                continue
            out = mp.LOGS / f"tier2b-{name}-samp-{label}-{mp.DAY}.jsonl"
            cmd = [mp.PY, str(pathlib.Path(__file__).with_name("tier2b_llama.py")), "--model", str(m["path"]),
                   "--server", server, "--ncmoe", str(w["ncmoe"]), "--mtp", str(w["depth"] if w["spec"] else 0),
                   "--spec-type", w["spec"] or "none", "--budget", str(plan["budget"]),
                   "--chat-kwargs", json.dumps(plan["chat_kwargs"]), "--extra-args", json.dumps(w["extra"]),
                   "--sampling", json.dumps(sampling), "--out", str(out)]
            if w.get("draft") and w["spec"]:
                cmd += ["--draft-model", w["draft"]]
            mp.log(f"  sampling {name} {label}: {sampling} -> {out.name}")
            p = subprocess.run(cmd, capture_output=True, text=True)
            lines = [l for l in p.stdout.splitlines() if l.startswith("{")]
            summary = json.loads(lines[-1]) if lines else {"error": (p.stderr or p.stdout)[-400:]}
            row = {"model": name, "label": label, "sampling": sampling, "runtime": w,
                   "passed": summary.get("passed"), "total": summary.get("total"),
                   "minutes": summary.get("minutes"), "restarts": summary.get("server_restarts"),
                   "by_category": by_category(out) if out.exists() else None, "results_file": str(out)}
            with OUT.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
            mp.log(f"  sampling {name} {label}: {row['passed']}/{row['total']} in {row['minutes']} min "
                   f"{row['by_category']}")
            time.sleep(30)  # breathing room for C:'s SSD between model loads (see moe_sweep)
    mp.log("sampling sweep done")


if __name__ == "__main__":
    main()
