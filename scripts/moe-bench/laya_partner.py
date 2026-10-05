"""Laya beside Qwen3.6 keep96: classify a task, verify one candidate file (Laya partner spec §3, §6, 2026-10-05).

Laya (convaiinnovations/laya, 421M ModernBERT) is used as shipped, on the CPU. Two wordings of the task questions
and two forms of the verify question are defined here; laya_calibrate.py picks one of each on the calibration pool,
never on tier2b or the judge set. Inputs longer than the English checkpoint's 512 tokens go to typed-decisions
(1,024 tokens); longer than that get no answer.

  worker  JSON lines for playbook_tier2b.py, model loaded once. Requests:
            {"op": "ping"} | {"op": "classify", "state": text} | {"op": "verify", "requirement", "entry", "code"}
          The first line out is {"ok": true, "ready": true}; every request gets one line back with "secs".
  label   every wording and form in batch: a card per task in TIER2B_DIR and P(correct) per stored candidate
          (rows of type "trial" from playbook_tier2b.py nested, or "cand" from bestofn_tier2b.py). Resumable.

usage: laya_partner.py worker [--calib CALIB.json]
       laya_partner.py label --runs RUNS.jsonl --out LABELS.jsonl      (TIER2B_DIR = the runs' task set)
"""
import argparse
import json
import os
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from laya_calibrate import IDENTITY, calibrate_card, platt_apply  # noqa: E402

REPO_ID = "convaiinnovations/laya"
CLASSIFY = {
    "v1": {
        "kind": {"type": "choice", "instructions": "What kind of fix is this?",
                 "criteria": {"algorithm": "get an algorithm right", "input": "handle bad or missing input",
                              "files": "read or write files or run processes",
                              "library": "use a library helper correctly",
                              "unseen": "depends on code whose source is not shown"}},
        "unseen": {"type": "noul", "instructions": "The fix depends on how code that is not shown behaves."},
        "effort": {"type": "score", "instructions": "How much reasoning does this fix need?",
                   "criteria": ["little", "some", "a lot"]},
    },
    "v2": {
        "kind": {"type": "choice", "instructions": "Which kind of bug is this?",
                 "criteria": {"algorithm": "wrong logic", "input": "breaks on bad input",
                              "files": "file or process handling", "library": "misuses a library",
                              "unseen": "misreads a module it cannot see"}},
        "unseen": {"type": "noul",
                   "instructions": "Fixing this needs facts about a module whose source is unavailable."},
        "effort": {"type": "score", "instructions": "How hard is this fix?", "criteria": ["easy", "medium", "hard"]},
    },
}
VERIFY = {
    "noul": {"ok": {"type": "noul", "instructions": "The corrected file does what the requirement asks."}},
    "rubric": {"ok": {"type": "choice", "instructions": "Does the corrected file meet the requirement?",
                      "criteria": {"meets": "yes, it does what the requirement asks",
                                   "misses": "no, it still misses the requirement"}}},
}


def verify_state(requirement, entry, code):
    return f"Requirement: {requirement}\n\nCorrected {entry}:\n```python\n{code}\n```"


class Laya:
    def __init__(self):
        os.environ.setdefault("USE_TF", "0")
        import laya
        self.laya, self.agents = laya, {}
        self.agent("root")

    def agent(self, name):
        if name not in self.agents:
            kw = {} if name == "root" else {"subfolder": name}
            self.agents[name] = self.laya.load(REPO_ID, device="cpu", **kw)
        return self.agents[name]

    def ask(self, state, questions):
        """(answers, checkpoint), or (None, None) when the input is too long for both checkpoints."""
        for name in ("root", "typed-decisions"):
            r = self.agent(name).predict(state, questions)
            if not r["usage"]["truncated"]:
                return r["answers"], name
        return None, None

    def classify(self, state, wording):
        ans, ckpt = self.ask(state, CLASSIFY[wording])
        if ans is None:
            raise ValueError("task text is too long for Laya")
        ep = ans["effort"]["probabilities"]
        return {"kind": ans["kind"]["choice"], "kind_p": ans["kind"]["probabilities"],
                "unseen": ans["unseen"]["noul"], "effort_p": [ep["0"], ep["1"], ep["2"]], "ckpt": ckpt}

    def verify(self, requirement, entry, code, form):
        """(P(correct), checkpoint), or (None, None) when the input is too long."""
        ans, ckpt = self.ask(verify_state(requirement, entry, code), VERIFY[form])
        if ans is None:
            return None, None
        a = ans["ok"]
        return (a["noul"] if form == "noul" else a["probabilities"]["meets"]), ckpt


