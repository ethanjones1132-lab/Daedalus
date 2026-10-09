"""Appends a second seed round to the first: task index shifted by --offset, near-duplicates (Jaccard >= 0.6 on the
request words) of anything already present dropped, rows tagged round 2. Idempotent.
usage: merge_seeds.py --base E:/AI/teacher-data/gen-v0/seeds.jsonl --extra E:/AI/teacher-data/gen-v0b/seeds.jsonl"""
import argparse
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "moe-bench" / "train_tasks"))
import make  # noqa: E402

LIMIT = 0.6


def read(path):
    p = pathlib.Path(path)
    return [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()] if p.exists() else []


def merge(base, extra, offset=3):
    have = [make.words(r["request"]) for r in read(base) if r.get("request")]
    added = duplicates = skipped = 0
    with open(base, "a", encoding="utf-8") as out:
        for r in read(extra):
            if r.get("empty") or r.get("excluded") or not r.get("request"):
                skipped += 1
                continue
            w = make.words(r["request"])
            if any(make.jaccard(w, h) >= LIMIT for h in have):
                duplicates += 1
                continue
            r["i"] = r["i"] + offset
            r["round"] = 2
            out.write(json.dumps(r) + "\n")
            have.append(w)
            added += 1
    return {"added": added, "duplicates": duplicates, "skipped": skipped}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--extra", required=True)
    ap.add_argument("--offset", type=int, default=3)
    a = ap.parse_args()
    print(json.dumps(merge(a.base, a.extra, a.offset)))


if __name__ == "__main__":
    main()
