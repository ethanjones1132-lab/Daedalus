"""The Laya v3 judge set (spec 2026-10-07-laya-v3-design.md §2): DeepSeek on OpenCode Go writes tier2b-format tasks
from train_tasks/families.py's family briefs, which carry one format example each, written for that file and from
no scored set. train_tasks/make.py normalizes them, checks disjointness from tier2b, the pool and the old judge set,
and validates them (the buggy file fails its test, the reference passes). The first 24 valid per family, in id order,
form the set. No filtering on any model's performance.

usage: judgeset_writer.py run --out docs/benchmarks/laya-judge3 [--k 24] [--round 20] [--max-per-family 160]
"""
import argparse
import collections
import concurrent.futures
import json
import pathlib
import shutil
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "train_tasks"))
import families  # noqa: E402
import make  # noqa: E402
import opencode_go  # noqa: E402

TASKS_PY = ('"""Laya v3 judge set (spec 2026-10-07-laya-v3-design.md §2): 120 tier2b-format tasks written by DeepSeek\n'
            'on OpenCode Go, validated, disjoint from tier2b, the pool and the old judge set. Scoring only; sealed by\n'
            'commit before anything runs on it."""\nimport json\nimport pathlib\n\nK = 3\n'
            'TASKS = json.loads((pathlib.Path(__file__).resolve().parent / "tasks.json").read_text(encoding="utf-8"))\n')


def judge_prompts(per_family, seed=11):
    out = []
    for pid, fam, topic, text in families.prompts(per_family, seed=seed):
        text = text.replace("You write training tasks for a Python bug-fixing benchmark",
                            "You write tasks for a Python bug-fixing benchmark")
        out.append((pid, fam, topic, text))
    return out


def select(kept, k):
    by = collections.defaultdict(list)
    for t in sorted(kept, key=lambda t: t["id"]):
        by[t["category"]].append(t)
    sel = []
    for fam in sorted(by):
        for t in by[fam][:k]:
            sel.append(dict(t, name="d_" + t["name"].removeprefix("t_")))
    return sel


def short_families(kept, k):
    have = collections.Counter(t["category"] for t in kept)
    return {f: k - have[f] for f in "ABCDE" if have[f] < k}


def generate(client, prompts, raw_path, workers=8):
    done = set()
    if raw_path.exists():
        done = {json.loads(l)["id"] for l in raw_path.read_text(encoding="utf-8").splitlines() if l.strip()}
    todo = [p for p in prompts if p[0] not in done]

    def one(p):
        pid, fam, topic, text = p
        try:
            return {"id": pid, "family": fam, "topic": topic, "content": client.chat(text)}
        except Exception as e:  # noqa: BLE001 - one failed call must not stop the batch
            return {"id": pid, "family": fam, "topic": topic, "content": "", "error": repr(e)[:200]}

    with concurrent.futures.ThreadPoolExecutor(workers) as ex, raw_path.open("a", encoding="utf-8") as f:
        for row in ex.map(one, todo):
            f.write(json.dumps(row) + "\n")
            f.flush()


def build(raw_path):
    """Valid, disjoint candidates (make.py's rules), each with its raw id."""
    names, ids, hidden, specs = make.scored_index()
    cands = []
    for raw in map(json.loads, raw_path.read_text(encoding="utf-8").splitlines()):
        obj = opencode_go.extract_json(raw.get("content") or "")
        if obj is None:
            continue
        t, _ = make.normalize(dict(raw, content=json.dumps(obj)))  # normalize() expects JSON text in "content"
        if t is None:
            continue
        clash = (t["name"] in names) or (make.idents(t) & ids) or \
                (t.get("hidden_file") and pathlib.PurePosixPath(t["hidden_file"]).stem in hidden) or \
                any(make.jaccard(make.words(t["spec"]), s) >= 0.5 for s in specs)
        if not clash:
            cands.append(dict(t, id=raw["id"]))
    with concurrent.futures.ProcessPoolExecutor(8) as ex:
        verdicts = list(ex.map(make.validate, cands, chunksize=4))
    return [t for t, (ok, _) in zip(cands, verdicts) if ok]


def run(a):
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    raw_path = out / "raw.jsonl"
    client = opencode_go.Client()
    print(f"writer: {client!r}", flush=True)
    per_family, kept = 0, []
    while per_family < a.max_per_family:
        per_family += a.round
        generate(client, judge_prompts(per_family), raw_path)
        kept = build(raw_path)
        short = short_families(kept, a.k)
        print(f"{per_family} prompts per family -> valid {dict(collections.Counter(t['category'] for t in kept))}; "
              f"short {short}", flush=True)
        if not short:
            break
    sel = select(kept, a.k)
    (out / "tasks.json").write_text(json.dumps([{k: v for k, v in t.items() if k != "id"} for t in sel], indent=0),
                                    encoding="utf-8")
    (out / "tasks.py").write_text(TASKS_PY, encoding="utf-8")
    shutil.copy(HERE.parents[1] / "docs" / "benchmarks" / "laya-calib" / "runbench2b.py", out / "runbench2b.py")
    report = {"writer_model": client.model, "prompts_per_family": per_family, "valid": len(kept),
              "selected": dict(collections.Counter(t["category"] for t in sel)), "ids": [t["id"] for t in sel]}
    (out / "writer-report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "ids"}, indent=1))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--out", required=True)
    r.add_argument("--k", type=int, default=24)
    r.add_argument("--round", type=int, default=20)
    r.add_argument("--max-per-family", type=int, default=160)
    a = ap.parse_args()
    run(a)


if __name__ == "__main__":
    main()
