"""Smallest-first model pipeline, C:-only edition (2026-10-04).

D: (the USB drive holding the forge, its venv, builds and model archive) went
offline overnight with bad-block errors, so everything here lives on C:.

For each model, in ascending download size, one at a time:
  1. make sure its llama.cpp build exists (builds overlap downloads, never runs),
  2. download to C:\\qwen3-forge-stage\\models\\<name> and verify sha256 against
     Hugging Face (an already-staged file of the right size is reused),
  3. apply known GGUF metadata fixes,
  4. probe expert placement (moe_sweep.run_config) and keep the fastest config
     whose VRAM delta stays inside the project's 7,168 MiB cap,
  5. run the full tier2b suite (39 tasks x 3 samples, thinking off),
then the next size up. Finished models are only evicted from C: when the next
download needs the space (oldest first). Results append to pipeline-results.jsonl.
"""
import glob
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import threading
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import moe_sweep  # noqa: E402
from huggingface_hub import get_hf_file_metadata, hf_hub_download, hf_hub_url  # noqa: E402

STAGE = pathlib.Path(r"C:\qwen3-forge-stage")
MODELS_DIR = STAGE / "models"
TOOLS = STAGE / "tools"
LOGS = STAGE / "logs"
PY = str(STAGE / "venv" / "Scripts" / "python.exe")
BUILD_PS1 = str(pathlib.Path(__file__).with_name("build_llama.ps1"))
VRAM_CAP_MIB = 7168
SPACE_MARGIN_GB = 8
DAY = time.strftime("%Y-%m-%d")
LOG = LOGS / f"pipeline-{DAY}.log"
RESULTS = LOGS / "pipeline-results.jsonl"

# Ascending by total download size.
MODELS = [
    # The published non-MTP file keeps nextn_predict_layers=1 without the MTP tensors;
    # the loader then treats the last real layer as the MTP layer and fails
    # ("wrong number of tensors; expected 953, got 947"). Setting it to 0 fixes the load.
    dict(name="xing4-iq3xxs", repo="Venastine-Research/Xing4.0-29B-A4B-GGUF",
         files=["Xing4.0-29B-A4B-IQ3_XXS.gguf"], build="xing4",
         fix_metadata=[("xing4_0.nextn_predict_layers", "0")], ncmoe=[18, 22, 26], mtp=0),
    dict(name="gptoss20b-mxfp4", repo="ggml-org/gpt-oss-20b-GGUF",
         files=["gpt-oss-20b-MXFP4.gguf", "eagle3-gpt-oss-20b-Q8_0.gguf"], build="master",
         draft="eagle3-gpt-oss-20b-Q8_0.gguf", spec="draft-eagle3", mtp=3,
         ncmoe=[12, 15, 18], budget=-1, chat_kwargs={"reasoning_effort": "low"}),
    dict(name="tiel-iq3xxs", repo="peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF-MTP",
         files=["Tiel-Coder-35B-A3B-MTP-UD-IQ3_XXS.gguf"], build="master", ncmoe=[24, 26, 28], mtp=2),
    dict(name="gemma4-qat-q4kxl", repo="unsloth/gemma-4-26B-A4B-it-qat-GGUF",
         files=["gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf", "mtp-gemma-4-26B-A4B-it.gguf"], build="master",
         draft="mtp-gemma-4-26B-A4B-it.gguf", mtp=2, ncmoe=[22, 24, 26]),
    # K2's MoVA attention keeps its own experts (attn_v_exps, 2.9 GB) that --n-cpu-moe
    # does not move; left on the GPU they overflow VRAM into system RAM (7 tok/s).
    dict(name="k2h-iq3xxs", repo="NANI-Nithin/K2-Horizon-MoVA-36B-A4B-GGUF",
         files=["K2-Horizon-MoVA-36B-A4B-IQ3_XXS.gguf"], build="k2h", ncmoe=[30, 34, 38], mtp=0,
         extra_args=["-ot", "attn_v_exps=CPU"]),
]
BRANCH = {"master": "master", "xing4": "pr-xing4", "k2h": "pr-k2h"}


