"""Repair with self-test feedback on tier2b (2026-10-05): the test-driven loop of the swarm design.

Per task and trial:
  1. one self-test suite, written by the model from the visible task information (as in bestofn_tier2b)
  2. one fix (the single-shot answer: the model's best temperature, the tier2b seed)
  3. run the self-tests in a seeded workspace with the grading test removed; if any fail, show the
     model its previous file and each failing test with its error, and ask for a corrected file
  4. repeat up to --rounds times; stop early when every self-test passes
The grading test scores every round's file, for analysis only. It never enters the loop.

Best-of-N picks among independent samples, so it cannot fix a task where all samples fail the same
way. Repair adds information: which checks fail, and how. The risk is the verifier: about 15% of
self-tests were wrong on keep96, and repair can bend correct code to satisfy a wrong test. The
analysis counts both directions.

usage: repair_tier2b.py run --model qwen36keep96|gemma26b --out OUT.jsonl [--rounds 2] [--trials 3]
       repair_tier2b.py analyze OUT.jsonl
"""
import argparse
import collections
import json
import pathlib
import py_compile
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import bestofn_tier2b as bon  # noqa: E402
from bestofn_tier2b import baseline_prompt, extract_code, TASKS  # noqa: E402

# Like bestofn_tier2b.RUNNER, but keeps each failure's last error line for the feedback.
RUNNER = """import importlib.util, inspect, json, sys, traceback, unittest
spec = importlib.util.spec_from_file_location("_selftest", sys.argv[1])
try:
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
except BaseException as e:
    print(json.dumps({"__load_error__": [False, repr(e)[:300]]}))
    sys.exit(0)
def last(e):
    return (traceback.format_exception_only(type(e), e)[-1].strip() or type(e).__name__)[:300]
res = {}
for name, obj in sorted(vars(m).items()):
    if getattr(obj, "__module__", None) != m.__name__:
        continue
    if inspect.isfunction(obj) and name.startswith("test"):
        try:
            obj()
            res[name] = [True, ""]
        except BaseException as e:
            res[name] = [False, last(e)]
    elif inspect.isclass(obj) and issubclass(obj, unittest.TestCase):
        for meth in sorted(n for n in dir(obj) if n.startswith("test") and callable(getattr(obj, n))):
            r = unittest.TestResult()
            obj(meth).run(r)
            bad = r.failures + r.errors
            res[f"{name}.{meth}"] = [not bad, (bad[0][1].strip().splitlines() or ["?"])[-1][:300] if bad else ""]
print(json.dumps(res))
"""


def self_check(task, code, suite):
    """-> (compiles, {test: [ok, error]}) in a seeded workspace without the grading test."""
    d = bon.workspace(task, code)
    try:
        try:
            py_compile.compile(str(d / task["entry"]), doraise=True)
        except py_compile.PyCompileError as e:
            return False, {"__compile__": [False, str(e).strip().splitlines()[-1][:300]]}
        (d / "_runner.py").write_text(RUNNER, encoding="utf-8")
        (d / "_selftest.py").write_text(suite, encoding="utf-8")
        try:
            r = subprocess.run([sys.executable, "_runner.py", "_selftest.py"], cwd=d, capture_output=True,
                               text=True, timeout=10)
            return True, json.loads((r.stdout.strip().splitlines() or ["{}"])[-1])
        except subprocess.TimeoutExpired:
            return True, {"__timeout__": [False, "the tests did not finish within 10 seconds"]}
        except json.JSONDecodeError:
            return True, {"__runner__": [False, (r.stderr.strip().splitlines() or ["?"])[-1][:300]]}
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_sources(suite):
    """test name -> its source, for functions and Class.method (a bare assert fails with no message)."""
    import ast
    try:
        tree = ast.parse(suite)
    except SyntaxError:
        return {}
    out = {}
    for n in tree.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith("test"):
            out[n.name] = ast.get_source_segment(suite, n) or ""
        elif isinstance(n, ast.ClassDef):
            for m in n.body:
                if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and m.name.startswith("test"):
                    out[f"{n.name}.{m.name}"] = ast.get_source_segment(suite, m) or ""
    return out


