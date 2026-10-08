"""The Laya partner's rule, selection, offline simulation and fitting (Laya partner spec §3.2-3.3, §5).

Pure functions on plain dicts, no models. records() joins the two nested runs from playbook_tier2b.py with Laya's
labels from laya_partner.py into one record per task-trial:
  rec  = {"task", "category", "trial", "probe_secs", "classify_secs",
          "suites": {"r8s0": {"secs"}, "r8s1": {...}, "prs0": {...}},
          "cands": {"r8": [cand x 8], "pr": [cand x 3]}}
  cand = {"run", "cand", "secs", "compiles", "imports", "graded_ok", "self": {suite: {test: passed}},
          "p": calibrated P(correct) or None, "verify_secs"}
  card = {"kind", "unseen", "p_little", "p_alot", "effort_top", "hidden"}   (laya_calibrate.calibrate_card)
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
    """Spec §3.2. The form is fixed; only the cutoffs in `rule` are fitted. No card (Laya failed) -> recipe.
    form "targeted" (spec 2026-10-06-laya-v2-design.md §2): P when Laya's hidden-code signal clears c_hidden,
    else R."""
    if card is None:
        return "R"
    if rule.get("form") == "targeted":
        return "P" if card["hidden"] >= rule["c_hidden"] else "R"
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


def decile_grid(values):
    """Cutoff candidates for the targeted form: the 0th..90th percentile values (one per task) plus NEVER."""
    v = sorted(values)
    return tuple(sorted({v[int(len(v) * i / 10)] for i in range(10)})) + (NEVER,)


def fit_targeted(recs, cards, budget, use_p):
    """Spec v2 §2: (rule, solved, mean secs) over c_hidden in the decile grid of the cards' hidden signal (and,
    with use_p, the verify thresholds); same objective as fit(). None when no rule fits the budget."""
    memo, best = {}, None
    thresholds = list(itertools.product(T_HI, T_LO)) if use_p else [(NEVER, -1.0)]
    for c in decile_grid([cd["hidden"] for cd in cards.values()]):
        for t_hi, t_lo in thresholds:
            rule = dict(form="targeted", c_hidden=c, t_hi=t_hi, t_lo=t_lo)
            solved, secs = system(recs, cards, rule, use_p, memo)
            if secs <= budget and (best is None or (solved, -secs) > (best[1], -best[2])):
                best = (rule, solved, secs)
    return best


def records(trial_rows, label_rows, calib):
    """Join nested-run rows (type "trial") and Laya label rows into (records, calibrated cards)."""
    w, f, pl = calib["classify_wording"], calib["verify_form"], calib["platt"]
    hs = calib.get("hidden_signal", "noul")
    cards, csecs, vp = {}, {}, {}
    for r in label_rows:
        if r["type"] == "card" and r["wording"] == w:
            cards[r["task"]], csecs[r["task"]] = calibrate_card(r["card"], pl, hs), r["secs"]
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


def task_sign(pairs):
    """pairs: [(task, a_ok, b_ok)] per trial -> (tasks a solved more trials of, tasks b did, exact sign-test p).
    A task's trials are correlated, so the task is the unit here (owner's bar, 2026-10-06)."""
    per = collections.defaultdict(lambda: [0, 0])
    for task, a_ok, b_ok in pairs:
        per[task][0] += bool(a_ok)
        per[task][1] += bool(b_ok)
    wins = sum(a > b for a, b in per.values())
    losses = sum(a < b for a, b in per.values())
    return wins, losses, mcnemar_p(wins, losses)


def by_category(rows_ok):
    """rows_ok: [(category, ok)] -> {category: solved}."""
    res = collections.Counter()
    for cat, ok in rows_ok:
        res[cat] += ok
    return dict(sorted(res.items()))


def fit_cmd(a):
    if getattr(a, "form", None) == "v3":
        calib = json.loads(pathlib.Path(a.calib).read_text(encoding="utf-8"))
        recs, cards = records_v3(read_jsonl(a.trials), read_jsonl(a.labels), calib)
        budget = fixed(recs, "R")[1]
        best = fit_v3(recs, cards, budget)
        if best is None:
            sys.exit(f"no v3 rule fits the recipe's {budget:.2f} s budget")
        rule, solved, secs = best
        out = {"budget_secs": round(budget, 3), "records": len(recs), "form": "v3",
               "grid": {"hidden": list(decile_grid([c["hidden"] for c in cards.values()])),
                        "library": list(decile_grid([c.get("library", 0.0) for c in cards.values()]))},
               "rule": rule, "fit": {"solved": solved, "mean_secs": round(secs, 3), "routes": dict(
                   collections.Counter(route_v3(cards.get(r["task"]), rule) for r in recs))},
               "ablations": {n: dict(zip(("solved", "mean_secs"), system_v3(recs, cards, rule, dict(FULL, **ch))))
                             for n, ch in ABLATIONS.items()},
               "calib_pool": {pb: fixed(recs, pb)[0] for pb in PLAYBOOKS}}
        pathlib.Path(a.out).write_text(json.dumps(out, indent=1), encoding="utf-8")
        print(json.dumps(out, indent=1))
        return
    calib = json.loads(pathlib.Path(a.calib).read_text(encoding="utf-8"))
    recs, cards = records(read_jsonl(a.trials), read_jsonl(a.labels), calib)
    budget = fixed(recs, "R")[1]
    form = getattr(a, "form", None) or "targeted"
    out = {"budget_secs": round(budget, 3), "records": len(recs), "form": form}
    if form == "targeted":
        out["grid"] = list(decile_grid([cd["hidden"] for cd in cards.values()]))
    for name, use_p in (("verify", True), ("noverify", False)):
        best = fit_targeted(recs, cards, budget, use_p) if form == "targeted" else fit(recs, cards, budget, use_p)
        if best is None:
            sys.exit(f"no {name} rule fits the recipe's {budget:.2f} s budget")
        rule, solved, secs = best
        out[name] = rule
        out[f"{name}_fit"] = {"solved": solved, "mean_secs": round(secs, 3), "playbooks": dict(
            collections.Counter(choose(cards.get(r["task"]), rule) for r in recs))}
    out["calib_pool"] = {pb: fixed(recs, pb)[0] for pb in PLAYBOOKS}
    out["calib_pool"].update(oracle=oracle(recs), n=len(recs))
    pathlib.Path(a.out).write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(json.dumps(out, indent=1))


def report_cmd(a):
    """Configurations 1, 2 and 6 from the judge set's nested runs, 3-5 from the live files, and the bar (spec §5)."""
    calib = json.loads(pathlib.Path(a.calib).read_text(encoding="utf-8"))
    rules = json.loads(pathlib.Path(a.rule).read_text(encoding="utf-8"))
    recs, cards = records(read_jsonl(a.trials), read_jsonl(a.labels), calib)
    base = {(r["task"], r["trial"]): bool(outcome(r, "R")[0]) for r in recs}
    res = {"n": len(recs)}
    for label, play in (("c1_single", "S"), ("c2_recipe", "R")):
        solved, secs = fixed(recs, play)
        res[label] = {"solved": solved, "mean_secs": round(secs, 3),
                      "by_category": by_category((r["category"], outcome(r, play)[0]) for r in recs)}
    res["c6_oracle"] = {"solved": oracle(recs)}
    sim = system(recs, cards, rules["verify"], True)
    res["c4_simulated"] = {"solved": sim[0], "mean_secs": round(sim[1], 3)}
    live = {}
    for spec in a.live:
        label, path = spec.split("=", 1)
        rows = {(r["task"], r["trial"]): r for r in read_jsonl(path) if r.get("type") == "live"}
        live[label] = rows
        res[label] = {"solved": sum(r["graded_ok"] for r in rows.values()), "n": len(rows),
                      "mean_secs": round(sum(r["model_secs"] for r in rows.values()) / max(len(rows), 1), 3),
                      "by_category": by_category((r["category"], r["graded_ok"]) for r in rows.values()),
                      "playbooks": dict(collections.Counter(r["playbook"] for r in rows.values())),
                      "early_stops": sum(r["early_stop"] for r in rows.values()),
                      "escalations": sum(r["escalated"] for r in rows.values()),
                      "laya_fallbacks": sum(not r["laya_ok"] for r in rows.values())}
    if "c4" in live:
        rows4 = live["c4"]
        b = sum(1 for k, r in rows4.items() if k in base and r["graded_ok"] and not base[k])
        c = sum(1 for k, r in rows4.items() if k in base and not r["graded_ok"] and base[k])
        p = mcnemar_p(b, c)
        # The owner's bar (2026-10-06): the per-sample McNemar AND an exact sign test over tasks, both p < 0.10.
        tw, tl, tp = task_sign((k[0], r["graded_ok"], base[k]) for k, r in rows4.items() if k in base)
        res["bar"] = {"c4_only": b, "recipe_only": c, "mcnemar_p": p,
                      "tasks_c4_better": tw, "tasks_recipe_better": tl, "task_sign_p": tp,
                      "c4_secs": res["c4"]["mean_secs"], "recipe_secs": res["c2_recipe"]["mean_secs"],
                      "met": res["c4"]["solved"] > res["c2_recipe"]["solved"] and p < 0.10 and tp < 0.10
                      and res["c4"]["mean_secs"] <= res["c2_recipe"]["mean_secs"]}
    if a.out:
        pathlib.Path(a.out).write_text(json.dumps(res, indent=1), encoding="utf-8")
    print(json.dumps(res, indent=1))