def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")
    print(line, flush=True)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(16 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def remote_meta(repo, name):
    m = get_hf_file_metadata(hf_hub_url(repo, name))
    return (m.etag or "").strip('"'), m.size


def free_gb():
    return shutil.disk_usage(STAGE).free / 1e9


def make_room(need_gb, finished):
    while free_gb() < need_gb + SPACE_MARGIN_GB and finished:
        old = finished.pop(0)
        shutil.rmtree(old, ignore_errors=True)
        log(f"  evicted {old.name} to make room (C: free now {free_gb():.1f} GB)")
    if free_gb() < need_gb + SPACE_MARGIN_GB:
        raise RuntimeError(f"not enough space on C: ({free_gb():.1f} GB free, need {need_gb:.1f} + margin)")


def download(repo, name, dest):
    want, size = remote_meta(repo, name)
    target = dest / pathlib.Path(name).name
    if target.exists() and target.stat().st_size == size:
        log(f"  using staged {target.name} ({size / 1e9:.2f} GB)")
        return target
    for attempt in range(1, 4):
        try:
            t = time.time()
            path = pathlib.Path(hf_hub_download(repo, name, local_dir=str(dest)))
            got = sha256(path)
            if want and want != got:
                raise RuntimeError(f"sha256 mismatch: want {want} got {got}")
            log(f"  downloaded {name} ({path.stat().st_size / 1e9:.2f} GB, sha256 ok) in {time.time() - t:.0f} s")
            return path
        except Exception as e:
            log(f"  download attempt {attempt} for {name} failed: {type(e).__name__}: {e}")
            time.sleep(60)
    raise RuntimeError(f"giving up on {name}")


def server_for(label):
    found = sorted(glob.glob(str(TOOLS / f"llama-{label}-*" / "llama-server.exe")), key=os.path.getmtime)
    return found[-1] if found else None


def build(label):
    """Build if missing; returns the llama-server path. Runs synchronously."""
    srv = server_for(label)
    if srv:
        return srv
    log(f"  building llama.cpp {BRANCH[label]}")
    t = time.time()
    p = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", BUILD_PS1,
                        "-Branch", BRANCH[label], "-Name", label, "-Jobs", "6", "-Force"],
                       capture_output=True, text=True)
    srv = server_for(label)
    if not srv:
        tail = " | ".join((p.stdout + p.stderr).strip().splitlines()[-3:])
        raise RuntimeError(f"build {label} failed: {tail}")
    log(f"  build {label} done in {(time.time() - t) / 60:.0f} min: {srv}")
    return srv


def builds_running():
    return any("build_llama" in (c or "") for c in _cmdlines())


def start_build(label):
    """Start a background build if this label has no server and nothing else is compiling."""
    while builds_running():
        time.sleep(30)
    if server_for(label):
        return
    log(f"  starting llama.cpp build {BRANCH[label]} in the background")
    subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", BUILD_PS1,
                      "-Branch", BRANCH[label], "-Name", label, "-Jobs", "6", "-Force"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(20)  # let the process appear before anyone polls for it


def _cmdlines():
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command",
                              "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"],
                             capture_output=True, text=True, timeout=60).stdout
        return out.splitlines()
    except Exception:
        return []


def fix_metadata(path, fixes):
    from gguf import GGUFReader
    for key, value in fixes:
        r = GGUFReader(str(path), "r")
        f = r.fields.get(key)
        cur = f.parts[f.data[0]].tolist()[0] if f else None
        del r
        if f is not None and str(cur) != value:
            subprocess.run([PY, "-m", "gguf.scripts.gguf_set_metadata", str(path), key, value, "--force"],
                           check=True, capture_output=True)
            log(f"  metadata fix: {key} {cur} -> {value}")


