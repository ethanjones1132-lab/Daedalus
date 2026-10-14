"""Thinking-budget sweep on tier2b for Qwen3.6 keep96 and Gemma 4 26B-A4B (2026-10-05).

Each model runs at its speed-lab winner (every lever in it is lossless) and its best sampling
from the 2026-10-04 sweep: Qwen at temperature 0.2 / top_p 0.95 (101/117 thinking off), Gemma
greedy (105/117 thinking off). Budgets are llama-server --reasoning-budget values: the server
closes the thinking block after that many tokens, and max_tokens is 2,048 + budget.
On 2026-09-10 Gemma scored 96 thinking off and 105 at a 1,536 budget (an older runtime config).
Rows: logs/thinking-results-<day>.jsonl. Restart-safe: finished (model, budget) pairs are skipped.
usage: thinking_sweep.py [model ...]
"""
import json
import pathlib
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import model_pipeline as mp  # noqa: E402
from sampling_sweep import BASE, GREEDY, by_category  # noqa: E402
from speedlab import MODELS  # noqa: E402

BEST = mp.LOGS / "speedlab-best-2026-10-04.json"  # speedlab.BEST follows today's date; the winners are from 10-04
OUT = mp.LOGS / f"thinking-results-{mp.DAY}.jsonl"
PLANS = {
    "qwen36keep96": dict(sampling=BASE, budgets=[512, 1536, 4096]),
    "gemma26b": dict(sampling=GREEDY, budgets=[512, 1536, 4096]),
}


def main():
    best = json.loads(BEST.read_text())
    done = set()
    if OUT.exists():
        done = {(json.loads(l)["model"], json.loads(l)["budget"]) for l in OUT.read_text(encoding="utf-8").splitlines()
                if l.strip()}
    server = mp.server_for("master")
    names = [a for a in sys.argv[1:] if a in PLANS] or list(PLANS)
    for name in names:
        w, plan, m = best[name], PLANS[name], MODELS[name]
        for budget in plan["budgets"]:
            if (name, budget) in done:
                continue
            out = mp.LOGS / f"tier2b-{name}-think{budget}-{mp.DAY}.jsonl"
            cmd = [mp.PY, str(pathlib.Path(__file__).with_name("tier2b_llama.py")), "--model", str(m["path"]),
                   "--server", server, "--ncmoe", str(w["ncmoe"]), "--mtp", str(w["depth"] if w["spec"] else 0),
                   "--spec-type", w["spec"] or "none", "--budget", str(budget),
                   "--extra-args", json.dumps(w["extra"]), "--sampling", json.dumps(plan["sampling"]),
                   "--out", str(out)]
            if w.get("draft") and w["spec"]:
                cmd += ["--draft-model", w["draft"]]
            mp.log(f"  thinking {name} budget {budget}: {plan['sampling']} -> {out.name}")
            p = subprocess.run(cmd, capture_output=True, text=True)
            lines = [l for l in p.stdout.splitlines() if l.startswith("{")]
            summary = json.loads(lines[-1]) if lines else {"error": (p.stderr or p.stdout)[-400:]}
            row = {"model": name, "budget": budget, "sampling": plan["sampling"], "runtime": w,
                   "passed": summary.get("passed"), "total": summary.get("total"),
                   "minutes": summary.get("minutes"), "restarts": summary.get("server_restarts"),
                   "by_category": by_category(out) if out.exists() else {}, "error": summary.get("error")}
            with OUT.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
            mp.log(f"  thinking {name} budget {budget}: {row['passed']}/{row['total']} in {row['minutes']} min "
                   f"{row['by_category']}")
            time.sleep(30)  # breathing room for the SSD between model loads


if __name__ == "__main__":
    main()
