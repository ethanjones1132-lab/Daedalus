"""Lean Laya (int8) against fp32, 2026-10-09 (Step 1 item 2).

  bench   a Laya worker per variant (fp32, int8): load seconds, RAM available before and after, the worker's working set
          and private bytes at ready and after N calls, and the latency (p50/p95) of the same classify and verify calls.
  accept  the acceptance test on the calibration pool, from two label files (laya_partner.py label --v3 on the pool, one
          run per variant): hidden-code, library and verify AUC, median |delta p| over every matched probability, and the
          v3 rule's routing on the pool's tasks. Never run on a judge set.

usage: TIER2B_DIR=docs/benchmarks/laya-calib laya_lean_eval.py bench --out BENCH.json [--calls 30]
       laya_lean_eval.py accept --fp32 LABELS.jsonl --lean LABELS.jsonl --trials NESTED.jsonl --calib CALIB.json
                                --rule RULE.json --out ACCEPT.json
"""
import argparse
import json
import os
import pathlib
import statistics
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import laya_calibrate as lc  # noqa: E402
import playbook  # noqa: E402


def pct(v, q):
    v = sorted(v)
    return v[min(len(v) - 1, int(round(q * (len(v) - 1))))]


def make_msgs(nested, n):
    """n worker requests alternating classify and verify, from the calibration pool's tasks and stored candidates
    (TIER2B_DIR must name the pool's task set)."""
    sys.path.insert(0, os.environ["TIER2B_DIR"])
    from runbench2b import baseline_prompt, extract_code
    from tasks import TASKS
    import laya_partner
    cands = laya_partner.run_candidates(pathlib.Path(nested), extract_code)
    by_task = {t["name"]: t for t in TASKS}
    msgs = []
    for i in range(n):
        t = TASKS[(7 * i) % len(TASKS)]
        if i % 2 == 0:
            msgs.append({"op": "classify", "state": baseline_prompt(t)})
        else:
            name, _, _, _, code = cands[(53 * i) % len(cands)]
            msgs.append({"op": "verify", "requirement": by_task[name]["spec"], "entry": by_task[name]["entry"],
                         "code": code})
    return msgs


def bench(a):
    import playbook_tier2b as pt
    msgs = make_msgs(a.nested, a.calls)
    out = {}
    for variant, env in (("fp32", "0"), ("int8", "1")):
        if variant not in a.variants.split(","):
            continue
        os.environ["LAYA_INT8"] = env
        ram0 = pt.available_mb()
        t0 = time.time()
        client = pt.LayaClient(a.calib)
        row = {"variant": variant, "load_s": round(time.time() - t0, 1), "ram_avail_mb_before": ram0,
               "ram_avail_mb_after_load": pt.available_mb(), "ready": client.ready, "dead": client.dead}
        if not client.dead:
            secs, rows = [], []
            for m in msgs:
                rep, wall = client.call(m)
                secs.append(wall)
                rows.append(rep)
            mem, _ = client.call({"op": "mem"})
            row.update(calls=len(secs), ok=sum(bool(r and r.get("ok")) for r in rows), p50_s=round(pct(secs, .5), 3),
                       p95_s=round(pct(secs, .95), 3), mean_s=round(statistics.mean(secs), 3),
                       mem_after_calls=mem, ram_avail_mb_after_calls=pt.available_mb())
            row["answers"] = [{k: r.get(k) for k in ("p", "p_raw", "card")} if r else None for r in rows]
        client.close()
        out[variant] = row
        time.sleep(5)
    pathlib.Path(a.out).write_text(json.dumps(out, indent=1), encoding="utf-8")
    for v, r in out.items():
        print(v, {k: r.get(k) for k in ("load_s", "ram_avail_mb_before", "ram_avail_mb_after_load", "p50_s", "p95_s",
                                        "ok", "calls")}, "ready", r.get("ready"), "after", r.get("mem_after_calls"))


def probs(label_rows):
    """key -> value for every probability the labels hold, keyed so two label files line up."""
    out = {}
    for r in label_rows:
        if r["type"] == "card":
            c, k = r["card"], ("card", r["task"], r["wording"])
            out[k + ("unseen",)] = c["unseen"]
            for name, p in c["kind_p"].items():
                out[k + ("kind", name)] = p
            for i, p in enumerate(c["effort_p"]):
                out[k + ("effort", i)] = p
        elif r["type"] == "verify" and r["p"] is not None:
            out[("verify", r["task"], r["trial"], r["run"], r["cand"], r["form"])] = r["p"]
        elif r["type"] == "valid" and r["p"] is not None:
            out[("valid", r["task"], r["trial"], r["assert"])] = r["p"]
    return out


