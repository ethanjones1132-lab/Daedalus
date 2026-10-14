"""Family E, second version (plan 2026-10-06-adapters-phase2.md, Task 3; found by Task 6 on the pool).

The generated E tasks' buggy files already import from the real package path (`from lib.<module> import <wrong>`), so
the fix only renames a function, and LoRA v1 learned to keep whatever import path it saw: on the pool, whose E files
import a module that does not exist (`from str_utils import ...`), it wrote `from textfmt import ...` and lost 4.
Here the buggy file's `lib.` prefix is dropped (`from <module> import <wrong>`), so the fix has to build the package
path from the spec, as in the pool. References and tests are unchanged; every rewritten task is validated again.

usage: rewrite_e.py --tasks v1/tasks.json --out v2_dir
"""
import argparse
import json
import pathlib
import re
import shutil
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import make  # noqa: E402

LIB_IMPORT = re.compile(r"^(\s*)(from|import)\s+lib\.(\w+)", re.M)


def rewrite(task):
    t = json.loads(json.dumps(task))
    t["files"][t["entry"]] = LIB_IMPORT.sub(lambda m: f"{m.group(1)}{m.group(2)} {m.group(3)}", t["files"][t["entry"]])
    return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    tasks = json.load(open(a.tasks, encoding="utf-8"))
    out, changed, dropped = [], 0, 0
    for t in tasks:
        if t["category"] != "E":
            out.append(t)
            continue
        t2 = rewrite(t)
        if t2["files"][t2["entry"]] == t["files"][t["entry"]]:
            dropped += 1  # nothing to rewrite: not the pool's shape
            continue
        ok, why = make.validate(t2)
        if ok:
            out.append(t2)
            changed += 1
        else:
            dropped += 1
    d = pathlib.Path(a.out)
    d.mkdir(parents=True, exist_ok=True)
    (d / "tasks.json").write_text(json.dumps(out, indent=0), encoding="utf-8")
    src = pathlib.Path(a.tasks).parent
    for f in ("tasks.py", "runbench2b.py"):
        shutil.copy(src / f, d / f)
    print(json.dumps({"tasks": len(out), "e_rewritten": changed, "e_dropped": dropped}))


if __name__ == "__main__":
    main()
