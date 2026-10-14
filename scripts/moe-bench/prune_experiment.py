"""Track A pilot: how much does usage-based expert pruning cost on our tasks?

Model: Qwen3.6-35B-A3B UD-IQ2_M (already on C:). Steps:
  1. llama-imatrix on Python stdlib source (NOT tier2b text, to avoid test leakage),
     recording per-expert activation energy;
  2. slice 256 -> 192 and 256 -> 128 experts per layer (slice_experts.py);
  3. placement probe + full tier2b (thinking off) for the unpruned baseline and
     each slice, all on the same llama.cpp build, so the deltas are comparable.
Results append to logs/prune-results.jsonl.
"""
import json
import pathlib
import shutil
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import model_pipeline as mp  # noqa: E402

SRC = pathlib.Path(r"C:\qwen3-forge-stage\Qwen3.6-35B-A3B-UD-IQ2_M.gguf")
CALIB = pathlib.Path(r"C:\qwen3-forge-stage\calib\code-calib.txt")
WORK = pathlib.Path(r"C:\qwen3-forge-stage\models\prune-qwen36")
OUT = mp.LOGS / "prune-results.jsonl"


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    server = mp.server_for("master")
    imatrix_exe = str(pathlib.Path(server).with_name("llama-imatrix.exe"))
    imx = WORK / "imatrix-qwen36-code.gguf"
    if not imx.exists():
        mp.log("prune: imatrix on stdlib code")
        t = time.time()
        p = subprocess.run([imatrix_exe, "-m", str(SRC), "-f", str(CALIB), "-o", str(imx),
                            "--chunks", "120", "-c", "512", "-b", "512", "-ngl", "99", "--n-cpu-moe", "24"],
                           capture_output=True, text=True)
        if not imx.exists():
            raise RuntimeError("imatrix failed: " + (p.stderr or p.stdout)[-600:])
        mp.log(f"prune: imatrix done in {(time.time() - t) / 60:.0f} min")
    variants = [("qwen36-iq2m-full", SRC, None)]
    for keep in (192, 128):
        dst = WORK / f"Qwen3.6-35B-A3B-UD-IQ2_M-keep{keep}.gguf"
        if not dst.exists():
            need = SRC.stat().st_size / 1e9 * keep / 256 + 1
            old = sorted((d for d in mp.MODELS_DIR.iterdir() if d.is_dir() and d != WORK),
                         key=lambda d: d.stat().st_mtime)
            while mp.free_gb() < need + mp.SPACE_MARGIN_GB and old:  # benchmarked models only
                d = old.pop(0)
                shutil.rmtree(d, ignore_errors=True)
                mp.log(f"prune: evicted {d.name} for space (C: free {mp.free_gb():.1f} GB)")
            p = subprocess.run([mp.PY, str(pathlib.Path(__file__).parent / "slice_experts.py"), str(SRC), str(dst),
                                "--keep", str(keep), "--imatrix", str(imx),
                                "--report", str(WORK / f"keep{keep}.json")], capture_output=True, text=True)
            if p.returncode != 0:
                raise RuntimeError(f"slice {keep} failed: {p.stderr[-600:]}")
            mp.log(f"prune: sliced to {keep}: {p.stdout.strip()} ({dst.stat().st_size / 1e9:.2f} GB)")
        variants.append((f"qwen36-iq2m-keep{keep}", dst, keep))
    for name, path, keep in variants:
        m = dict(name=name, ncmoe=[16, 20, 24] if keep else [20, 22, 24], mtp=2)
        try:
            best = mp.probe_placement(m, path, server, None)
            summary, out = mp.run_tier2b(m, path, server, None, best)
            with OUT.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"name": name, "keep": keep, "file_gb": round(path.stat().st_size / 1e9, 2),
                                    "ncmoe": best["ncmoe"], "gen_tps_mean": best["gen_tps_mean"],
                                    "vram_mib": best["vram_delta_mib_peak"], "tier2b": summary}) + "\n")
        except Exception as e:
            mp.log(f"prune: {name} FAILED: {type(e).__name__}: {e}")
    mp.log("prune experiment done")


if __name__ == "__main__":
    main()
