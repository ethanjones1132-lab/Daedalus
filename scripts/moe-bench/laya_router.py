"""Laya as the task router for Qwen3.6 keep96 / Gemma 4 26B (2026-10-05).

Laya (convaiinnovations/laya) makes bounded decisions about one input: a state plus typed
questions in, structured answers with calibrated probabilities out. Here the input is one
tier2b task exactly as the coder sees it (the tier2b prompt), and the decisions are about
that task:
  hidden   noul    does fixing it depend on how code that is not shown behaves?
  effort   score   how much step-by-step reasoning does it need? (little / some / a lot)
  kind     choice  small local fix / logic that needs careful reasoning / depends on unseen code
The routing rule maps those answers to a configuration (a model, thinking budget, best-of-N).
The rule's thresholds are fixed in advance (0.5, the most likely class), not tuned on tier2b,
and Laya is used zero-shot, so the score below is a clean estimate. A trained router would need
disjoint training tasks.

  decide    run Laya on every task, write logs/laya-decisions-<checkpoint>.json
  evaluate  score routes against per-config tier2b results (files given as label=path.jsonl)

usage: laya_router.py decide [--checkpoint typed-decisions|root|multilingual]
       laya_router.py evaluate DECISIONS.json --route RULE label=results.jsonl ...
"""
import argparse
import collections
import json
import os
import pathlib
import sys
import time

BENCH = pathlib.Path(os.environ.get("TIER2B_DIR", r"C:\Projects\home-base-recovered\scripts\benchmark-tier2b"))
sys.path.insert(0, str(BENCH))
from runbench2b import baseline_prompt  # noqa: E402
from tasks import TASKS  # noqa: E402

LOGS = pathlib.Path(r"C:\qwen3-forge-stage\logs")
QUESTIONS = {
    "hidden": {"type": "noul", "instructions": "Does fixing this code depend on how some other code, whose source "
                                               "is not shown, behaves?"},
    "effort": {"type": "score", "instructions": "How much step-by-step reasoning does this fix need?",
               "criteria": ["little: the bug is local and obvious", "some", "a lot: subtle logic or edge cases"]},
    "kind": {"type": "choice", "instructions": "What kind of fix is this?",
             "criteria": {"local": "a small, local change in the code shown",
                          "logic": "logic that needs careful reasoning about behaviour and edge cases",
                          "unseen": "depends on code or an API whose source is not shown"}},
    "files": {"type": "noul", "instructions": "Does this code read or write files on disk?"},
    "library": {"type": "noul", "instructions": "Does the fix depend on using a standard-library module correctly?"},
    "robust": {"type": "noul", "instructions": "Is the bug about handling bad, missing or unusual input without "
                                               "crashing?"},
}
# tier2b categories each signal should pick out (for the zero-shot separation report only)
SIGNALS = {"hidden": "B", "files": "D", "library": "E", "robust": "C"}


def decide(a):
    os.environ.setdefault("USE_TF", "0")
    import laya
    kw = {} if a.checkpoint == "root" else {"subfolder": a.checkpoint}
    agent = laya.load("convaiinnovations/laya", device="cpu", **kw)
    out = {}
    t0 = time.time()
    for task in TASKS:
        state = baseline_prompt(task)
        extra = {"max_len": 8192} if a.checkpoint == "multilingual" else {}
        r = agent.predict(state, QUESTIONS, **extra)["answers"]
        out[task["name"]] = {"category": task["category"], "effort": r["effort"]["score"],
                             "kind": r["kind"]["choice"], "kind_p": r["kind"]["probabilities"],
                             **{k: r[k]["noul"] for k in SIGNALS}}
    path = LOGS / f"laya-decisions-{a.checkpoint}.json"
    path.write_text(json.dumps(out, indent=1))
    print(f"{len(out)} tasks in {time.time() - t0:.0f} s -> {path}")
    for sig, cat in SIGNALS.items():  # how well does each signal separate its category from the rest? (AUC)
        pos = [v[sig] for v in out.values() if v["category"] == cat]
        neg = [v[sig] for v in out.values() if v["category"] != cat]
        auc = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg) / max(len(pos) * len(neg), 1)
        print(f"{sig:8s} vs {cat}: mean P {sum(pos) / len(pos):.3f} on {cat}, {sum(neg) / len(neg):.3f} on others, "
              f"AUC {auc:.3f}")
    kinds = collections.Counter((v["category"], v["kind"]) for v in out.values())
    print("kind by category:", dict(sorted(kinds.items())))


def per_task(path):
    """task -> (passed, samples) for one tier2b-style results file, or for a bestofn file's
    self-test pick (rows of type 'cand')."""
    rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    if any(r.get("type") == "cand" for r in rows):
        sys.path.insert(0, str(pathlib.Path(__file__).parent))
        from bestofn_tier2b import pick
        by = collections.defaultdict(list)
        latest = {(r["task"], r["trial"], r["cand"]): r for r in rows if r.get("type") == "cand"}
        for r in latest.values():
            by[(r["task"], r["trial"])].append(r)
        res = collections.defaultdict(lambda: [0, 0])
        for (task, _), cands in by.items():
            cands.sort(key=lambda r: r["cand"])
            res[task][0] += pick(cands, "selftest")["graded_ok"]
            res[task][1] += 1
        return dict(res)
    res = collections.defaultdict(lambda: [0, 0])
    for r in rows:
        if "task" in r:
            res[r["task"]][0] += r["ok"]
            res[r["task"]][1] += 1
    return dict(res)


def route(rule, d, labels):
    """rule: 'hidden:A|B' -> config B when P(hidden) > 0.5 else A; 'kind:local=A,logic=B,unseen=C';
    'effort:A|B' -> B when effort > 1.0 (past 'some')."""
    kind, spec = rule.split(":", 1)
    if kind == "hidden":
        lo, hi = spec.split("|")
        return hi if d["hidden"] > 0.5 else lo
    if kind == "effort":
        lo, hi = spec.split("|")
        return hi if d["effort"] > 1.0 else lo
    if kind == "kind":
        m = dict(p.split("=") for p in spec.split(","))
        return m[d["kind"]]
    raise ValueError(rule)


def evaluate(a):
    dec = json.loads(pathlib.Path(a.decisions).read_text())
    res = {lab: per_task(p) for lab, p in (s.split("=", 1) for s in a.results)}
    labels = list(res)
    total = {lab: sum(v[0] for v in r.values()) for lab, r in res.items()}
    print("fixed configurations:", ", ".join(f"{lab} {total[lab]}" for lab in labels))
    best = sum(max(res[lab].get(t, [0, 0])[0] for lab in labels) for t in dec)
    print(f"oracle router (best configuration per task, chosen with hindsight): {best}")
    for rule in a.route:
        got, choice = 0, collections.Counter()
        for t, d in dec.items():
            c = route(rule, d, labels)
            choice[c] += 1
            got += res[c].get(t, [0, 0])[0]
        print(f"Laya route {rule}: {got}  (tasks per configuration: {dict(choice)})")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("decide")
    d.add_argument("--checkpoint", default="typed-decisions", choices=["typed-decisions", "root", "multilingual"])
    e = sub.add_parser("evaluate")
    e.add_argument("decisions")
    e.add_argument("--route", action="append", default=[])
    e.add_argument("results", nargs="+")
    a = ap.parse_args()
    decide(a) if a.cmd == "decide" else evaluate(a)


if __name__ == "__main__":
    main()
