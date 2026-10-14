"""Calibration math and reports for Laya's answers (Laya partner spec §3, §5, 2026-10-05).

Laya is used as shipped. Only a monotone two-parameter map, a sigmoid with an offset on the logit of each
probability (Platt scaling), is fitted per quantity on the calibration pool. laya.fit_temperatures wants about
100 records per option bucket, more than a 60-task pool gives; jev-swarm found a fitted sigmoid with an offset
is what made Laya's gates usable (eval/ladder/LAYA-L1N.md).

Quantities and their labels:
  unseen         P(the fix depends on unseen code), per task   label: the task is category B
  effort_little  P(effort = little), per task-trial            label: single shot solved that trial
  effort_alot    P(effort = a lot), per task-trial             label: the recipe failed that trial
  verify         P(correct), per candidate                     label: the candidate passes grading

usage: laya_calibrate.py fit --trials NESTED.jsonl --labels LABELS.jsonl --out CALIB.json
       laya_calibrate.py report --trials NESTED.jsonl --labels LABELS.jsonl --calib CALIB.json [--out R.json]
       laya_calibrate.py zeroshot --bestofn BESTOFN.jsonl --labels LABELS.jsonl [--out R.json]
"""
import argparse
import json
import math
import pathlib

EPS = 1e-4
WORDINGS = ("v1", "v2")
FORMS = ("noul", "rubric")
QUANTITIES = ("unseen", "effort_little", "effort_alot", "verify", "valid")
KIND_OF = {"A": "algorithm", "B": "unseen", "C": "input", "D": "files", "E": "library"}
HIDDEN_SIGNALS = ("noul", "kind_p")  # the v2 rule's task signal (spec 2026-10-06-laya-v2-design.md §3)
IDENTITY = {"classify_wording": "v1", "verify_form": "noul", "hidden_signal": "noul",
            "platt": {q: [1.0, 0.0] for q in QUANTITIES}}


def read_jsonl(path):
    return [json.loads(line) for line in open(path, encoding="utf-8") if line.strip()]


def logit(p):
    p = min(max(p, EPS), 1 - EPS)
    return math.log(p / (1 - p))


def sigmoid(z):
    if z >= 0:
        return 1 / (1 + math.exp(-z))
    e = math.exp(z)
    return e / (1 + e)


def auc(pos, neg):
    """P(a random positive scores above a random negative); ties count half. NaN without both classes."""
    if not pos or not neg:
        return float("nan")
    return sum((p > n) + 0.5 * (p == n) for p in pos for n in neg) / (len(pos) * len(neg))


def ece(probs, labels, bins=10):
    """Expected calibration error over equal-width bins."""
    total, err = len(probs), 0.0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        idx = [i for i, p in enumerate(probs) if lo <= p < hi or (b == bins - 1 and p == 1.0)]
        if idx:
            conf = sum(probs[i] for i in idx) / len(idx)
            acc = sum(labels[i] for i in idx) / len(idx)
            err += len(idx) / total * abs(conf - acc)
    return err


def platt_fit(probs, labels, iters=100, l2=1e-3):
    """(a, b) for p' = sigmoid(a * logit(p) + b), by Newton's method with a backtracking line search on the log
    loss. A little L2 pull towards the identity (a = 1, b = 0) keeps one-class or separable samples finite; the
    line search keeps the step sane when a and b are nearly collinear (all probabilities alike)."""
    xs = [logit(p) for p in probs]

    def loss(a, b):
        tot = 0.5 * l2 * ((a - 1) ** 2 + b ** 2)
        for x, y in zip(xs, labels):
            z = a * x + b
            tot += max(z, 0.0) + math.log1p(math.exp(-abs(z))) - y * z
        return tot

    a, b = 1.0, 0.0
    cur = loss(a, b)
    for _ in range(iters):
        ga, gb, haa, hab, hbb = l2 * (a - 1), l2 * b, l2, 0.0, l2
        for x, y in zip(xs, labels):
            q = sigmoid(a * x + b)
            r, w = q - y, q * (1 - q)
            ga, gb = ga + r * x, gb + r
            haa, hab, hbb = haa + w * x * x, hab + w * x, hbb + w
        det = haa * hbb - hab * hab
        if det <= 1e-12:
            break
        da, db = (hbb * ga - hab * gb) / det, (haa * gb - hab * ga) / det
        t = 1.0
        while t > 1e-10 and loss(a - t * da, b - t * db) > cur:
            t /= 2
        a, b = a - t * da, b - t * db
        new_loss = loss(a, b)
        if cur - new_loss < 1e-12:
            break
        cur = new_loss
    return a, b


