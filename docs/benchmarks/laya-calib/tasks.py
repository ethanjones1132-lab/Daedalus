"""Laya partner calibration pool (2026-10-05): 60 tier2b-format tasks, 12 per category, used only for fitting
(question wording, calibration, cutoffs and thresholds; spec §4). B is validation-b's 12 fresh hidden-package
tasks; A, C, D and E are new. Never used for scoring."""
import importlib.util
import pathlib

K = 3
_HERE = pathlib.Path(__file__).resolve().parent


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.TASKS


TASKS = (_load(_HERE / "tasks_a.py", "_calib_a")
         + _load(_HERE.parent / "2026-10-05" / "validation-b" / "tasks.py", "_calib_b")
         + _load(_HERE / "tasks_c.py", "_calib_c")
         + _load(_HERE / "tasks_d.py", "_calib_d")
         + _load(_HERE / "tasks_e.py", "_calib_e"))
