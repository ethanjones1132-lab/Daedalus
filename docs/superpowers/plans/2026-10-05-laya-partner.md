# Laya Partner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and judge the system in `docs/superpowers/specs/2026-10-05-laya-partner-design.md`. Laya, as shipped plus calibration, classifies each task, picks one of five playbooks for Qwen3.6 keep96, and verifies candidates, all within the recipe's time budget.

**Architecture:**
- **Pure core.** `laya_calibrate.py` holds the calibration math. `playbook.py` holds the rule, selection, offline simulation, fitting and the report. Both are standard library only and unit-tested.
- **Laya side.** `laya_partner.py` runs in Laya's own venv, as a JSON-lines worker and a batch labeller.
- **Runner.** `playbook_tier2b.py` runs the nested calibration and judge runs and the live configurations. It reuses `bestofn_tier2b` and `probe_tier2b` functions and leaves those scripts unchanged.
- **Task sets.** Two new tier2b-format sets live under `docs/benchmarks/`, selected with the existing `TIER2B_DIR` switch.

**Tech stack:**
- Python 3.12, two venvs:
  - `C:\qwen3-forge-stage\venv`: the runner and tests;
  - `C:\qwen3-forge-stage\venv-laya`: `laya` 0.3.27 and CPU torch.
- `unittest`; neither venv has pytest.
- llama-server 836d571, with Qwen3.6-35B-A3B keep96 as in `bestofn_tier2b.CONFIGS` (deviation 9 records the 2026-10-06 check of swap108 and add108).

---

## Measured while planning (2026-10-05)

- **Laya load and speed.** `laya.load` takes 41 s cold. Warm, `predict` takes 0.35 s per input on the CPU (torch threads 10). `predict_batch` of 3 takes 1.0 s, so batching saves nothing.
- **No CUDA.** Laya's venv has a CPU-only torch (`2.14.1+cpu`).
- **Answer shapes:**
  - `noul` returns `{"noul": p}`;
  - `choice` returns `{"choice", "probabilities": {key: p}}`;
  - `score` returns `{"score", "probabilities": {"0": p, "1": p, "2": p}, "legend"}`;
  - `usage.truncated` says whether the state was cut.
- **Last night's recipe** cost about 6.6 s per task-trial (12.9 min for 117), and single shot about 0.9 s. Laya calls are a real share of the budget, so Laya is asked only where its answer can change a decision. The simulation and the live runner follow the same rule.

## Deviations from the spec, and why

1. **Calibration uses a Platt map** (a sigmoid on the logit, with an offset) per quantity, instead of `laya.fit_temperatures`. The latter wants about 100 records per option bucket, more than 60 tasks give. jev-swarm found the fitted sigmoid with an offset was what worked.
2. **Abstention is the rule's default branch.** No separate abstention threshold is fitted: `fit_abstention_thresholds` needs 100+ records per bucket. A task where no cutoff is crossed runs the recipe, which is the spec's "Laya is unsure → recipe".
3. **The rubric verify form** calls `predict` directly with a rubric-style `choice` question. `LayaEvaluator` is a LangChain wrapper around the same call.
4. **Cost is model seconds:** Qwen generation, probe execution and Laya calls. Self-test and grading runs are excluded on every side, because `bon.check` runs them together and they cost the same per candidate. End-to-end wall time is logged as well.
5. **Two rules are fitted:** `verify` for configurations 4 and 5, and `noverify` for configuration 3. A rule fitted with early-stop savings could overrun the budget without verify.
6. **One shared validator,** `scripts/moe-bench/validate_tasks.py`, driven by `TIER2B_DIR`, replaces a `validate.py` copy per task set.
7. **The probe uses prompt v1,** which is `probe_tier2b`'s default and Qwen's better version last night (tier2b 95 vs 90, fresh 16 vs 13).
8. **Ties:** today's `selftest` pick breaks ties by the largest agreeing group, then the first candidate. Laya's P(correct) is inserted after the pass count and before the group size.
9. **The coder stays keep96, after a check of swap108 and add108** (2026-10-06, before GPU session 1).
   - Adapters phase 1 found that swap108 beats keep96 on the sealed judge set (recipe 164 vs 153, McNemar p = 0.027), and the owner first moved Laya to it.
   - On tier2b with the same recipe harness and seeds, swap108 lost to keep96 (101 vs 107, 0 vs 6 discordant, p = 0.031), and so did add108 (102 vs 107, p = 0.062). By a rule written before add108's run (`docs/benchmarks/adapters/swap108-manifest.json`), keep96 stays. Details: `docs/superpowers/specs/2026-10-06-model-settle.md`.
   - 23 nested rows run on swap108 before the check are set aside (`laya-calib-nested-swap108-partial.jsonl`), not mixed in.
   - `playbook_tier2b.py` gained `--model` (default `qwen36keep96`), and every nested and live row records the GGUF it ran on.
   - **Configuration 2 on the judge set is already known.** Phase 1 ran keep96's recipe there with the same harness, prompts and seeds (153/180, single shot 143). The judge nested run repeats that measurement; the pre-registration states the known score.
   - **RAM.** On 2026-10-06 a 4 GB VM outside this project held RAM, so the 2 GB guard may stop the live runs (configurations 3–5). The guard is the spec's and stays as is.
10. **Cutoff grid from the data.** v1's fixed grid (0.3–0.9) started above every hidden-convention task's calibrated P(unseen) (0.20–0.26), so the fitted rule could never probe them. The targeted form's grid is the deciles of the pool's per-task signal.
11. **Signal choice.** The wording and the hidden signal are chosen together by the signal's pool AUC for category B, with Laya's kind probabilities as candidates. v1 summed three AUCs and ignored the kind probabilities; v1's P(kind = hidden code) has AUC 1.00 on the pool.
12. **Targeted rule form.** P when the hidden signal clears c_hidden, else R (spec v2 §2), replacing the four-branch form, whose effort branches read signals at chance.
13. **Notes only on probed tasks.** Under wording v1 the top kind is "library" for nearly every task, so per-kind notes would mislead.
14. **`--load-mode none` and an explicit RAM guard.** Session-2 runs use `--load-mode none` (identical answers, 2.5 GB less RAM). `live --min-free-mb` sets the guard per run: 2,048 MB by default, with a 1,024 MB retry delegated by the owner.
15. **The bar adds a per-task sign test** (owner, 2026-10-06). Each task's 3 trials are correlated, and the per-sample McNemar alone overstated the evening's model comparisons.

## File map

| File | Responsibility |
|---|---|
| `scripts/moe-bench/laya_calibrate.py` | AUC, ECE, Platt fit and apply, `calibrate_card`; CLI `fit`, `report`, `zeroshot` |
| `scripts/moe-bench/playbook.py` | `choose`, `pick`, `outcome`, `records`, `system`, `fixed`, `oracle`, `fit`, `mcnemar_p`; CLI `fit`, `report` |
| `scripts/moe-bench/laya_partner.py` | Laya wordings and forms, the `Laya` wrapper, CLI `worker` and `label` (venv-laya) |
| `scripts/moe-bench/playbook_tier2b.py` | `LayaClient`, the note templates, the probe-aware suite prompt, CLI `nested`, `live`, `summarize` |
| `scripts/moe-bench/validate_tasks.py` | Buggy-fails / reference-passes check for the task set in `TIER2B_DIR` |
| `scripts/moe-bench/test_laya_calibrate.py`, `test_playbook.py` | Unit tests |
| `docs/benchmarks/laya-calib/{runbench2b.py, tasks.py, tasks_a.py, tasks_c.py, tasks_d.py, tasks_e.py}` | Calibration pool: 48 new tasks plus validation-b's 12 B tasks |
| `docs/benchmarks/laya-judge/{runbench2b.py, tasks.py, tasks_a.py … tasks_e.py}` | Judge set: 60 new tasks |
| `docs/benchmarks/laya-partner/` | Labels, run results, `calib.json`, `rule.json`, reports |
| `docs/superpowers/specs/2026-10-05-laya-partner-prereg.md` | The committed rule, calibration and bar, before any judge run |

Commands below run from the worktree root `C:\Projects\home-base-recovered\.claude\worktrees\micro-agent-swarm-design-929d42`, in Git Bash. Shorthand:

```bash
PY=/c/qwen3-forge-stage/venv/Scripts/python.exe
LPY=/c/qwen3-forge-stage/venv-laya/Scripts/python.exe
MB=scripts/moe-bench
```

---

### Task 1: Task-set scaffolding and validator

**Files:**
- Create: `docs/benchmarks/laya-calib/runbench2b.py`, `docs/benchmarks/laya-judge/runbench2b.py` (identical shims)
- Create: `docs/benchmarks/laya-calib/tasks.py`, `docs/benchmarks/laya-judge/tasks.py`
- Create: empty `tasks_?.py` stubs (`TASKS = []`) so the aggregators import
- Create: `scripts/moe-bench/validate_tasks.py`

- [ ] **Step 1: Write the shim.** `bestofn_tier2b` does `from runbench2b import …` from `TIER2B_DIR`. The shim re-exports tier2b's helpers, and they import this directory's `tasks`.