def platt_apply(p, ab):
    return None if p is None else sigmoid(ab[0] * logit(p) + ab[1])


def calibrate_card(raw, platt, hidden_signal="noul"):
    """Laya's raw task card -> the card the rule reads (playbook.choose). The most likely effort level comes
    from the raw probabilities, so calibrating two of them separately cannot reorder it. `hidden` is the v2 rule's
    raw task signal, used by rank only."""
    ep = raw["effort_p"]
    return {"kind": raw["kind"], "unseen": platt_apply(raw["unseen"], platt["unseen"]),
            "p_little": platt_apply(ep[0], platt["effort_little"]),
            "p_alot": platt_apply(ep[2], platt["effort_alot"]),
            "effort_top": max(range(3), key=lambda i: ep[i]),
            "hidden": hidden_of(raw, hidden_signal), "library": raw.get("kind_p", {}).get("library", 0.0)}


def valid_pairs(trial_rows, label_rows):
    """[(Laya's raw P(valid), the reference passes the assert)] for every labelled example assert (spec v3 §4)."""
    truth = {(t["task"], t["trial"], i): ok for t in trial_rows if t.get("p3")
             for i, ok in enumerate(t["p3"]["asserts_valid"])}
    return [(r["p"], truth[k]) for r in label_rows if r["type"] == "valid" and r["p"] is not None
            and (k := (r["task"], r["trial"], r["assert"])) in truth]


def hidden_of(raw, signal):
    """The yes/no "unseen" probability, or the kind question's probability for the hidden-code option."""
    return raw["kind_p"]["unseen"] if signal == "kind_p" else raw["unseen"]


def pairs_auc(pairs):
    return auc([p for p, y in pairs if y], [p for p, y in pairs if not y])


def _num(x):
    return 0.5 if x != x else x  # NaN (one class only) counts as no separation


def quantities(cards, cats, s_ok, r_ok):
    """name -> [(raw probability, label)] for one wording's raw cards."""
    return {"unseen": [(c["unseen"], cats[t] == "B") for t, c in cards.items() if t in cats],
            "effort_little": [(cards[t]["effort_p"][0], ok) for (t, _), ok in s_ok.items() if t in cards],
            "effort_alot": [(cards[t]["effort_p"][2], not ok) for (t, _), ok in r_ok.items() if t in cards]}


def outcomes(trial_rows, label_rows):
    """Labels from the nested runs: categories, single-shot and recipe outcomes per task-trial, grading per
    candidate."""
    import playbook  # playbook imports this module, so import it here
    recs, _ = playbook.records(trial_rows, label_rows, IDENTITY)
    cats = {r["task"]: r["category"] for r in recs}
    s_ok = {(r["task"], r["trial"]): bool(playbook.outcome(r, "S")[0]) for r in recs}
    r_ok = {(r["task"], r["trial"]): bool(playbook.outcome(r, "R")[0]) for r in recs}
    cand_ok = {(r["task"], r["trial"], c["run"], c["cand"]): c["graded_ok"]
               for r in recs for run in ("r8", "pr") for c in r["cands"][run]}
    return cats, s_ok, r_ok, cand_ok