def worker(a):
    out = sys.stdout
    sys.stdout = sys.stderr  # anything the libraries print goes to stderr; only our replies use stdout

    def say(obj):
        out.write(json.dumps(obj) + "\n")
        out.flush()

    calib = json.loads(pathlib.Path(a.calib).read_text(encoding="utf-8")) if a.calib else IDENTITY
    lp = Laya()
    lp.classify("Fix solution.py.\n\nRequirement: warm-up.", calib["classify_wording"])  # first call is slow
    say({"ok": True, "ready": True, "wording": calib["classify_wording"], "form": calib["verify_form"]})
    for line in sys.stdin:
        t = time.time()
        try:
            m = json.loads(line)
            if m["op"] == "ping":
                rep = {}
            elif m["op"] == "classify":
                raw = lp.classify(m["state"], calib["classify_wording"])
                rep = {"raw": raw, "card": calibrate_card(raw, calib["platt"])}
            elif m["op"] == "verify":
                p, ckpt = lp.verify(m["requirement"], m["entry"], m["code"], calib["verify_form"])
                rep = {"p_raw": p, "p": platt_apply(p, calib["platt"]["verify"]), "ckpt": ckpt}
            else:
                raise ValueError(f"unknown op {m['op']!r}")
            rep["ok"] = True
        except Exception as e:  # any failure is a fallback for the caller, never a crash of the worker
            rep = {"ok": False, "error": repr(e)[:300]}
        rep["secs"] = round(time.time() - t, 3)
        say(rep)


def run_candidates(path, extract_code):
    """(task, trial, run, cand, code) for every stored candidate; the last copy of a candidate wins."""
    found = {}
    for r in map(json.loads, open(path, encoding="utf-8")):
        if r.get("type") == "trial":
            for c in r["cands"]:
                found[(r["task"], r["trial"], c["run"], c["cand"])] = c["code"]
        elif r.get("type") == "cand":
            found[(r["task"], r["trial"], "bon", r["cand"])] = extract_code(r["content"])
    return [k + (code,) for k, code in sorted(found.items())]


def label(a):
    sys.path.insert(0, os.environ["TIER2B_DIR"])
    from runbench2b import baseline_prompt, extract_code
    from tasks import TASKS
    tasks = {t["name"]: t for t in TASKS}
    out = pathlib.Path(a.out)
    done = set()
    if out.exists():
        for r in map(json.loads, out.read_text(encoding="utf-8").splitlines()):
            done.add(("card", r["task"], r["wording"]) if r["type"] == "card"
                     else ("verify", r["task"], r["trial"], r["run"], r["cand"], r["form"]))
    lp = Laya()
    t0, n = time.time(), 0
    with out.open("a", encoding="utf-8") as f:
        for name, task in tasks.items():
            for w in CLASSIFY:
                if ("card", name, w) not in done:
                    t = time.time()
                    card = lp.classify(baseline_prompt(task), w)
                    f.write(json.dumps({"type": "card", "task": name, "wording": w, "card": card,
                                        "secs": round(time.time() - t, 3)}) + "\n")
        f.flush()
        for name, trial, run, c, code in run_candidates(a.runs, extract_code):
            task = tasks[name]
            for form in VERIFY:
                if ("verify", name, trial, run, c, form) in done:
                    continue
                t = time.time()
                p, ckpt = lp.verify(task["spec"], task["entry"], code, form)
                f.write(json.dumps({"type": "verify", "task": name, "trial": trial, "run": run, "cand": c,
                                    "form": form, "p": p, "ckpt": ckpt, "secs": round(time.time() - t, 3)}) + "\n")
                n += 1
                if n % 100 == 0:
                    f.flush()
                    print(f"{n} verify answers, {time.time() - t0:.0f} s", flush=True)
    print(f"labelled in {time.time() - t0:.0f} s -> {out}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    w = sub.add_parser("worker")
    w.add_argument("--calib")
    lab = sub.add_parser("label")
    lab.add_argument("--runs", required=True)
    lab.add_argument("--out", required=True)
    a = ap.parse_args()
    worker(a) if a.cmd == "worker" else label(a)


if __name__ == "__main__":
    main()