def probe_placement(m, model_path, server, draft_path):
    moe_sweep.SERVER = server
    moe_sweep.SPEC_TYPE = m.get("spec", "draft-mtp")
    moe_sweep.DRAFT_MODEL = str(draft_path) if draft_path else ""
    moe_sweep.EXTRA_ARGS = list(m.get("extra_args", []))
    logdir = LOGS / f"placement-{m['name']}-{DAY}-logs"
    logdir.mkdir(parents=True, exist_ok=True)
    prompts = moe_sweep.build_prompts()
    rows, tried, mtp = [], set(), m.get("mtp", 0)
    candidates = list(m["ncmoe"])

    def fits(r):
        return not r.get("error") and (r.get("vram_delta_mib_peak") or 1e9) <= VRAM_CAP_MIB

    # Reuse placements already measured for this model today (restart-safe).
    prior = LOGS / f"placement-{m['name']}-{DAY}.jsonl"
    if prior.exists():
        rows = [json.loads(l) for l in prior.read_text(encoding="utf-8").splitlines() if l.strip()]
        rows = [r for r in rows if r.get("model") == pathlib.Path(model_path).name
                and r.get("ncmoe") in m["ncmoe"]]
        if any(fits(r) for r in rows):
            candidates = []
            log(f"  reusing {len(rows)} placement probe(s) measured earlier today")

    while candidates:
        n = candidates.pop(0)
        if n in tried or n > 80:
            continue
        tried.add(n)
        row = moe_sweep.run_config(str(model_path), n, mtp, 16384, 512, None, logdir, prompts)
        if row.get("error") and mtp:  # speculation unsupported here? retry plain
            log(f"  ncmoe {n} with speculation failed ({row['error']}); retrying without")
            row = moe_sweep.run_config(str(model_path), n, 0, 16384, 512, None, logdir, prompts)
        rows.append(row)
        with (LOGS / f"placement-{m['name']}-{DAY}.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        log(f"  probe ncmoe {n} mtp {row['mtp']}: {row.get('gen_tps_mean')} tok/s, "
            f"VRAM {row.get('vram_delta_mib_peak')} MiB, paging_risk={row.get('paging_risk')}, "
            f"error={row.get('error')}")
        if len(rows) >= 3 and all(r.get("error") for r in rows[-3:]):
            raise RuntimeError(f"3 placements in a row failed; last error: {row.get('error')}")
        # No early stop: near the VRAM ceiling the Windows driver silently spills to
        # system RAM ("sysmem fallback"), so fewer CPU layers can be much slower
        # (Xing4.0: ncmoe 18 = 12.2 tok/s at 6,602 MiB vs ncmoe 22 = 32.4 at 6,446).
        if not candidates and not any(fits(r) for r in rows):
            candidates.append(max(tried) + 4)  # nothing fit: move more experts to the CPU
    ok = [r for r in rows if fits(r)]
    if not ok:
        raise RuntimeError("no placement fits the VRAM cap")
    best = max(ok, key=lambda r: r.get("gen_tps_mean") or 0)
    log(f"  chosen: ncmoe {best['ncmoe']} mtp {best['mtp']} -> {best['gen_tps_mean']} tok/s, "
        f"{best['vram_delta_mib_peak']} MiB")
    return best


def run_tier2b(m, model_path, server, draft_path, best):
    budget = m.get("budget", 0)
    out = LOGS / f"tier2b-{m['name']}-{'off' if budget == 0 else 'b' + str(budget)}-{DAY}.jsonl"
    cmd = [PY, str(pathlib.Path(__file__).parent / "tier2b_llama.py"), "--model", str(model_path),
           "--server", server, "--ncmoe", str(best["ncmoe"]), "--mtp", str(best["mtp"]),
           "--spec-type", m.get("spec", "draft-mtp"), "--budget", str(budget),
           "--chat-kwargs", json.dumps(m.get("chat_kwargs", {})),
           "--extra-args", json.dumps(m.get("extra_args", [])), "--out", str(out)]
    if draft_path and best["mtp"]:
        cmd += ["--draft-model", str(draft_path)]
    log(f"  tier2b -> {out.name}")
    p = subprocess.run(cmd, capture_output=True, text=True)
    lines = [l for l in p.stdout.splitlines() if l.startswith("{")]
    summary = json.loads(lines[-1]) if lines else {"error": (p.stderr or p.stdout)[-400:]}
    log(f"  tier2b result: {summary.get('passed')}/{summary.get('total')} "
        f"in {summary.get('minutes')} min, restarts {summary.get('server_restarts')}")
    return summary, out


