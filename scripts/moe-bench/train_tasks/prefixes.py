"""Code prefixes for the KL-only regularizer (adapters spec section 4.2; plan Task 4): openings at top-level
definitions of standard-library modules, which the teacher continues. The held-out closeness modules
(kl_eval.HELDOUT_MODULES) are never used, so the KL measurement stays clean.

usage: prefixes.py --out prefixes.json [--n 300] [--chars 600]
"""
import argparse
import ast
import importlib.util
import json
import pathlib
import random
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from kl_eval import HELDOUT_MODULES  # noqa: E402


def sources():
    for name in sorted(sys.stdlib_module_names):
        if name in HELDOUT_MODULES or name.startswith("_") or name in ("this", "antigravity", "idlelib", "test"):
            continue
        try:
            spec = importlib.util.find_spec(name)
        except (ImportError, ValueError):
            continue
        if spec and spec.origin and spec.origin.endswith(".py"):
            yield name, pathlib.Path(spec.origin)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--chars", type=int, default=600)
    a = ap.parse_args()
    rng = random.Random(0)
    cands = []
    for name, path in sources():
        text = path.read_text(encoding="utf-8", errors="replace")
        try:
            tree = ast.parse(text)
        except SyntaxError:
            continue
        lines = text.splitlines(keepends=True)
        starts = [n.lineno for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.lineno > 5]
        for ln in rng.sample(starts, min(3, len(starts))):
            prefix = "".join(lines[ln - 1:])[:a.chars]
            if len(prefix) == a.chars:
                cands.append([f"{name}:{ln}", prefix])
    rng.shuffle(cands)
    pathlib.Path(a.out).write_text(json.dumps(cands[:a.n]), encoding="utf-8")
    print(f"{min(a.n, len(cands))} prefixes from {len({c[0].split(':')[0] for c in cands[:a.n]})} modules")


if __name__ == "__main__":
    main()
