"""Laya v3 judge set (spec 2026-10-07-laya-v3-design.md §2): 120 tier2b-format tasks written by DeepSeek
on OpenCode Go, validated, disjoint from tier2b, the pool and the old judge set. Scoring only; sealed by
commit before anything runs on it."""
import json
import pathlib

K = 3
TASKS = json.loads((pathlib.Path(__file__).resolve().parent / "tasks.json").read_text(encoding="utf-8"))
