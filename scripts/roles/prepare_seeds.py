"""seeds.jsonl -> seeds-clean.jsonl: drops empty and upstream-excluded rows, adds sid and split, flags Lab-near seeds.
usage: prepare_seeds.py --dir E:/AI/teacher-data/gen-v0"""
import argparse
import collections
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import exclude  # noqa: E402
import splits  # noqa: E402


def prepare(src, dst):
    kept, usable = 0, collections.Counter()
    with open(dst, "w", encoding="utf-8") as out:
        for line in open(src, encoding="utf-8"):
            r = json.loads(line)
            if r.get("empty") or r.get("excluded"):
                continue
            r["sid"] = "|".join([r["lang"], r["kind"], r["field"], str(r["i"])])
            r["split"] = splits.split_of(r["field"])
            reason = exclude.lab_hit(r.get("title", "") + " " + r["request"])
            r["lab_excluded"], r["lab_reason"] = bool(reason), reason
            out.write(json.dumps(r) + "\n")
            kept += 1
            usable[r["split"]] += not r["lab_excluded"]
    return {"rows": kept, "usable": dict(usable)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    a = ap.parse_args()
    d = pathlib.Path(a.dir)
    print(json.dumps(prepare(d / "seeds.jsonl", d / "seeds-clean.jsonl")))


if __name__ == "__main__":
    main()
