"""Paired speed and VRAM probe for Qwen3.6 slices at the speed-lab winner (2026-10-06, settling swap108).

Each round runs moe_sweep.run_config once per GGUF, alternating the models so drift hits them alike. The config
is final report section 7's Qwen winner: all layers on the GPU, MTP depth 2 stacked with n-gram lookup, ctx
16384, q8_0 KV, ub 512. The prompts are the speed lab's three (gen, edit2k, long10k) plus long15k, a near-full
context prompt: the VRAM peak after it shows the headroom left once the compute pool has grown.
A load is skipped (and recorded) when less than --min-ram-gb is available, so a RAM squeeze never pages a model
load onto C: (the NV2 bugchecked under that load on 2026-10-04).

usage: speed_pair.py --out OUT.jsonl [--reps 2] [--min-ram-gb 1.0] GGUF [GGUF ...]
"""
import argparse
import json
import pathlib
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import moe_sweep  # noqa: E402
from bestofn_tier2b import SERVER  # noqa: E402


def prompts():
    p = moe_sweep.build_prompts()
    import argparse as _argparse
    src = pathlib.Path(_argparse.__file__).read_text(encoding="utf-8")
    p.append(("long15k", "Here is the start of a Python module:\n\n```python\n" + src[:58000] +
              "\n```\n\nList every class defined above with a one-line description of each.", 200))
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--min-ram-gb", type=float, default=1.0)
    ap.add_argument("models", nargs="+")
    a = ap.parse_args()
    out = pathlib.Path(a.out)
    logdir = out.with_suffix("")
    logdir.mkdir(parents=True, exist_ok=True)
    moe_sweep.SERVER = SERVER
    moe_sweep.SPEC_TYPE = "draft-mtp,ngram-mod"
    moe_sweep.DRAFT_MODEL = ""
    moe_sweep.EXTRA_ARGS = []
    ps = prompts()
    for rep in range(a.reps):
        for model in a.models:
            ram = moe_sweep.ram_avail_gb()
            if ram < a.min_ram_gb:
                row = {"model": pathlib.Path(model).name, "rep": rep, "error": f"skipped: {ram} GB available"}
            else:
                row = moe_sweep.run_config(model, 0, 2, 16384, 512, None, logdir, ps)
                row["rep"] = rep
                row["vram_total_mib"] = 8188
            with out.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
            per = {r["prompt"]: (r["gen_tps"], r["prompt_n"]) for r in row.get("runs", [])}
            print(f"{time.strftime('%H:%M:%S')} rep {rep} {row['model']}: {per}; mean {row.get('gen_tps_mean')}; "
                  f"VRAM loaded {row.get('vram_delta_mib_loaded')} peak {row.get('vram_delta_mib_peak')}; "
                  f"spill {row.get('shared_spill_mib')}; RAM {row.get('ram_avail_gb_during')}; "
                  f"error {row.get('error')}", flush=True)


if __name__ == "__main__":
    main()