```python
"""tier2b's harness helpers (scripts/benchmark-tier2b/runbench2b.py), re-exported so TIER2B_DIR can point at
this task set. The loaded module imports `tasks` from sys.path, which the harnesses put this directory first on."""
import importlib.util
import pathlib

_src = pathlib.Path(__file__).resolve().parents[3] / "scripts" / "benchmark-tier2b" / "runbench2b.py"
_spec = importlib.util.spec_from_file_location("_tier2b_runbench2b", _src)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
extract_code, run_test, seed, baseline_prompt = _mod.extract_code, _mod.run_test, _mod.seed, _mod.baseline_prompt
```

- [ ] **Step 2: Write `docs/benchmarks/laya-calib/tasks.py`.**

```python
"""Laya partner calibration pool (2026-10-05): 60 tier2b-format tasks, 12 per category, used only for fitting
(question wording, calibration, cutoffs and thresholds; spec §4). B is validation-b's 12 fresh hidden-package
tasks; A, C, D and E are new. Never used for scoring."""
import importlib.util
import pathlib

K = 3
_HERE = pathlib.Path(__file__).resolve().parent


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.TASKS


TASKS = (_load(_HERE / "tasks_a.py", "_calib_a")
         + _load(_HERE.parent / "2026-10-05" / "validation-b" / "tasks.py", "_calib_b")
         + _load(_HERE / "tasks_c.py", "_calib_c")
         + _load(_HERE / "tasks_d.py", "_calib_d")
         + _load(_HERE / "tasks_e.py", "_calib_e"))
```

- [ ] **Step 3: Write `docs/benchmarks/laya-judge/tasks.py`.**

```python
"""Laya partner judge set (2026-10-05): 60 new tier2b-format tasks, 12 per category, used only for scoring
(spec §4). Committed before anything runs on it; nothing is fitted on it."""
import importlib.util
import pathlib

K = 3
_HERE = pathlib.Path(__file__).resolve().parent


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.TASKS


TASKS = [t for c in "abcde" for t in _load(_HERE / f"tasks_{c}.py", f"_judge_{c}")]
```

- [ ] **Step 4: Write stub `tasks_a.py`, `tasks_c.py`, `tasks_d.py` and `tasks_e.py` in laya-calib, and `tasks_a.py` … `tasks_e.py` in laya-judge.** Each stub contains only:

```python
TASKS = []
```

- [ ] **Step 5: Write `scripts/moe-bench/validate_tasks.py`.**

```python
"""Prove every task in TIER2B_DIR is well-formed (the check validation-b used, 2026-10-05): its grading test fails
on the buggy entry file and passes on the reference fix, the required fields are there, and names are unique.

usage: TIER2B_DIR=<task set> python validate_tasks.py      (exit 1 if any task is bad)
"""
import collections
import os
import pathlib
import shutil
import sys
import tempfile

BENCH = pathlib.Path(os.environ["TIER2B_DIR"])
sys.path.insert(0, str(BENCH))
from runbench2b import run_test, seed  # noqa: E402
from tasks import TASKS  # noqa: E402

REQUIRED = ("name", "category", "entry", "files", "spec", "test", "reference")
names = collections.Counter(t.get("name") for t in TASKS)
bad = 0
for t in TASKS:
    missing = [k for k in REQUIRED if k not in t]
    if t.get("category") == "B" and "hidden_file" not in t:
        missing.append("hidden_file")
    if missing or names[t.get("name")] > 1 or t.get("entry") not in t.get("files", {}):
        bad += 1
        print(f"BAD {t.get('name')}: missing {missing}, duplicate name {names[t.get('name')] > 1}")
        continue
    res = {}
    for label, code in (("buggy", t["files"][t["entry"]]), ("reference", t["reference"])):
        d = pathlib.Path(tempfile.mkdtemp(prefix="vt-"))
        try:
            seed(d, t)
            (d / t["entry"]).write_text(code, encoding="utf-8")
            res[label] = run_test(d, t["test"])
        finally:
            shutil.rmtree(d, ignore_errors=True)
    ok = (not res["buggy"][0]) and res["reference"][0]
    bad += not ok
    print(f"{'ok ' if ok else 'BAD'} {t['category']} {t['name']:26s} buggy={res['buggy'][0]} "
          f"({res['buggy'][1][:60]}) reference={res['reference'][0]} ({res['reference'][1][:60]})")
print(f"{len(TASKS) - bad}/{len(TASKS)} well-formed; per category "
      f"{dict(sorted(collections.Counter(t['category'] for t in TASKS).items()))}")
sys.exit(1 if bad else 0)
```

- [ ] **Step 6: Run it on the calibration pool, which is the 12 validation-b tasks so far.**

Run: `TIER2B_DIR=docs/benchmarks/laya-calib $PY $MB/validate_tasks.py`
Expected: 12 `ok` lines, then `12/12 well-formed; per category {'B': 12}`, exit 0.

- [ ] **Step 7: Commit.**

```bash
git add docs/benchmarks/laya-calib docs/benchmarks/laya-judge scripts/moe-bench/validate_tasks.py
git commit -m "feat(laya-partner): task-set scaffolding and shared task validator"
```

---

### Task 2: Calibration math (`laya_calibrate.py`, core)

**Files:**
- Create: `scripts/moe-bench/laya_calibrate.py`
- Test: `scripts/moe-bench/test_laya_calibrate.py`

- [ ] **Step 1: Write the failing tests.**

```python
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import laya_calibrate as lc  # noqa: E402


class CalibrateTest(unittest.TestCase):
    def test_auc(self):
        self.assertEqual(lc.auc([0.9, 0.8], [0.1, 0.2]), 1.0)
        self.assertEqual(lc.auc([0.1], [0.9]), 0.0)
        self.assertEqual(lc.auc([0.5], [0.5]), 0.5)

    def test_ece(self):
        self.assertAlmostEqual(lc.ece([1.0, 1.0], [0, 0]), 1.0)
        self.assertAlmostEqual(lc.ece([0.25] * 4, [1, 0, 0, 0]), 0.0)

    def test_platt_pulls_overconfidence_to_the_base_rate(self):
        probs, labels = [0.9] * 40, [1, 0] * 20
        ab = lc.platt_fit(probs, labels)
        self.assertAlmostEqual(lc.platt_apply(0.9, ab), 0.5, delta=0.05)

    def test_platt_keeps_order(self):
        probs = [0.1, 0.2, 0.3, 0.6, 0.7, 0.8] * 5
        labels = [0, 0, 1, 0, 1, 1] * 5
        ab = lc.platt_fit(probs, labels)
        self.assertLess(lc.platt_apply(0.2, ab), lc.platt_apply(0.7, ab))

    def test_platt_apply_none(self):
        self.assertIsNone(lc.platt_apply(None, [1.0, 0.0]))

    def test_identity_card(self):
        raw = {"kind": "unseen", "kind_p": {}, "unseen": 0.7, "effort_p": [0.2, 0.3, 0.5]}
        card = lc.calibrate_card(raw, lc.IDENTITY["platt"])
        self.assertEqual(card["kind"], "unseen")
        self.assertAlmostEqual(card["unseen"], 0.7, places=3)
        self.assertAlmostEqual(card["p_little"], 0.2, places=3)
        self.assertAlmostEqual(card["p_alot"], 0.5, places=3)
        self.assertEqual(card["effort_top"], 2)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run them and confirm they fail.**

Run: `cd scripts/moe-bench && $PY -m unittest test_laya_calibrate -v`
Expected: ERROR `ModuleNotFoundError: No module named 'laya_calibrate'`.

- [ ] **Step 3: Write the core of `laya_calibrate.py`.** The CLI parts come in Task 5.

```python
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
```

- [ ] **Step 4: Run the tests and confirm they pass.**

Run: `cd scripts/moe-bench && $PY -m unittest test_laya_calibrate -v`
Expected: 6 tests, `OK`.

- [ ] **Step 5: Commit.**

```bash
git add scripts/moe-bench/laya_calibrate.py scripts/moe-bench/test_laya_calibrate.py
git commit -m "feat(laya-partner): calibration math (AUC, ECE, Platt with offset)"
```

---

### Task 3: The playbook core (`playbook.py`)

**Files:**
- Create: `scripts/moe-bench/playbook.py`
- Test: `scripts/moe-bench/test_playbook.py`

- [ ] **Step 1: Write the failing tests.**

```python
import collections
import json
import os
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import playbook as pb  # noqa: E402

RULE = dict(c_u=0.5, c_easy=0.5, c_hard=0.5, t_hi=pb.NEVER, t_lo=-1.0)


def cand(run, i, ok, tests=None, p=None, secs=1.0, vs=0.3, compiles=True):
    """tests: {suite: [passed, ...]}"""
    return {"run": run, "cand": i, "secs": secs, "compiles": compiles, "imports": compiles, "graded_ok": ok,
            "self": {s: {f"t{j}": v for j, v in enumerate(vals)} for s, vals in (tests or {}).items()},
            "p": p, "verify_secs": vs}


def rec(r8, pr, probe_secs=2.0, suite_secs=1.0, classify_secs=0.4, task="t"):
    return {"task": task, "category": "A", "trial": 0, "probe_secs": probe_secs, "classify_secs": classify_secs,
            "suites": {k: {"secs": suite_secs} for k in ("r8s0", "r8s1", "prs0")}, "cands": {"r8": r8, "pr": pr}}


def card(unseen=0.0, p_little=0.0, p_alot=0.0, effort_top=1, kind="algorithm"):
    return {"kind": kind, "unseen": unseen, "p_little": p_little, "p_alot": p_alot, "effort_top": effort_top}


