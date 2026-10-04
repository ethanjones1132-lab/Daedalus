"""Pruning pilot, part 2: find the cliff, and the fast placements.

Same model, imatrix and build as prune_experiment.py. Slices Qwen3.6-35B-A3B IQ2_M
to 96 and 64 experts per layer (64/256 = 25% kept, the same ratio Flash-Next
512 -> 128 would need), and re-probes the slices with far fewer CPU-held layers,
since the 128 slice used only 5.1 GB of VRAM at ncmoe 16.
Results append to logs/prune-results.jsonl.
"""
import json
import pathlib
import shutil
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import model_pipeline as mp  # noqa: E402
from prune_experiment import OUT, SRC, WORK  # noqa: E402

PLAN = [
    # (name, keep, ncmoe candidates)
    ("qwen36-iq2m-keep128-fast", 128, [4, 8, 12]),
    ("qwen36-iq2m-keep96", 96, [0, 4, 8]),
    ("qwen36-iq2m-keep64", 64, [0, 4]),
]


def main():
    server = mp.server_for("master")
    imx = WORK / "imatrix-qwen36-code.gguf"
    for name, keep, cands in PLAN:
        dst = WORK / f"Qwen3.6-35B-A3B-UD-IQ2_M-keep{keep}.gguf"
        try:
            if not dst.exists():
                need = SRC.stat().st_size / 1e9 * keep / 256 + 1
                old = sorted((d for d in mp.MODELS_DIR.iterdir() if d.is_dir() and d != WORK
                              and d.name != "k2h-iq3xxs"), key=lambda d: d.stat().st_mtime)
                while mp.free_gb() < need + mp.SPACE_MARGIN_GB and old:
                    d = old.pop(0)
                    shutil.rmtree(d, ignore_errors=True)
                    mp.log(f"prune2: evicted {d.name} for space (C: free {mp.free_gb():.1f} GB)")
                p = subprocess.run([mp.PY, str(pathlib.Path(__file__).parent / "slice_experts.py"), str(SRC),
                                    str(dst), "--keep", str(keep), "--imatrix", str(imx),
                                    "--report", str(WORK / f"keep{keep}.json")], capture_output=True, text=True)
                if p.returncode != 0:
                    raise RuntimeError(f"slice {keep} failed: {p.stderr[-600:]}")
                mp.log(f"prune2: sliced to {keep}: {p.stdout.strip()} ({dst.stat().st_size / 1e9:.2f} GB)")
            m = dict(name=name, ncmoe=cands, mtp=2)
            best = mp.probe_placement(m, dst, server, None)
            if name.endswith("-fast"):  # speed-only re-probe of a slice already scored
                summary = {"note": "speed re-probe only; quality measured in the keep128 run"}
            else:
                summary, _ = mp.run_tier2b(m, dst, server, None, best)
            with OUT.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"name": name, "keep": keep, "file_gb": round(dst.stat().st_size / 1e9, 2),
                                    "ncmoe": best["ncmoe"], "gen_tps_mean": best["gen_tps_mean"],
                                    "vram_mib": best["vram_delta_mib_peak"],
                                    "shared_spill_mib": best.get("shared_spill_mib"), "tier2b": summary}) + "\n")
        except Exception as e:
            mp.log(f"prune2: {name} FAILED: {type(e).__name__}: {e}")
    mp.log("prune2 done")


if __name__ == "__main__":
    main()
