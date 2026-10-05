"""Per-task table for the fresh hidden-package validation runs."""
import collections
import json

L = r"C:\qwen3-forge-stage\logs"
RUNS = {"qwen single": "valb-qwen36keep96-single", "gemma single": "valb-gemma26b-greedy",
        "qwen probe": "valb-probe-qwen36keep96", "gemma probe": "valb-probe-gemma26b"}
res = {}
for label, base in RUNS.items():
    c = collections.Counter()
    for line in open(rf"{L}\{base}-2026-10-05.jsonl", encoding="utf-8"):
        r = json.loads(line)
        if "task" in r:
            c[r["task"]] += r["ok"]
    res[label] = c
tasks = sorted({t for c in res.values() for t in c})
print(f"{'task':24s} " + " ".join(f"{k:>12s}" for k in RUNS))
for t in tasks:
    print(f"{t:24s} " + " ".join(f"{res[k][t]:>10d}/3" for k in RUNS))
print(f"{'total':24s} " + " ".join(f"{sum(res[k].values()):>9d}/36" for k in RUNS))
bon = collections.defaultdict(list)
for line in open(rf"{L}\valb-bestofn-keep96-recipe-2026-10-05.jsonl", encoding="utf-8"):
    r = json.loads(line)
    if r.get("type") == "cand":
        bon[(r["task"], r["trial"])].append(r["graded_ok"])
print(f"qwen best-of-N recipe: oracle {sum(any(v) for v in bon.values())}/36 (self-test pick 10/36, single 10/36)")
