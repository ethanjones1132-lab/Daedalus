"""Probe-then-fix on tier2b (2026-10-05): before fixing, the model writes one short Python script,
which is run in the task's package, and sees its output.

Why: on Qwen3.6 keep96, every task-trial that best-of-N with self-tests could not fix was a
hidden-package task (B) where no candidate was right. The model never learned how the module
whose source it cannot see behaves. Probing is the general move for real features too: run the
code to learn how a dependency behaves before editing.

Fairness:
- The probe runs in a seeded workspace with the grading test removed.
- The hidden module is present only as compiled bytecode: `rules.pyc` next to where `rules.py` was.
  It is importable and runnable, but its source is not there to read.
- Output is capped at 2,000 characters; the probe gets 10 seconds.
- The same probe step is offered on every task, not only B, because a real agent doesn't know in
  advance which tasks need it.

For each task and trial:
  probe prompt -> script -> run -> fix prompt (task + script + output) -> candidate -> graded
Rows: one per task-trial, with the probe, its output, the answer and the grade.

usage: probe_tier2b.py run --model qwen36keep96|gemma26b --out OUT.jsonl [--trials 3] [--budget 0]
       probe_tier2b.py analyze OUT.jsonl [--baseline TIER2B.jsonl]
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
from bestofn_tier2b import baseline_prompt, extract_code, run_test, seed, TASKS  # noqa: E402

OUT_CAP = 2000


def probe_prompt(task):
    hidden = task.get("hidden_file")
    note = (f" {hidden} is importable and runnable, but its source cannot be read." if hidden else "")
    return (baseline_prompt(task) + "\n\nBefore you fix it, you may run one short Python script in the package "
            f"directory to see how the code behaves (import the modules, call functions, print results).{note} "
            "Reply with only that script, in one ```python block.")


def fix_prompt(task, script, output):
    return (baseline_prompt(task) + f"\n\nYou ran this script in the package directory:\n```python\n{script}\n```\n"
            f"Its output:\n```\n{output}\n```\nNow return only the complete corrected file.")


def run_probe(task, script):
    d = pathlib.Path(tempfile.mkdtemp(prefix="probe-"))
    try:
        seed(d, task)
        (d / "_t.py").unlink(missing_ok=True)
        hidden = task.get("hidden_file")
        if hidden:  # keep the module runnable, remove its source: a sourceless .pyc imports from the same folder
            src = d / hidden
            py_compile.compile(str(src), cfile=str(src.with_suffix(".pyc")), doraise=True)
            src.unlink()
            shutil.rmtree(src.parent / "__pycache__", ignore_errors=True)
        (d / "_probe.py").write_text(script, encoding="utf-8")
        try:
            r = subprocess.run([sys.executable, "_probe.py"], cwd=d, capture_output=True, text=True, timeout=10)
            out = (r.stdout + (("\n" + r.stderr) if r.stderr.strip() else "")).strip()
        except subprocess.TimeoutExpired:
            out = "(timed out after 10 s)"
        return out[:OUT_CAP] + ("\n... (truncated)" if len(out) > OUT_CAP else "")
    finally:
        shutil.rmtree(d, ignore_errors=True)


def grade(task, code):
    g = pathlib.Path(tempfile.mkdtemp(prefix="probe-grade-"))
    try:
        seed(g, task)
        (g / task["entry"]).write_text(code, encoding="utf-8")
        return run_test(g, task["test"])
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
                    text, n1 = bon.chat(probe_prompt(task), 30000 + trial)
                    script = extract_code(text)
                    output = run_probe(task, script)
                    answer, n2 = bon.chat(fix_prompt(task, script, output), trial)
                    ok, detail = grade(task, extract_code(answer))
                    f.write(json.dumps({"task": task["name"], "category": task["category"], "trial": trial,
                                        "probe": script, "probe_output": output, "answer": answer, "ok": ok,
                                        "detail": detail, "gen_probe": n1, "gen_fix": n2,
                                        "secs": round(time.time() - t, 1)}) + "\n")
                    f.flush()
                    print(f"{task['name']} t{trial}: {'PASS' if ok else 'fail'} ({time.time() - t:.0f} s)", flush=True)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
    print(f"done in {(time.time() - t_start) / 60:.1f} min", flush=True)
    analyze(argparse.Namespace(out=a.out, baseline=a.baseline))


def analyze(a):
    rows = [json.loads(l) for l in open(a.out, encoding="utf-8") if l.strip()]
    cat = collections.defaultdict(lambda: [0, 0])
    for r in rows:
        cat[r["category"]][0] += r["ok"]
        cat[r["category"]][1] += 1
    tot = sum(v[0] for v in cat.values())
    print(f"probe-then-fix: {tot}/{len(rows)}  " + "  ".join(f"{c}:{p}/{n}" for c, (p, n) in sorted(cat.items())))
    if a.baseline:
        base = collections.defaultdict(lambda: [0, 0])
        for r in map(json.loads, open(a.baseline, encoding="utf-8")):
            if "task" in r:
                base[r["category"]][0] += r["ok"]
                base[r["category"]][1] += 1
        print(f"single shot:    {sum(v[0] for v in base.values())}/{sum(v[1] for v in base.values())}  "
              + "  ".join(f"{c}:{p}/{n}" for c, (p, n) in sorted(base.items())))
    timeouts = sum("(timed out" in r["probe_output"] for r in rows)
    errs = sum("Traceback" in r["probe_output"] for r in rows)
    print(f"probes: {timeouts} timed out, {errs} raised; mean probe {sum(r['gen_probe'] or 0 for r in rows) / len(rows):.0f} "
          f"tokens, fix {sum(r['gen_fix'] or 0 for r in rows) / len(rows):.0f} tokens")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--model", default="qwen36keep96", choices=sorted(bon.CONFIGS))
    r.add_argument("--out", required=True)
    r.add_argument("--trials", type=int, default=3)
    r.add_argument("--budget", type=int, default=0)
    r.add_argument("--baseline", default="")
    z = sub.add_parser("analyze")
    z.add_argument("out")
    z.add_argument("--baseline", default="")
    a = ap.parse_args()
    run(a) if a.cmd == "run" else analyze(a)


if __name__ == "__main__":
    main()