def repair_prompt(task, code, failures, suite):
    src = test_sources(suite)
    parts = []
    for name, err in failures[:6]:
        body = src.get(name, "")
        parts.append(f"- {name}: {err}" + (f"\n```python\n{body[:800]}\n```" if body else ""))
    return (baseline_prompt(task) + f"\n\nYour previous version of {task['entry']}:\n```python\n{code}\n```\n"
            f"These checks failed against it:\n" + "\n".join(parts) + "\n\nA check can itself be wrong; fix the "
            f"file only where the requirement supports the check. Return only the complete corrected {task['entry']}.")


def grade(task, code):
    g = pathlib.Path(tempfile.mkdtemp(prefix="repair-grade-"))
    try:
        bon.seed(g, task)
        (g / task["entry"]).write_text(code, encoding="utf-8")
        return bon.run_test(g, task["test"])
    finally:
        shutil.rmtree(g, ignore_errors=True)


def run(a):
    bon.CFG.update(bon.CONFIGS[a.model], budget=a.budget)
    out = pathlib.Path(a.out)
    done = set()
    if out.exists():
        done = {(r["task"], r["trial"]) for r in map(json.loads, out.read_text(encoding="utf-8").splitlines())}
    log = open(out.with_suffix(".server.log"), "a", encoding="utf-8", errors="replace")
    proc = bon.start_server(log)
    t_start = time.time()
    try:
        with out.open("a", encoding="utf-8") as f:
            for task in TASKS:
                for trial in range(a.trials):
                    if (task["name"], trial) in done:
                        continue
                    t = time.time()
                    text, _ = bon.chat(bon.test_prompt(task), 20000 + 100 * trial)
                    suite = extract_code(text)
                    answer, _ = bon.chat(baseline_prompt(task), trial)
                    code = extract_code(answer)
                    rounds = []
                    for rnd in range(a.rounds + 1):
                        compiles, res = self_check(task, code, suite)
                        ok, detail = grade(task, code)
                        fails = [(n, v[1]) for n, v in res.items() if not v[0]]
                        rounds.append({"round": rnd, "graded_ok": ok, "detail": detail, "compiles": compiles,
                                       "self_total": len(res), "self_failed": len(fails), "code": code})
                        if not fails or rnd == a.rounds:
                            break
                        answer, _ = bon.chat(repair_prompt(task, code, fails, suite), 40000 + 100 * trial + rnd)
                        code = extract_code(answer)
                    f.write(json.dumps({"task": task["name"], "category": task["category"], "trial": trial,
                                        "suite": suite, "rounds": rounds}) + "\n")
                    f.flush()
                    print(f"{task['name']} t{trial}: " + " -> ".join(
                        f"{'PASS' if r['graded_ok'] else 'fail'}({r['self_failed']}/{r['self_total']})" for r in rounds)
                          + f" {time.time() - t:.0f} s", flush=True)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
    print(f"done in {(time.time() - t_start) / 60:.1f} min", flush=True)
    analyze(argparse.Namespace(out=a.out))


def analyze(a):
    rows = [json.loads(l) for l in open(a.out, encoding="utf-8") if l.strip()]
    first, final = collections.Counter(), collections.Counter()
    moves = collections.Counter()
    for r in rows:
        f0, fn = r["rounds"][0]["graded_ok"], r["rounds"][-1]["graded_ok"]
        first[r["category"]] += f0
        final[r["category"]] += fn
        if len(r["rounds"]) > 1:
            moves[("fixed" if fn and not f0 else "broke" if f0 and not fn else "stayed right" if fn else
                   "stayed wrong")] += 1
    cats = sorted({r["category"] for r in rows})
    print(f"{len(rows)} task-trials")
    print("single shot   " + f"{sum(first.values())}/{len(rows)}  " + "  ".join(f"{c}:{first[c]}" for c in cats))
    print("after repair  " + f"{sum(final.values())}/{len(rows)}  " + "  ".join(f"{c}:{final[c]}" for c in cats))
    print("task-trials that entered repair:", dict(moves), "(broke = repair bent correct code to a wrong check)")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--model", default="qwen36keep96", choices=sorted(bon.CONFIGS))
    r.add_argument("--out", required=True)
    r.add_argument("--rounds", type=int, default=2)
    r.add_argument("--trials", type=int, default=3)
    r.add_argument("--budget", type=int, default=0)
    z = sub.add_parser("analyze")
    z.add_argument("out")
    a = ap.parse_args()
    run(a) if a.cmd == "run" else analyze(a)


if __name__ == "__main__":
    main()