def plain_rec(r8_ok=(False,) * 8, pr_ok=(False,) * 3):
    tests = {"r8s0": [False], "r8s1": [False], "prs0": [False]}
    return rec([cand("r8", i, ok, tests) for i, ok in enumerate(r8_ok)],
               [cand("pr", i, ok, tests) for i, ok in enumerate(pr_ok)])


class ChooseTest(unittest.TestCase):
    def test_no_card_runs_the_recipe(self):
        self.assertEqual(pb.choose(None, RULE), "R")

    def test_rule_order(self):
        self.assertEqual(pb.choose(card(unseen=0.9, effort_top=0), RULE), "P")
        self.assertEqual(pb.choose(card(unseen=0.9, effort_top=2), RULE), "PR")
        self.assertEqual(pb.choose(card(p_little=0.9, p_alot=0.9), RULE), "S")
        self.assertEqual(pb.choose(card(p_alot=0.9), RULE), "R8")
        self.assertEqual(pb.choose(card(), RULE), "R")


class PickTest(unittest.TestCase):
    def test_most_tests_then_p_then_group_then_index(self):
        a = cand("r8", 0, False, {"r8s0": [True, False]}, p=0.2)
        b = cand("r8", 1, True, {"r8s0": [True, False]}, p=0.9)
        c = cand("r8", 2, False, {"r8s0": [False, False]}, p=1.0)
        self.assertIs(pb.pick([a, b, c], ("r8s0",)), a)  # no P: tie goes to the lowest index
        self.assertIs(pb.pick([a, b, c], ("r8s0",), lambda x: x["p"]), b)

    def test_p_asked_only_for_ties_at_the_top(self):
        a = cand("r8", 0, True, {"r8s0": [True, True]})
        b = cand("r8", 1, False, {"r8s0": [True, False]})
        asked = []
        pb.pick([a, b], ("r8s0",), lambda x: asked.append(x["cand"]) or 0.5)
        self.assertEqual(asked, [])

    def test_non_compiling_candidates_are_skipped(self):
        a = cand("r8", 0, False, {"r8s0": [True]}, compiles=False)
        b = cand("r8", 1, True, {"r8s0": [False]})
        self.assertIs(pb.pick([a, b], ("r8s0",)), b)


class OutcomeTest(unittest.TestCase):
    def test_plain_costs(self):
        r = plain_rec()
        self.assertEqual(pb.outcome(r, "S")[1], 1.0)
        self.assertEqual(pb.outcome(r, "R")[1], 1.0 + 3)
        self.assertEqual(pb.outcome(r, "R8")[1], 2.0 + 8)
        self.assertEqual(pb.outcome(r, "P")[1], 2.0 + 1)
        self.assertEqual(pb.outcome(r, "PR")[1], 2.0 + 1.0 + 3)

    def test_plain_picks(self):
        self.assertTrue(pb.outcome(plain_rec(r8_ok=(True,) + (False,) * 7), "S")[0])
        self.assertFalse(pb.outcome(plain_rec(pr_ok=(True, False, False)), "S")[0])
        self.assertTrue(pb.outcome(plain_rec(pr_ok=(True, False, False)), "P")[0])

    def test_early_stop(self):
        r8 = [cand("r8", 0, True, {"r8s0": [True, True]}, p=0.95)] + \
             [cand("r8", i, False, {"r8s0": [False, False]}) for i in range(1, 8)]
        r = rec(r8, [cand("pr", i, False) for i in range(3)])
        ok, secs = pb.outcome(r, "R8", t_hi=0.9, use_p=True)
        self.assertTrue(ok)
        self.assertAlmostEqual(secs, 1.0 + 1.0 + 0.3)  # first suite + candidate 0 + one verify

    def test_no_early_stop_when_p_is_low(self):
        r8 = [cand("r8", 0, True, {"r8s0": [True]}, p=0.5)] + \
             [cand("r8", i, False, {"r8s0": [False]}) for i in range(1, 8)]
        r = rec(r8, [cand("pr", i, False) for i in range(3)])
        ok, secs = pb.outcome(r, "R", t_hi=0.9, use_p=True)
        self.assertTrue(ok)
        self.assertAlmostEqual(secs, 1.0 + 3 + 0.3)  # verify of candidate 0 is still paid

    def test_escalation_adds_the_probe_fix(self):
        r8 = [cand("r8", i, False, p=0.1) for i in range(8)]
        pr = [cand("pr", 0, True, p=0.8)] + [cand("pr", i, False) for i in (1, 2)]
        ok, secs = pb.outcome(rec(r8, pr), "S", t_lo=0.3, use_p=True)
        self.assertTrue(ok)
        self.assertAlmostEqual(secs, 1.0 + 2.0 + 1.0 + 0.3 + 0.3)  # S + probe + fix + two verifies

    def test_no_verify_cost_without_ties(self):
        r8 = [cand("r8", 0, True, {"r8s0": [True, True]}, p=0.4)] + \
             [cand("r8", i, False, {"r8s0": [False, True]}, p=0.4) for i in range(1, 8)]
        ok, secs = pb.outcome(rec(r8, [cand("pr", i, False) for i in range(3)]), "R", use_p=True)
        self.assertTrue(ok)
        self.assertAlmostEqual(secs, 1.0 + 3)


class FitTest(unittest.TestCase):
    def test_fit_routes_easy_tasks_to_single_shot_within_budget(self):
        easy = [plain_rec(r8_ok=(True,) * 8) for _ in range(4)]
        hard = [plain_rec(r8_ok=(False, True, False, False, False, False, False, False)) for _ in range(4)]
        for i, r in enumerate(easy):
            r["task"] = f"e{i}"
        for i, r in enumerate(hard):
            r["task"] = f"h{i}"
            r["cands"]["r8"][1]["self"]["r8s0"] = {"t0": True}
        cards = {r["task"]: card(p_little=0.9) for r in easy} | {r["task"]: card(p_little=0.1) for r in hard}
        recs = easy + hard
        budget = pb.fixed(recs, "R")[1]
        rule, solved, secs = pb.fit(recs, cards, budget, use_p=False)
        self.assertEqual(solved, 8)
        self.assertLessEqual(secs, budget)
        self.assertEqual(pb.choose(cards["e0"], rule), "S")


class StatsTest(unittest.TestCase):
    def test_mcnemar(self):
        self.assertEqual(pb.mcnemar_p(0, 0), 1.0)
        self.assertAlmostEqual(pb.mcnemar_p(8, 1), 0.0390625)


