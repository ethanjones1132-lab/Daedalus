"""Markdown tables for the 2026-10-04 final report, built from the result files in logs/.
Prints to stdout; nothing is modified."""
import collections
import json
import pathlib
import statistics as st

LOGS = pathlib.Path(r"C:\qwen3-forge-stage\logs")
DAY = "2026-10-04"


def rows(path):
    p = LOGS / path
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()] if p.exists() else []


def tier2b(path):
    rs = [r for r in rows(path) if "task" in r]
    cat, n = collections.Counter(), collections.Counter()
    for r in rs:
        cat[r["category"]] += r["ok"]
        n[r["category"]] += 1
    summ = [r for r in rows(path) if r.get("summary")]
    return dict(passed=sum(cat.values()), total=len(rs), cats={c: f"{cat[c]}/{n[c]}" for c in sorted(n)},
                minutes=summ[-1].get("minutes") if summ else None,
                median_tokens=st.median([r["gen_n"] or 0 for r in rs]) if rs else None)


def pruning():
    print("### gpt-oss-20b expert pruning (tier2b)\n")
    print("| Variant | Calibration | Score | A | B | C | D | E | Median tokens | Minutes |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for label, calib, f in [("full (32 experts)", "-", f"tier2b-gptoss20b-mxfp4-b-1-{DAY}.jsonl"),
                            ("keep24", "own transcripts", f"tier2b-gptoss20b-keep24-selfgen-b-1-{DAY}.jsonl"),
                            ("keep16", "own transcripts", f"tier2b-gptoss20b-keep16-b-1-{DAY}.jsonl"),
                            ("keep16", "stdlib source (stopped)", f"tier2b-gptoss20b-keep16-code-b-1-{DAY}.jsonl")]:
        t = tier2b(f)
        c = t["cats"]
        print(f"| {label} | {calib} | {t['passed']}/{t['total']} | {c.get('A')} | {c.get('B')} | {c.get('C')} | "
              f"{c.get('D')} | {c.get('E')} | {t['median_tokens']} | {t['minutes']} |")
    print()


def speedlab(name):
    rs = rows(f"speedlab-{name}-{DAY}.jsonl")
    if not rs:
        return
    print(f"### Speed lab: {name}\n")
    print("| Config | CPU layers | Spec | Mean tok/s | Gen | 2k edit | 10k ctx | Prefill 10k | Accept | VRAM MiB | RAM flag |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    for r in rs:
        per = {x["prompt"]: x["gen_tps"] for x in r.get("runs", [])}
        pp = {x["prompt"]: x["prompt_tps"] for x in r.get("runs", [])}
        spec = f"{r.get('spec') or 'none'}" + (f" d{r.get('depth')}" if r.get("spec") else "")
        err = f" ({r['error']})" if r.get("error") else ""
        print(f"| {r['label'][:40]}{err} | {r['ncmoe']} | {spec} | {r.get('gen_tps_mean')} | {per.get('gen')} | "
              f"{per.get('edit2k')} | {per.get('long10k')} | {pp.get('long10k')} | {r.get('draft_accept_rate')} | "
              f"{r.get('vram_delta_mib_peak')} | {'yes' if r.get('paging_risk') else ''} |")
    print()


def sampling():
    rs = rows(f"sampling-results-{DAY}.jsonl")
    if not rs:
        return
    print("### Sampling sweep (tier2b at each speed-lab winner)\n")
    print("| Model | Sampling | Settings | Score | A | B | C | D | E | Minutes |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for r in rs:
        c = r.get("by_category") or {}
        print(f"| {r['model']} | {r['label']} | `{json.dumps(r['sampling'])}` | {r['passed']}/{r['total']} | "
              f"{c.get('A')} | {c.get('B')} | {c.get('C')} | {c.get('D')} | {c.get('E')} | {r['minutes']} |")
    print()


if __name__ == "__main__":
    pruning()
    best = json.loads((LOGS / f"speedlab-best-{DAY}.json").read_text()) if (LOGS / f"speedlab-best-{DAY}.json").exists() else {}
    print("### Speed-lab winners\n")
    print("| Model | Winner | CPU layers | Spec | Extra | Mean tok/s | Base tok/s | Fewer experts (lossy) |")
    print("|---|---|---|---|---|---|---|---|")
    for k, v in best.items():
        f = v.get("lossy_fewer_experts") or {}
        print(f"| {k} | {v['label']} | {v['ncmoe']} | {v['spec']} d{v['depth']} | {' '.join(v['extra']) or '-'} | "
              f"{v['gen_tps_mean']} | {v['base_tps']} | top-{f.get('used')}: {f.get('tps')} |")
    print()
    for name in ("gptoss20b", "gemma26b", "qwen36keep96", "gptoss20b-keep24"):
        speedlab(name)
    sampling()
