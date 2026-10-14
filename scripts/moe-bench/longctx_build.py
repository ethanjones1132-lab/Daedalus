"""Long-session builder for the long-context check (2026-10-07; spec 2026-10-07-long-context-design.md §3).

A session is a chat in the model's own template. Filler is made of units, each a run of user and assistant turns:
  episode    a calibration-pool task: the tier2b-style fix request with the buggy file's failing test output,
             answered with the reference fix; then "the test passes now" and a one-line acknowledgement
  file read  a chunk of a standard-library module shown "for context", acknowledged in one line
No unit contains a tier2b or old judge set task name, or a tier2b function or class name with an underscore
(block_regex). Token counts come through an injected counter (the server's /tokenize in a run), so this module
needs no model.
"""
import ast
import importlib.util
import pathlib
import random
import re
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from bestofn_tier2b import TASKS, baseline_prompt, seed  # noqa: E402

DOCS = HERE.parents[1] / "docs" / "benchmarks"
MODULES = ("argparse", "configparser", "csv", "difflib", "inspect", "pprint", "shlex", "statistics", "string",
           "tarfile", "calendar", "ipaddress", "email.message", "http.client", "urllib.parse", "logging",
           "dataclasses", "enum", "typing", "ast", "tokenize", "pickle", "gettext", "zipfile", "shutil",
           "subprocess", "tempfile", "datetime", "random", "pathlib", "glob", "queue", "contextlib", "textwrap",
           "fractions", "optparse", "mailbox", "doctest", "traceback", "threading")
CHUNK_CHARS = 6000
MSG_OVERHEAD = 5  # <|im_start|>, the role, a newline, <|im_end|> and a newline around each message
EARLY_ACK = "I'll look at related code first."
EARLY_BACK = "Back to the first task: write the complete fixed file now. Return only the complete corrected file."


def load_tasks(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.TASKS


def block_regex():
    words = {t["name"] for t in TASKS}
    words |= {t["name"] for t in load_tasks(DOCS / "laya-judge" / "tasks.py", "_lc_judge")}
    for t in TASKS:
        for src in t["files"].values():
            try:
                body = ast.parse(src).body
            except SyntaxError:
                continue
            words |= {n.name for n in body
                      if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and "_" in n.name.strip("_")}
    return re.compile(r"\b(" + "|".join(map(re.escape, sorted(words))) + r")\b")


def failure_output(task):
    """The last 12 lines of the task's test run against its buggy files, with local paths removed."""
    d = pathlib.Path(tempfile.mkdtemp(prefix="lc-"))
    try:
        seed(d, task)
        r = subprocess.run([sys.executable, "_t.py"], cwd=d, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return "The test timed out after 15 s."
    finally:
        shutil.rmtree(d, ignore_errors=True)
    if r.returncode == 0:
        return "Exit code 0 (the test does not catch the bug)."
    out = (r.stderr or r.stdout).replace(str(d), ".")
    for prefix in sorted({sys.prefix, sys.base_prefix}, key=len, reverse=True):
        out = out.replace(prefix, "<python>")
    return "\n".join(out.strip().splitlines()[-12:])


def episode(task, failure):
    ask = baseline_prompt(task) + f"\n\nRunning its test now gives:\n```\n{failure}\n```"
    return [("user", ask), ("assistant", f"```python\n{task['reference']}```"),
            ("user", "I ran the test again: exit code 0, no output."), ("assistant", "Good, the fix holds.")]


def file_units():
    units = []
    for mod in MODULES:
        path = pathlib.Path(importlib.util.find_spec(mod).origin)
        lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
        name = mod.replace(".", "/") + ".py"
        i = 0
        while i < len(lines):
            j, size = i, 0
            while j < len(lines) and size < CHUNK_CHARS:
                size += len(lines[j])
                j += 1
            text = "".join(lines[i:j]).rstrip()
            units.append((f"file:{mod}:{i + 1}",
                          [("user", f"For context, here is {name}, lines {i + 1}-{j}:\n```python\n{text}\n```"),
                           ("assistant", f"Read {name}, lines {i + 1}-{j}.")]))
            i = j
    return units


def all_units(failure=failure_output):
    """(uid, messages) for every pool episode and stdlib chunk that block_regex lets through."""
    rx = block_regex()
    pool = load_tasks(DOCS / "laya-calib" / "tasks.py", "_lc_pool")
    units = [(f"ep:{t['name']}", episode(t, failure(t))) for t in pool] + file_units()
    return [(uid, msgs) for uid, msgs in units if not rx.search("\n".join(c for _, c in msgs))]


def unit_tokens(msgs, count):
    return sum(count(c) + MSG_OVERHEAD for _, c in msgs)


def build_filler(uids, counts, target, seed_, tol=0.05):
    """Shuffle the unit ids with the seed; take each unit that keeps the total within target * (1 + tol) until the
    total reaches target * (1 - tol). Returns (picked ids, estimated tokens)."""
    order = sorted(uids)
    random.Random(seed_).shuffle(order)
    picked, total = [], 0
    for uid in order:
        if total + counts[uid] <= target * (1 + tol):
            picked.append(uid)
            total += counts[uid]
            if total >= target * (1 - tol):
                return picked, total
    raise ValueError(f"the units run out at {total} tokens for a target of {target}")


def messages(units, uids):
    return [{"role": role, "content": text} for uid in uids for role, text in units[uid]]


def short(task):
    return [{"role": "user", "content": baseline_prompt(task)}]


def late(task, filler):
    return filler + short(task)


def early(task, filler):
    return (short(task) + [{"role": "assistant", "content": EARLY_ACK}] + filler
            + [{"role": "user", "content": EARLY_BACK}])
