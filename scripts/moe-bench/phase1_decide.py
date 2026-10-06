"""The adapters spec's phase-1 decision rules, applied to measured files so the overnight chain decides without
a person (spec §3.3, §3.4, §5; plan Task 8). Every decision is written to D/decisions.json.

  closest  variants within +0.5 GB and >= 95% of keep96's tok/s; the two lowest mean KL go to the pool
  winner   most recipe-solved on the pool, then single-shot, then lower KL, then smaller; must beat keep96's recipe
  config   steering configuration at scale 0.5 with the largest drop in discipline failures (ties: more solved)
  scale    the scale with the fewest failures whose probe solved is not below the no-steering run
  keep     the chosen steering survives only if the pool recipe and single shot do not fall
  prereg   writes the pre-registration (refuses if both arms are null)
  judge    paired McNemar on the judge set, per-category drops, the bar

usage: phase1_decide.py STEP --dir D [--logs L]
"""
import argparse
import collections
import datetime
import json
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
VARIANTS = ("swap96", "add108", "swap108")
CONFIGS = ("mean-all", "mean-mid", "pca-all", "pca-mid")
SCALES = ("0.25", "0.5", "1.0")


def load(d):
    p = d / "decisions.json"
    return json.loads(p.read_text()) if p.exists() else {}


def save(d, dec):
    (d / "decisions.json").write_text(json.dumps(dec, indent=1))


def recipe_scores(path):
    """(recipe solved, single-shot solved, {(task, trial): (s_ok, r_ok)}) from a bestofn_tier2b.py file."""
    os.environ.setdefault("TIER2B_DIR", str(HERE.parent / "benchmark-tier2b"))
    import bestofn_tier2b as bon
    latest = {}
    for r in map(json.loads, open(path, encoding="utf-8")):
        if r.get("type") == "cand":
            latest[(r["task"], r["trial"], r["cand"])] = r
    by = collections.defaultdict(list)
    for r in latest.values():
        by[(r["task"], r["trial"])].append(r)
    per = {}
    for k, cands in by.items():
        cands.sort(key=lambda r: r["cand"])
        per[k] = (bool(cands[0]["graded_ok"]), bool(bon.pick(cands, "selftest")["graded_ok"]))
    return sum(v[1] for v in per.values()), sum(v[0] for v in per.values()), per


def discipline_counts(path):
    sys.path.insert(0, os.environ["TIER2B_DIR"])
    from runbench2b import extract_code
    import steer
    tasks = steer.tasks_by_name()
    rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    bad = sum(not steer.discipline(tasks[r["task"]], extract_code(r["answer"]))[0] for r in rows)
    return bad, sum(r["ok"] for r in rows)


def closest(a, d, dec):
    base = json.loads((d / "bench-keep96.json").read_text())
    ok = []
    for v in VARIANTS:
        if not ((d / f"bench-{v}.json").exists() and (d / f"kl-{v}.json").exists()):
            dec.setdefault("variants", {})[v] = {"fits": False, "missing": True}  # refused or failed: not measured
            continue
        b, k = json.loads((d / f"bench-{v}.json").read_text()), json.loads((d / f"kl-{v}.json").read_text())
        fits = b["bytes"] - base["bytes"] <= 0.5e9 and b["tps"] >= 0.95 * base["tps"] and k["mean_kld"] is not None
        dec.setdefault("variants", {})[v] = {**b, **k, "fits": fits}
        if fits:
            ok.append((k["mean_kld"], v))
    dec["closest"] = [v for _, v in sorted(ok)[:2]]
    print("closest:", dec["closest"])


def winner(a, d, dec):
    L = pathlib.Path(a.logs)
    r0, s0, _ = recipe_scores(L / "adapters-pool-keep96.jsonl")
    dec["pool"] = {"keep96": {"recipe": r0, "single": s0}}
    best = None
    for v in dec["closest"]:
        r, s, _ = recipe_scores(L / f"adapters-pool-{v}.jsonl")
        dec["pool"][v] = {"recipe": r, "single": s}
        key = (r, s, -dec["variants"][v]["mean_kld"], -dec["variants"][v]["bytes"])
        if best is None or key > best[0]:
            best = (key, v)
    dec["winner"] = best[1] if best and best[0][0] > r0 else None
    print("pool:", dec["pool"], "winner:", dec["winner"])


T = os.environ.get("STEER_TAG", "")  # "-<variant>" when the sweep runs on a winning variant (run_phase1.ps1)


def config(a, d, dec):
    L = pathlib.Path(a.logs)
    base_bad, base_ok = discipline_counts(L / f"adapters-steer{T}-none.jsonl")
    dec["steer_base"] = T.lstrip("-") or "keep96"
    dec["steer"] = {"none": {"failures": base_bad, "solved": base_ok}}
    best = None
    for c in CONFIGS:
        p = L / f"adapters-steer{T}-{c}-0.5.jsonl"
        if not p.exists():
            continue
        bad, ok = discipline_counts(p)
        dec["steer"][f"{c}-0.5"] = {"failures": bad, "solved": ok}
        if bad < base_bad and (best is None or (base_bad - bad, ok) > best[0]):
            best = ((base_bad - bad, ok), c)
    dec["steer_config"] = best[1] if best else None
    print("steering:", dec["steer"], "config:", dec["steer_config"])


