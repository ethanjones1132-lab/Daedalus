"""K2-Horizon in the original mmap configuration (no --load-mode none), apps closed: how fast does it read and generate?
One load, one short generation prompt and one ~9k-token prompt, with RAM and VRAM. usage: k2_probe.py OUT.json"""
import json
import pathlib
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "moe-bench"))
import moe_sweep  # noqa: E402
import oneshot_bench as ob  # noqa: E402

moe_sweep.BASE = f"http://127.0.0.1:{ob.PORT}"
m = ob.MODELS["k2h"]
extra = list(m["extra"])
if "--load-mode" in extra:
    i = extra.index("--load-mode")
    del extra[i:i + 2]
m["extra"] = extra
args = ob.llama_args("k2h", m["ncmoe"])
out = {"args": [a for a in args[args.index("--host") + 2:]], "ram_before_gb": moe_sweep.ram_avail_gb()}
log = open(pathlib.Path(sys.argv[1]).with_suffix(".server.log"), "w", encoding="utf-8", errors="replace")
t0 = time.time()
proc = ob._start(args, log)
out["load_s"] = round(time.time() - t0, 1)
try:
    if proc is None:
        out["error"] = "did not load"
    else:
        out["ram_after_load_gb"] = moe_sweep.ram_avail_gb()
        gen, _, long10k = moe_sweep.build_prompts()
        for name, content, mx in (("gen", gen[1], 200), ("long", long10k[1], 100)):
            try:
                r = moe_sweep.chat_once([{"role": "user", "content": content}], mx, False)
                r.pop("text")
                r["ram_gb"], r["vram_mib"] = moe_sweep.ram_avail_gb(), moe_sweep.vram_used_mib()
                out[name] = r
            except Exception as e:
                out[name] = {"error": f"{type(e).__name__}: {e}"[:200]}
            print(name, out[name], flush=True)
finally:
    if proc:
        ob._stop(proc)
    log.close()
pathlib.Path(sys.argv[1]).write_text(json.dumps(out, indent=1), encoding="utf-8")
