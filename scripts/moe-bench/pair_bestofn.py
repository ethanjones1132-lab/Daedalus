"""Paired comparison of two bestofn_tier2b run files over the same tasks and seeds (2026-10-06).

For the single shot (candidate 0) and the recipe pick (most self-tests passed, bestofn_tier2b.pick "selftest"),
prints both totals by category, the discordant samples and the exact two-sided McNemar p, the wall time from each
run's .out file, and the tasks where the two differ. No generation; reads stored rows only.

usage: pair_bestofn.py A.jsonl B.jsonl [--names A B]
"""
import argparse
import collections
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from bestofn_tier2b import pick  # noqa: E402
from playbook import mcnemar_p  # noqa: E402


def outcomes(path):
    latest = {}
    for r in map(json.loads, open(path, encoding="utf-8")):
        if r.get("type") == "cand":
            latest[(r["task"], r["trial"], r["cand"])] = r
    by = collections.defaultdict(list)
    for r in latest.values():
        by[(r["task"], r["category"], r["trial"])].append(r)
    out = {}
    for key, cands in by.items():
        cands.sort(key=lambda r: r["cand"])
        out[key] = {"single": bool(cands[0]["graded_ok"]), "recipe": bool(pick(cands, "selftest")["graded_ok"])}
    return out


def wall_secs(path):
    out = pathlib.Path(path).with_suffix(".out")
    if not out.exists():
        return None
    return sum(int(m) for m in re.findall(r"; (\d+) s$", out.read_text(encoding="utf-8", errors="replace"), re.M))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("--names", nargs=2, default=["A", "B"])
    x = ap.parse_args()
    na, nb = x.names
    oa, ob = outcomes(x.a), outcomes(x.b)
    keys = sorted(set(oa) & set(ob))
    print(f"{len(keys)} paired samples ({len(oa)} in {na}, {len(ob)} in {nb})")
    cats = sorted({k[1] for k in keys})
    for pol in ("single", "recipe"):
        ta = collections.Counter(k[1] for k in keys if oa[k][pol])
        tb = collections.Counter(k[1] for k in keys if ob[k][pol])
        only_a = sum(oa[k][pol] and not ob[k][pol] for k in keys)
        only_b = sum(ob[k][pol] and not oa[k][pol] for k in keys)
        print(f"\n{pol}: {na} {sum(ta.values())}  {nb} {sum(tb.values())}   "
              f"{na}-only {only_a}, {nb}-only {only_b}, McNemar p = {mcnemar_p(only_a, only_b):.3f}")
        print("  by category: " + "  ".join(f"{c} {ta[c]}/{tb[c]}" for c in cats))
        tasks = collections.defaultdict(lambda: [0, 0])
        for k in keys:
            tasks[k[0]][0] += oa[k][pol]
            tasks[k[0]][1] += ob[k][pol]
        diff = sorted(((t, v) for t, v in tasks.items() if v[0] != v[1]), key=lambda tv: tv[1][0] - tv[1][1])
        print("  tasks that differ (trials solved): " + ", ".join(f"{t} {v[0]}/{v[1]}" for t, v in diff))
    wa, wb = wall_secs(x.a), wall_secs(x.b)
    if wa and wb:
        print(f"\nsum of per-task-trial seconds: {na} {wa / 60:.1f} min, {nb} {wb / 60:.1f} min")


if __name__ == "__main__":
    main()
