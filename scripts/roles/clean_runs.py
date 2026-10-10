"""Drops infrastructure failures (an empty plan or build, or API errors) from runs.jsonl so `gen` retries them; real
test failures stay. The original is kept as runs.jsonl.bak. usage: clean_runs.py --dir E:/AI/teacher-data/gen-v0"""
import argparse
import json
import pathlib
import shutil


def clean(path):
    path = pathlib.Path(path)
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    keep = [r for r in rows if r.get("plan") and r.get("build") and not r.get("errors")]
    shutil.copy(path, str(path) + ".bak")
    path.write_text("".join(json.dumps(r) + "\n" for r in keep), encoding="utf-8")
    return len(keep), len(rows) - len(keep)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    a = ap.parse_args()
    print(clean(pathlib.Path(a.dir) / "runs.jsonl"))


if __name__ == "__main__":
    main()