# ---- Laya v3 (spec 2026-10-07-laya-v3-design.md) ----
EVIDENCE_NONE = "none"
V3_NOTE = (0.3, 0.5, 0.7, NEVER)
V3_VALID = (0.3, 0.5, 0.7, NEVER)
V3_T_HI = (0.5, 0.6, 0.7, 0.8, 0.9, NEVER)
V3_T_LO = (-1.0, 0.2, 0.4, 0.6)
FULL = dict(use_a=True, repair="gate", use_c=True, lib_gate=True, old_probe=False, v1_route=True)
ABLATIONS = {"no_A": {"use_a": False}, "no_B": {"repair": "always"}, "no_check": {"repair": "never"},
             "no_C": {"use_c": False}, "no_lib_gate": {"lib_gate": False}, "old_probe": {"old_probe": True},
             "no_v1_route": {"v1_route": False}}


def route_v3(card, rule):
    """§3: the probe path P3 when the hidden-code signal clears c_hidden and the library signal is below c_lib.
    Amendment 2026-10-08 (prereg): otherwise v1's probe P when the signal clears c_probe, else the recipe. No v3
    rule without it fit the recipe's seconds on the pool; a rule without c_probe routes as first specified."""
    if card is None:
        return "R"
    if card["hidden"] >= rule["c_hidden"] and card.get("library", 0.0) < rule["c_lib"]:
        return "P3"
    return "P" if card["hidden"] >= rule.get("c_probe", NEVER) else "R"


