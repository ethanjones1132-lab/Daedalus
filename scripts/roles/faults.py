"""Teacher-authored faults for the fix role (spec section 2): DeepSeek inserts one realistic bug into a build that passed
its acceptance tests; a fault is kept only if the tests then fail without a crash. The original code is the fix target.
usage: faults.py --dir E:/AI/teacher-data/gen-v0 [--per-seed 2] [--splits train,dev] [--workers 6]"""
import argparse
import concurrent.futures
import json
import pathlib
import sys
import threading

HERE = pathlib.Path(__file__).resolve().parent
for p in (HERE, HERE.parent / "teacher", HERE.parent / "moe-bench"):
    sys.path.insert(0, str(p))
import samples  # noqa: E402
import teacher_gen as tg  # noqa: E402

CRASH = ("SyntaxError", "IndentationError", "ModuleNotFoundError", "ImportError", "Cannot find module",
         "Unexpected token")
FAULT_PROMPT = """Here is a working implementation and the acceptance tests it passes.

Request:
{request}

Files:
{files}

Acceptance tests:
{tests}

Introduce exactly one realistic bug, the kind a careful engineer might make: an off-by-one, a wrong comparison or
operator, a missed edge case, a mishandled empty or malformed input, a wrong default, state that is not reset, or an
ordering or formatting mistake. The bug must make at least one acceptance test fail. The code must still load and run:
no syntax errors, no missing imports. Keep the change small (a few lines).

Reply with every file in full, each in its own fenced code block whose first line is a comment naming the file, e.g.
`# file: tool.py`, `// file: lib.js` or `<!-- file: index.html -->`. Do not explain the change or mark it in the code."""
_lock = threading.Lock()


def passing_files(rec):
    """The files that passed the seed's tests: the first build if it passed, else the fix."""
    text = rec["build"] if rec.get("build_ok") else rec.get("fix") if rec.get("fix_ok") else None
    return tg.extract_files(text, rec["entry"]) if text else None


def check_fault(lang, tests, original, bad):
    """The failure output if `bad` is a usable fault of `original`, else None."""
    if not bad or bad == original:
        return None
    ok, out = tg.run_tests(lang, bad, tests)
    return None if ok or any(m in out for m in CRASH) else out


def one(rec, k, path):
    files = passing_files(rec)
    prompt = FAULT_PROMPT.format(request=rec["request"], files=samples.show_files(files), tests=rec["tests"])
    text, secs, err = tg.call("deepseek", prompt)
    bad = tg.extract_files(text, rec["entry"]) if text else {}
    out = check_fault(rec["lang"], rec["tests"], files, bad)
    row = {"sid": samples.sid_of(rec), "k": k, "split": samples.split_of_rec(rec), "lang": rec["lang"],
           "request": rec["request"], "entry": rec["entry"], "tests": rec["tests"], "ok": out is not None,
           "secs": secs, "err": err}
    if out is not None:
        row.update(files_ok=files, files_bad=bad, fail_out=out)
    with _lock, open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")
    print(f"fault {row['sid'][:60]:60} k{k}: {'kept' if row['ok'] else 'dropped'}{'; ' + err if err else ''}", flush=True)


_told = threading.Event()


def safe_one(rec, k, path):
    """One job; a spent usage window or token cap (teacher_gen.Stop) ends the jobs quietly and records nothing for them."""
    try:
        one(rec, k, path)
    except tg.Stop as e:
        if not _told.is_set():
            _told.set()
            print(f"fault STOP: {e}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--per-seed", type=int, default=2, help="faults per train seed (dev gets 1)")
    ap.add_argument("--splits", default="train,dev")
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    d = pathlib.Path(a.dir)
    path = d / "faults.jsonl"
    done = {(r["sid"], r["k"]) for r in samples.read_jsonl(path) if not r.get("err")}
    jobs = []
    for rec in samples.read_jsonl(d / "runs.jsonl"):
        split = samples.split_of_rec(rec)
        if split not in a.splits.split(",") or not passing_files(rec):
            continue
        for k in range(a.per_seed if split == "train" else 1):
            if (samples.sid_of(rec), k) not in done:
                jobs.append((rec, k))
    # shortest programs first: a fix prompt shows every file, and the trainer drops samples over its token cap, so
    # the short ones are the ones that become training data
    jobs.sort(key=lambda j: (j[1], sum(len(c) for c in passing_files(j[0]).values())))
    print(f"{len(jobs)} fault jobs", flush=True)
    with concurrent.futures.ThreadPoolExecutor(a.workers) as ex:
        list(ex.map(lambda j: safe_one(j[0], j[1], path), jobs))


if __name__ == "__main__":
    main()
