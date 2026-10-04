"""Serving sweep for MoE GGUFs on the RTX 4060 (llama-server, Windows CUDA build).

For each config: start llama-server, wait for /health, measure the VRAM delta
against an idle baseline, run a fixed prompt set (short generation, ~2k-token
edit, ~10k-token long context), record llama-server's own timings, stop.
One JSON row per config is appended to --out. Stdlib only.
"""
import argparse
import ctypes
import itertools
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

SERVER = ""  # set by --server or by a caller (C: builds; D: went offline 2026-10-04)
PORT = 8091
BASE = f"http://127.0.0.1:{PORT}"
DRAFT_MODEL = ""
SPEC_TYPE = "draft-mtp"  # or draft-eagle3 etc.; set by --spec-type or a caller
EXTRA_ARGS = []  # extra llama-server args, e.g. ["-ot", "attn_v_exps=CPU"] for K2-Horizon


class _MemStat(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


def ram_avail_gb() -> float:
    m = _MemStat()
    m.dwLength = ctypes.sizeof(_MemStat)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return round(m.ullAvailPhys / 1e9, 2)


def vram_used_mib() -> int:
    out = subprocess.check_output(
        ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], text=True)
    return int(out.strip().splitlines()[0])


def gpu_shared_mib() -> int:
    """System RAM the GPU driver is using for this adapter ("shared GPU memory").
    Growth during a run means Windows sysmem fallback: VRAM overflowed into RAM,
    which made Xing4.0 at ncmoe 18 2.6x slower than at ncmoe 22 (2026-10-04)."""
    try:
        out = subprocess.check_output(
            ["powershell", "-NoProfile", "-Command",
             r"((Get-Counter '\GPU Adapter Memory(*)\Shared Usage').CounterSamples | "
             r"Measure-Object CookedValue -Maximum).Maximum"], text=True, timeout=120)
        return int(float(out.strip() or 0) / 2**20)
    except Exception:
        return -1


def working_set_gb(pid: int) -> float:
    out = subprocess.check_output(
        ["powershell", "-NoProfile", "-Command", f"(Get-Process -Id {pid}).WorkingSet64"], text=True)
    return round(int(out.strip()) / 1e9, 2)


def http(method: str, path: str, payload=None, timeout=900):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read() or b"{}")


def build_prompts():
    import json as _json  # stdlib source files are realistic code context
    import argparse as _argparse
    dec = pathlib.Path(_json.decoder.__file__).read_text(encoding="utf-8")
    ap = pathlib.Path(_argparse.__file__).read_text(encoding="utf-8")
    return [
        ("gen", "Write a Python function `parse_duration(s: str) -> int` that parses ISO-8601 "
                "durations like 'PT1H30M15S' or 'P2DT3H' into seconds, raising ValueError on "
                "bad input. Include a docstring and five pytest tests.", 400),
        ("edit2k", "Here is a Python module:\n\n```python\n" + dec + "\n```\n\nModify "
                   "`py_scanstring` so it also accepts a `max_len` keyword argument and raises "
                   "ValueError when the decoded string exceeds it. Return only the full "
                   "modified function.", 500),
        ("long10k", "Here is the start of a Python module:\n\n```python\n" + ap[:40000] +
                    "\n```\n\nList every class defined above with a one-line description of "
                    "each.", 300),
    ]


