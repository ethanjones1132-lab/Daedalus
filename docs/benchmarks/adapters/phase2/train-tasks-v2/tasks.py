"""Adapters phase-2 training tasks (plan 2026-10-06-adapters-phase2.md, Task 3): written by the teacher model,
validated (buggy fails, reference passes) and disjoint from tier2b, the pool and the judge set (make.py).
Training only: never scored."""
import json
import pathlib

K = 1
TASKS = json.loads((pathlib.Path(__file__).resolve().parent / "tasks.json").read_text(encoding="utf-8"))