def verify_pairs(label_rows, cand_ok, form):
    return [(r["p"], cand_ok[k]) for r in label_rows if r["type"] == "verify" and r["form"] == form
            and r["p"] is not None and (k := (r["task"], r["trial"], r["run"], r["cand"])) in cand_ok]


def cards_of(label_rows, wording):
    return {r["task"]: r["card"] for r in label_rows if r["type"] == "card" and r["wording"] == wording}


def hidden_aucs(label_rows, cats, wordings=WORDINGS):
    """(wording, signal) -> AUC of the signal for category-B tasks (spec v2 §3)."""
    out = {}
    for w in wordings:
        cards = cards_of(label_rows, w)
        for s in HIDDEN_SIGNALS:
            out[(w, s)] = pairs_auc([(hidden_of(c, s), cats[t] == "B") for t, c in cards.items() if t in cats])
    return out


def hidden_report(cards, cats, signal):
    """The v2 rule's task signal on a scored set: AUC for category-B tasks (raw cards, one per task)."""
    pairs = [(hidden_of(c, signal), cats[t] == "B") for t, c in cards.items() if t in cats]
    return {"signal": signal, "n": len(pairs), "positives": sum(y for _, y in pairs), "auc": pairs_auc(pairs)}


def kind_accuracy(cards, cats):
    hits = [cards[t]["kind"] == KIND_OF[cats[t]] for t in cards if t in cats]
    return sum(hits) / max(len(hits), 1)


def diagnose(data, platt):
    """Per quantity: n, AUC, and ECE before and after calibration."""
    rep = {}
    for q, v in data.items():
        probs, ys = [p for p, _ in v], [int(y) for _, y in v]
        rep[q] = {"n": len(v), "positives": sum(ys), "auc": pairs_auc(v), "ece_raw": ece(probs, ys),
                  "ece_cal": ece([platt_apply(p, platt[q]) for p in probs], ys)}
    return rep


def fit_cmd(a):
    trials, labels = read_jsonl(a.trials), read_jsonl(a.labels)
    cats, s_ok, r_ok, cand_ok = outcomes(trials, labels)
    wq = {w: quantities(cards_of(labels, w), cats, s_ok, r_ok) for w in WORDINGS}
    wauc = {w: {q: pairs_auc(v) for q, v in wq[w].items()} for w in WORDINGS}
    # v2 (spec 2026-10-06 §3): the wording and signal are chosen together by the rule's one input, the hidden-code
    # signal's AUC for category-B tasks. v1 summed three AUCs and never looked at the kind probabilities.
    hauc = hidden_aucs(labels, cats)
    wording, signal = max(hauc, key=lambda k: _num(hauc[k]))
    vp = {f: verify_pairs(labels, cand_ok, f) for f in FORMS}
    vauc = {f: pairs_auc(vp[f]) for f in FORMS}
    form = max(FORMS, key=lambda f: _num(vauc[f]))
    data = dict(wq[wording], verify=vp[form])
    vpairs = valid_pairs(trials, labels)  # v3: the repair gate's labels
    if vpairs:
        data["valid"] = vpairs
    platt = {q: list(platt_fit([p for p, _ in v], [int(y) for _, y in v])) for q, v in data.items()}
    calib = {"classify_wording": wording, "verify_form": form, "hidden_signal": signal, "platt": platt,
             "report": {"hidden_auc": {f"{w}/{s}": v for (w, s), v in hauc.items()},
                        "wording_auc": wauc, "verify_auc": vauc,
                        "kind_accuracy": {w: kind_accuracy(cards_of(labels, w), cats) for w in WORDINGS},
                        "library_auc": {w: pairs_auc([(c["kind_p"].get("library", 0.0), cats[t] == "E")
                                                      for t, c in cards_of(labels, w).items() if t in cats])
                                        for w in WORDINGS},
                        "chosen": diagnose(data, platt)}}
    pathlib.Path(a.out).write_text(json.dumps(calib, indent=1), encoding="utf-8")
    print(json.dumps(calib, indent=1))