class MatchesBestofnTest(unittest.TestCase):
    def test_pick_equals_bestofn_selftest_on_a_stored_run(self):
        os.environ.setdefault("TIER2B_DIR", str(HERE.parents[1] / "scripts" / "benchmark-tier2b"))
        import bestofn_tier2b as bon
        path = HERE.parents[1] / "docs" / "benchmarks" / "2026-10-05" / "bestofn-keep96-recipe-replication.jsonl"
        latest = {}
        for r in map(json.loads, path.read_text(encoding="utf-8").splitlines()):
            if r.get("type") == "cand":
                latest[(r["task"], r["trial"], r["cand"])] = r
        by = collections.defaultdict(list)
        for r in latest.values():
            by[(r["task"], r["trial"])].append(r)
        for cands in by.values():
            cands.sort(key=lambda r: r["cand"])
            self.assertEqual(pb.pick(cands, ("s0",))["cand"], bon.pick(cands, "selftest")["cand"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run them and confirm they fail.**

Run: `cd scripts/moe-bench && $PY -m unittest test_playbook -v`
Expected: ERROR `ModuleNotFoundError: No module named 'playbook'`.

- [ ] **Step 3: Write `playbook.py`.** The CLI functions `fit_cmd` and `report_cmd` come in Task 5; this step writes everything above them.

```python
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
```

- [ ] **Step 4: Run the tests and confirm they pass.**

Run: `cd scripts/moe-bench && $PY -m unittest test_playbook -v`
Expected: 14 tests, `OK`. `MatchesBestofnTest` checks the new `pick` against all 117 stored task-trials of last night's recipe replication.

- [ ] **Step 5: Commit.**

```bash
git add scripts/moe-bench/playbook.py scripts/moe-bench/test_playbook.py
git commit -m "feat(laya-partner): playbook rule, lazy-verify selection, offline simulation and fitting"
```

---

### Task 4: Laya side (`laya_partner.py`)

**Files:**
- Create: `scripts/moe-bench/laya_partner.py`

- [ ] **Step 1: Write `laya_partner.py`.**

```python
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
```

- [ ] **Step 2: Smoke-test the worker by hand.**

Run:
```bash
printf '%s\n' '{"op":"ping"}' '{"op":"classify","state":"Fix solution.py.\n\nRequirement: return x plus two."}' '{"op":"verify","requirement":"return x plus two","entry":"solution.py","code":"def f(x):\n    return x + 2\n"}' '{"op":"nope"}' | USE_TF=0 $LPY $MB/laya_partner.py worker 2>/dev/null
```
Expected: 5 JSON lines:
1. `{"ok": true, "ready": true, ...}`
2. ping: `"ok": true`
3. classify: a `card` with `kind`, `unseen`, `p_little`, `p_alot`, `effort_top`
4. verify: `p` between 0 and 1
5. `{"ok": false, "error": "ValueError(\"unknown op 'nope'\")", ...}`

- [ ] **Step 3: Commit.**

```bash
git add scripts/moe-bench/laya_partner.py
git commit -m "feat(laya-partner): Laya worker and batch labeller (two wordings, two verify forms)"
```

---

### Task 5: The fit and report commands

**Files:**
- Modify: `scripts/moe-bench/laya_calibrate.py` (append the CLI)
- Modify: `scripts/moe-bench/playbook.py` (append the CLI)
- Test: `scripts/moe-bench/test_playbook.py` (add an end-to-end test on synthetic files)

- [ ] **Step 1: Write the failing end-to-end test.** It builds a synthetic nested-run file and labels, runs `laya_calibrate.fit_cmd`, then `playbook.fit_cmd`, and checks the outputs. Append to `test_playbook.py`, before the `if __name__` line:

```python
class CommandsTest(unittest.TestCase):
    def test_fit_commands_end_to_end(self):
        import argparse
        import tempfile
        import laya_calibrate as lc
        d = pathlib.Path(tempfile.mkdtemp())
        trials, labels = [], []
        for t in range(10):
            cat = "B" if t < 3 else "A"
            easy = t >= 6
            for trial in range(3):
                cands = []
                for run, n in (("r8", 8), ("pr", 3)):
                    for c in range(n):
                        ok = easy or (cat == "B" and run == "pr") or (c == 1 and run == "r8")
                        cands.append({"run": run, "cand": c, "secs": 1.0, "compiles": True, "imports": True,
                                      "graded_ok": ok, "code": "x = 1",
                                      "self": {s: {"t0": ok} for s in ("r8s0", "r8s1", "prs0")}})
                        labels.append({"type": "verify", "task": f"t{t}", "trial": trial, "run": run, "cand": c,
                                       "form": "noul", "p": 0.8 if ok else 0.3, "secs": 0.3})
                        labels.append({"type": "verify", "task": f"t{t}", "trial": trial, "run": run, "cand": c,
                                       "form": "rubric", "p": 0.5, "secs": 0.3})
                trials.append({"type": "trial", "task": f"t{t}", "category": cat, "trial": trial,
                               "suites": {s: {"secs": 1.0} for s in ("r8s0", "r8s1", "prs0")},
                               "probe": {"secs_gen": 1.0, "secs_exec": 0.2}, "cands": cands})
            for w in ("v1", "v2"):
                labels.append({"type": "card", "task": f"t{t}", "wording": w, "secs": 0.35,
                               "card": {"kind": "unseen" if cat == "B" else "algorithm", "kind_p": {},
                                        "unseen": (0.9 if cat == "B" else 0.2) if w == "v1" else 0.5,
                                        "effort_p": [0.8, 0.1, 0.1] if easy else [0.1, 0.3, 0.6]}})
        (d / "n.jsonl").write_text("\n".join(map(json.dumps, trials)), encoding="utf-8")
        (d / "l.jsonl").write_text("\n".join(map(json.dumps, labels)), encoding="utf-8")
        lc.fit_cmd(argparse.Namespace(trials=str(d / "n.jsonl"), labels=str(d / "l.jsonl"), out=str(d / "c.json")))
        calib = json.loads((d / "c.json").read_text(encoding="utf-8"))
        self.assertEqual(calib["classify_wording"], "v1")
        self.assertEqual(calib["verify_form"], "noul")
        pb.fit_cmd(argparse.Namespace(trials=str(d / "n.jsonl"), labels=str(d / "l.jsonl"),
                                      calib=str(d / "c.json"), out=str(d / "r.json")))
        rule = json.loads((d / "r.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(rule["verify_fit"]["solved"], rule["calib_pool"]["R"])
        self.assertLessEqual(rule["verify_fit"]["mean_secs"], rule["budget_secs"])
```

- [ ] **Step 2: Run it and confirm it fails.**

Run: `cd scripts/moe-bench && $PY -m unittest test_playbook.CommandsTest -v`
Expected: ERROR `AttributeError: module 'laya_calibrate' has no attribute 'fit_cmd'`.

- [ ] **Step 3: Append the CLI to `laya_calibrate.py`.**

```python
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
    wording = max(WORDINGS, key=lambda w: sum(_num(x) for x in wauc[w].values()))
    vp = {f: verify_pairs(labels, cand_ok, f) for f in FORMS}
    vauc = {f: pairs_auc(vp[f]) for f in FORMS}
    form = max(FORMS, key=lambda f: _num(vauc[f]))
    data = dict(wq[wording], verify=vp[form])
    platt = {q: list(platt_fit([p for p, _ in v], [int(y) for _, y in v])) for q, v in data.items()}
    calib = {"classify_wording": wording, "verify_form": form, "platt": platt,
             "report": {"wording_auc": wauc, "verify_auc": vauc,
                        "kind_accuracy": {w: kind_accuracy(cards_of(labels, w), cats) for w in WORDINGS},
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
    rep = {"diagnostics": diagnose(data, calib["platt"]), "kind_accuracy": kind_accuracy(cards, cats)}
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
```

- [ ] **Step 4: Append the CLI to `playbook.py`.**

```python
def by_category(rows_ok):
    """rows_ok: [(category, ok)] -> {category: solved}."""
    res = collections.Counter()
    for cat, ok in rows_ok:
        res[cat] += ok
    return dict(sorted(res.items()))


def fit_cmd(a):
    calib = json.loads(pathlib.Path(a.calib).read_text(encoding="utf-8"))
    recs, cards = records(read_jsonl(a.trials), read_jsonl(a.labels), calib)
    budget = fixed(recs, "R")[1]
    out = {"budget_secs": round(budget, 3), "records": len(recs)}
    for name, use_p in (("verify", True), ("noverify", False)):
        best = fit(recs, cards, budget, use_p)
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
        res["bar"] = {"c4_only": b, "recipe_only": c, "mcnemar_p": p, "c4_secs": res["c4"]["mean_secs"],
                      "recipe_secs": res["c2_recipe"]["mean_secs"],
                      "met": res["c4"]["solved"] > res["c2_recipe"]["solved"] and p < 0.10
                      and res["c4"]["mean_secs"] <= res["c2_recipe"]["mean_secs"]}
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
        else:
            s.add_argument("--rule", required=True)
            s.add_argument("--live", action="append", default=[])
            s.add_argument("--out")
    a = ap.parse_args()
    fit_cmd(a) if a.cmd == "fit" else report_cmd(a)


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Run the whole suite and confirm it passes.**

Run: `cd scripts/moe-bench && $PY -m unittest test_laya_calibrate test_playbook -v`
Expected: 21 tests, `OK`.

- [ ] **Step 6: Commit.**

```bash
git add scripts/moe-bench/laya_calibrate.py scripts/moe-bench/playbook.py scripts/moe-bench/test_playbook.py
git commit -m "feat(laya-partner): calibration fit, rule fit and judge report commands"
```

---

### Task 6: The runner (`playbook_tier2b.py`)

**Files:**
- Create: `scripts/moe-bench/playbook_tier2b.py`

- [ ] **Step 1: Write `playbook_tier2b.py`.**

```python
"""The Laya partner on tier2b-format task sets (Laya partner spec §3-§7, 2026-10-05).

  nested     both nested runs per task and trial, for calibration and for configurations 1, 2 and 6:
               an 8-candidate run with 2 suites (S = candidate 0; R = candidates 0-2 + suite r8s0; R8 = all) and a
               probe run (the probe, then 1 suite and 3 candidates that all see its output; P = probe + candidate 0;
               PR = all). Every candidate is checked against all three suites; every call is timed.
  live       configurations 3-5 end to end: Laya classifies, the committed rule picks the playbook, the playbook
               runs; with --verify on, Laya's P(correct) breaks ties, stops early and escalates (as playbook.outcome).
  summarize  totals for a live file.

Seeds match bestofn_tier2b.py and probe_tier2b.py: candidate 0 uses the trial's seed at temperature 0.2, other
candidates 1000 + 100 * trial + c at --temp-alt, suites 20000 + 100 * trial + s, the probe 30000 + trial.
Probe-run candidates 1-2 use 40000 + 100 * trial + c; the probe-run suite 50000 + 100 * trial.
Cost is model seconds: Qwen generation, probe execution and Laya calls. Self-test and grading runs are excluded
everywhere (bon.check runs them together; they cost the same per candidate in every configuration).

usage: playbook_tier2b.py nested --out NESTED.jsonl [--trials 3] [--temp-alt 0.7]
       playbook_tier2b.py live --out LIVE.jsonl --rule RULE.json --calib CALIB.json [--note on|off] [--verify on|off]
       playbook_tier2b.py summarize LIVE.jsonl
(TIER2B_DIR selects the task set, as for the other harnesses.)
"""
import argparse
import collections
import ctypes
import json
import pathlib
import queue
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bestofn_tier2b as bon  # noqa: E402
import playbook  # noqa: E402
from bestofn_tier2b import TASKS, baseline_prompt, extract_code, test_names, test_prompt  # noqa: E402
from probe_tier2b import fix_prompt, probe_prompt, run_probe  # noqa: E402

LAYA_PY = r"C:\qwen3-forge-stage\venv-laya\Scripts\python.exe"
MIN_FREE_MB = 2048
SUITE_KEYS = ("r8s0", "r8s1", "prs0")
# One fixed line per Laya `kind`, put at the top of every Qwen prompt for the task (spec §3.1).
NOTES = {
    "algorithm": "Note: this fix is about getting the algorithm right, including its edge cases.",
    "input": "Note: this fix is about handling bad or missing input.",
    "files": "Note: this fix is about reading or writing files or running processes safely.",
    "library": "Note: this fix is about using the available library helpers correctly.",
    "unseen": "Note: the fix depends on code whose source isn't shown.",
}


def probe_test_prompt(task, script, output):
    return (test_prompt(task) + f"\n\nThis script was run in the package directory:\n```python\n{script}\n```\n"
            f"Its output:\n```\n{output}\n```\nUse what it shows about how the code behaves.")


def timed_chat(prompt, seed_, temperature=None):
    t = time.time()
    text, n = bon.chat(prompt, seed_, temperature)
    return text, n, round(time.time() - t, 3)


def available_mb():
    class Status(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
    s = Status()
    s.dwLength = ctypes.sizeof(Status)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(s))
    return s.ullAvailPhys // 2 ** 20


class LayaClient:
    """laya_partner.py worker in Laya's own venv, over JSON lines. It never raises: once the worker fails to start,
    crashes or misses the deadline, every later call returns (None, secs) and tasks fall back (spec §7)."""

    def __init__(self, calib, timeout=5.0, start_timeout=300.0):
        self.timeout, self.dead, self.q, self.proc = timeout, False, queue.Queue(), None
        try:
            self.proc = subprocess.Popen([LAYA_PY, str(HERE / "laya_partner.py"), "worker", "--calib", str(calib)],
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                         text=True, encoding="utf-8", bufsize=1)
        except OSError:
            self.dead = True
            return
        threading.Thread(target=self._read, daemon=True).start()
        r = self._get(start_timeout)
        if not (r and r.get("ready")):
            self.close()
            self.dead = True

    def _read(self):
        for line in self.proc.stdout:
            if line.startswith("{"):
                try:
                    self.q.put(json.loads(line))
                except json.JSONDecodeError:
                    pass
        self.q.put(None)

    def _get(self, timeout):
        try:
            return self.q.get(timeout=timeout)
        except queue.Empty:
            return None

    def call(self, msg):
        """(reply or None, secs)."""
        if self.dead:
            return None, 0.0
        t = time.time()
        try:
            self.proc.stdin.write(json.dumps(msg) + "\n")
            self.proc.stdin.flush()
        except OSError:
            self.dead = True
            return None, round(time.time() - t, 3)
        r = self._get(self.timeout)
        if r is None:
            self.dead = True  # a late reply would answer the next question: stop asking
        return r, round(time.time() - t, 3)

    def close(self):
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.stdin.close()
                self.proc.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                self.proc.kill()


def start():
    bon.CFG.update(bon.CONFIGS["qwen36keep96"], budget=0)


def stop(proc, log):
    proc.terminate()
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
    log.close()


def done_keys(out):
    if not out.exists():
        return set()
    return {(r["task"], r["trial"]) for r in map(json.loads, out.read_text(encoding="utf-8").splitlines())}


def nested_trial(task, trial, temp_alt, ex):
    suites = {}
    for s in (0, 1):
        text, n, secs = timed_chat(test_prompt(task), 20000 + 100 * trial + s, temp_alt if s else None)
        code = extract_code(text)
        suites[f"r8s{s}"] = {"code": code, "tests": test_names(code), "secs": secs, "gen_n": n}
    cands = []
    for c in range(8):
        sd = trial if c == 0 else 1000 + 100 * trial + c
        text, n, secs = timed_chat(baseline_prompt(task), sd, temp_alt if c else None)
        cands.append({"run": "r8", "cand": c, "seed": sd, "gen_n": n, "secs": secs, "content": text})
    text, n_probe, s_gen = timed_chat(probe_prompt(task), 30000 + trial)
    script = extract_code(text)
    t = time.time()
    output = run_probe(task, script)
    probe = {"script": script, "output": output, "gen_n": n_probe, "secs_gen": s_gen,
             "secs_exec": round(time.time() - t, 3)}
    text, n, secs = timed_chat(probe_test_prompt(task, script, output), 50000 + 100 * trial)
    code = extract_code(text)
    suites["prs0"] = {"code": code, "tests": test_names(code), "secs": secs, "gen_n": n}
    for c in range(3):
        sd = trial if c == 0 else 40000 + 100 * trial + c
        text, n, secs = timed_chat(fix_prompt(task, script, output), sd, temp_alt if c else None)
        cands.append({"run": "pr", "cand": c, "seed": sd, "gen_n": n, "secs": secs, "content": text})
    suite_list = [(suites[k]["code"], suites[k]["tests"]) for k in SUITE_KEYS]
    for c in cands:
        c["code"] = extract_code(c["content"])
    for c, chk in zip(cands, ex.map(lambda c: bon.check(task, c["code"], suite_list), cands)):
        c.update(compiles=chk["compiles"], imports=chk["imports"], graded_ok=chk["graded_ok"],
                 graded_detail=chk["graded_detail"],
                 self={k: chk["self"][f"s{i}"] for i, k in enumerate(SUITE_KEYS)})
    return {"type": "trial", "task": task["name"], "category": task["category"], "trial": trial,
            "suites": suites, "probe": probe, "cands": cands}


def nested(a):
    out = pathlib.Path(a.out)
    done = done_keys(out)
    start()
    log = open(out.with_suffix(".server.log"), "a", encoding="utf-8", errors="replace")
    proc = bon.start_server(log)
    t_start = time.time()
    try:
        with out.open("a", encoding="utf-8") as f, ThreadPoolExecutor(8) as ex:
            for task in TASKS:
                for trial in range(a.trials):
                    if (task["name"], trial) in done:
                        continue
                    t = time.time()
                    row = nested_trial(task, trial, a.temp_alt, ex)
                    f.write(json.dumps(row) + "\n")
                    f.flush()
                    ok = collections.Counter(c["run"] for c in row["cands"] if c["graded_ok"])
                    print(f"{task['name']} t{trial}: r8 {ok['r8']}/8, pr {ok['pr']}/3 pass grading; "
                          f"{time.time() - t:.0f} s", flush=True)
    finally:
        stop(proc, log)
    print(f"done in {(time.time() - t_start) / 60:.1f} min", flush=True)


def live_trial(task, trial, rule, lc, note_on, use_p, temp_alt):
    """One task-trial of configurations 3-5. Mirrors playbook.outcome step for step."""
    t0, calls, pvals = time.time(), [], {}

    def gen(what, prompt, sd, temp=None):
        text, n, secs = timed_chat(note + prompt, sd, temp)
        calls.append([what, secs, n])
        return text

    def new(run, i, prompt, sd, temp, suites):
        c = {"run": run, "cand": i, "code": extract_code(gen(f"{run}{i}", prompt, sd, temp))}
        chk = bon.check(task, c["code"], suites)  # self-tests for the pick; the grade is read only at the end
        c.update(compiles=chk["compiles"], imports=chk["imports"], graded_ok=chk["graded_ok"], self=chk["self"])
        return c

    def p_of(c):  # Laya's calibrated P(correct), asked at most once per candidate
        k = (c["run"], c["cand"])
        if k not in pvals:
            r, s = lc.call({"op": "verify", "requirement": task["spec"], "entry": task["entry"], "code": c["code"]})
            calls.append(["laya_verify", s, 0])
            pvals[k] = r["p"] if r and r.get("ok") else None
        return -1.0 if pvals[k] is None else pvals[k]

    probe = {}

    def run_probe_step():
        script = extract_code(gen("probe", probe_prompt(task), 30000 + trial))
        t = time.time()
        probe.update(script=script, output=run_probe(task, script))
        calls.append(["probe_exec", round(time.time() - t, 3), 0])

    note = ""
    reply, secs = lc.call({"op": "classify", "state": baseline_prompt(task)})
    calls.append(["laya_classify", secs, 0])
    card = reply["card"] if reply and reply.get("ok") else None
    play = playbook.choose(card, rule)
    if note_on and card:
        note = NOTES[card["kind"]] + "\n\n"
    early = escalated = False
    suites, names = [], ()
    if play in ("R", "R8"):
        code = extract_code(gen("suite0", test_prompt(task), 20000 + 100 * trial))
        suites, names = [(code, test_names(code))], ("s0",)
        c0 = new("r8", 0, baseline_prompt(task), trial, None, suites)
        if use_p and rule["t_hi"] <= 1.0 and playbook.allpass(c0, "s0") and p_of(c0) >= rule["t_hi"]:
            pool, early = [c0], True
        else:
            if play == "R8":
                code = extract_code(gen("suite1", test_prompt(task), 20000 + 100 * trial + 1, temp_alt))
                suites, names = suites + [(code, test_names(code))], ("s0", "s1")
                c0 = dict(c0, self=bon.check(task, c0["code"], suites)["self"])
            pool = [c0] + [new("r8", c, baseline_prompt(task), 1000 + 100 * trial + c, temp_alt, suites)
                           for c in range(1, 3 if play == "R" else 8)]
    elif play == "PR":
        run_probe_step()
        code = extract_code(gen("suite0", probe_test_prompt(task, probe["script"], probe["output"]),
                                50000 + 100 * trial))
        suites, names = [(code, test_names(code))], ("s0",)
        pool = [new("pr", c, fix_prompt(task, probe["script"], probe["output"]),
                    trial if c == 0 else 40000 + 100 * trial + c, temp_alt if c else None, suites) for c in range(3)]
    elif play == "S":
        pool = [new("r8", 0, baseline_prompt(task), trial, None, [])]
    else:  # P
        run_probe_step()
        pool = [new("pr", 0, fix_prompt(task, probe["script"], probe["output"]), trial, None, [])]
    best = pool[0] if early else playbook.pick(pool, names, p_of if use_p else None)
    if (use_p and not early and rule["t_lo"] > -1.0 and play in ("S", "R", "R8")
            and p_of(best) >= 0 and p_of(best) < rule["t_lo"]):
        run_probe_step()
        extra = new("pr", 100, fix_prompt(task, probe["script"], probe["output"]), trial, None, suites)
        escalated = True
        best = playbook.pick(pool + [extra], names, p_of)
    return {"type": "live", "task": task["name"], "category": task["category"], "trial": trial, "card": card,
            "laya_ok": card is not None, "laya_dead": lc.dead, "playbook": play, "note": bool(note),
            "verify": use_p, "early_stop": early, "escalated": escalated,
            "pick": {"run": best["run"], "cand": best["cand"]}, "p_pick": pvals.get((best["run"], best["cand"])),
            "graded_ok": best["graded_ok"], "calls": calls,
            "model_secs": round(sum(c[1] for c in calls), 3), "gen_tokens": sum(c[2] or 0 for c in calls),
            "wall_secs": round(time.time() - t0, 3)}


def live(a):
    rules = json.loads(pathlib.Path(a.rule).read_text(encoding="utf-8"))
    use_p = a.verify == "on"
    rule = rules["verify" if use_p else "noverify"]
    out = pathlib.Path(a.out)
    done = done_keys(out)
    start()
    log = open(out.with_suffix(".server.log"), "a", encoding="utf-8", errors="replace")
    proc = bon.start_server(log)
    lc = None
    t_start = time.time()
    try:
        lc = LayaClient(a.calib)
        free = available_mb()
        print(f"Laya worker {'down' if lc.dead else 'up'}; {free} MB available with Qwen and Laya loaded", flush=True)
        if free < MIN_FREE_MB:
            sys.exit(f"only {free} MB available; the spec needs {MIN_FREE_MB}")
        with out.open("a", encoding="utf-8") as f:
            for task in TASKS:
                for trial in range(a.trials):
                    if (task["name"], trial) in done:
                        continue
                    row = live_trial(task, trial, rule, lc, a.note == "on", use_p, a.temp_alt)
                    f.write(json.dumps(row) + "\n")
                    f.flush()
                    print(f"{task['name']} t{trial}: {row['playbook']}{' early' if row['early_stop'] else ''}"
                          f"{' escalated' if row['escalated'] else ''} -> {'PASS' if row['graded_ok'] else 'fail'} "
                          f"({row['model_secs']:.1f} s)", flush=True)
    finally:
        if lc:
            lc.close()
        stop(proc, log)
    print(f"done in {(time.time() - t_start) / 60:.1f} min", flush=True)
    summarize(argparse.Namespace(path=a.out))


def summarize(a):
    rows = [r for r in map(json.loads, open(a.path, encoding="utf-8")) if r.get("type") == "live"]
    by = collections.Counter()
    for r in rows:
        by[r["category"]] += r["graded_ok"]
    print(f"{sum(r['graded_ok'] for r in rows)}/{len(rows)} solved  " + "  ".join(f"{c}:{n}" for c, n in sorted(by.items())))
    print(f"mean model secs {sum(r['model_secs'] for r in rows) / max(len(rows), 1):.2f}; playbooks "
          f"{dict(collections.Counter(r['playbook'] for r in rows))}; early stops {sum(r['early_stop'] for r in rows)}; "
          f"escalations {sum(r['escalated'] for r in rows)}; Laya fallbacks {sum(not r['laya_ok'] for r in rows)}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("nested")
    n.add_argument("--out", required=True)
    n.add_argument("--trials", type=int, default=3)
    n.add_argument("--temp-alt", type=float, default=0.7)
    lv = sub.add_parser("live")
    lv.add_argument("--out", required=True)
    lv.add_argument("--rule", required=True)
    lv.add_argument("--calib", required=True)
    lv.add_argument("--note", choices=["on", "off"], default="on")
    lv.add_argument("--verify", choices=["on", "off"], default="on")
    lv.add_argument("--trials", type=int, default=3)
    lv.add_argument("--temp-alt", type=float, default=0.7)
    s = sub.add_parser("summarize")
    s.add_argument("path")
    a = ap.parse_args()
    {"nested": nested, "live": live, "summarize": summarize}[a.cmd](a)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Check that it imports and parses** (no GPU).

Run: `TIER2B_DIR=docs/benchmarks/laya-calib $PY $MB/playbook_tier2b.py --help`
Expected: usage showing `{nested,live,summarize}`.

- [ ] **Step 3: Smoke-test `LayaClient` against the real worker** (CPU only). The first command writes `docs/benchmarks/laya-partner/identity-calib.json` from `laya_calibrate.IDENTITY`:

```bash
mkdir -p docs/benchmarks/laya-partner
$PY -c "import json,sys; sys.path.insert(0,'scripts/moe-bench'); import laya_calibrate as lc; json.dump(lc.IDENTITY, open('docs/benchmarks/laya-partner/identity-calib.json','w'), indent=1)"
TIER2B_DIR=scripts/benchmark-tier2b $PY -c "
import sys; sys.path.insert(0,'scripts/moe-bench')
import playbook_tier2b as pt
lc = pt.LayaClient('docs/benchmarks/laya-partner/identity-calib.json')
print('dead', lc.dead)
print(lc.call({'op':'classify','state':pt.baseline_prompt(pt.TASKS[0])}))
print(lc.call({'op':'verify','requirement':'x','entry':'solution.py','code':'x = 1'}))
lc.close(); print('free MB', pt.available_mb())"
```
Expected: `dead False`, a classify reply with `card` and `secs` under 1 s, a verify reply with `p`, and a free-memory number.

- [ ] **Step 4: Commit.**

```bash
git add scripts/moe-bench/playbook_tier2b.py docs/benchmarks/laya-partner/identity-calib.json
git commit -m "feat(laya-partner): nested and live runners with the Laya worker client"
```

---

### Task 7: Zero-shot baseline on tier2b (CPU only, no GPU)

**Files:**
- Create: `docs/benchmarks/laya-partner/zeroshot-tier2b-labels.jsonl`, `docs/benchmarks/laya-partner/zeroshot-tier2b.json`

- [ ] **Step 1: Label tier2b's 39 tasks and the 936 stored candidates of last night's 8-candidate run.** This takes about 12 minutes on the CPU and resumes if interrupted.

Run: `TIER2B_DIR=scripts/benchmark-tier2b USE_TF=0 $LPY $MB/laya_partner.py label --runs docs/benchmarks/2026-10-05/bestofn-keep96-t07.jsonl --out docs/benchmarks/laya-partner/zeroshot-tier2b-labels.jsonl`
Expected: progress every 100 answers, ending `labelled in … s`. The file holds 78 card rows and 1,872 verify rows.

- [ ] **Step 2: Report it.**

Run: `$PY $MB/laya_calibrate.py zeroshot --bestofn docs/benchmarks/2026-10-05/bestofn-keep96-t07.jsonl --labels docs/benchmarks/laya-partner/zeroshot-tier2b-labels.jsonl --out docs/benchmarks/laya-partner/zeroshot-tier2b.json`
Expected: JSON with per-wording AUCs (`unseen`, `effort_little`, `effort_alot`), kind accuracy, and per-form verify AUC with mean P on right vs wrong candidates. These numbers are reported once and never used to choose anything.

- [ ] **Step 3: Commit.**

```bash
git add docs/benchmarks/laya-partner/zeroshot-tier2b-labels.jsonl docs/benchmarks/laya-partner/zeroshot-tier2b.json
git commit -m "docs(laya-partner): zero-shot baseline on tier2b (reported once, not used for tuning)"
```

---

### Task 8: Write the 48 calibration tasks

**Files:**
- Modify: `docs/benchmarks/laya-calib/tasks_a.py`, `tasks_c.py`, `tasks_d.py`, `tasks_e.py` (12 tasks each)

**Format.** The same as tier2b and validation-b: `dict(name, category, entry, files, spec, test, reference)`.
- **Visible file:** `files[entry]` is the buggy file the model sees.
- **E tasks:** they also carry a helper under `lib/`. It's present in the workspace but not shown; the spec names it.
- **Grading test:** `test` uses plain `assert`, runs as a script in the seeded folder, and never enters a prompt.
- **Reference:** `reference` is a correct entry file, used only by the validator.
- **No near-copies:** don't reuse tier2b or validation-b functions or conventions.

Example (category A):

```python
dict(name="c_rle_encode", category="A", entry="solution.py",
     files={"solution.py": '''def rle_encode(s):
    """Run-length encode a string: "aaabcc" -> [("a", 3), ("b", 1), ("c", 2)]."""
    out = []
    i = 0
    while i < len(s):
        j = i
        while j < len(s) and s[j] == s[i]:
            j += 1
        if j < len(s):
            out.append((s[i], j - i))
        i = j
    return out
'''},
     spec="Return (character, count) pairs for each run of equal characters, in order, including the last run; "
          "an empty string gives [].",
     reference='''def rle_encode(s):
    """Run-length encode a string: "aaabcc" -> [("a", 3), ("b", 1), ("c", 2)]."""
    out = []
    i = 0
    while i < len(s):
        j = i
        while j < len(s) and s[j] == s[i]:
            j += 1
        out.append((s[i], j - i))
        i = j
    return out
''',
     test='''from solution import rle_encode
assert rle_encode("aaabcc") == [("a", 3), ("b", 1), ("c", 2)], rle_encode("aaabcc")
assert rle_encode("") == []
assert rle_encode("x") == [("x", 1)]
assert rle_encode("abba") == [("a", 1), ("b", 2), ("a", 1)]
'''),
```

**The 48 tasks.** Name, then the bug the visible file has:

| A: algorithms | C: bad input | D: files and processes | E: library helpers (helper in `lib/`) |
|---|---|---|---|
| `c_rle_encode`: drops the last run | `c_parse_int_or`: `int(s)` crashes on None / "" / "abc"; must strip and default | `c_read_config`: crashes on a missing file; keeps `#` comments | `c_title_lib`: uses invented `str_utils.titlecase`; must use `lib/textfmt.title_word` |
| `c_balanced_brackets`: counts only, accepts "(]" | `c_deep_get`: KeyError / TypeError on missing path parts and list indices | `c_write_csv`: `open` without `newline=""` gives blank rows on Windows | `c_date_lib`: invented `dateparse.quick`; must use `lib/dates.parse_iso` → (y, m, d) |
| `c_moving_average`: misses the last window | `c_mean_or_none`: ZeroDivisionError on [] | `c_count_lines`: counts "\n", misses a last line without one | `c_round_lib`: `round()` gives 0.12 for 0.125; must use `lib/money.round_half_up` |
| `c_roman_to_int`: no subtractive pairs | `c_clean_email`: AttributeError on None | `c_backup_copy`: `os.rename` moves the original away | `c_mask_lib`: invented `pii.mask`; must use `lib/privacy.mask_local` |
| `c_flatten`: one level only | `c_split_tags`: keeps empty tags, crashes on None | `c_tail`: returns the first n lines | `c_wrap_lib`: invented `textwrap3.fill`; must use `lib/wraptext.wrap_words` |
| `c_kth_largest`: returns the kth smallest | `c_pct_change`: ZeroDivisionError when old is 0; must return None | `c_run_capture`: `check=True` raises on a nonzero exit; must return (code, stdout) | `c_hash_lib`: invented `idgen.hash6`; must use `lib/ids.short_hash` |
| `c_dedupe_keep_order`: `list(set(x))` loses order | `c_first_or`: indexes `[0]` (fails on generators and empty input) | `c_json_set`: opens with "a", corrupting JSON on a second write | `c_temp_lib`: invented `units2.celsius_to_f`; must use `lib/units.c_to_f` |
| `c_top_k_words`: no alphabetical tie-break | `c_clamp_checked`: silently accepts lo > hi; must raise ValueError | `c_safe_join`: allows "../" and absolute names; must raise ValueError | `c_zip_lib`: invented `zipcheck.valid`; must use `lib/validate.is_us_zip` |
| `c_running_max`: starts at 0, so all-negative input is wrong | `c_parse_pairs`: crashes on "c" or "=3"; must skip malformed pairs | `c_find_ext`: not recursive; must return sorted relative paths with "/" | `c_pct_lib`: invented `fmtx.percent`; must use `lib/fmt.pct` |
| `c_rotate_right`: rotates left; crashes on [] | `c_to_bool`: `bool(s)` treats "no" and "0" as True; unknown values must raise ValueError | `c_write_utf8`: default encoding fails on "✓"; must write UTF-8 | `c_words_lib`: invented `nlp.tokenize`; must use `lib/tokens.words` |
| `c_merge_sorted`: drops the longer list's tail | `c_max_by`: KeyError when an item lacks the key; must skip; all missing → None | `c_file_sha256`: reads in text mode; must hash the raw bytes | `c_median_lib`: invented `statsx.med`; must use `lib/stats.median` |
| `c_is_anagram`: set comparison ignores counts | `c_truncate`: None crashes, a negative n slices wrongly; None → "", n < 0 → ValueError | `c_write_lines`: `"\n".join`, so the last line has no newline | `c_join_lib`: invented `pathx.join`; must use `lib/paths.safe_join` |

E tasks follow tier2b's `slugify_with_lib`. The spec names the module and helper and says the invented names are not available. The test asserts the behaviour and that the invented name is absent from the source.

- [ ] **Step 1:** Write the 12 tasks of `tasks_a.py`. Run `TIER2B_DIR=docs/benchmarks/laya-calib $PY $MB/validate_tasks.py`. Expected: every A line `ok`, exit 0.
- [ ] **Step 2:** Do the same for `tasks_c.py`.
- [ ] **Step 3:** Do the same for `tasks_d.py`. Tests write only inside the seeded folder and use `sys.executable` for processes.
- [ ] **Step 4:** Do the same for `tasks_e.py`.
- [ ] **Step 5: Validate the whole pool.** Expected: `60/60 well-formed; per category {'A': 12, 'B': 12, 'C': 12, 'D': 12, 'E': 12}`.
- [ ] **Step 6: Commit.**

```bash
git add docs/benchmarks/laya-calib
git commit -m "feat(laya-partner): 48 new calibration tasks (A, C, D, E), all validated"
```

---

### Task 9: Write the 60 judge tasks and seal them

**Files:**
- Modify: `docs/benchmarks/laya-judge/tasks_a.py` … `tasks_e.py` (12 tasks each)

Same format and rules as Task 8. B tasks follow validation-b:
- `hidden_file` is in the package, and its source is never shown;
- the test exercises the real helper;
- each task hinges on one unseen convention that differs from validation-b's.

| A: algorithms | B: hidden convention | C: bad input | D: files and processes | E: library helpers |
|---|---|---|---|---|
| `j_pascal_row` | `j_weight_grams`: helper returns grams, entry assumes kg | `j_safe_json_loads`: bad JSON → default | `j_append_unique_line`: no duplicate lines | `j_snake_lib`: `lib/strings.snake_case` |
| `j_spiral_order` | `j_duration_minutes`: minutes, entry assumes hours | `j_parse_duration`: "1h30m" → 5400; bad → None | `j_read_json_or`: missing or corrupt file → default | `j_epoch_lib`: `lib/timeutil.to_epoch` |
| `j_common_prefix` | `j_disk_kib`: KiB (1024), entry divides by 1000 | `j_mean_skip_none`: ignore None values; all None → None | `j_copy_no_clobber`: existing destination → FileExistsError, untouched | `j_distance_lib`: `lib/geometry.distance` |
| `j_rle_decode` | `j_utc_offset_west`: minutes west of UTC, entry adds | `j_env_int`: missing or bad value → default | `j_count_words_files`: skip missing files | `j_hex_lib`: `lib/colors.hex_to_rgb` |
| `j_second_largest` | `j_month_zero_based`: month 0–11, entry indexes 1–12 | `j_split_full_name`: one word, extra spaces | `j_head_bytes`: binary read, first n bytes | `j_chunks_lib`: `lib/lists.chunked` |
| `j_count_islands` | `j_sorted_desc`: descending, entry takes [0] as lowest | `j_parse_price`: "$1,234.50" → 1234.5; bad → None | `j_run_snippet`: (code, stdout); timeout → (None, "") | `j_hash_lib`: `lib/hashing.stable_hash` |
| `j_to_base` | `j_pairs_not_dict`: list of pairs, entry calls `.get` | `j_safe_ratio`: zero denominator → None | `j_list_files_sorted`: files only, sorted | `j_email_lib`: `lib/check.is_email` |
| `j_merge_counts` | `j_missing_is_empty`: "" for missing, entry checks `is None` | `j_last_n`: n > len → all; n ≤ 0 → [] | `j_replace_in_file`: in place, returns the count | `j_clamp_lib`: `lib/numbers.clamp` |
| `j_unique_paths` | `j_range_exclusive`: end excluded, entry expects inclusive | `j_normalize_phone`: 10 digits or None; None in → None | `j_csv_column_sum`: quoted commas, via the `csv` module | `j_add_days_lib`: `lib/dates.add_days` |
| `j_caesar` | `j_basis_points`: basis points, entry treats as percent | `j_pairs_to_dict`: odd length → ValueError | `j_rotate_log`: keep N rotated logs | `j_accents_lib`: `lib/text.strip_accents` |
| `j_max_subarray` | `j_iso_weekday`: Mon = 1, entry assumes Mon = 0 | `j_index_or`: not found or None → -1 | `j_read_strip_bom`: utf-8-sig | `j_miles_lib`: `lib/units.km_to_miles` |
| `j_interleave` | `j_bytes_not_str`: helper returns bytes, entry concatenates str | `j_sum_numeric`: skip non-numbers and bools | `j_tee_write`: same text to two files, creating the second folder | `j_cents_lib`: `lib/currency.format_cents` |

- [ ] **Steps 1–5:** Write `tasks_a.py` … `tasks_e.py`, validating after each with `TIER2B_DIR=docs/benchmarks/laya-judge $PY $MB/validate_tasks.py`.
- [ ] **Step 6: Validate the whole set.** Expected: `60/60 well-formed; per category {'A': 12, 'B': 12, 'C': 12, 'D': 12, 'E': 12}`.
- [ ] **Step 7: Commit (the seal).** Nothing runs on these tasks until Task 12.

```bash
git add docs/benchmarks/laya-judge
git commit -m "feat(laya-partner): seal the 60-task judge set (validated; nothing has run on it)"
```

---

### Task 10: GPU session 1: resources, smoke test, calibration runs

**Precondition:** the owner has confirmed the Versutus gate may be paused. Pause it from `C:\Projects\Versutus` with `node gate\cli.mjs service stop`.

- [ ] **Step 1: Smoke-test the live runner.** Use 1 trial on the calibration pool with the identity calibration and a rule that sends everything to the recipe (`docs/benchmarks/laya-partner/smoke-rule.json` = `{"verify": {"c_u": 2, "c_easy": 2, "c_hard": 2, "t_hi": 0.5, "t_lo": 0.3}, "noverify": {"c_u": 2, "c_easy": 2, "c_hard": 2, "t_hi": 2, "t_lo": -1}}`). Stop it after the first few tasks with Ctrl-C.

Run: `TIER2B_DIR=docs/benchmarks/laya-calib $PY $MB/playbook_tier2b.py live --out /c/qwen3-forge-stage/logs/laya-smoke.jsonl --rule docs/benchmarks/laya-partner/smoke-rule.json --calib docs/benchmarks/laya-partner/identity-calib.json --trials 1`
Expected:
- `Laya worker up; N MB available with Qwen and Laya loaded`, with N ≥ 2048 (record N for the report);
- task lines like `c_rle_encode t0: R -> PASS (… s)`;
- some `early` or `escalated` lines are fine.

- [ ] **Step 2: Calibration nested runs.** 60 tasks × 3 trials, about 1.5 hours.

Run: `TIER2B_DIR=docs/benchmarks/laya-calib $PY $MB/playbook_tier2b.py nested --out /c/qwen3-forge-stage/logs/laya-calib-nested.jsonl`
Expected: 180 task-trial lines (`r8 k/8, pr m/3 pass grading`), then `done in … min`.

- [ ] **Step 3: Label them** (CPU, about 25 minutes). This can overlap the next GPU job.

Run: `TIER2B_DIR=docs/benchmarks/laya-calib USE_TF=0 $LPY $MB/laya_partner.py label --runs /c/qwen3-forge-stage/logs/laya-calib-nested.jsonl --out /c/qwen3-forge-stage/logs/laya-calib-labels.jsonl`

---

### Task 11: Fit and pre-register

- [ ] **Step 1: Fit the calibration.**

Run: `$PY $MB/laya_calibrate.py fit --trials /c/qwen3-forge-stage/logs/laya-calib-nested.jsonl --labels /c/qwen3-forge-stage/logs/laya-calib-labels.jsonl --out docs/benchmarks/laya-partner/calib.json`
Expected: the chosen wording and form, Platt parameters, and AUC and ECE before and after.

- [ ] **Step 2: Fit the rules.**

Run: `$PY $MB/playbook.py fit --trials /c/qwen3-forge-stage/logs/laya-calib-nested.jsonl --labels /c/qwen3-forge-stage/logs/laya-calib-labels.jsonl --calib docs/benchmarks/laya-partner/calib.json --out docs/benchmarks/laya-partner/rule.json`
Expected: `verify` and `noverify` rules with mean secs ≤ `budget_secs`, plus the playbook mix and calibration-pool scores. If the command exits with "no … rule fits", stop and report it: Laya's own time does not fit the budget.

- [ ] **Step 3: Copy the raw runs into the repo, scrubbed.**

```bash
cp /c/qwen3-forge-stage/logs/laya-calib-nested.jsonl /c/qwen3-forge-stage/logs/laya-calib-labels.jsonl docs/benchmarks/laya-partner/
$PY $MB/scrub_paths.py docs/benchmarks/laya-partner/laya-calib-nested.jsonl docs/benchmarks/laya-partner/laya-calib-labels.jsonl
```

- [ ] **Step 4: Write `docs/superpowers/specs/2026-10-05-laya-partner-prereg.md`.** It records:
  - `calib.json`'s chosen wording and form, and its AUC and ECE;
  - both rules and their fitted calibration-pool scores and costs;
  - the bar, word for word from the spec: configuration 4 beats configuration 2 on the judge set by exact two-sided McNemar, p < 0.10, solves more, and has mean model secs ≤ configuration 2's;
  - the judge commands of Task 12.
- [ ] **Step 5: Commit and push before any judge run.**

```bash
git add docs/benchmarks/laya-partner docs/superpowers/specs/2026-10-05-laya-partner-prereg.md
git commit -m "docs(laya-partner): pre-register calibration, rules and the bar before the judge run"
git push
```

---

### Task 12: GPU session 2: judge runs

- [ ] **Step 1: Judge nested runs** (configurations 1, 2 and 6; about 1.5 hours).

Run: `TIER2B_DIR=docs/benchmarks/laya-judge $PY $MB/playbook_tier2b.py nested --out /c/qwen3-forge-stage/logs/laya-judge-nested.jsonl`

- [ ] **Step 2: Configurations 3, 4 and 5** (about 1 hour).

```bash
env TIER2B_DIR=docs/benchmarks/laya-judge $PY $MB/playbook_tier2b.py live --out /c/qwen3-forge-stage/logs/laya-judge-c3.jsonl --rule docs/benchmarks/laya-partner/rule.json --calib docs/benchmarks/laya-partner/calib.json --note on --verify off
env TIER2B_DIR=docs/benchmarks/laya-judge $PY $MB/playbook_tier2b.py live --out /c/qwen3-forge-stage/logs/laya-judge-c4.jsonl --rule docs/benchmarks/laya-partner/rule.json --calib docs/benchmarks/laya-partner/calib.json --note on --verify on
env TIER2B_DIR=docs/benchmarks/laya-judge $PY $MB/playbook_tier2b.py live --out /c/qwen3-forge-stage/logs/laya-judge-c5.jsonl --rule docs/benchmarks/laya-partner/rule.json --calib docs/benchmarks/laya-partner/calib.json --note off --verify on
```

- [ ] **Step 3: Configurations 3–5 on tier2b** (about 40 minutes). Same three commands with `TIER2B_DIR=scripts/benchmark-tier2b` and outputs `laya-tier2b-c3/c4/c5.jsonl`.
- [ ] **Step 4: Label the judge nested runs** (CPU) for the diagnostics.

Run: `TIER2B_DIR=docs/benchmarks/laya-judge USE_TF=0 $LPY $MB/laya_partner.py label --runs /c/qwen3-forge-stage/logs/laya-judge-nested.jsonl --out /c/qwen3-forge-stage/logs/laya-judge-labels.jsonl`

- [ ] **Step 5: Restore the Versutus gate:** `node gate\cli.mjs service start` from `C:\Projects\Versutus`.

---

### Task 13: Report

- [ ] **Step 1: Score the judge set and run the diagnostics.**

```bash
L=/c/qwen3-forge-stage/logs; D=docs/benchmarks/laya-partner
$PY $MB/playbook.py report --trials $L/laya-judge-nested.jsonl --labels $L/laya-judge-labels.jsonl --calib $D/calib.json --rule $D/rule.json --live c3=$L/laya-judge-c3.jsonl --live c4=$L/laya-judge-c4.jsonl --live c5=$L/laya-judge-c5.jsonl --out $D/judge-report.json
$PY $MB/laya_calibrate.py report --trials $L/laya-judge-nested.jsonl --labels $L/laya-judge-labels.jsonl --calib $D/calib.json --out $D/judge-laya-diagnostics.json
for c in c3 c4 c5; do $PY $MB/playbook_tier2b.py summarize $L/laya-tier2b-$c.jsonl; done
```

- [ ] **Step 2: Copy and scrub the judge and tier2b run files** into `docs/benchmarks/laya-partner/` (as Task 11 Step 3).
- [ ] **Step 3: Write `docs/superpowers/specs/<judge-run date>-laya-partner-results.md`.** It covers:
  - the six configurations, per category, solved and cost;
  - the bar and whether it was met;
  - which step helped: 3 vs 2, 4 vs 3, 4 vs 5;
  - Laya's AUC and ECE on the judge set;
  - verify's false accepts and false rejects;
  - the RAM measurement;
  - the zero-shot tier2b baseline;
  - fallbacks.
- [ ] **Step 4: Update the `scripts/moe-bench/README.md` table** with the five new files, then commit and push.

```bash
git add docs scripts/moe-bench/README.md
git commit -m "docs(laya-partner): judge results"
git push
```

---

## Execution notes

- **Task 2:** `platt_fit` gained a backtracking line search. The plain Newton step diverged when every probability was alike; `test_platt_pulls_overconfidence_to_the_base_rate` caught it.
- **Tasks 8–9:** a check against tier2b's 39 tasks found collisions, and 22 of the tasks named in the tables above were replaced before anything ran on them.
  - **Shared names:** `merge_sorted`, `roman_to_int`, `clamp`, the hash fingerprint, the money label.
  - **Shared conventions:** running sums, nested lookups, None on divide by zero, creating parent folders, run-and-capture, JSON-or-default, BOM decoding, appending log lines, chunking.
  - **Calibration replacements:** `c_matrix_transpose`, `c_lcm_list`, `c_digital_root`, `c_pair_sum_count`, `c_parse_percent`, `c_as_list`, `c_parse_version`, `c_newest_file`, `c_merge_text_files`, `c_initials_lib`, `c_ordinal_lib`, `c_plural_lib`.
  - **Judge replacements:** `j_wrap_index`, `j_split_file`, `j_dir_size`, `j_copy_tree_ext`, `j_line_endings`, `j_unique_name`, `j_bmi_lib`, `j_mime_lib`, `j_luhn_lib`, `j_duration_lib`.
  - **Final state:** the three sets share no function names, `lib/` file names or task names. The task files are the source of truth.
