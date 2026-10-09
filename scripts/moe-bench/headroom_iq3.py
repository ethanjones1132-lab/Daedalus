"""Headroom test for Qwen3.6-35B-A3B UD-IQ3_XXS (Step 1 item 1, 2026-10-09).

For each window the fitted placement is found (--n-cpu-moe raised until the loaded server, and then its peak after the
deep prompt, stay at or under oneshot_bench.VRAM_CAP_MIB), then speed and memory are measured:
  cold   the first prompt after load (~9k tokens, experts paging in)         warm  the same prompt again
  short  generation on the speed lab's short prompts                          deep  a prompt filling ~85% of the window
  follow-up  the deep chat plus one turn, and the same text with a new ending (prompt_n shows what was re-read)
Then the Laya worker is loaded alongside, once per variant (int8 = lean, fp32 = as shipped): RAM available before, after
load and 10 s later, and 20 Laya calls (classify and verify) fired during a generation: latency p50/p95 and timeouts,
and the generation's speed while Laya answers.

Pass rule (stated in the results doc, the owner may adjust). A window passes, for a Laya variant, if:
  - it serves with the fitted placement (loaded, VRAM peak <= cap, no error);
  - generation is >= 25 tok/s on the short prompts and on the deep prompt;
  - the deep prompt and the follow-up complete;
  - with Laya loaded, RAM available after the Laya load is >= 2048 MB (>= 1024 MB is reported as the fallback tier);
  - the 20 Laya calls all answer, p95 < 5 s, no timeouts.
The 'none' variant is the first three lines only.

usage (from the repo root): headroom_iq3.py --out OUT.jsonl [--windows 16384,40960,65536,98304,131072]
                                            [--variants int8,fp32] [--stop-file F] [--load-mode none|mmap] [--tag T]
                                            [--no-followup-above N] [--laya-only] [--ncmoe-from HEADROOM.jsonl]
"""
import argparse
import json
import os
import pathlib
import statistics
import sys
import threading
import time

os.environ.setdefault("TIER2B_DIR", "docs/benchmarks/laya-calib")  # before bestofn_tier2b loads its task set
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "oneshot"))
import moe_sweep  # noqa: E402
import oneshot_bench as ob  # noqa: E402
import speed_pair  # noqa: E402

moe_sweep.BASE = f"http://127.0.0.1:{ob.PORT}"
MODEL = "qwen36full-iq3xxs"
VRAM_TOTAL = 8188
MAX_DEEP = 108000  # the stdlib text in speed_pair runs out near here
MIN_GEN_TPS, MIN_RAM_MB, FALLBACK_RAM_MB, MAX_P95_S, N_LAYA = 25.0, 2048, 1024, 5.0, 20
HARD_RAM_FLOOR_MB = 250  # below this a launch is skipped and recorded; above it Laya is launched even when the
# pass rule will fail, because what happens then (paging, timeouts, server speed) is the measurement (2026-10-09)


def deep_tokens(window):
    return min(int(0.85 * window), MAX_DEEP)


