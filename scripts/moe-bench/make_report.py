"""Collect overnight results into one Markdown table (stdout)."""
import json
import pathlib

LOGS = pathlib.Path(r"C:\qwen3-forge-stage\logs")


def rows(name):
    p = LOGS / name
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()] if p.exists() else []


def median_tokens(results_file):
    p = pathlib.Path(results_file)
    if not p.exists():
        return None
    g = sorted(r["gen_n"] for r in map(json.loads, p.read_text(encoding="utf-8").splitlines())
               if '"task"' in json.dumps(r) and r.get("gen_n"))
    return g[len(g) // 2] if g else None


print("| Model | Placement (CPU expert layers / draft) | Speed (tok/s) | VRAM (MiB) | tier2b (thinking off) | Median answer tokens |")
print("|---|---|---|---|---|---|")
for r in rows("pipeline-results.jsonl"):
    t = r["tier2b"]
    draft = f"draft {r['mtp']}" if r["mtp"] else "no draft"
    print(f"| {r['name']} | {r['ncmoe']} / {draft} | {r['gen_tps_mean']} | {r['vram_mib']} | "
          f"{t.get('passed')}/{t.get('total')} | {median_tokens(r['results_file'])} |")
pr = rows("prune-results.jsonl")
if pr:
    print("\n| Pruning pilot (Qwen3.6-35B-A3B IQ2_M) | Experts | File (GB) | Speed (tok/s) | VRAM (MiB) | tier2b |")
    print("|---|---|---|---|---|---|")
    for r in pr:
        t = r["tier2b"]
        print(f"| {r['name']} | {r['keep'] or 256} | {r['file_gb']} | {r['gen_tps_mean']} | {r['vram_mib']} | "
              f"{t.get('passed')}/{t.get('total')} |")
