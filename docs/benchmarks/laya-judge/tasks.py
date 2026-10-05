"""Laya partner judge set (2026-10-05): 60 new tier2b-format tasks, 12 per category, used only for scoring
(spec §4). Committed before anything runs on it; nothing is fitted on it."""
import importlib.util
import pathlib

K = 3
_HERE = pathlib.Path(__file__).resolve().parent


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.TASKS


TASKS = [t for c in "abcde" for t in _load(_HERE / f"tasks_{c}.py", f"_judge_{c}")]
