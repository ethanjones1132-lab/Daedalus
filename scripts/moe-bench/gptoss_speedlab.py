"""gpt-oss-20b speed lab: runtime levers other than pruning (2026-10-04).

Each config is one moe_sweep.run_config probe (warm-up pass, then timed short-generation,
2k-token edit and 10k-context prompts) on the FULL gpt-oss-20b MXFP4 model, so every
lever is measured against the same baseline under the same conditions. Placements leave
room for the Versutus voice server (~1.1 GB VRAM since the 11:13 reboot): 17 CPU expert
layers with the 0.92 GB EAGLE3 draft, 15 without.

Levers: CPU threads (i5-14400F: 6 P-cores + 4 E-cores; one DDR5 stick, so the CPU experts
are memory-bound), KV cache precision, speculation type and depth (EAGLE3, n-gram lookup,
both), experts per token (3 instead of 4: not lossless, quality checked separately),
and prompt-processing batch size. Rows append to logs/speedlab-gptoss-<day>.jsonl.
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import model_pipeline as mp  # noqa: E402
import moe_sweep  # noqa: E402

WORK = mp.MODELS_DIR / "prune-gptoss20b"
MODEL = WORK / "gpt-oss-20b-MXFP4.gguf"
DRAFT = WORK / "eagle3-gpt-oss-20b-Q8_0.gguf"
OUT = mp.LOGS / f"speedlab-gptoss-{mp.DAY}.jsonl"

E3 = "draft-eagle3"
# (label, ncmoe, spec type or None, draft depth, extra args, ubatch)
CONFIGS = [
    ("base-eagle3",         17, E3, 3, [], 512),
    ("threads6",            17, E3, 3, ["-t", "6"], 512),
    ("threads6-prio2",      17, E3, 3, ["-t", "6", "--prio", "2"], 512),
    ("threads10",           17, E3, 3, ["-t", "10"], 512),
    ("kv-f16",              17, E3, 3, ["-ctk", "f16", "-ctv", "f16"], 512),
    ("eagle3-depth2",       17, E3, 2, [], 512),
    ("eagle3-depth5",       17, E3, 5, [], 512),
    ("eagle3+ngram",        17, E3 + ",ngram-mod", 3, [], 512),
    ("ngram-only",          15, "ngram-mod", 3, [], 512),
    ("no-spec",             15, None, 0, [], 512),
    ("experts3",            17, E3, 3, ["--override-kv", "gpt-oss.expert_used_count=int:3"], 512),
    ("ub1024",              17, E3, 3, [], 1024),
]


def main():
    moe_sweep.SERVER = mp.server_for("master")
    logdir = mp.LOGS / f"speedlab-gptoss-{mp.DAY}-logs"
    logdir.mkdir(parents=True, exist_ok=True)
    prompts = moe_sweep.build_prompts()
    done = set()
    if OUT.exists():
        done = {json.loads(l)["label"] for l in OUT.read_text(encoding="utf-8").splitlines() if l.strip()}
    mp.log(f"=== gpt-oss speed lab: {len(CONFIGS) - len(done)} configs on the full model")
    for label, ncmoe, spec, depth, extra, ub in CONFIGS:
        if label in done:
            continue
        uses_draft = bool(spec) and "eagle3" in spec
        moe_sweep.SPEC_TYPE = spec or "none"
        moe_sweep.DRAFT_MODEL = str(DRAFT) if uses_draft else ""
        moe_sweep.EXTRA_ARGS = list(extra)
        row = moe_sweep.run_config(str(MODEL), ncmoe, depth if spec else 0, 16384, ub, None, logdir, prompts)
        row["label"], row["spec"], row["extra"] = label, spec, extra
        with OUT.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        per = {r["prompt"]: r["gen_tps"] for r in row.get("runs", [])}
        pp = {r["prompt"]: r["prompt_tps"] for r in row.get("runs", [])}
        mp.log(f"  speedlab {label:15s} gen {per.get('gen')} | edit2k {per.get('edit2k')} | long10k "
               f"{per.get('long10k')} tok/s (mean {row.get('gen_tps_mean')}); prefill 10k {pp.get('long10k')} tok/s; "
               f"accept {row.get('draft_accept_rate')}; VRAM {row.get('vram_delta_mib_peak')} MiB; "
               f"spill {row.get('shared_spill_mib')}; paging_risk {row.get('paging_risk')}; error {row.get('error')}")
    mp.log("speed lab done")


if __name__ == "__main__":
    main()