def probe_outcome_v3(rec, rule, use_a=True, repair="gate"):
    """(graded_ok, model secs) of the probe path. repair: "gate" (B), "always" (no gate) or "never" (no check)."""
    p3 = rec["p3"]
    ev, fixes = p3.get("evidence"), p3["fixes"]
    secs = p3["probe_secs"] + (p3.get("evidence_secs") or 0.0)
    noted = (use_a and ev is not None and ev["choice"] != EVIDENCE_NONE and len(fixes) > 1
             and ev["probabilities"].get(ev["choice"], 0.0) >= rule["c_note"])
    f = fixes[1] if noted else fixes[0]
    secs += f["secs"]
    if repair == "never":
        return f["graded_ok"], secs
    secs += p3["examples_secs"]
    failing = [i for i, ok in enumerate(f["asserts_ok"]) if not ok]
    if not failing or f.get("repair") is None:
        return f["graded_ok"], secs
    if repair == "gate":
        secs += sum(p3["valid_secs"][i] for i in failing)
        if not any(p3["valid_p"][i] is not None and p3["valid_p"][i] >= rule["c_valid"] for i in failing):
            return f["graded_ok"], secs
    return f["repair"]["graded_ok"], secs + f["repair"]["secs"]


def recipe_outcome_v3(rec, rule, use_p=True, use_c=True):
    """(graded_ok, model secs) of the recipe path: v2's early stop, then C (escalate to all 8 candidates and the
    second suite when the pick's P(correct) < t_lo or, with e_fail, when it fails any of its own self-tests)."""
    r8, su = rec["cands"]["r8"], rec["suites"]
    asked = {}

    def p(c):
        asked[(c["run"], c["cand"])] = c.get("verify_secs", 0.0)
        return -1.0 if c.get("p") is None else c["p"]

    c0 = r8[0]
    if use_p and rule["t_hi"] <= 1.0 and allpass(c0, "r8s0") and p(c0) >= rule["t_hi"]:
        return c0["graded_ok"], su["r8s0"]["secs"] + c0["secs"] + sum(asked.values())
    cands, secs = r8[:3], su["r8s0"]["secs"] + sum(c["secs"] for c in r8[:3])
    best = pick(cands, ("r8s0",), p if use_p else None)
    low = use_p and rule["t_lo"] > -1.0 and best.get("p") is not None and p(best) < rule["t_lo"]
    failing = rule.get("e_fail", True) and not allpass(best, "r8s0")
    if use_c and (low or failing):
        secs += su["r8s1"]["secs"] + sum(c["secs"] for c in r8[3:])
        best = pick(r8, ("r8s0", "r8s1"), p if use_p else None)
    return best["graded_ok"], secs + sum(asked.values())


