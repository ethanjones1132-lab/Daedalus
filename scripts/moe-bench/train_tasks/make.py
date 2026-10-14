"""Training tasks from the task-writer's raw answers (plan 2026-10-06-adapters-phase2.md, Task 3).

Each candidate must parse, have the pool's fields, pass validate_tasks.py's check (the test fails on the buggy entry
file and passes on the reference, through tier2b's own seed/run_test), and be disjoint from every scored set
(tier2b, the calibration pool with validation-b, the sealed judge set): no shared task name, no shared top-level
function, class or module name (a few generic names excepted), no hidden-module name in common, and no spec with
word overlap (Jaccard) of 0.5 or more with a scored spec.

usage: make.py check-examples
       make.py build --raw raw.jsonl --out DIR [--workers 8]   (DIR becomes a task set: tasks.json, tasks.py, runbench2b.py)
"""
import argparse
import ast
import collections
import concurrent.futures
import importlib.util
import json
import pathlib
import re
import shutil
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "benchmark-tier2b"))
from runbench2b import run_test, seed  # noqa: E402

REQUIRED = ("name", "entry", "files", "spec", "reference", "test")
GENERIC = {"main", "run", "load", "save", "get", "set", "update", "process", "solution", "helpers", "utils", "lib",
           "test", "parse", "format", "convert", "compute", "calculate", "total", "add", "remove"}
SCORED = {"tier2b": ROOT / "scripts" / "benchmark-tier2b" / "tasks.py",
          "pool": ROOT / "docs" / "benchmarks" / "laya-calib" / "tasks.py",
          "judge": ROOT / "docs" / "benchmarks" / "laya-judge" / "tasks.py"}


def load_tasks(path, tag):
    spec = importlib.util.spec_from_file_location(f"_scored_{tag}", path)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(path.parent))
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.path.remove(str(path.parent))
    return mod.TASKS


def idents(task):
    """Top-level def/class names of every file and the reference, plus module stems."""
    out = set()
    for src in list(task.get("files", {}).values()) + [task.get("reference", "")]:
        try:
            tree = ast.parse(src)
        except SyntaxError:
            continue
        out |= {n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
    out |= {pathlib.PurePosixPath(p).stem for p in task.get("files", {})}
    return out - GENERIC


def words(text):
    return {w for w in re.findall(r"[a-z]{3,}", text.lower())}


def scored_index():
    names, ids, hidden, specs = set(), set(), set(), []
    for tag, path in SCORED.items():
        for t in load_tasks(path, tag):
            names.add(t["name"])
            ids |= idents(t)
            if t.get("hidden_file"):
                hidden.add(pathlib.PurePosixPath(t["hidden_file"]).stem)
            specs.append(words(t["spec"]))
    return names, ids, hidden, specs


def jaccard(a, b):
    return len(a & b) / max(1, len(a | b))


def validate(task):
    """(ok, reason): buggy fails, reference passes (validate_tasks.py's rule, same harness)."""
    res = {}
    for label, code in (("buggy", task["files"][task["entry"]]), ("reference", task["reference"])):
        d = pathlib.Path(tempfile.mkdtemp(prefix="tt-"))
        try:
            seed(d, task)
            (d / task["entry"]).write_text(code, encoding="utf-8")
            res[label] = run_test(d, task["test"])
        except Exception as e:  # noqa: BLE001
            res[label] = (False, f"harness: {e!r}")
        finally:
            shutil.rmtree(d, ignore_errors=True)
    if res["buggy"][0]:
        return False, "test passes on the buggy file"
    if not res["reference"][0]:
        return False, "test fails on the reference"
    return True, "ok"


def normalize(raw):
    """A raw answer -> (task, None) or (None, reason)."""
    try:
        t = json.loads(raw["content"])
    except (json.JSONDecodeError, TypeError):
        return None, "not JSON"
    if not isinstance(t, dict) or any(k not in t for k in REQUIRED):
        return None, "missing fields"
    if not isinstance(t["files"], dict) or t["entry"] not in t["files"]:
        return None, "entry not in files"
    if not all(isinstance(v, str) for v in list(t["files"].values()) + [t["spec"], t["reference"], t["test"]]):
        return None, "non-text field"
    fam = raw["family"]
    if fam in ("B", "E"):
        h = t.get("hidden_file")
        if not h or h not in t["files"] or h == t["entry"]:
            return None, "no hidden file"
    else:
        t.pop("hidden_file", None)
    name = re.sub(r"[^a-z0-9_]", "_", str(t["name"]).lower())
    t["name"] = name if name.startswith("t_") else "t_" + name
    t["category"] = fam
    t["topic"] = raw["topic"]
    keys = ["name", "category", "entry", "files", "spec", "reference", "test", "topic"]
    return {k: t[k] for k in keys + (["hidden_file"] if "hidden_file" in t else [])}, None


def check_examples(a):
    from families import FAMILIES
    for fam, f in FAMILIES.items():
        t = dict(f["example"], category=fam)
        print(fam, t["name"], validate(t))


def build(a):
    names, ids, hidden, specs = scored_index()
    rows = [json.loads(l) for l in open(a.raw, encoding="utf-8") if l.strip()]
    why = collections.Counter()
    cands, seen = [], set()
    for raw in rows:
        t, reason = normalize(raw)
        if t is None:
            why[f"{raw['family']}: {reason}"] += 1
            continue
        if t["name"] in seen:
            t["name"] += f"_{raw['id'].lower()}"
        seen.add(t["name"])
        clash = (t["name"] in names) or (idents(t) & ids) or \
                (t.get("hidden_file") and pathlib.PurePosixPath(t["hidden_file"]).stem in hidden) or \
                any(jaccard(words(t["spec"]), s) >= 0.5 for s in specs)
        if clash:
            why[f"{t['category']}: overlaps a scored task"] += 1
            continue
        cands.append(t)
    with concurrent.futures.ProcessPoolExecutor(a.workers) as ex:
        verdicts = list(ex.map(validate, cands, chunksize=8))
    kept = []
    for t, (ok, reason) in zip(cands, verdicts):
        if ok:
            kept.append(t)
        else:
            why[f"{t['category']}: {reason}"] += 1
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "tasks.json").write_text(json.dumps(kept, indent=0), encoding="utf-8")
    (out / "tasks.py").write_text(
        '"""Adapters phase-2 training tasks (plan 2026-10-06-adapters-phase2.md, Task 3): written by the teacher model,\n'
        'validated (buggy fails, reference passes) and disjoint from tier2b, the pool and the judge set (make.py).\n'
        'Training only: never scored."""\nimport json\nimport pathlib\n\nK = 1\n'
        'TASKS = json.loads((pathlib.Path(__file__).resolve().parent / "tasks.json").read_text(encoding="utf-8"))\n',
        encoding="utf-8")
    shutil.copy(ROOT / "docs" / "benchmarks" / "laya-calib" / "runbench2b.py", out / "runbench2b.py")
    report = {"raw": len(rows), "kept": len(kept), "by_family": dict(collections.Counter(t["category"] for t in kept)),
              "rejected": dict(why.most_common())}
    (out / "make-report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(json.dumps(report, indent=1))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check-examples")
    b = sub.add_parser("build")
    b.add_argument("--raw", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()
    sys.path.insert(0, str(HERE))
    {"check-examples": check_examples, "build": build}[a.cmd](a)


if __name__ == "__main__":
    main()
