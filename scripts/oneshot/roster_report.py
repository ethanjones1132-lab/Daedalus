"""Ecosystem Lab results table in round two's format, from a runs directory (dev checks).

One row per model: builds, mean check score (sd), per-build passed checks of 70, apps that run (the page reached tick
200: shots/step200.png exists), the exploratory assembled score, mean generation speed, mean output tokens, finish
reasons, and the placement the fit chose.

usage: roster_report.py RUNS [--models a,b,c] [--set dev]"""
import argparse
import json
import pathlib
import statistics


def load(path):
    p = pathlib.Path(path)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def mean(xs):
    xs = [x for x in xs if x is not None]
    return statistics.mean(xs) if xs else None


def rows(runs, set_name="dev", only=None):
    out = []
    for mdir in sorted(p for p in pathlib.Path(runs).iterdir() if p.is_dir()):
        if only and mdir.name not in only:
            continue
        builds = []
        for b in sorted(p for p in mdir.iterdir() if p.is_dir() and (p / "response.md").exists()):
            chk, asm = load(b / f"checks-{set_name}.json"), load(b / f"checks-{set_name}-assembled.json")
            meta, static = load(b / "meta.json") or {}, load(b / "static.json") or {}
            builds.append({"seed": b.name, "score": chk["score"] if chk else None, "passed": chk["passed"] if chk else None,
                           "assembled": asm["score"] if asm else None, "runs": (b / "shots" / "step200.png").exists(),
                           "tps": meta.get("gen_tps"), "gen_n": meta.get("gen_n"), "finish": meta.get("finish_reason"),
                           "place": (meta.get("fit") or [{}])[-1], "spec": meta.get("spec"), "wall_s": meta.get("wall_s")})
        scored = [b for b in builds if b["score"] is not None]
        if not scored:
            continue
        sc = [b["score"] for b in scored]
        out.append({"model": mdir.name, "n": len(scored), "mean": statistics.mean(sc),
                    "sd": statistics.stdev(sc) if len(sc) > 1 else 0.0, "passed": [b["passed"] for b in scored],
                    "runs": sum(b["runs"] for b in scored), "assembled": mean(b["assembled"] for b in scored),
                    "tps": mean(b["tps"] for b in scored), "gen_n": mean(b["gen_n"] for b in scored),
                    "wall": mean(b["wall_s"] for b in scored),
                    "finish": ", ".join(sorted(f"{k} x{sum(1 for b in scored if b['finish'] == k)}"
                                               for k in {b["finish"] for b in scored})),
                    "place": scored[0]["place"], "spec": scored[0]["spec"]})
    return sorted(out, key=lambda r: -r["mean"])


def fmt(x, nd=0):
    return "—" if x is None else f"{x:.{nd}f}"


def table(rs):
    lines = ["| Model | Builds | Check score, mean (sd) | Passed, per build (of 70) | Apps that run | Assembled score | "
             "Speed (tok/s) | Output tokens | Mean wall (s) | Finish | Placement (ncmoe / ngl) |", "|" + "---|" * 11]
    for r in rs:
        p = r["place"] or {}
        place = f"{p.get('ncmoe', '—')} {r['spec'] or ''}".strip()
        lines.append(f"| {r['model']} | {r['n']} | **{r['mean']:.3f}** ({r['sd']:.2f}) | {', '.join(map(str, r['passed']))} | "
                     f"{r['runs']}/{r['n']} | {fmt(r['assembled'], 3)} | {fmt(r['tps'])} | {fmt(r['gen_n'])} | "
                     f"{fmt(r['wall'])} | {r['finish']} | {place} |")
    return "\n".join(lines)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("runs")
    ap.add_argument("--models", default="")
    ap.add_argument("--set", default="dev")
    a = ap.parse_args()
    print(table(rows(a.runs, a.set, set(a.models.split(",")) if a.models else None)))