def outcome_v3(rec, card, rule, flags=FULL):
    r = dict(rule)
    if not flags["lib_gate"]:
        r["c_lib"] = NEVER
    if not flags.get("v1_route", True):
        r["c_probe"] = NEVER
    play = route_v3(card, r)
    if play == "P3":
        if flags["old_probe"]:
            return outcome(rec, "P")
        return probe_outcome_v3(rec, rule, flags["use_a"], flags["repair"])
    if play == "P":
        return outcome(rec, "P")
    return recipe_outcome_v3(rec, rule, True, flags["use_c"])


def system_v3(recs, cards, rule, flags=FULL):
    solved = secs = 0.0
    for rec in recs:
        card = cards.get(rec["task"])
        ok, s = outcome_v3(rec, card, rule, flags)
        solved += ok
        secs += s + (rec["classify_secs"] if card is not None else 0.0)
    return solved, secs / len(recs)


def fit_v3(recs, cards, budget):
    """§4: the most solved within budget (ties: fewer secs), using that the probe outcome depends only on
    (c_note, c_valid), the recipe outcome only on (t_hi, t_lo, e_fail), and the route only on (c_hidden, c_lib,
    c_probe). c_probe (amendment 2026-10-08) shares c_hidden's grid; v1's probe outcome has no parameters.
    Exact ties (a setting that no routed record uses) go to the probe and recipe settings that score best on their
    own over the whole pool (most solved, then fewer secs), not to the loop order."""
    base = dict(form="v3", c_hidden=0.0, c_lib=NEVER)
    cls = [rec["classify_secs"] if cards.get(rec["task"]) is not None else 0.0 for rec in recs]
    probe = {(n, v): [probe_outcome_v3(r, dict(base, c_note=n, c_valid=v)) if r.get("p3") else (False, 0.0)
                      for r in recs]
             for n in V3_NOTE for v in V3_VALID}
    recipe = {(h, l, e): [recipe_outcome_v3(r, dict(base, t_hi=h, t_lo=l, e_fail=e)) for r in recs]
              for h in V3_T_HI for l in V3_T_LO for e in (True, False)}
    own = lambda res: (sum(x[0] for x in res), -sum(x[1] for x in res))  # noqa: E731
    pscore = {k: own(v) for k, v in probe.items()}
    rscore = {k: own(v) for k, v in recipe.items()}
    oldp = [outcome(r, "P") for r in recs]
    hid = decile_grid([c["hidden"] for c in cards.values()])
    lib = decile_grid([c.get("library", 0.0) for c in cards.values()])
    best = None
    for ch in hid:
        for cl in lib:
            for cp in hid:
                route = [route_v3(cards.get(r["task"]), dict(c_hidden=ch, c_lib=cl, c_probe=cp)) for r in recs]
                route = ["R" if x == "P3" and r.get("p3") is None else x for x, r in zip(route, recs)]
                for pk, pv_ in probe.items():
                    for rk, rv in recipe.items():
                        res = [pv_[i] if x == "P3" else oldp[i] if x == "P" else rv[i] for i, x in enumerate(route)]
                        solved = sum(x[0] for x in res)
                        secs = (sum(x[1] for x in res) + sum(cls)) / len(recs)
                        key = (solved, -round(secs, 9), pscore[pk], rscore[rk])
                        if secs <= budget and (best is None or key > best[3]):
                            best = (dict(form="v3", c_hidden=ch, c_lib=cl, c_probe=cp, c_note=pk[0], c_valid=pk[1],
                                         t_hi=rk[0], t_lo=rk[1], e_fail=rk[2]), solved, secs, key)
    return best and best[:3]


