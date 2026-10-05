"""Best-of-N on tier2b with a verifier that never sees the grading test (2026-10-04).

The question is how much a fast local model gains from sampling several fixes and choosing one,
when the choice uses only signals that exist for any feature or build:
  compiles   py_compile on the edited file
  imports    the edited module imports in the seeded workspace
  self-tests test functions the model wrote itself, from the same visible information as the fix
             (the requirement and the visible file), run against every candidate
The grading test is deleted from every checking workspace. It is used afterwards, only to score the
chosen candidate, and per candidate for the diagnostics.

For each task and trial: N candidate fixes (the tier2b prompt; candidate 0 uses the tier2b seed, so
it is the plain single-shot answer) and S self-test suites. Everything is stored, and `analyze`
computes the selection policies from the rows, so a new policy needs no new generations:
  first     candidate 0 (single shot)
  compile   first candidate that compiles and imports
  selftest  most self-tests passed; ties go to the largest group with the same pass pattern
  codet     CodeT dual agreement: group size x self-tests passed by the group
  oracle    any candidate passes grading (pass@N, the ceiling no verifier can beat)
plus the verifier's own error modes: self-tests that grading-correct candidates fail, false
accepts (the pick passes every self-test yet fails grading), misses, and no-signal task-trials.

usage: bestofn_tier2b.py run --out OUT.jsonl [--n 8] [--suites 2] [--trials 3] [--tasks 0]
       bestofn_tier2b.py analyze OUT.jsonl
"""
import argparse
import ast
import collections
import json
import os
import pathlib
import py_compile
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BENCH = pathlib.Path(os.environ.get("TIER2B_DIR", r"C:\Projects\home-base-recovered\scripts\benchmark-tier2b"))
sys.path.insert(0, str(BENCH))
from runbench2b import baseline_prompt, extract_code, run_test, seed  # noqa: E402
from tasks import TASKS  # noqa: E402

SERVER = r"C:\qwen3-forge-stage\tools\llama-master-836d57176\llama-server.exe"
MODEL = r"C:\qwen3-forge-stage\models\prune-qwen36\Qwen3.6-35B-A3B-UD-IQ2_M-keep96.gguf"
PORT = 8093
BASE = f"http://127.0.0.1:{PORT}"
SAMPLING = {"temperature": 0.2, "top_p": 0.95}  # keep96's best single-shot setting (101/117)
RUNNER = """import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("_selftest", sys.argv[1])
try:
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
except BaseException as e:
    print(json.dumps({"__load_error__": repr(e)[:200]}))
    sys.exit(0)
res = {}
for name in sorted(n for n in dir(m) if n.startswith("test")):
    f = getattr(m, name)
    if callable(f):
        try:
            f()
            res[name] = True
        except BaseException:
            res[name] = False
print(json.dumps(res))
"""


def post(path, payload, timeout=600):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def chat(prompt, seed_):
    r = post("/v1/chat/completions", {"messages": [{"role": "user", "content": prompt}], "max_tokens": 2048,
                                      **SAMPLING, "seed": seed_, "cache_prompt": True,
                                      "chat_template_kwargs": {"enable_thinking": False}})
    return r["choices"][0]["message"].get("content") or "", r.get("timings", {}).get("predicted_n")


def module_of(entry):
    return entry[:-3].replace("/", ".")


def test_prompt(task):
    entry, visible = task["entry"], task["files"][task["entry"]]
    extra = (f" The package also has {task['hidden_file']}; its source is unavailable, but tests may import it."
             if task["category"] == "B" else "")
    return (f"Write acceptance tests for a fix to {entry}.{extra}\n\n"
            f"Current {entry} (it has the bug):\n```python\n{visible}```\n\n"
            f"Requirement: {task['spec']}\n\n"
            f"Write 4 to 8 small test functions named test_*, using plain assert and only the standard "
            f"library. Import what you test from `{module_of(entry)}`; do not re-implement it. Check the "
            f"required behaviour, including any edge cases the requirement names. Return one ```python block.")


def test_names(code):
    try:
        return sorted(n.name for n in ast.parse(code).body
                      if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith("test"))
    except SyntaxError:
        return []


def workspace(task, code):
    """A seeded copy of the task with the grading test removed and the candidate in place."""
    d = pathlib.Path(tempfile.mkdtemp(prefix="bon-"))
    seed(d, task)
    (d / "_t.py").unlink(missing_ok=True)
    (d / task["entry"]).write_text(code, encoding="utf-8")
    return d


