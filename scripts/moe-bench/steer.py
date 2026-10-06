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
MAX_CHARS = 4000  # these prompts run about 2.3 characters per token (a 5,251-character one was 2,284 tokens): every
                  # prompt fits one 2,048-token micro-batch, so all layers are captured


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


def opening(code):
    return "```python\n" + "\n".join(code.splitlines()[:HEAD_LINES])


def make_pairs(rows):
    """[(task, row, code, ok)] -> (positives, negatives). Each pair shares its prompt, so the difference is the
    answer's opening alone: a disciplined opening against a script opening and against itself without imports
    (both templated from it), and a failed answer's opening against a disciplined opening of the same task taken
    from another row. Over-long prompts and identical sides are skipped."""
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    import probe_tier2b as pt
    good = {}
    for task, r, code, ok in rows:
        if ok:
            good.setdefault(task["name"], code)
    pos, neg = [], []
    for task, r, code, ok in rows:
        head = ("<|im_start|>user\n" + pt.fix_prompt(task, r["probe"], r["probe_output"]) +
                "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n")
        if ok:
            script = ("Here is a script that checks the behaviour first:\n```python\nimport "
                      + task["entry"][:-3].replace("/", ".") + "\n\nprint(")
            bare = opening("\n".join(l for l in code.splitlines() if not l.startswith(("import ", "from "))))
            cands = [(opening(code), script), (opening(code), bare)]
        elif task["name"] in good:
            cands = [(opening(good[task["name"]]), opening(code))]
        else:
            cands = []
        for p, n in cands:
            if p != n and len(head) + max(len(p), len(n)) <= MAX_CHARS:
                pos.append(esc(head + p))
                neg.append(esc(head + n))
    return pos, neg


def pairs(a):
    sys.path.insert(0, os.environ["TIER2B_DIR"])
    from runbench2b import extract_code
    tasks = tasks_by_name()
    rows = []
    for path in a.rows:
        for r in map(json.loads, open(path, encoding="utf-8")):
            task = tasks.get(r.get("task"))
            if task and r.get("answer"):
                code = extract_code(r["answer"])
                rows.append((task, r, code, discipline(task, code)[0]))
    pos, neg = make_pairs(rows)
    out = pathlib.Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "positive.txt").write_text("\n".join(pos) + "\n", encoding="utf-8")
    (out / "negative.txt").write_text("\n".join(neg) + "\n", encoding="utf-8")
    print(f"pairs: {len(pos)} from {len(rows)} rows ({sum(r[3] for r in rows)} disciplined)")


def build(a):
    d = pathlib.Path(a.dir)
    # needs the generator patched to count its captured layers (patches/cvector-generator-nextn.patch); a prompt
    # split across micro-batches is not captured, hence one 2,048-token micro-batch
    cmd = [str(TOOLS / "llama-cvector-generator.exe"), "-m", a.model, "-ngl", "99", "-c", "4096", "-b", "2048",
           "-ub", "2048", "--positive-file",
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
