"""tier2b's harness helpers (scripts/benchmark-tier2b/runbench2b.py), re-exported so TIER2B_DIR can point at
this task set. The loaded module imports `tasks` from sys.path, which the harnesses put this directory first on."""
import importlib.util
import pathlib

_src = pathlib.Path(__file__).resolve().parents[3] / "scripts" / "benchmark-tier2b" / "runbench2b.py"
_spec = importlib.util.spec_from_file_location("_tier2b_runbench2b", _src)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
extract_code, run_test, seed, baseline_prompt = _mod.extract_code, _mod.run_test, _mod.seed, _mod.baseline_prompt