def check(task, code, suites):
    d = workspace(task, code)
    out = {"compiles": False, "imports": False, "self": {}}
    try:
        try:
            py_compile.compile(str(d / task["entry"]), doraise=True)
            out["compiles"] = True
        except py_compile.PyCompileError:
            pass
        if out["compiles"]:
            try:
                r = subprocess.run([sys.executable, "-c", f"import {module_of(task['entry'])}"], cwd=d,
                                   capture_output=True, text=True, timeout=10)
                out["imports"] = r.returncode == 0
            except subprocess.TimeoutExpired:
                pass
        (d / "_runner.py").write_text(RUNNER, encoding="utf-8")
        for s, (scode, names) in enumerate(suites):
            res = {n: False for n in names}
            if out["imports"] and names:
                (d / f"_selftest{s}.py").write_text(scode, encoding="utf-8")
                try:
                    r = subprocess.run([sys.executable, "_runner.py", f"_selftest{s}.py"], cwd=d,
                                       capture_output=True, text=True, timeout=10)
                    got = json.loads((r.stdout.strip().splitlines() or ["{}"])[-1])
                    res.update({n: bool(v) for n, v in got.items() if n in res})
                except (subprocess.TimeoutExpired, json.JSONDecodeError):
                    pass
            out["self"][f"s{s}"] = res
    finally:
        shutil.rmtree(d, ignore_errors=True)
    g = pathlib.Path(tempfile.mkdtemp(prefix="bon-grade-"))
    try:
        seed(g, task)
        (g / task["entry"]).write_text(code, encoding="utf-8")
        out["graded_ok"], out["graded_detail"] = run_test(g, task["test"])
    finally:
        shutil.rmtree(g, ignore_errors=True)
    return out


def start_server(log):
    args = [SERVER, "-m", MODEL, "--host", "127.0.0.1", "--port", str(PORT), "-ngl", "99", "--n-cpu-moe", "0",
            "-c", "16384", "-ctk", "q8_0", "-ctv", "q8_0", "--flash-attn", "on", "-b", "512", "-ub", "512",
            "-np", "1", "--jinja", "--reasoning-budget", "0", "--no-webui", "--cache-ram", "0",
            "--spec-type", "draft-mtp,ngram-mod", "--spec-draft-n-max", "2"]
    proc = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT)
    t0 = time.time()
    while time.time() - t0 < 600:
        if proc.poll() is not None:
            sys.exit(f"server exited {proc.returncode}")
        try:
            with urllib.request.urlopen(BASE + "/health", timeout=2) as r:
                if r.status == 200:
                    return proc
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(1)
    sys.exit("server load timeout")


def run(a):
    out = pathlib.Path(a.out)
    done = collections.Counter()
    if out.exists():
        for line in out.read_text(encoding="utf-8").splitlines():
            r = json.loads(line)
            if r.get("type") == "cand":
                done[(r["task"], r["trial"])] += 1
    tasks = TASKS[: a.tasks] if a.tasks else TASKS
    log = open(out.with_suffix(".server.log"), "a", encoding="utf-8", errors="replace")
    proc = start_server(log)
    t_start = time.time()
    try:
        with out.open("a", encoding="utf-8") as f, ThreadPoolExecutor(a.n) as ex:
            for task in tasks:
                for trial in range(a.trials):
                    if done[(task["name"], trial)] >= a.n:
                        continue
                    t = time.time()
                    suites = []
                    for s in range(a.suites):
                        text, n_tok = chat(test_prompt(task), 20000 + 100 * trial + s)
                        code = extract_code(text)
                        names = test_names(code)
                        suites.append((code, names))
                        f.write(json.dumps({"type": "suite", "task": task["name"], "category": task["category"],
                                            "trial": trial, "suite": s, "gen_n": n_tok, "tests": names,
                                            "code": code[:6000]}) + "\n")
                    cands = []
                    for c in range(a.n):
                        sd = trial if c == 0 else 1000 + 100 * trial + c  # candidate 0 = the tier2b sample
                        text, n_tok = chat(baseline_prompt(task), sd)
                        cands.append((c, sd, n_tok, text))
                    checks = list(ex.map(lambda x: check(task, extract_code(x[3]), suites), cands))
                    for (c, sd, n_tok, text), chk in zip(cands, checks):
                        f.write(json.dumps({"type": "cand", "task": task["name"], "category": task["category"],
                                            "trial": trial, "cand": c, "seed": sd, "gen_n": n_tok, **chk,
                                            "content": text[:6000]}) + "\n")
                    f.flush()
                    ok = sum(chk["graded_ok"] for chk in checks)
                    print(f"{task['name']} t{trial}: {ok}/{a.n} candidates pass grading; "
                          f"tests {[len(n) for _, n in suites]}; {time.time() - t:.0f} s", flush=True)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
    print(f"done in {(time.time() - t_start) / 60:.1f} min", flush=True)
    analyze(argparse.Namespace(out=a.out))


