"""Speed lab: runtime levers for gpt-oss-20b, Gemma 4 26B-A4B and Qwen3.6-35B-A3B keep96
(2026-10-04; the user's plan after the pruning rounds).

For each model: (1) find the base placement (fastest CPU-expert layer count that fits the
7,168 MiB cap without paging), (2) probe one lever at a time against that base, (3) probe
the combination of every lossless lever that helped. Each probe is a moe_sweep.run_config
(warm-up pass, then timed short-generation, 2k-token edit and 10k-context prompts).

Levers: CPU threads (i5-14400F: 6 P-cores + 4 E-cores; single-channel DDR5, so CPU-held
experts are memory-bound), process priority, KV cache f16 vs q8_0, speculation depth,
n-gram lookup (alone and stacked on the draft model), no speculation at the placement the
draft's VRAM buys back, experts per token (lossy: reported, never folded into the
combined config), and prompt-processing ubatch. The Versutus gate is paused for the run.

Rows: logs/speedlab-<model>-<day>.jsonl; winners: logs/speedlab-best-<day>.json.
usage: speedlab.py [model ...]
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import model_pipeline as mp  # noqa: E402
import moe_sweep  # noqa: E402

STAGE = mp.STAGE
GPTOSS = mp.MODELS_DIR / "prune-gptoss20b"
BEST = mp.LOGS / f"speedlab-best-{mp.DAY}.json"
GAIN = 1.03  # a lever must beat the base by 3% to be adopted (run-to-run noise is ~1-2%)

MODELS = {
    "gptoss20b": dict(path=GPTOSS / "gpt-oss-20b-MXFP4.gguf", draft=GPTOSS / "eagle3-gpt-oss-20b-Q8_0.gguf",
                      spec="draft-eagle3", depth=3, depths=[2, 4, 5], arch="gpt-oss", used=4, fewer=3,
                      place=[14, 15, 16], place_nospec=[11, 12, 13], cpu_bound=True),
    "gemma26b": dict(path=STAGE / "google_gemma-4-26B-A4B-it-IQ2_M.gguf", draft=STAGE / "mtp-gemma-4-26B-A4B-it.gguf",
                     spec="draft-mtp", depth=2, depths=[1, 3, 4], arch="gemma4", used=8, fewer=6,
                     place=[14, 16, 18, 20], place_nospec=None, cpu_bound=True),
    "qwen36keep96": dict(path=mp.MODELS_DIR / "prune-qwen36" / "Qwen3.6-35B-A3B-UD-IQ2_M-keep96.gguf", draft=None,
                         spec="draft-mtp", depth=2, depths=[1, 3, 4], arch="qwen35moe", used=8, fewer=6,
                         place=[0], place_nospec=[0], cpu_bound=False),
    # Added at the user's request after keep24 scored 107/117 (full 109) at 40.8 tok/s with
    # 7 CPU layers and no draft; with EAGLE3 it needed 14 CPU layers and ran at 20.9.
    "gptoss20b-keep24": dict(path=GPTOSS / "gpt-oss-20b-MXFP4-keep24-selfgen.gguf",
                             draft=GPTOSS / "eagle3-gpt-oss-20b-Q8_0.gguf", spec="draft-eagle3", depth=3,
                             depths=[2], arch="gpt-oss", used=4, fewer=3,
                             place=[11, 12], place_nospec=[6, 7, 8], cpu_bound=True),
}


def fits(row):
    return (not row.get("error") and (row.get("vram_delta_mib_peak") or 1e9) <= mp.VRAM_CAP_MIB
            and (row.get("gen_tps_mean") or 0) > 0)


def usable(row):
    """Fits, and RAM never ran out (below 0.5 GB available Windows evicts mmap'd expert
    pages, so the timing measures the SSD)."""
    return fits(row) and not row.get("paging_risk")


CLEAN_SLACK = 0.90  # a clean row within 10% of the fastest is preferred over it


def pick(rows):
    """Fastest row that fits; a clean (never hit the RAM floor) row wins instead if it is
    within 10% of that. A RAM squeeze can only slow a probe down, so a flagged row that is
    much faster is real; but at similar speed the clean config is the safer one to run
    (less paging onto C:). The first rule, clean-only, would have ranked Gemma's MTP+ngram
    config (101.7 tok/s, flagged) below a 43.7 tok/s clean row (15:55)."""
    pool = [r for r in rows if r and fits(r)]
    if not pool:
        return None
    fastest = max(pool, key=lambda r: r["gen_tps_mean"])
    clean = [r for r in pool if usable(r) and r["gen_tps_mean"] >= CLEAN_SLACK * fastest["gen_tps_mean"]]
    return max(clean, key=lambda r: r["gen_tps_mean"]) if clean else fastest


def combo_label(spec, ncmoe, depth, extra):
    return f"combined:{spec}:{ncmoe}:{depth}:{' '.join(extra)}"


def probe(name, m, label, ncmoe, spec, depth, extra, ub, out, logdir, prompts):
    moe_sweep.SPEC_TYPE = spec or "none"
    moe_sweep.DRAFT_MODEL = str(m["draft"]) if (spec and m["draft"] and spec.split(",")[0] == m["spec"]) else ""
    moe_sweep.EXTRA_ARGS = list(extra)
    row = moe_sweep.run_config(str(m["path"]), ncmoe, depth if spec else 0, 16384, ub, None, logdir, prompts)
    row.update(label=label, spec=spec, depth=depth if spec else 0, extra=list(extra), ub=ub, ncmoe=ncmoe)
    with out.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")
    per = {r["prompt"]: r["gen_tps"] for r in row.get("runs", [])}
    pp = {r["prompt"]: r["prompt_tps"] for r in row.get("runs", [])}
    mp.log(f"  speedlab {name} {label:18s} ncmoe {ncmoe:2d}: gen {per.get('gen')} | edit2k {per.get('edit2k')} | "
           f"long10k {per.get('long10k')} (mean {row.get('gen_tps_mean')}); prefill10k {pp.get('long10k')}; "
           f"accept {row.get('draft_accept_rate')}; VRAM {row.get('vram_delta_mib_peak')}; "
           f"paging {row.get('paging_risk')}; error {row.get('error')}")
    return row


def lab(name, m):
    out = mp.LOGS / f"speedlab-{name}-{mp.DAY}.jsonl"
    logdir = mp.LOGS / f"speedlab-{name}-{mp.DAY}-logs"
    logdir.mkdir(parents=True, exist_ok=True)
    prompts = moe_sweep.build_prompts()
    rows = []
    if out.exists():  # restart-safe: reuse rows already measured today
        rows = [json.loads(l) for l in out.read_text(encoding="utf-8").splitlines() if l.strip()]
    for r in rows:  # rows from before combined probes were labelled by their config
        if r["label"] == "combined":
            r["label"] = combo_label(r.get("spec"), r["ncmoe"], r.get("depth", 0), r.get("extra", []))
    have = {r["label"] for r in rows}

    def run(label, ncmoe, spec, depth, extra=(), ub=512):
        if label in have:
            return next(r for r in rows if r["label"] == label)
        r = probe(name, m, label, ncmoe, spec, depth, extra, ub, out, logdir, prompts)
        rows.append(r)
        have.add(label)
        return r

    mp.log(f"=== speed lab: {name}")
    # 1. base placement, with the model's own speculation at its default depth
    base_rows = [run(f"place-{n}", n, m["spec"], m["depth"]) for n in m["place"]]
    base = pick(base_rows)
    if not base:
        mp.log(f"  speedlab {name}: no base placement fits")
        return None
    n0 = base["ncmoe"]
    mp.log(f"  speedlab {name}: base = ncmoe {n0}, {base['gen_tps_mean']} tok/s, paging {base.get('paging_risk')}")

    # 2. one lever at a time
    levers = {}
    if m["cpu_bound"]:
        levers["threads6"] = run("threads6", n0, m["spec"], m["depth"], ["-t", "6"])
        levers["threads6-prio2"] = run("threads6-prio2", n0, m["spec"], m["depth"], ["-t", "6", "--prio", "2"])
        levers["threads10"] = run("threads10", n0, m["spec"], m["depth"], ["-t", "10"])
        # Only the CPU-side tensors live in RAM, instead of mapping the whole file:
        levers["no-mmap"] = run("no-mmap", n0, m["spec"], m["depth"], ["--load-mode", "none"])
    levers["kv-f16"] = run("kv-f16", n0, m["spec"], m["depth"], ["-ctk", "f16", "-ctv", "f16"])
    spec_rows = [base]
    for d in m["depths"]:
        spec_rows.append(run(f"depth{d}", n0, m["spec"], d))
    spec_rows.append(run("plus-ngram", n0, m["spec"] + ",ngram-mod", m["depth"]))
    for n in (m["place_nospec"] or []):
        spec_rows.append(run(f"nospec-{n}", n, None, 0))
        spec_rows.append(run(f"ngram-only-{n}", n, "ngram-mod", 16))
    fewer = run(f"experts{m['fewer']}", n0, m["spec"], m["depth"],
                ["--override-kv", f"{m['arch']}.expert_used_count=int:{m['fewer']}"])
    ub = run("ub1024", n0, m["spec"], m["depth"], [], 1024)

    # 3. combine the lossless levers that helped
    best_spec = pick(spec_rows) or base

    def helped(r):
        return r and fits(r) and r["gen_tps_mean"] > base["gen_tps_mean"] * GAIN

    extra = []
    for key in ("threads6-prio2", "threads6", "threads10"):
        if helped(levers.get(key)):
            extra = list(levers[key]["extra"])
            break
    nm = levers.get("no-mmap")
    if nm and fits(nm) and (helped(nm) or (base.get("paging_risk") and not nm.get("paging_risk"))):
        extra += ["--load-mode", "none"]  # (836d571 renamed --no-mmap) adopted if faster, or if it ends the RAM squeeze at no cost
    if helped(levers["kv-f16"]):
        extra += ["-ctk", "f16", "-ctv", "f16"]
    combo = run(combo_label(best_spec["spec"], best_spec["ncmoe"], best_spec["depth"] if best_spec["spec"] else 0, extra),
                best_spec["ncmoe"], best_spec["spec"], best_spec["depth"], extra)
    winner = pick([combo, best_spec, base] + list(levers.values()))
    summary = {k: winner[k] for k in ("label", "ncmoe", "spec", "depth", "extra", "gen_tps_mean")}
    summary["paging_risk"] = winner.get("paging_risk")
    summary.update(draft=str(m["draft"]) if (winner["spec"] and m["draft"] and winner["spec"].split(",")[0] == m["spec"]) else "",
                   base_label=base["label"], base_tps=base["gen_tps_mean"],
                   lossy_fewer_experts={"used": m["fewer"], "tps": fewer.get("gen_tps_mean"), "ok": usable(fewer)},
                   ub1024_prefill10k=next((x["prompt_tps"] for x in ub.get("runs", []) if x["prompt"] == "long10k"), None))
    mp.log(f"  speedlab {name}: WINNER {summary['label']} -> {summary['gen_tps_mean']} tok/s "
           f"(base {base['gen_tps_mean']}): ncmoe {summary['ncmoe']}, spec {summary['spec']} depth {summary['depth']}, "
           f"extra {summary['extra']}")
    return summary


def main():
    moe_sweep.SERVER = mp.server_for("master")
    names = [a for a in sys.argv[1:] if a in MODELS] or list(MODELS)
    best = json.loads(BEST.read_text()) if BEST.exists() else {}
    for name in names:
        try:
            s = lab(name, MODELS[name])
            if s:
                best[name] = s
                BEST.write_text(json.dumps(best, indent=1))
        except Exception as e:
            mp.log(f"  speedlab {name} FAILED: {type(e).__name__}: {e}")
    mp.log("speed lab done")


if __name__ == "__main__":
    main()
