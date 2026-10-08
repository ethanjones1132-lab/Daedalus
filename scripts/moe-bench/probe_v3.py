"""Laya v3's probe path prompts and the example-assert check (spec 2026-10-07-laya-v3-design.md §3).
probe_tier2b.py is left unchanged so earlier runs stay reproducible; run_probe and grade are reused from it."""
import ast
import pathlib
import shutil
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from bestofn_tier2b import baseline_prompt, module_of, workspace  # noqa: E402
from probe_tier2b import grade, run_probe  # noqa: E402,F401  (re-exported for the runner)


def probe_prompt_v3(task):
    entry = task["entry"]
    hidden = task.get("hidden_file")
    target = (f"Import {module_of(hidden)} (it is importable and runnable, but its source cannot be read) and call "
              f"its functions directly" if hidden else
              f"Import the non-standard-library modules {entry} imports from and call the functions it uses directly")
    return (baseline_prompt(task) + f"\n\nBefore you fix it, write one short Python script that runs in the package "
            f"directory and shows how the code {entry} depends on behaves. {target}, with arguments like the ones "
            f"{entry} passes to them. For every call, print the call, repr(result) and type(result).__name__. "
            f"Do not call {entry}'s own functions. Reply with only that script, in one ```python block.")


def retry_prompt_v3(task, script, output):
    return (probe_prompt_v3(task) + f"\n\nYour previous script failed:\n```python\n{script}\n```\nOutput:\n```\n"
            f"{output}\n```\nImport the modules the way {task['entry']} does and use arguments the helper accepts. "
            f"Reply with only a corrected script, in one ```python block.")


def fix_prompt_v3(task, script, output, note):
    body = (baseline_prompt(task) + f"\n\nYou ran this script in the package directory:\n```python\n{script}\n```\n"
            f"Its output:\n```\n{output}\n```\nUse what the output shows about how the code behaves. Now return the "
            f"complete corrected {task['entry']} itself, not a test or probe script. Keep {task['entry']}'s own import "
            f"lines unless the fix needs a change there.")
    return (note + "\n\n" + body) if note else body


def example_prompt(task):
    # The current file is shown so the checks call its real function names (2026-10-08 smoke run: from the text
    # alone, Qwen guessed names and every check failed with ImportError, even on the reference). Expected values
    # still come only from the text, never from the (buggy) code.
    return (f"Here is a bug report or requirement for {task['entry']}:\n\n{task['spec']}\n\n"
            f"The current {task['entry']} (it has the bug; use it only for the names to call):\n```python\n"
            f"{task['files'][task['entry']]}```\n\n"
            f"Write checks taken only from concrete examples the text states: for each example (an input and the "
            f"output the text says it should give) write one line `assert <call> == <expected>`, importing what you "
            f"call from `{module_of(task['entry'])}`. Do not invent examples the text does not state. If it states "
            f"none, reply with an empty block. Reply with one ```python block.")


def repair_prompt(task, code, imports, failing):
    checks = "".join(f"```python\n{imports}\n{a}\n```\nError: {e}\n" for a, e in failing)
    return (baseline_prompt(task) + f"\n\nYour corrected {task['entry']}:\n```python\n{code}\n```\nThese checks, taken "
            f"from the requirement, fail on it:\n{checks}A check can itself be wrong; fix the file only where the "
            f"requirement supports the check. Return the complete corrected {task['entry']} itself.")


def split_asserts(code):
    """(import lines, [top-level assert statements]) of a checks block; ("", []) if it does not parse."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return "", []
    lines = code.splitlines()
    seg = lambda n: "\n".join(lines[n.lineno - 1:n.end_lineno])  # noqa: E731
    imports = "\n".join(seg(n) for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom)))
    return imports, [seg(n) for n in tree.body if isinstance(n, ast.Assert)]


def run_asserts(task, code, imports, asserts, timeout=10):
    """[(passed, last error line)] per assert, each run alone against `code` in a seeded workspace (no grading
    test)."""
    d = workspace(task, code)
    out = []
    try:
        for i, a in enumerate(asserts):
            p = d / f"_check{i}.py"
            p.write_text(f"{imports}\n{a}\n", encoding="utf-8")
            try:
                r = subprocess.run([sys.executable, p.name], cwd=d, capture_output=True, text=True, timeout=timeout,
                                   encoding="utf-8", errors="replace")
                err = (r.stderr.strip().splitlines() or [""])[-1]
                out.append((r.returncode == 0, err[:200]))
            except subprocess.TimeoutExpired:
                out.append((False, "timeout"))
    finally:
        shutil.rmtree(d, ignore_errors=True)
    return out