def pick(cands, policy):
    """cands: list of cand rows for one task-trial, ordered by cand index."""
    if policy == "first":
        return cands[0]
    ok = [c for c in cands if c["compiles"] and c["imports"]]
    if policy == "compile":
        return ok[0] if ok else cands[0]
    if not ok:
        return cands[0]
    keys = sorted({(s, n) for c in ok for s, res in c["self"].items() for n in res})

    def vec(c):
        return tuple(c["self"].get(s, {}).get(n, False) for s, n in keys)

    groups = collections.Counter(vec(c) for c in ok)
    if policy == "selftest":
        return max(ok, key=lambda c: (sum(vec(c)), groups[vec(c)], -c["cand"]))
    if policy == "codet":
        return max(ok, key=lambda c: (groups[vec(c)] * sum(vec(c)), groups[vec(c)], -c["cand"]))
    raise ValueError(policy)


def analyze(a):
    rows = [json.loads(l) for l in open(a.out, encoding="utf-8") if l.strip()]
    by = collections.defaultdict(list)
    for r in rows:
        if r["type"] == "cand":
            by[(r["task"], r["category"], r["trial"])].append(r)
    for v in by.values():
        v.sort(key=lambda r: r["cand"])
    n = min(len(v) for v in by.values())
    policies = ["first", "compile", "selftest", "codet"]
    score = collections.defaultdict(lambda: collections.Counter())
    diag = collections.Counter()
    wrong_tests = [0, 0]
    for (task, cat, trial), cands in by.items():
        cands = cands[:n]
        oracle = any(c["graded_ok"] for c in cands)
        for p in policies:
            ch = pick(cands, p)
            score[p][cat] += ch["graded_ok"]
            if p == "codet":
                allself = [v for res in ch["self"].values() for v in res.values()]
                if not ch["graded_ok"]:
                    if oracle:
                        diag["miss (a correct candidate existed)"] += 1
                    else:
                        diag["no correct candidate"] += 1
                    if allself and all(allself):
                        diag["false accept (passes every self-test, fails grading)"] += 1
                ok = [c for c in cands if c["compiles"] and c["imports"]]
                vecs = {json.dumps(c["self"], sort_keys=True) for c in ok}
                if len(vecs) <= 1:
                    diag["no signal (self-tests cannot tell candidates apart)"] += 1
        score["oracle"][cat] += oracle
        score["mean of candidates"][cat] += sum(c["graded_ok"] for c in cands) / len(cands)
        for c in cands:  # self-tests a grading-correct candidate fails are wrong (or over-specified)
            if c["graded_ok"]:
                for res in c["self"].values():
                    wrong_tests[0] += sum(not v for v in res.values())
                    wrong_tests[1] += len(res)
    cats = sorted({k[1] for k in by})
    total = len(by)
    print(f"\n{total} task-trials, N = {n} candidates each")
    print(f"{'policy':22s} {'score':>8s}  " + "  ".join(f"{c:>6s}" for c in cats))
    for p in ["first", "mean of candidates", "compile", "selftest", "codet", "oracle"]:
        s = score[p]
        tot = sum(s.values())
        print(f"{p:22s} {tot:6.1f}/{total}  " + "  ".join(f"{s[c]:6.1f}" for c in cats))
    print("verifier diagnostics (codet):")
    for k, v in diag.most_common():
        print(f"  {k}: {v}")
    if wrong_tests[1]:
        print(f"  self-tests failed by grading-correct candidates: {wrong_tests[0]}/{wrong_tests[1]} "
              f"({wrong_tests[0] / wrong_tests[1]:.1%}) -> wrong or over-specified tests")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--out", required=True)
    r.add_argument("--n", type=int, default=8)
    r.add_argument("--suites", type=int, default=2)
    r.add_argument("--trials", type=int, default=3)
    r.add_argument("--tasks", type=int, default=0, help="first N tasks only (smoke test)")
    z = sub.add_parser("analyze")
    z.add_argument("out")
    a = ap.parse_args()
    run(a) if a.cmd == "run" else analyze(a)


if __name__ == "__main__":
    main()
