"""Re-create the gpt-oss-20b keep24 (selfgen-calibrated) slice for the speed lab and sampling
sweep, then give C: its quiet spell before anything reads it back (see prune_gptoss.SETTLE_S)."""
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import model_pipeline as mp  # noqa: E402
from prune_gptoss import IMATRIX, MODEL_FILE, SETTLE_S, WORK, slice_to  # noqa: E402

dst = WORK / "gpt-oss-20b-MXFP4-keep24-selfgen.gguf"
fresh = not dst.exists()
slice_to(WORK / MODEL_FILE, [IMATRIX["selfgen"]], 24, "keep24-selfgen")
if fresh:
    mp.log(f"make_keep24: letting C: settle {SETTLE_S} s after writing {dst.name}")
    time.sleep(SETTLE_S)
mp.log("make_keep24: slice ready")