def measures(labels, trials, cats, cand_ok):
    cards = lc.cards_of(labels, "v1")
    lib = [(c["kind_p"]["library"], cats[t] == "E") for t, c in cards.items() if t in cats]
    return {"hidden_auc": lc.hidden_report(cards, cats, "kind_p")["auc"], "library_auc": lc.pairs_auc(lib),
            "verify_auc": lc.pairs_auc(lc.verify_pairs(labels, cand_ok, "rubric")),
            "valid_auc": lc.pairs_auc(lc.valid_pairs([t for t in trials if t.get("type") == "trial"], labels))}


def accept(a):
    trials = lc.read_jsonl(a.trials)
    calib = json.loads(pathlib.Path(a.calib).read_text(encoding="utf-8"))
    rule = json.loads(pathlib.Path(a.rule).read_text(encoding="utf-8"))["rule"]
    fp, ln = lc.read_jsonl(a.fp32), lc.read_jsonl(a.lean)
    cats, _, _, cand_ok = lc.outcomes(trials, fp)
    m_fp, m_ln = measures(fp, trials, cats, cand_ok), measures(ln, trials, cats, cand_ok)
    pf, pl = probs(fp), probs(ln)
    shared = sorted(set(pf) & set(pl), key=str)
    d = [abs(pf[k] - pl[k]) for k in shared]
    routes = {}
    for name, labels in (("fp32", fp), ("lean", ln)):
        cards = lc.cards_of(labels, calib["classify_wording"])
        routes[name] = {t: playbook.route_v3(lc.calibrate_card(c, calib["platt"], calib.get("hidden_signal", "kind_p")),
                                             rule) for t, c in cards.items()}
    tasks = sorted(set(routes["fp32"]) & set(routes["lean"]))
    same = sum(routes["fp32"][t] == routes["lean"][t] for t in tasks)
    secs = {n: statistics.mean(r["secs"] for r in labs if r["type"] in ("card", "verify", "valid"))
            for n, labs in (("fp32", fp), ("lean", ln))}
    res = {"measures_fp32": m_fp, "measures_lean": m_ln,
           "auc_delta": {k: round(m_ln[k] - m_fp[k], 4) for k in m_fp},
           "matched_probabilities": len(shared), "median_abs_dp": round(statistics.median(d), 5),
           "p95_abs_dp": round(pct(d, .95), 5), "max_abs_dp": round(max(d), 5),
           "routing_tasks": len(tasks), "routing_identical": same, "routing_agreement": round(same / len(tasks), 4),
           "route_counts": {n: {r: sum(v == r for v in rt.values()) for r in sorted(set(rt.values()))}
                            for n, rt in routes.items()},
           "mean_secs_per_call_in_label_run": {k: round(v, 4) for k, v in secs.items()},
           "rows": {"fp32": len(fp), "lean": len(ln)}}
    res["pass"] = {"auc_within_0.02": all(abs(res["auc_delta"][k]) <= 0.02 for k in ("hidden_auc", "library_auc", "verify_auc")),
                   "median_dp_under_0.02": res["median_abs_dp"] < 0.02, "routing_95": res["routing_agreement"] >= 0.95}
    pathlib.Path(a.out).write_text(json.dumps(res, indent=1), encoding="utf-8")
    print(json.dumps(res, indent=1))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("bench")
    b.add_argument("--calib", default="docs/benchmarks/laya3/calib.json")
    b.add_argument("--nested", default="docs/benchmarks/laya3/laya3-calib-nested.jsonl")
    b.add_argument("--calls", type=int, default=30)
    b.add_argument("--variants", default="fp32,int8")
    b.add_argument("--out", required=True)
    c = sub.add_parser("accept")
    for n in ("fp32", "lean", "trials", "calib", "rule", "out"):
        c.add_argument("--" + n, required=True)
    a = ap.parse_args()
    bench(a) if a.cmd == "bench" else accept(a)


if __name__ == "__main__":
    main()