def run_config(model, ncmoe, mtp, ctx, ubatch, threads, logdir, prompts):
    tag = f"{pathlib.Path(model).stem}_ncmoe{ncmoe}_mtp{mtp}_ctx{ctx}_ub{ubatch}_t{threads or 'def'}"
    args = [SERVER, "-m", model, "--host", "127.0.0.1", "--port", str(PORT),
            "-ngl", "99", "--n-cpu-moe", str(ncmoe), "-c", str(ctx),
            "-ctk", "q8_0", "-ctv", "q8_0", "--flash-attn", "on",
            "-b", str(max(ubatch, 512)), "-ub", str(ubatch), "-np", "1",
            "--jinja", "--reasoning-budget", "0", "--no-webui",
            "--cache-ram", "0"] + list(EXTRA_ARGS)  # default 8 GiB host prompt cache starves 16 GB RAM
    if threads:
        args += ["-t", str(threads)]
    if mtp:
        args += ["--spec-type", SPEC_TYPE, "--spec-draft-n-max", str(mtp)]
        if DRAFT_MODEL:  # Gemma ships its MTP head as a separate file
            args += ["-md", DRAFT_MODEL]
    row = {"tag": tag, "model": pathlib.Path(model).name, "ncmoe": ncmoe, "mtp": mtp,
           "ctx": ctx, "ubatch": ubatch, "threads": threads}
    base_vram, base_ram, base_shared = vram_used_mib(), ram_avail_gb(), gpu_shared_mib()
    log = open(logdir / f"{tag}.log", "w", encoding="utf-8", errors="replace")
    t0 = time.time()
    proc = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT)
    try:
        while True:
            if proc.poll() is not None:
                row["error"] = f"server exited {proc.returncode} during load"
                return row
            try:
                if http("GET", "/health", timeout=2)[0] == 200:
                    break
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                pass
            if time.time() - t0 > 600:
                row["error"] = "load timeout"
                return row
            time.sleep(1)
        row["load_s"] = round(time.time() - t0, 1)
        row["vram_delta_mib_loaded"] = vram_used_mib() - base_vram
        results, peak = [], 0
        # Warm-up pass over the full prompt set, not recorded. With experts in RAM,
        # the first pass pages cold expert weights in from disk (measured on Gemma:
        # 4.2 tok/s cold vs 23.7 warm), which is a load cost, not a serving speed.
        for _, content, max_tokens in prompts:
            http("POST", "/v1/chat/completions", {
                "messages": [{"role": "user", "content": content}],
                "max_tokens": max_tokens, "temperature": 0, "cache_prompt": False,
                "chat_template_kwargs": {"enable_thinking": False}})
        row["server_working_set_gb"] = working_set_gb(proc.pid)
        for name, content, max_tokens in prompts:
            t = time.time()
            _, resp = http("POST", "/v1/chat/completions", {
                "messages": [{"role": "user", "content": content}],
                "max_tokens": max_tokens, "temperature": 0, "cache_prompt": False,
                "chat_template_kwargs": {"enable_thinking": False}})
            peak = max(peak, vram_used_mib() - base_vram)
            tm = resp.get("timings", {})
            text = resp["choices"][0]["message"].get("content") or ""
            results.append({
                "prompt": name, "wall_s": round(time.time() - t, 2),
                "prompt_n": tm.get("prompt_n"), "prompt_tps": round(tm.get("prompt_per_second", 0), 1),
                "gen_n": tm.get("predicted_n"), "gen_tps": round(tm.get("predicted_per_second", 0), 2),
                "draft_n": tm.get("draft_n"), "draft_accepted": tm.get("draft_n_accepted"),
                "thinking_leak": "<think>" in text, "head": text[:80]})
        row["vram_delta_mib_peak"] = peak
        # One read after all prompts: a spill, once allocated, persists while the server runs.
        row["shared_spill_mib"] = gpu_shared_mib() - base_shared if base_shared >= 0 else None
        row["ram_avail_gb_during"] = ram_avail_gb()
        row["ram_avail_gb_before"] = base_ram
        # Below ~0.5 GB available, Windows evicts mmap'd expert pages and decode
        # speed measures the disk, not the config. Flag it rather than trust it.
        row["paging_risk"] = row["ram_avail_gb_during"] < 0.5
        row["runs"] = results
        gen = [r["gen_tps"] for r in results if r["gen_tps"]]
        row["gen_tps_mean"] = round(sum(gen) / len(gen), 2) if gen else None
        acc = [(r["draft_accepted"], r["draft_n"]) for r in results if r.get("draft_n")]
        if acc:
            row["draft_accept_rate"] = round(sum(a for a, _ in acc) / sum(n for _, n in acc), 3)
        return row
    except Exception as e:  # record and move on; one bad config must not kill the sweep
        row["error"] = f"{type(e).__name__}: {e}"
        return row
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        time.sleep(3)


def main():
    global DRAFT_MODEL, SPEC_TYPE, SERVER
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True)
    p.add_argument("--ncmoe", default="28")
    p.add_argument("--mtp", default="0")
    p.add_argument("--ctx", default="16384")
    p.add_argument("--ubatch", default="512")
    p.add_argument("--threads", default="0")
    p.add_argument("--draft-model", default="")
    p.add_argument("--spec-type", default="draft-mtp")
    p.add_argument("--server", required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args()
    DRAFT_MODEL, SPEC_TYPE, SERVER = a.draft_model, a.spec_type, a.server
    out = pathlib.Path(a.out)
    logdir = out.parent / (out.stem + "-logs")
    logdir.mkdir(parents=True, exist_ok=True)
    prompts = build_prompts()
    grid = itertools.product(*[[int(x) for x in s.split(",")] for s in
                               (a.ncmoe, a.mtp, a.ctx, a.ubatch, a.threads)])
    for ncmoe, mtp, ctx, ub, th in grid:
        row = run_config(a.model, ncmoe, mtp, ctx, ub, th or None, logdir, prompts)
        with out.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        brief = {k: row.get(k) for k in ("tag", "error", "load_s", "vram_delta_mib_peak",
                                          "server_working_set_gb", "ram_avail_gb_during",
                                          "paging_risk", "gen_tps_mean", "draft_accept_rate")}
        brief["per_prompt"] = {r["prompt"]: [r["prompt_tps"], r["gen_tps"]] for r in row.get("runs", [])}
        print(json.dumps(brief), flush=True)


if __name__ == "__main__":
    sys.exit(main())