def tier2b_guard(pairs):
    """§6 guard: pairs [(task, v3_ok, recipe_ok)] per trial; fails when the recipe wins on tasks at p < 0.10."""
    w, l, p = task_sign(pairs)
    return {"tasks_v3_better": w, "tasks_recipe_better": l, "task_sign_p": p, "fails": l > w and p < 0.10}


def records_v3(trial_rows, label_rows, calib):
    """records() plus each row's p3 block, with Laya's calibrated P(valid) per example assert."""
    recs, cards = records(trial_rows, label_rows, calib)
    pv_ = {(r["task"], r["trial"], r["assert"]): (platt_apply(r["p"], calib["platt"].get("valid", [1.0, 0.0])),
                                                  r["secs"])
           for r in label_rows if r["type"] == "valid"}
    rows = {(t["task"], t["trial"]): t for t in trial_rows if t.get("type") == "trial"}
    for rec in recs:
        p3 = rows[(rec["task"], rec["trial"])].get("p3")
        if not p3:
            continue
        pr = p3["probe"]
        n = len(p3["examples"]["asserts"])
        rec["p3"] = {
            "probe_secs": pr["secs_gen"] + pr["secs_exec"] + pr.get("secs_retry_gen", 0.0) + pr.get("secs_retry_exec", 0.0),
            "evidence": p3.get("evidence"), "evidence_secs": p3.get("evidence_secs") or 0.0,
            "examples_secs": p3["examples"]["secs"], "asserts": p3["examples"]["asserts"],
            "valid_p": [pv_.get((rec["task"], rec["trial"], i), (None, 0.0))[0] for i in range(n)],
            "valid_secs": [pv_.get((rec["task"], rec["trial"], i), (None, 0.0))[1] for i in range(n)],
            "fixes": [{"graded_ok": f["graded_ok"], "secs": f["secs"], "asserts_ok": f["asserts_ok"],
                       "repair": ({"graded_ok": f["repair"]["graded_ok"], "secs": f["repair"]["secs"]}
                                  if f.get("repair") else None)} for f in p3["fixes"]]}
    return recs, cards