def scale(a, d, dec):
    L = pathlib.Path(a.logs)
    c, base = dec["steer_config"], dec["steer"]["none"]
    best = None
    for s in SCALES:
        p = L / f"adapters-steer{T}-{c}-{s}.jsonl"
        if not p.exists():
            continue
        bad, ok = discipline_counts(p)
        dec["steer"][f"{c}-{s}"] = {"failures": bad, "solved": ok}
        if bad < base["failures"] and ok >= base["solved"] and (best is None or (bad, -ok) < best[0]):
            best = ((bad, -ok), s)
    dec["steer_scale"] = best[1] if best else None
    print("scale:", dec["steer_scale"])


def keep(a, d, dec):
    L = pathlib.Path(a.logs)
    base = dec["pool"][dec["winner"] or "keep96"]
    r, s, _ = recipe_scores(L / f"adapters-pool-steer{T}.jsonl")
    dec["pool"]["steer"] = {"recipe": r, "single": s}
    dec["steer_final"] = (f"{dec['steer_config']}@{dec['steer_scale']}"
                          if r >= base["recipe"] and s >= base["single"] else None)
    print("steering kept:", dec["steer_final"])


def prereg(a, d, dec):
    if not dec.get("winner") and not dec.get("steer_final"):
        sys.exit("both arms null: no judge run (spec §3.4)")
    text = f"""# Adapters phase 1: pre-registration

- **Committed:** {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}, before any adapters judge run.
- **Spec:** `2026-10-05-adapters-design.md` §5. **Plan:** `plans/2026-10-05-adapters-phase1.md`.

**The patch:**
- expert variant: `{dec.get('winner') or 'keep96 (expert arm null)'}`
- steering vector: `{dec.get('steer_final') or 'none'}` (method-layers@relative scale; the applied scale is the relative scale times the method's unit, {json.loads((d / 'steer-units.json').read_text()) if (d / 'steer-units.json').exists() else 'units not recorded'})

**Chosen on the calibration pool only.** The numbers are in `docs/benchmarks/adapters/decisions.json`.

**The bar:**
- the patched recipe (3 candidates + 1 self-test suite, temperatures 0.2 / 0.7 / 0.7, the recipe's seeds) solves more of the sealed judge set's 180 samples than keep96's recipe, in a paired exact McNemar test (p < 0.10);
- tok/s at least 95% of keep96's;
- the patch at most +0.5 GB;
- no category drops by more than 3 of its 36 samples.

**Baseline:** keep96's recipe on the judge set, run by this chain with the same harness and seeds. It is paired per (task, trial). Sub-project A can reuse it.
"""
    (HERE.parents[1] / "docs" / "superpowers" / "specs" / "2026-10-05-adapters-prereg.md").write_text(text, encoding="utf-8")
    print(text)


def judge(a, d, dec):
    from playbook import mcnemar_p
    L = pathlib.Path(a.logs)
    rb, sb, base = recipe_scores(L / "adapters-judge-keep96.jsonl")
    rp, sp, patch = recipe_scores(L / "adapters-judge-patch.jsonl")
    keys = sorted(set(base) & set(patch))
    b = sum(patch[k][1] and not base[k][1] for k in keys)
    c = sum(base[k][1] and not patch[k][1] for k in keys)
    cats = collections.Counter()
    sys.path.insert(0, os.environ["TIER2B_DIR"])
    from tasks import TASKS
    cat_of = {t["name"]: t["category"] for t in TASKS}
    for k in keys:
        cats[cat_of[k[0]]] += int(patch[k][1]) - int(base[k][1])
    p = mcnemar_p(b, c)
    v = dec.get("variants", {}).get(dec.get("winner") or "", {})
    tps_ok = (not v) or v["tps"] >= 0.95 * json.loads((d / "bench-keep96.json").read_text())["tps"]
    dec["judge"] = {"keep96": {"recipe": rb, "single": sb}, "patch": {"recipe": rp, "single": sp},
                    "patch_better": b, "keep96_better": c, "mcnemar_p": round(p, 4), "category_delta": dict(cats),
                    "bar_met": rp > rb and p < 0.10 and min(cats.values(), default=0) >= -3 and tps_ok}
    print(json.dumps(dec["judge"], indent=1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["closest", "winner", "config", "scale", "keep", "prereg", "judge"])
    ap.add_argument("--dir", required=True)
    ap.add_argument("--logs", default=r"C:\qwen3-forge-stage\logs")
    a = ap.parse_args()
    d = pathlib.Path(a.dir)
    dec = load(d)
    globals()[a.step](a, d, dec)
    save(d, dec)


if __name__ == "__main__":
    main()