def report_cmd(a):
    """Laya's diagnostics on a scored set, with the committed calibration (judge set: spec §5)."""
    calib = json.loads(pathlib.Path(a.calib).read_text(encoding="utf-8"))
    trials, labels = read_jsonl(a.trials), read_jsonl(a.labels)
    cats, s_ok, r_ok, cand_ok = outcomes(trials, labels)
    cards = cards_of(labels, calib["classify_wording"])
    data = dict(quantities(cards, cats, s_ok, r_ok), verify=verify_pairs(labels, cand_ok, calib["verify_form"]))
    vpairs = valid_pairs(trials, labels)
    if vpairs and "valid" in calib["platt"]:
        data["valid"] = vpairs
    rep = {"hidden": hidden_report(cards, cats, calib.get("hidden_signal", "noul")),
           "diagnostics": diagnose(data, calib["platt"]), "kind_accuracy": kind_accuracy(cards, cats)}
    if a.out:
        pathlib.Path(a.out).write_text(json.dumps(rep, indent=1), encoding="utf-8")
    print(json.dumps(rep, indent=1))


def zeroshot_cmd(a):
    """Zero-shot baseline on tier2b (spec §5), reported once and never used for tuning: both wordings against
    tier2b's categories and a stored best-of-N run (S = candidate 0; R = candidates 0-2 picked on suite s0), both
    verify forms against that run's grading."""
    import collections
    import playbook
    rows = [r for r in read_jsonl(a.bestofn) if r.get("type") == "cand"]
    latest = {(r["task"], r["trial"], r["cand"]): r for r in rows}
    by = collections.defaultdict(list)
    for r in latest.values():
        by[(r["task"], r["trial"])].append(r)
    cats = {r["task"]: r["category"] for r in rows}
    s_ok, r_ok = {}, {}
    for k, cands in by.items():
        cands.sort(key=lambda r: r["cand"])
        s_ok[k] = bool(cands[0]["graded_ok"])
        r_ok[k] = bool(playbook.pick(cands[:3], ("s0",))["graded_ok"])
    cand_ok = {(t, tr, "bon", c): r["graded_ok"] for (t, tr, c), r in latest.items()}
    labels = read_jsonl(a.labels)
    rep = {"tasks": len(cats), "task_trials": len(by), "candidates": len(cand_ok), "wordings": {}, "forms": {}}
    for w in WORDINGS:
        cards = cards_of(labels, w)
        q = quantities(cards, cats, s_ok, r_ok)
        rep["wordings"][w] = {"auc": {k: pairs_auc(v) for k, v in q.items()},
                              "kind_accuracy": kind_accuracy(cards, cats)}
    for f in FORMS:
        v = verify_pairs(labels, cand_ok, f)
        right, wrong = [p for p, y in v if y], [p for p, y in v if not y]
        rep["forms"][f] = {"auc": pairs_auc(v), "n": len(v), "mean_p_right": sum(right) / max(len(right), 1),
                           "mean_p_wrong": sum(wrong) / max(len(wrong), 1)}
    if a.out:
        pathlib.Path(a.out).write_text(json.dumps(rep, indent=1), encoding="utf-8")
    print(json.dumps(rep, indent=1))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fit")
    f.add_argument("--trials", required=True)
    f.add_argument("--labels", required=True)
    f.add_argument("--out", required=True)
    r = sub.add_parser("report")
    r.add_argument("--trials", required=True)
    r.add_argument("--labels", required=True)
    r.add_argument("--calib", required=True)
    r.add_argument("--out")
    z = sub.add_parser("zeroshot")
    z.add_argument("--bestofn", required=True)
    z.add_argument("--labels", required=True)
    z.add_argument("--out")
    a = ap.parse_args()
    {"fit": fit_cmd, "report": report_cmd, "zeroshot": zeroshot_cmd}[a.cmd](a)


if __name__ == "__main__":
    main()