def report_v3_cmd(a):
    """Spec v3 §6: configurations 1, 2 and 6, v2 and v3 simulated, the ablations, live v3, and the bar."""
    calib = json.loads(pathlib.Path(a.calib).read_text(encoding="utf-8"))
    rule = json.loads(pathlib.Path(a.rule).read_text(encoding="utf-8"))["rule"]
    trials, labels = read_jsonl(a.trials), read_jsonl(a.labels)
    recs, cards = records_v3(trials, labels, calib)
    res = {"n": len(recs)}
    for label, play in (("c1_single", "S"), ("c2_recipe", "R")):
        solved, secs = fixed(recs, play)
        res[label] = {"solved": solved, "mean_secs": round(secs, 3),
                      "by_category": by_category((r["category"], outcome(r, play)[0]) for r in recs)}
    res["c6_oracle"] = {"solved": oracle(recs)}
    v2c = json.loads(pathlib.Path(a.v2_calib).read_text(encoding="utf-8"))
    v2r = json.loads(pathlib.Path(a.v2_rule).read_text(encoding="utf-8"))
    r2, k2 = records(trials, labels, v2c)
    res["v2_simulated"] = dict(zip(("solved", "mean_secs"), system(r2, k2, v2r["verify"], True)))
    res["v3_simulated"] = dict(zip(("solved", "mean_secs"), system_v3(recs, cards, rule)))
    res["ablations"] = {n: dict(zip(("solved", "mean_secs"), system_v3(recs, cards, rule, dict(FULL, **ch))))
                        for n, ch in ABLATIONS.items()}
    rows = {(r["task"], r["trial"]): r for r in read_jsonl(a.live) if r.get("type") == "live"}
    res["v3_live"] = {"solved": sum(r["graded_ok"] for r in rows.values()), "n": len(rows),
                      "mean_secs": round(sum(r["model_secs"] for r in rows.values()) / max(len(rows), 1), 3),
                      "by_category": by_category((r["category"], r["graded_ok"]) for r in rows.values()),
                      **{k: sum(bool(r.get(f)) for r in rows.values()) for k, f in
                         (("notes", "note"), ("repairs", "repaired"), ("escalations", "escalated"),
                          ("early_stops", "early_stop"))},
                      "probe_routes": sum(r["playbook"] == "P3" for r in rows.values()),
                      "v1_probe_routes": sum(r["playbook"] == "P" for r in rows.values()),
                      "laya_fallbacks": sum(not r["laya_ok"] for r in rows.values())}
    # the bar (owner, 2026-10-07): solves more, McNemar and task sign test both p < 0.10, no more model secs,
    # and the tier2b guard
    base = {(r["task"], r["trial"]): bool(outcome(r, "R")[0]) for r in recs}
    b = sum(1 for k, r in rows.items() if k in base and r["graded_ok"] and not base[k])
    c = sum(1 for k, r in rows.items() if k in base and not r["graded_ok"] and base[k])
    tw, tl, tp = task_sign((k[0], r["graded_ok"], base[k]) for k, r in rows.items() if k in base)
    import pair_bestofn
    t2 = pair_bestofn.outcomes(a.tier2b_recipe)
    t2_rec = {(k[0], k[2]): v["recipe"] for k, v in t2.items()}
    t2_rows = {(r["task"], r["trial"]): r for r in read_jsonl(a.tier2b_live) if r.get("type") == "live"}
    guard = tier2b_guard((k[0], r["graded_ok"], t2_rec[k]) for k, r in t2_rows.items() if k in t2_rec)
    live_secs = sum(r["model_secs"] for r in rows.values()) / max(len(rows), 1)
    met = (sum(r["graded_ok"] for r in rows.values()) > sum(base.values()) and mcnemar_p(b, c) < 0.10 and tp < 0.10
           and live_secs <= res["c2_recipe"]["mean_secs"] and not guard["fails"])
    res["bar"] = {"v3_only": b, "recipe_only": c, "mcnemar_p": mcnemar_p(b, c), "tasks_v3_better": tw,
                  "tasks_recipe_better": tl, "task_sign_p": tp, "v3_secs": live_secs,
                  "recipe_secs": res["c2_recipe"]["mean_secs"], "tier2b_guard": guard, "met": met}
    if a.out:
        pathlib.Path(a.out).write_text(json.dumps(res, indent=1), encoding="utf-8")
    print(json.dumps(res, indent=1))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("fit", "report"):
        s = sub.add_parser(name)
        s.add_argument("--trials", required=True)
        s.add_argument("--labels", required=True)
        s.add_argument("--calib", required=True)
        if name == "fit":
            s.add_argument("--out", required=True)
            s.add_argument("--form", choices=["targeted", "v1", "v3"], default="targeted")
        else:
            s.add_argument("--rule", required=True)
            s.add_argument("--live", action="append", default=[])
            s.add_argument("--out")
    r3 = sub.add_parser("report-v3")
    for arg in ("--trials", "--labels", "--calib", "--rule", "--live", "--tier2b-live", "--tier2b-recipe", "--v2-calib",
                "--v2-rule"):
        r3.add_argument(arg, required=True)
    r3.add_argument("--out")
    a = ap.parse_args()
    if a.cmd == "report-v3":
        report_v3_cmd(a)
    else:
        fit_cmd(a) if a.cmd == "fit" else report_cmd(a)


if __name__ == "__main__":
    main()