def window_verdict(row):
    """{variant: {pass, tier, reasons}} from one window's row (see the module docstring)."""
    base_ok = []
    if row.get("error") or not row.get("fit_ok"):
        base_ok.append(row.get("error") or "no fitted placement")
    short = row.get("short_gen_tps") or []
    if not short or statistics.mean(short) < MIN_GEN_TPS:
        base_ok.append(f"short generation {statistics.mean(short) if short else None} tok/s < {MIN_GEN_TPS}")
    deep = row.get("deep") or {}
    fu = row.get("followup") or {}
    if "skipped" not in deep:
        if not deep.get("gen_tps") or deep["gen_tps"] < MIN_GEN_TPS:
            base_ok.append(f"deep generation {deep.get('gen_tps')} tok/s < {MIN_GEN_TPS}")
        if "error" in fu or not fu or "error" in deep:
            base_ok.append("deep prompt or follow-up did not complete")
    out = {"none": {"pass": not base_ok, "tier": "base", "reasons": list(base_ok)}}
    for variant, lay in (row.get("laya") or {}).items():
        reasons = list(base_ok)
        tier = "base"
        if lay.get("skipped"):
            reasons.append(lay["skipped"])
        else:
            ram = lay.get("ram_after_load_mb")
            if ram is None or ram < FALLBACK_RAM_MB:
                reasons.append(f"RAM available after the Laya load {ram} MB < {FALLBACK_RAM_MB}")
            elif ram < MIN_RAM_MB:
                tier = "fallback"
            if lay.get("dead") or lay.get("ok") != N_LAYA:
                reasons.append(f"Laya answered {lay.get('ok')} of {N_LAYA} calls (dead={lay.get('dead')})")
            elif lay.get("p95_s") is None or lay["p95_s"] >= MAX_P95_S:
                reasons.append(f"Laya p95 {lay.get('p95_s')} s >= {MAX_P95_S}")
        out[variant] = {"pass": not reasons, "tier": tier if not reasons else "fail", "reasons": reasons}
    return out


def pct(v, q):
    v = sorted(v)
    return v[min(len(v) - 1, int(round(q * (len(v) - 1))))]


def laya_phase(variant, client_cls, msgs, server_prompt, avail_mb):
    """Load the Laya worker for `variant`, fire the calls during a generation; returns the variant's record."""
    os.environ["LAYA_INT8"] = "1" if variant == "int8" else "0"
    ram0 = avail_mb()
    rec = {"variant": variant, "ram_before_mb": ram0}
    if ram0 < HARD_RAM_FLOOR_MB:
        rec["skipped"] = f"only {ram0} MB available; a worker launch could page the server"
        return rec
    t0 = time.time()
    client = client_cls(str(pathlib.Path("docs/benchmarks/laya3/calib.json")))
    rec.update(load_s=round(time.time() - t0, 1), dead=client.dead, ready=client.ready, ram_after_load_mb=avail_mb())
    if client.dead:
        client.close()
        return rec
    time.sleep(10)
    rec["ram_after_10s_mb"] = avail_mb()
    # a state longer than 512 tokens makes the worker load the second checkpoint (typed-decisions): its worst-case size
    first_verify = next(m for m in msgs if m["op"] == "verify")
    primer_rep, rec["primer_s"] = client.call(dict(first_verify, code=(first_verify["code"] + "\n\n") * 3))
    rec["primer_ckpt"] = (primer_rep or {}).get("ckpt")
    rec["worker_mem_both_checkpoints"] = client.call({"op": "mem"})[0] if not client.dead else None
    rec["ram_with_both_mb"] = avail_mb()
    gen = {}

    def generate():
        try:
            gen.update(moe_sweep.chat_once([{"role": "user", "content": server_prompt}], 900, False))
        except Exception as e:  # recorded; the Laya calls still count
            gen["error"] = f"{type(e).__name__}: {e}"[:200]
    th = threading.Thread(target=generate)
    th.start()
    time.sleep(2)  # let the generation start before the first call
    secs, replies, ram_min = [], [], rec["ram_after_10s_mb"]
    for m in msgs:
        rep, wall = client.call(m)
        secs.append(wall)
        replies.append(bool(rep and rep.get("ok")))
        ram_min = min(ram_min, avail_mb())
        if client.dead:
            break
    th.join()
    mem, _ = client.call({"op": "mem"}) if not client.dead else (None, 0)
    rec.update(calls=len(secs), ok=sum(replies), dead=client.dead, p50_s=round(pct(secs, .5), 3),
               p95_s=round(pct(secs, .95), 3), max_s=round(max(secs), 3), ram_min_during_mb=ram_min,
               worker_mem=mem, gen_tps_during=gen.get("gen_tps"), gen_n_during=gen.get("gen_n"),
               gen_error=gen.get("error"), ram_after_calls_mb=avail_mb())
    client.close()
    time.sleep(10)
    return rec


