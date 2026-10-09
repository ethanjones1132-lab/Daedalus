"""Markdown tables from headroom_iq3.py rows (the final row of each window).

Speed at depth is the mean of the deep prompt's answer (300 tokens) and the follow-up turn's (200 tokens): a single
300-token sample varied 22-38 tok/s between two runs of the same 16k window (speculation acceptance depends on the text).

usage: headroom_report.py HEADROOM.jsonl [--md]"""
import json
import pathlib
import statistics
import sys


def finals(path):
    rows = {}
    for line in pathlib.Path(path).read_text(encoding="utf-8").splitlines():
        r = json.loads(line)
        if r.get("final"):
            rows[r["window"]] = r
    return [rows[w] for w in sorted(rows)]


def depth_gen(r):
    fu = r.get("followup") or {}
    v = [fu[k]["gen_tps"] for k in ("first", "next_turn") if isinstance(fu.get(k), dict) and fu[k].get("gen_tps")]
    return round(statistics.mean(v), 1) if v else None


def gen_pair(r):
    """Short prompts run as [gen, edit, gen, edit]: fresh code (the speed that matters) and an edit that re-emits
    code from the prompt (n-gram speculation makes it 2x faster)."""
    v = r.get("short_gen_tps") or []
    if len(v) < 4:
        return "—"
    return f"{statistics.mean(v[0::2]):.0f} / {statistics.mean(v[1::2]):.0f}"


def fmt(x, nd=1):
    return "—" if x is None else (f"{x:.{nd}f}" if isinstance(x, float) else str(x))


def tables(rows):
    out = ["| Window | ncmoe | Load s | VRAM loaded / peak / margin (MiB) | Spill (MiB) | Cold / warm read (tok/s) | "
           "Gen: fresh code / copy-heavy edit (tok/s) | Deep read (tok/s) | Deep gen (tok/s) | Follow-up turn re-read (tokens) | "
           "RAM free before launch / after warm / after deep (MB) |", "|" + "---|" * 11]
    for r in rows:
        fu = r.get("followup") or {}
        out.append("| {w} | {nc} | {ls} | {vl} / {vp} / {vm} | {sp} | {cold} / {warm} | {sg} | {dr} | {dg} | {nt} | "
                   "{r0} / {r1} / {r2} |".format(
                       w=r["window"], nc=r["ncmoe"], ls=fmt(r.get("load_s")), vl=r.get("vram_used_loaded_mib"),
                       vp=r.get("vram_peak_mib"), vm=r.get("vram_margin_mib"), sp=r.get("shared_spill_mib"),
                       cold=fmt((r.get("cold") or {}).get("prompt_tps")), warm=fmt((r.get("warm") or {}).get("prompt_tps")),
                       sg=gen_pair(r),
                       dr=fmt((r.get("deep") or {}).get("prompt_tps")), dg=fmt(depth_gen(r)),
                       nt=(fu.get("next_turn") or {}).get("prompt_n"), r0=r.get("ram_before_launch_mb"),
                       r1=r.get("ram_after_warm_mb"), r2=r.get("ram_after_deep_mb")))
    out += ["", "| Window | Laya variant | RAM free before / after load / +10 s (MB) | Both checkpoints: worker WS / private (MiB) | "
            "Calls ok | p50 / p95 / max (s) | Gen speed while Laya answers (tok/s) | Lowest RAM free during (MB) |",
            "|" + "---|" * 8]
    for r in rows:
        for v, lay in (r.get("laya") or {}).items():
            m = lay.get("worker_mem_both_checkpoints") or {}
            out.append("| {w} | {v} | {a} / {b} / {c} | {ws} / {pv} | {ok}/{n} | {p50} / {p95} / {mx} | {g} | {lo} |".format(
                w=r["window"], v=v, a=lay.get("ram_before_mb"), b=lay.get("ram_after_load_mb"),
                c=lay.get("ram_after_10s_mb"), ws=m.get("ws_mib", "—"), pv=m.get("private_mib", "—"),
                ok=lay.get("ok", "—"), n=lay.get("calls", "—"), p50=fmt(lay.get("p50_s"), 2), p95=fmt(lay.get("p95_s"), 2),
                mx=fmt(lay.get("max_s"), 2), g=fmt(lay.get("gen_tps_during")), lo=lay.get("ram_min_during_mb", lay.get("skipped"))))
    out += ["", "Pass rule (docs/superpowers/specs/2026-10-09-step1-results.md): per window and variant; the reasons are in the rows.", "",
            "| Window | none | int8 (lean) | fp32 (as shipped) |", "|---|---|---|---|"]
    for r in rows:
        v = r.get("verdict") or {}
        cell = lambda k: "—" if k not in v else ("PASS" + (" (fallback guard)" if v[k]["tier"] == "fallback" else "") if v[k]["pass"]
                                                else "fail: " + "; ".join(v[k]["reasons"])[:90])
        out.append(f"| {r['window']} | {cell('none')} | {cell('int8')} | {cell('fp32')} |")
    return "\n".join(out)


if __name__ == "__main__":
    print(tables(finals(sys.argv[1])))
