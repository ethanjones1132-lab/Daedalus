"""Paired speed and VRAM probe for Qwen3.6 slices at the speed-lab winner (2026-10-06, settling swap108).

Each round runs moe_sweep.run_config once per GGUF, alternating the models so drift hits them alike. The config
is final report section 7's Qwen winner: all layers on the GPU, MTP depth 2 stacked with n-gram lookup, ctx
16384, q8_0 KV, ub 512. The prompts are the speed lab's three (gen, edit2k, long10k) plus long15k, a near-full
context prompt: the VRAM peak after it shows the headroom left once the compute pool has grown.
A load is skipped (and recorded) when less than --min-ram-gb is available, so a RAM squeeze never pages a model
load onto C: (the NV2 bugchecked under that load on 2026-10-04).

--grid (2026-10-07, long-context spec §2): one GGUF over the window grid (GRID, a 16k control up to 128k). Each row
runs the short prompts three times, long10k, the deep prompts that fit in 85% of the window and the follow-up probe
on the deepest. Then q4_0 rows for windows from 64k up whose q8_0 row failed, and ub 1024 at the largest passing
window above 64k. Writes OUT.jsonl and OUT.verdict.json. Models load with --load-mode none.

usage: speed_pair.py --out OUT.jsonl [--reps 2] [--min-ram-gb 1.0] GGUF [GGUF ...]
       speed_pair.py --grid --out OUT.jsonl [--min-ram-gb 1.0] GGUF
"""
import argparse
import importlib.util
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


# (window, ub, cache type) in run order, spec §2 rows 1-6
GRID = [(16384, 512, "q8_0"), (32768, 512, "q8_0"), (65536, 512, "q8_0"), (65536, 1024, "q8_0"),
        (98304, 512, "q8_0"), (131072, 512, "q8_0")]
DEEP = (26000, 54000, 80000, 108000)  # deep prompts, estimated tokens
CHARS_PER_TOKEN = 4.5  # 2026-10-06: long10k 40,000 chars -> 8,801 tokens, long15k 58,000 -> 12,789
DEEP_MODULES = ("argparse", "configparser", "difflib", "inspect", "tarfile", "zipfile", "http.client",
                "email.message", "logging", "dataclasses", "typing", "ast", "pickle", "calendar", "ipaddress",
                "fractions", "statistics", "textwrap", "shutil", "subprocess", "tempfile", "datetime", "random",
                "collections", "pathlib", "doctest", "optparse", "imaplib", "mailbox", "pdb", "threading",
                "traceback", "urllib.request", "http.server", "xml.dom.minidom", "html.parser", "unittest.case")


def stdlib_text(chars):
    parts, size = [], 0
    for mod in DEEP_MODULES:
        part = f"# file: {mod.replace('.', '/')}.py\n" + pathlib.Path(
            importlib.util.find_spec(mod).origin).read_text(encoding="utf-8") + "\n"
        parts.append(part)
        size += len(part)
        if size >= chars:
            return "".join(parts)[:chars]
    raise ValueError(f"the stdlib text runs out at {size} chars")


def deep_prompt(tokens):
    return (f"deep{tokens // 1000}k", "Here are several Python modules:\n\n```python\n"
            + stdlib_text(int(tokens * CHARS_PER_TOKEN))
            + "\n```\n\nList every class defined above with a one-line description of each.", 300)


def deep_for(window):
    return [t for t in DEEP if t <= 0.85 * window]


def grid_prompts(window):
    gen, edit, long10k = moe_sweep.build_prompts()
    short = [(f"{n}#{i}", c, m) for i in range(3) for n, c, m in (gen, edit)]
    return short + [long10k] + [deep_prompt(t) for t in deep_for(window)]


def short_tps(row):
    v = [r["gen_tps"] for r in row.get("runs", [])
         if r.get("gen_tps") and r["prompt"].split("#")[0] in ("gen", "edit2k")]
    return sum(v) / len(v) if v else None