def measure(window, ncmoe, a, laya_msgs):
    """One server load at `ncmoe`: returns (row, proc-less). row['refit'] asks for a larger ncmoe."""
    import playbook_tier2b as pt
    ob.CTX = window
    args = ob.llama_args(MODEL, ncmoe) + (["--load-mode", "none"] if a.load_mode == "none" else [])
    log = open(pathlib.Path(a.out).parent / f"headroom-{window}-ncmoe{ncmoe}.log", "w",
               encoding="utf-8", errors="replace")
    row = {"window": window, "ncmoe": ncmoe, "load_mode": a.load_mode, "tag": a.tag, "t_start": time.strftime("%H:%M:%S"), "args": [
        x for x in args[args.index("--host") + 2:] if not str(x).endswith(".gguf")],
        "vram_base_mib": moe_sweep.vram_used_mib(), "ram_before_launch_mb": pt.available_mb()}
    base_shared = moe_sweep.gpu_shared_mib()
    t0 = time.time()
    proc = ob._start(args, log)
    row["load_s"] = round(time.time() - t0, 1)
    if proc is None:
        row.update(error="server did not load", fit_ok=False, loaded=False)
        log.close()
        return row
    try:
        moe_sweep.chat_once([{"role": "user", "content": "Say hi."}], 16, False)
        used = moe_sweep.vram_used_mib()
        row.update(loaded=True, vram_used_loaded_mib=used, ram_after_load_mb=pt.available_mb(),
                   server_ws_gb=moe_sweep.working_set_gb(proc.pid))
        gen, edit, long10k = moe_sweep.build_prompts()
        peak = used
        # cold, then warm: the same ~9k-token prompt
        for tag in ("cold", "warm"):
            r = moe_sweep.chat_once([{"role": "user", "content": long10k[1]}], 200, False)
            r.pop("text")
            row[tag] = r
            peak = max(peak, moe_sweep.vram_used_mib())
        row["ram_after_warm_mb"] = pt.available_mb()
        short = []
        for _ in range(2):
            for _n, content, mx in (gen, edit):
                r = moe_sweep.chat_once([{"role": "user", "content": content}], mx, False)
                short.append(r["gen_tps"])
        row["short_gen_tps"] = short
        peak = max(peak, moe_sweep.vram_used_mib())
        name, content, _ = speed_pair.deep_prompt(deep_tokens(window))
        row["deep_name"] = name
        if a.laya_only:  # the mmap pass: RAM state after a cold and a warm read is what Laya meets; no deep prompt
            row["deep"], row["followup"] = {"skipped": "laya-only"}, {"skipped": "laya-only"}
        else:
            try:
                if window > a.no_followup_above:  # reading 83-108k tokens takes 14-25 min: once, no follow-up
                    first = moe_sweep.chat_once([{"role": "user", "content": content}], 300, False)
                    first.pop("text")
                    row["followup"] = {"skipped": f"window above {a.no_followup_above}", "first": first}
                else:
                    fu = moe_sweep.followup_probe(content)
                    row["followup"] = fu
                    first = fu["first"]
                row["deep"] = {"prompt_n": first["prompt_n"], "prompt_tps": first["prompt_tps"],
                               "gen_tps": first["gen_tps"], "gen_n": first["gen_n"], "wall_s": first["wall_s"]}
            except Exception as e:
                row["deep"] = {"error": f"{type(e).__name__}: {e}"[:300]}
        peak = max(peak, moe_sweep.vram_used_mib())
        row.update(vram_peak_mib=peak, vram_margin_mib=VRAM_TOTAL - peak,
                   shared_spill_mib=moe_sweep.gpu_shared_mib() - base_shared if base_shared >= 0 else None,
                   ram_after_deep_mb=pt.available_mb(), server_ws_gb_end=moe_sweep.working_set_gb(proc.pid))
        row["fit_ok"] = peak <= ob.VRAM_CAP_MIB and "error" not in row["deep"]
        if peak > ob.VRAM_CAP_MIB:
            row["refit"] = True  # the cap holds at the peak too: the caller retries at a larger ncmoe
        if row["fit_ok"] and a.variants:
            row["laya"] = {}
            for v in a.variants:
                row["laya"][v] = laya_phase(v, pt.LayaClient, laya_msgs, content[:6000] + "\n\nSummarize the code above "
                                            "in detail, class by class.", pt.available_mb)
                print(f"{time.strftime('%H:%M:%S')}   laya {v}: {json.dumps({k: row['laya'][v].get(k) for k in ('ram_before_mb', 'ram_after_load_mb', 'ram_after_10s_mb', 'ok', 'p50_s', 'p95_s', 'gen_tps_during', 'skipped')})}",
                      flush=True)
    except Exception as e:
        row.update(error=f"{type(e).__name__}: {e}"[:300], fit_ok=False)
    finally:
        ob._stop(proc)
        log.close()
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--windows", default="16384,40960,65536,98304,131072")
    ap.add_argument("--variants", default="int8,fp32")
    ap.add_argument("--ncmoe", type=int, default=26)
    ap.add_argument("--stop-file", default="")
    ap.add_argument("--ncmoe-from", default="", help="a headroom.jsonl: start each window at its fitted ncmoe there")
    ap.add_argument("--no-followup-above", type=int, default=10 ** 9, help="no follow-up probe for larger windows")
    ap.add_argument("--laya-only", action="store_true", help="cold + warm read and short generations, no deep prompt")
    ap.add_argument("--load-mode", default="none", choices=["none", "mmap"], help="mmap = llama-server's default")
    ap.add_argument("--tag", default="", help="free text recorded in every row, e.g. the apps that were closed")
    a = ap.parse_args()
    a.variants = [v for v in a.variants.split(",") if v]
    out = pathlib.Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    import laya_lean_eval
    laya_msgs = laya_lean_eval.make_msgs("docs/benchmarks/laya3/laya3-calib-nested.jsonl", N_LAYA)
    done = {}
    if out.exists():
        for line in out.read_text(encoding="utf-8").splitlines():
            r = json.loads(line)
            if r.get("final"):
                done[r["window"]] = r
    ncmoe = a.ncmoe
    fitted = {}
    if a.ncmoe_from and pathlib.Path(a.ncmoe_from).exists():
        for line in pathlib.Path(a.ncmoe_from).read_text(encoding="utf-8").splitlines():
            r = json.loads(line)
            if r.get("final") and r.get("fit_ok"):
                fitted[r["window"]] = r["ncmoe"]
    for window in (int(w) for w in a.windows.split(",")):
        ncmoe = max(ncmoe, fitted.get(window, 0))
        if a.stop_file and pathlib.Path(a.stop_file).exists():
            print("stop file found", flush=True)
            return
        if window in done:
            ncmoe = max(ncmoe, done[window]["ncmoe"])
            continue
        final = None
        for _ in range(8):
            row = measure(window, ncmoe, a, laya_msgs)
            row["verdict"] = window_verdict(row) if row.get("loaded") else {}
            nxt = ncmoe + (4 if not row.get("loaded") else 2)
            retry = (not row.get("loaded") or row.get("refit")) and nxt <= 40
            row["final"] = not retry
            with out.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
            print(f"{time.strftime('%H:%M:%S')} window {window} ncmoe {ncmoe}: loaded {row.get('loaded')} VRAM used "
                  f"{row.get('vram_used_loaded_mib')} peak {row.get('vram_peak_mib')} short {row.get('short_gen_tps')} "
                  f"deep {row.get('deep')} verdict {json.dumps({k: v['pass'] for k, v in row['verdict'].items()})} "
                  f"error {row.get('error')}", flush=True)
            if not retry:
                final = row
                break
            ncmoe = nxt
        if final is None:
            print(f"window {window}: no placement fits up to ncmoe 40", flush=True)
            break


if __name__ == "__main__":
    main()
