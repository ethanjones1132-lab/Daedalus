"""The Laya partner's rule, selection, offline simulation and fitting (Laya partner spec §3.2-3.3, §5).

Pure functions on plain dicts, no models. records() joins the two nested runs from playbook_tier2b.py with Laya's
labels from laya_partner.py into one record per task-trial:
  rec  = {"task", "category", "trial", "probe_secs", "classify_secs",
          "suites": {"r8s0": {"secs"}, "r8s1": {...}, "prs0": {...}},
          "cands": {"r8": [cand x 8], "pr": [cand x 3]}}
  cand = {"run", "cand", "secs", "compiles", "imports", "graded_ok", "self": {suite: {test: passed}},
          "p": calibrated P(correct) or None, "verify_secs"}
  card = {"kind", "unseen", "p_little", "p_alot", "effort_top"}   (laya_calibrate.calibrate_card)
Cost is model seconds: Qwen generation, probe execution and Laya calls.

usage: playbook.py fit --trials NESTED.jsonl --labels LABELS.jsonl --calib CALIB.json --out RULE.json
       playbook.py report --trials NESTED.jsonl --labels LABELS.jsonl --calib CALIB.json --rule RULE.json
                          [--live c3=LIVE.jsonl ...] [--out REPORT.json]
"""
import argparse
import collections
import itertools
import json
import math
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from laya_calibrate import calibrate_card, platt_apply, read_jsonl  # noqa: E402

PLAYBOOKS = ("S", "P", "R", "PR", "R8")
SUITES = {"S": (), "P": (), "R": ("r8s0",), "PR": ("prs0",), "R8": ("r8s0", "r8s1")}
NEVER = 2.0  # a cutoff no probability reaches
GRID = (0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, NEVER)
T_HI = (0.5, 0.6, 0.7, 0.8, 0.9, NEVER)
T_LO = (-1.0, 0.1, 0.2, 0.3, 0.4)


def choose(card, rule):
    """Spec §3.2. The form is fixed; only the cutoffs in `rule` are fitted. No card (Laya failed) -> recipe."""
    if card is None:
        return "R"
    if card["unseen"] >= rule["c_u"]:
        return "P" if card["effort_top"] == 0 else "PR"
    if card["p_little"] >= rule["c_easy"]:
        return "S"
    if card["p_alot"] >= rule["c_hard"]:
        return "R8"
    return "R"


def pick(cands, suites, p=None):
    """Most self-tests passed in `suites` (only candidates that compile and import), then Laya's P(correct), then
    the largest group with the same pass pattern, then the lowest candidate index. p(c) is called only for the
    candidates tied at the top pass count, when there is more than one. With p None this is
    bestofn_tier2b.pick(cands, "selftest") restricted to `suites`."""
    ok = [c for c in cands if c["compiles"] and c["imports"]]
    if not ok:
        return cands[0]
    keys = sorted({(s, n) for c in ok for s in suites for n in c["self"].get(s, {})})

    def vec(c):
        return tuple(c["self"].get(s, {}).get(n, False) for s, n in keys)

    groups = collections.Counter(vec(c) for c in ok)
    top = max(sum(vec(c)) for c in ok)
    tied = [c for c in ok if sum(vec(c)) == top]
    pv = {id(c): p(c) for c in tied} if p is not None and len(tied) > 1 else {}
    return max(ok, key=lambda c: (sum(vec(c)), pv.get(id(c), -1.0), groups[vec(c)], -c["cand"]))


def allpass(c, suite):
    res = c["self"].get(suite, {})
    return bool(res) and c["compiles"] and c["imports"] and all(res.values())


def outcome(rec, pb, t_hi=NEVER, t_lo=-1.0, use_p=False):
    """(graded_ok, model secs) of playbook pb on one record (spec §3.2-3.3). use_p False: the plain playbook.
    use_p True: P(correct) breaks ties; R / R8 stop after candidate 0 when it passes every test of the first suite
    and P >= t_hi; S / R / R8 escalate (probe + one fix) when the pick's P < t_lo. Laya is asked only where its
    answer can change the decision, and every ask's time is counted. playbook_tier2b.live_trial does the same live."""
    r8, pr, su = rec["cands"]["r8"], rec["cands"]["pr"], rec["suites"]
    asked = {}

    def p(c):
        asked[(c["run"], c["cand"])] = c.get("verify_secs", 0.0)
        return -1.0 if c.get("p") is None else c["p"]

    if pb in ("R", "R8"):
        c0 = r8[0]
        if use_p and t_hi <= 1.0 and allpass(c0, "r8s0") and p(c0) >= t_hi:
            return c0["graded_ok"], su["r8s0"]["secs"] + c0["secs"] + sum(asked.values())
        cands, suites = (r8[:3] if pb == "R" else r8), SUITES[pb]
        secs = sum(su[s]["secs"] for s in suites) + sum(c["secs"] for c in cands)
    elif pb == "PR":
        cands, suites = pr, SUITES["PR"]
        secs = rec["probe_secs"] + su["prs0"]["secs"] + sum(c["secs"] for c in cands)
    elif pb == "S":
        cands, suites, secs = r8[:1], (), r8[0]["secs"]
    elif pb == "P":
        cands, suites, secs = pr[:1], (), rec["probe_secs"] + pr[0]["secs"]
    else:
        raise ValueError(pb)
    best = pick(cands, suites, p if use_p else None)
    if use_p and t_lo > -1.0 and pb in ("S", "R", "R8") and best.get("p") is not None and p(best) < t_lo:
        extra = dict(pr[0], cand=100)
        secs += rec["probe_secs"] + pr[0]["secs"]
        best = pick(cands + [extra], suites, p)
    return best["graded_ok"], secs + sum(asked.values())