def verdict(rows, tol=0.05, spill_tol=100):
    """A row passes if it loaded, every prompt was answered, short-prompt generation is within tol of the 16k
    control's, and overflow into shared memory is at most spill_tol MiB above the control's (spec §2). Returns the
    rows' verdicts, the cache type per passing window (ub 512 rows; q8_0 preferred) and the largest one."""
    control = next((r for r in rows if r["ctx"] == 16384 and r["ubatch"] == 512 and "error" not in r), None)
    if control is None or not short_tps(control):
        raise ValueError("no usable 16k control row")
    c_tps, c_spill = short_tps(control), control.get("shared_spill_mib") or 0
    out, ctk = [], {}
    for r in rows:
        ok = "error" not in r and bool(r.get("runs")) and all("error" not in x for x in r["runs"])
        ratio = short_tps(r) / c_tps if ok and short_tps(r) else None
        spill = (r.get("shared_spill_mib") or 0) - c_spill if ok else None
        passed = ratio is not None and ratio >= 1 - tol and spill <= spill_tol
        out.append({"tag": r["tag"], "ctx": r["ctx"], "ubatch": r["ubatch"], "ctk": r.get("ctk", "q8_0"),
                    "speed_ratio": round(ratio, 3) if ratio else None, "spill_over_control_mib": spill,
                    "vram_peak_mib": r.get("vram_delta_mib_peak"), "pass": passed,
                    "error": r.get("error") or next((x["error"] for x in r.get("runs", []) if "error" in x), None)})
        if passed and r["ubatch"] == 512 and ctk.get(str(r["ctx"])) != "q8_0":
            ctk[str(r["ctx"])] = r.get("ctk", "q8_0")
    return {"rows": out, "ctk": ctk, "largest_pass": max((int(w) for w in ctk), default=None)}


def extra_rows(rows):
    """q4_0 rows for each window from 64k up whose q8_0 ub-512 row failed."""
    return [(r["ctx"], 512, "q4_0") for r in verdict(rows)["rows"]
            if r["ubatch"] == 512 and r["ctk"] == "q8_0" and r["ctx"] >= 65536 and not r["pass"]]


def top_row(rows):
    """ub 1024 (Jarvis's batch) at the largest passing window above 64k; 64k's ub-1024 row is in GRID."""
    v = verdict(rows)
    w = v["largest_pass"]
    return [(w, 1024, v["ctk"][str(w)])] if w and w > 65536 else []


def grid(a, model, out, logdir):
    moe_sweep.EXTRA_ARGS = ["--load-mode", "none"]  # identical answers, ~2.5 GB less RAM (2026-10-07)
    rows = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines() if line.strip()] \
        if out.exists() else []
    rows = [r for r in rows if not str(r.get("error", "")).startswith("skipped")]
    idle = moe_sweep.vram_used_mib()

    def run(w, ub, ctk):
        if any(r["ctx"] == w and r["ubatch"] == ub and r.get("ctk", "q8_0") == ctk for r in rows):
            return
        ram = moe_sweep.ram_avail_gb()
        if ram < a.min_ram_gb:
            row = {"tag": f"ctx{w}_ub{ub}_{ctk}", "ctx": w, "ubatch": ub, "ctk": ctk,
                   "error": f"skipped: {ram} GB available"}
        else:
            ps = grid_prompts(w)
            deep = [c for n, c, _ in ps if n.startswith("deep")]
            row = moe_sweep.run_config(model, 0, 2, w, ub, None, logdir, ps, ctk=ctk, warm={"gen#0", "edit2k#0"},
                                       followup=deep[-1] if deep else None)
            rows.append(row)
        row["vram_total_mib"] = 8188
        with out.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        deep_runs = {r["prompt"]: (r.get("prompt_n"), r.get("prompt_tps"), r.get("gen_tps"))
                     for r in row.get("runs", []) if r["prompt"].startswith("deep")}
        fu = {k: v.get("prompt_n") for k, v in row.get("followup", {}).items() if isinstance(v, dict)}
        print(f"{time.strftime('%H:%M:%S')} ctx {w} ub {ub} {ctk}: short tps {short_tps(row)}; deep (prompt_n, "
              f"prompt tps, gen tps) {deep_runs}; VRAM peak {row.get('vram_delta_mib_peak')} spill "
              f"{row.get('shared_spill_mib')}; RAM {row.get('ram_avail_gb_during')}; follow-up prompt_n {fu}; "
              f"error {row.get('error')}", flush=True)

    for spec in GRID:
        run(*spec)
    for spec in extra_rows(rows):
        run(*spec)
    for spec in top_row(rows):
        run(*spec)
    v = verdict(rows)
    v["idle_vram_mib"] = idle
    out.with_suffix(".verdict.json").write_text(json.dumps(v, indent=1), encoding="utf-8")
    print(json.dumps({k: v[k] for k in ("ctk", "largest_pass", "idle_vram_mib")}), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--min-ram-gb", type=float, default=1.0)
    ap.add_argument("--grid", action="store_true")
    ap.add_argument("models", nargs="+")
    a = ap.parse_args()
    out = pathlib.Path(a.out)
    logdir = out.with_suffix("")
    logdir.mkdir(parents=True, exist_ok=True)
    moe_sweep.SERVER = SERVER
    moe_sweep.SPEC_TYPE = "draft-mtp,ngram-mod"
    moe_sweep.DRAFT_MODEL = ""
    moe_sweep.EXTRA_ARGS = []
    if a.grid:
        if len(a.models) != 1:
            sys.exit("--grid takes one GGUF")
        grid(a, a.models[0], out, logdir)
        return
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