def prefetch(m, finished, box):
    """Download the next model while the current one waits on a build (never during a run)."""
    try:
        dest = MODELS_DIR / m["name"]
        dest.mkdir(parents=True, exist_ok=True)
        need = sum(remote_meta(m["repo"], f)[1] for f in m["files"]) / 1e9
        make_room(need, finished)
        box["paths"] = [download(m["repo"], f, dest) for f in m["files"]]
    except Exception as e:
        box["error"] = e


def main():
    LOGS.mkdir(parents=True, exist_ok=True)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    done = set()
    if RESULTS.exists():
        done = {json.loads(l)["name"] for l in RESULTS.read_text(encoding="utf-8").splitlines() if l.strip()}
    todo = [m for m in MODELS if m["name"] not in done and (len(sys.argv) < 2 or m["name"] in sys.argv[1:])]
    finished = []  # model dirs eligible for eviction, oldest first
    prefetched = {}
    for i, m in enumerate(todo):
        log(f"=== {m['name']}  (C: free {free_gb():.1f} GB)")
        try:
            dest = MODELS_DIR / m["name"]
            dest.mkdir(parents=True, exist_ok=True)
            if not server_for(m["build"]):
                start_build(m["build"])  # compiles while this model downloads
            box = prefetched.pop(m["name"], None)
            if box is not None:
                box["thread"].join()
                if "error" in box:
                    raise box["error"]
                paths = box["paths"]
            else:
                # Only files not already staged at the right size need space.
                metas = [(f, remote_meta(m["repo"], f)[1]) for f in m["files"]]
                need = sum(size for f, size in metas
                           if not ((dest / pathlib.Path(f).name).exists()
                                   and (dest / pathlib.Path(f).name).stat().st_size == size)) / 1e9
                if need:
                    make_room(need, finished)
                paths = [download(m["repo"], f, dest) for f in m["files"]]
            # Builds and benchmark runs never overlap: wait for any compile to finish,
            # fetching the next model meanwhile.
            if builds_running() and i + 1 < len(todo) and todo[i + 1]["name"] not in prefetched:
                nxt = todo[i + 1]
                nbox = {}
                nbox["thread"] = threading.Thread(target=prefetch, args=(nxt, finished, nbox), daemon=True)
                nbox["thread"].start()
                prefetched[nxt["name"]] = nbox
                log(f"  prefetching {nxt['name']} while a llama.cpp build finishes")
            t_wait = time.time()
            while builds_running():
                time.sleep(30)
            if time.time() - t_wait > 60:
                log(f"  waited {(time.time() - t_wait) / 60:.0f} min for builds to finish")
            server = server_for(m["build"]) or build(m["build"])
            model_path = paths[0]
            if m.get("fix_metadata"):
                fix_metadata(model_path, m["fix_metadata"])
            draft_path = next((p for p in paths if p.name == m.get("draft")), None)
            best = probe_placement(m, model_path, server, draft_path)
            summary, out = run_tier2b(m, model_path, server, draft_path, best)
            with RESULTS.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"name": m["name"], "server": server, "ncmoe": best["ncmoe"],
                                    "mtp": best["mtp"], "gen_tps_mean": best["gen_tps_mean"],
                                    "vram_mib": best["vram_delta_mib_peak"],
                                    "per_prompt": {r["prompt"]: [r["prompt_tps"], r["gen_tps"]]
                                                   for r in best.get("runs", [])},
                                    "tier2b": summary, "results_file": str(out)}) + "\n")
            finished.append(dest)
        except Exception as e:
            log(f"  {m['name']} FAILED: {type(e).__name__}: {e}")
            finished.append(MODELS_DIR / m["name"])
    log("pipeline done (Flash-Next deferred: its 58.4 GB of shards do not fit on C: with D: offline)")


if __name__ == "__main__":
    main()
