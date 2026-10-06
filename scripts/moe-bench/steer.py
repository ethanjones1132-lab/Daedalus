"""Output-discipline steering vector (adapters spec §3.4, 2026-10-05).

  discipline(task, code) -> (ok, reason)   the spec's failure definition, on one fix answer: the code fails to
                                           compile, lacks a top-level def/class of the original entry, or drops
                                           one of its import lines (a proxy: a cleanup can also drop one)
  pairs    positive / negative prompt files for llama-cvector-generator (one prompt per line, newlines as \\n):
           the chat-formatted fix prompt plus the first lines of a disciplined or undisciplined answer
  build    llama-cvector-generator --method mean|pca -> cv-<method>.gguf
  rate     discipline-failure rate of a probe_tier2b.py results file

usage: steer.py pairs --rows ROWS.jsonl [ROWS.jsonl ...] --out-dir DIR   (TIER2B_DIR = their task set)
       steer.py build --model GGUF --dir DIR --method mean|pca
       steer.py rate --rows PROBE.jsonl                                  (TIER2B_DIR = its task set)
"""
import argparse
import ast
import json
import os
import pathlib
import subprocess
import sys

TOOLS = pathlib.Path(r"C:\qwen3-forge-stage\tools\llama-master-836d57176")
HEAD_LINES = 6


def _shape(src):
    tree = ast.parse(src)
    names = {n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
    imports = {ast.unparse(n) for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))}
    return names, imports


def discipline(task, code):
    try:
        names, imports = _shape(code)
    except SyntaxError:
        return False, "does not compile"
    want_names, want_imports = _shape(task["files"][task["entry"]])
    if want_names - names:
        return False, f"missing {sorted(want_names - names)}"
    if want_imports - imports:
        return False, f"dropped {sorted(want_imports - imports)}"
    return True, "ok"


def tasks_by_name():
    sys.path.insert(0, os.environ["TIER2B_DIR"])
    from tasks import TASKS
    return {t["name"]: t for t in TASKS}


def esc(s):
    return s.replace("\\", "\\\\").replace("\n", "\\n")


def pairs(a):
    sys.path.insert(0, os.environ["TIER2B_DIR"])
    from runbench2b import extract_code
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    import probe_tier2b as pt
    tasks = tasks_by_name()
    pos, neg = [], []
    for path in a.rows:
        for r in map(json.loads, open(path, encoding="utf-8")):
            task = tasks.get(r.get("task"))
            if not task or not r.get("answer"):
                continue
            head = ("<|im_start|>user\n" + pt.fix_prompt(task, r["probe"], r["probe_output"]) +
                    "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n")
            code = extract_code(r["answer"])
            start = "```python\n" + "\n".join(code.splitlines()[:HEAD_LINES])
            ok, _ = discipline(task, code)
            (pos if ok else neg).append(esc(head + start))
            if ok:  # templated negatives from each positive: a script opening, and a dropped import
                neg.append(esc(head + "Here is a script that checks the behaviour first:\n```python\nimport "
                               + task["entry"][:-3].replace("/", ".") + "\n\nprint("))
                lines = [l for l in code.splitlines() if not l.startswith(("import ", "from "))]
                neg.append(esc(head + "```python\n" + "\n".join(lines[:HEAD_LINES])))
    n = min(len(pos), len(neg))
    out = pathlib.Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "positive.txt").write_text("\n".join(pos[:n]) + "\n", encoding="utf-8")
    (out / "negative.txt").write_text("\n".join(neg[:n]) + "\n", encoding="utf-8")
    print(f"pairs: {n} (positives found {len(pos)}, negatives incl. templated {len(neg)})")


def build(a):
    d = pathlib.Path(a.dir)
    cmd = [str(TOOLS / "llama-cvector-generator.exe"), "-m", a.model, "-ngl", "99", "--positive-file",
           str(d / "positive.txt"), "--negative-file", str(d / "negative.txt"), "--method", a.method,
           "-o", str(d / f"cv-{a.method}.gguf")]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    (d / f"cv-{a.method}.log").write_text(p.stdout + p.stderr, encoding="utf-8")
    print(f"cvector {a.method}: exit {p.returncode}")
    sys.exit(p.returncode)


def rate(a):
    sys.path.insert(0, os.environ["TIER2B_DIR"])
    from runbench2b import extract_code
    tasks = tasks_by_name()
    rows = [json.loads(l) for l in open(a.rows, encoding="utf-8") if l.strip()]
    bad = sum(not discipline(tasks[r["task"]], extract_code(r["answer"]))[0] for r in rows)
    solved = sum(r["ok"] for r in rows)
    print(json.dumps({"rows": len(rows), "discipline_failures": bad, "solved": solved}))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pairs")
    p.add_argument("--rows", nargs="+", required=True)
    p.add_argument("--out-dir", required=True)
    b = sub.add_parser("build")
    b.add_argument("--model", required=True)
    b.add_argument("--dir", required=True)
    b.add_argument("--method", choices=["mean", "pca"], required=True)
    r = sub.add_parser("rate")
    r.add_argument("--rows", required=True)
    a = ap.parse_args()
    {"pairs": pairs, "build": build, "rate": rate}[a.cmd](a)


if __name__ == "__main__":
    main()
