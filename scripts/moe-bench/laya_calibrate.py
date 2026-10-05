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
QUANTITIES = ("unseen", "effort_little", "effort_alot", "verify")
KIND_OF = {"A": "algorithm", "B": "unseen", "C": "input", "D": "files", "E": "library"}
IDENTITY = {"classify_wording": "v1", "verify_form": "noul", "platt": {q: [1.0, 0.0] for q in QUANTITIES}}


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


def calibrate_card(raw, platt):
    """Laya's raw task card -> the card the rule reads (playbook.choose). The most likely effort level comes
    from the raw probabilities, so calibrating two of them separately cannot reorder it."""
    ep = raw["effort_p"]
    return {"kind": raw["kind"], "unseen": platt_apply(raw["unseen"], platt["unseen"]),
            "p_little": platt_apply(ep[0], platt["effort_little"]),
            "p_alot": platt_apply(ep[2], platt["effort_alot"]),
            "effort_top": max(range(3), key=lambda i: ep[i])}
