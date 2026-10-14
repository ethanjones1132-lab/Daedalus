"""Prove each validation task is well-formed: the test fails on the buggy entry file and passes on the
reference fix, using tier2b's own seed/run_test helpers."""
import pathlib
import shutil
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from runbench2b import run_test, seed  # noqa: E402
from tasks import TASKS  # noqa: E402

bad = 0
for t in TASKS:
    res = {}
    for label, code in (("buggy", t["files"][t["entry"]]), ("reference", t["reference"])):
        d = pathlib.Path(tempfile.mkdtemp(prefix="valb-"))
        try:
            seed(d, t)
            (d / t["entry"]).write_text(code, encoding="utf-8")
            res[label] = run_test(d, t["test"])
        finally:
            shutil.rmtree(d, ignore_errors=True)
    ok = (not res["buggy"][0]) and res["reference"][0]
    bad += not ok
    print(f"{'ok ' if ok else 'BAD'} {t['name']:24s} buggy={res['buggy'][0]} ({res['buggy'][1][:50]}) "
          f"reference={res['reference'][0]} ({res['reference'][1][:50]})")
print(f"{len(TASKS) - bad}/{len(TASKS)} well-formed")