def system(recs, cards, rule, use_p, memo=None):
    """(solved, mean model secs per record) when Laya picks every record's playbook (configurations 3 and 4)."""
    memo = {} if memo is None else memo
    solved = secs = 0.0
    for i, rec in enumerate(recs):
        card = cards.get(rec["task"])
        pb = choose(card, rule)
        key = (i, pb, rule["t_hi"], rule["t_lo"], use_p)
        if key not in memo:
            memo[key] = outcome(rec, pb, rule["t_hi"], rule["t_lo"], use_p)
        ok, s = memo[key]
        solved += ok
        secs += s + (rec["classify_secs"] if card is not None else 0.0)
    return solved, secs / len(recs)


def fixed(recs, pb):
    """(solved, mean model secs) of the plain playbook pb on every record (configurations 1 and 2)."""
    res = [outcome(r, pb) for r in recs]
    return sum(o for o, _ in res), sum(s for _, s in res) / len(res)


def oracle(recs):
    """Configuration 6: per task, the plain playbook that solves the most of its trials, chosen with hindsight."""
    by = collections.defaultdict(list)
    for r in recs:
        by[r["task"]].append(r)
    return sum(max(sum(outcome(r, pb)[0] for r in rs) for pb in PLAYBOOKS) for rs in by.values())


def fit(recs, cards, budget, use_p):
    """(rule, solved, mean secs) solving the most records with mean model secs <= budget (ties: fewer secs), over
    the cutoff grid and, with use_p, the verify thresholds. None when no rule fits the budget."""
    memo, best = {}, None
    thresholds = list(itertools.product(T_HI, T_LO)) if use_p else [(NEVER, -1.0)]
    for c_u, c_easy, c_hard in itertools.product(GRID, GRID, GRID):
        for t_hi, t_lo in thresholds:
            rule = dict(c_u=c_u, c_easy=c_easy, c_hard=c_hard, t_hi=t_hi, t_lo=t_lo)
            solved, secs = system(recs, cards, rule, use_p, memo)
            if secs <= budget and (best is None or (solved, -secs) > (best[1], -best[2])):
                best = (rule, solved, secs)
    return best


def records(trial_rows, label_rows, calib):
    """Join nested-run rows (type "trial") and Laya label rows into (records, calibrated cards)."""
    w, f, pl = calib["classify_wording"], calib["verify_form"], calib["platt"]
    cards, csecs, vp = {}, {}, {}
    for r in label_rows:
        if r["type"] == "card" and r["wording"] == w:
            cards[r["task"]], csecs[r["task"]] = calibrate_card(r["card"], pl), r["secs"]
        elif r["type"] == "verify" and r["form"] == f:
            vp[(r["task"], r["trial"], r["run"], r["cand"])] = (platt_apply(r["p"], pl["verify"]), r["secs"])
    latest = {(t["task"], t["trial"]): t for t in trial_rows if t.get("type") == "trial"}
    recs = []
    for t in latest.values():
        cands = {"r8": [], "pr": []}
        for c in sorted(t["cands"], key=lambda c: c["cand"]):
            p, s = vp.get((t["task"], t["trial"], c["run"], c["cand"]), (None, 0.0))
            row = {k: c[k] for k in ("run", "cand", "secs", "compiles", "imports", "graded_ok", "self")}
            cands[c["run"]].append(dict(row, p=p, verify_secs=s))
        recs.append({"task": t["task"], "category": t["category"], "trial": t["trial"],
                     "probe_secs": t["probe"]["secs_gen"] + t["probe"]["secs_exec"],
                     "classify_secs": csecs.get(t["task"], 0.0),
                     "suites": {k: {"secs": v["secs"]} for k, v in t["suites"].items()}, "cands": cands})
    return recs, cards


def mcnemar_p(b, c):
    """Exact two-sided McNemar test on the discordant pairs b and c."""
    n = b + c
    if n == 0:
        return 1.0
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(min(b, c) + 1)) / 2 ** n)
