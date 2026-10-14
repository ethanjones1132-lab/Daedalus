"""Mixed-model pool from two bestofn_tier2b.py runs (2026-10-05): per task-trial, the first k
candidates of run A plus the first m of run B, checked against the self-test suites of both runs,
then chosen by the same policies. No generation: every candidate and suite is already stored.

Different models fail differently (Qwen keep96: hidden-package 6/21; Gemma 26B: 15/21), so a mixed
pool should raise the oracle, and the self-tests decide whether selection can find it.

usage: bestofn_mix.py A.jsonl:k B.jsonl:m [OUT.jsonl]
"""
import collections
import json
import pathlib
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import bestofn_tier2b as bon  # noqa: E402


def load(spec):
    path, n = spec.rsplit(":", 1)
    rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    cands, suites = {}, {}
    for r in rows:
        if r["type"] == "cand" and r["cand"] < int(n):
            cands[(r["task"], r["trial"], r["cand"])] = r
        elif r["type"] == "suite":
            suites[(r["task"], r["trial"], r["suite"])] = r
    return pathlib.Path(path).stem, cands, suites


def main():
    runs = [load(s) for s in sys.argv[1:3]]
    out = pathlib.Path(sys.argv[3] if len(sys.argv) > 3 else
                       pathlib.Path(sys.argv[1].rsplit(":", 1)[0]).with_name("bestofn-mix.jsonl"))
    tasks = {t["name"]: t for t in bon.TASKS}
    keys = sorted({k[:2] for _, c, _ in runs for k in c} & set.intersection(*[{k[:2] for k in c} for _, c, _ in runs]))
    with out.open("w", encoding="utf-8") as f, ThreadPoolExecutor(8) as ex:
        for name, trial in keys:
            task = tasks[name]
            suite_list = []
            for _, _, suites in runs:
                for s in sorted(k[2] for k in suites if k[:2] == (name, trial)):
                    code = suites[(name, trial, s)]["code"]
                    suite_list.append((code, bon.test_names(code)))
            pool = []
            for label, cands, _ in runs:
                pool += [(label, cands[k]) for k in sorted(k for k in cands if k[:2] == (name, trial))]
            checks = list(ex.map(lambda lc: bon.check(task, bon.extract_code(lc[1]["content"]), suite_list), pool))
            for i, ((label, row), chk) in enumerate(zip(pool, checks)):
                f.write(json.dumps({**row, **chk, "type": "cand", "cand": i, "source": label}) + "\n")
            f.flush()
            print(f"{name} t{trial}: {sum(c['graded_ok'] for c in checks)}/{len(pool)} pass grading", flush=True)
    bon.analyze(type("A", (), {"out": str(out)}))


if __name__ == "__main__":
    main()
