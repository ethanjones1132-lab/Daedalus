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
