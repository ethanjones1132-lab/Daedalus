"""Tier-2B quality run against llama-server (OpenAI endpoint).

Reuses the benchmark's own prompt, extraction and scoring (runbench2b.py,
tasks.py): 39 tasks x K=3 samples, sampled at temperature 0.2 / top_p 0.95
with the sample index as seed (the t5_tier2b.py convention). Starts and stops
its own llama-server with the given placement. One JSON row per sample plus a
summary row go to --out.

Resumable: samples already in --out are skipped. If the server process dies
mid-run, it is restarted and the sample retried, instead of every remaining
sample being recorded as a connection failure (2026-10-03: one server death
turned 105 samples into instant "connection refused" fails).

Lives on C: since 2026-10-04 (the D: copy is on a drive that went offline).
"""
import argparse
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

BENCH = pathlib.Path(r"C:\Projects\home-base-recovered\scripts\benchmark-tier2b")
sys.path.insert(0, str(BENCH))
from runbench2b import baseline_prompt, extract_code, run_test, seed  # noqa: E402
from tasks import K, TASKS  # noqa: E402

PORT = 8092
BASE = f"http://127.0.0.1:{PORT}"
MAX_RESTARTS = 3


def post(path, payload, timeout):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def wait_healthy(proc, limit=600):
    t0 = time.time()
    while time.time() - t0 < limit:
        if proc.poll() is not None:
            raise RuntimeError(f"server exited {proc.returncode}")
        try:
            with urllib.request.urlopen(BASE + "/health", timeout=2) as r:
                if r.status == 200:
                    return
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(1)
    raise RuntimeError("load timeout")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True)
    p.add_argument("--server", required=True, help="llama-server.exe to use")
    p.add_argument("--draft-model", default="")
    p.add_argument("--spec-type", default="draft-mtp", help="draft-mtp | draft-eagle3 | ...")
    p.add_argument("--ncmoe", type=int, required=True)
    p.add_argument("--mtp", type=int, default=2, help="draft tokens per step; 0 = no speculation")
    p.add_argument("--ctx", type=int, default=16384)
    p.add_argument("--budget", type=int, default=0, help="reasoning budget; 0 = thinking off, -1 = unlimited")
    p.add_argument("--chat-kwargs", default="{}", help="extra chat_template_kwargs as JSON")
    p.add_argument("--max-tokens", type=int, default=0, help="0 = derive from budget")
    p.add_argument("--extra-args", default="[]", help="extra llama-server args as a JSON list")
    p.add_argument("--out", required=True)
    a = p.parse_args()

    args = [a.server, "-m", a.model, "--host", "127.0.0.1", "--port", str(PORT), "-ngl", "99",
            "--n-cpu-moe", str(a.ncmoe), "-c", str(a.ctx), "-ctk", "q8_0", "-ctv", "q8_0",
            "--flash-attn", "on", "-b", "512", "-ub", "512", "-np", "1", "--jinja",
            "--reasoning-budget", str(a.budget), "--no-webui",
            "--cache-ram", "0"]  # default 8 GiB host prompt cache starves 16 GB RAM
    args += json.loads(a.extra_args)
    if a.mtp:
        args += ["--spec-type", a.spec_type, "--spec-draft-n-max", str(a.mtp)]
        if a.draft_model:
            args += ["-md", a.draft_model]
    max_tokens = a.max_tokens or (2048 if a.budget == 0 else 4096 if a.budget < 0 else 2048 + a.budget)
    chat_kwargs = {"enable_thinking": a.budget != 0, **json.loads(a.chat_kwargs)}

    out = pathlib.Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    log = open(out.with_suffix(".server.log"), "a", encoding="utf-8", errors="replace")

    def start_server():
        proc = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT)
        wait_healthy(proc)
        return proc

    proc = start_server()
    restarts, t_start = 0, time.time()
    try:
        done = {}
        if out.exists():  # resume: keep finished samples, run only the missing ones
            for line in out.read_text(encoding="utf-8").splitlines():
                r = json.loads(line)
                if "task" in r:
                    done[(r["task"], r["sample"])] = r["ok"]
        passed, total = sum(done.values()), len(done)
        with out.open("a", encoding="utf-8") as f:
            for task in TASKS:
                for sample in range(K):
                    if (task["name"], sample) in done:
                        continue
                    t = time.time()
                    while True:
                        try:
                            resp = post("/v1/chat/completions", {
                                "messages": [{"role": "user", "content": baseline_prompt(task)}],
                                "max_tokens": max_tokens, "temperature": 0.2, "top_p": 0.95,
                                "seed": sample, "cache_prompt": True,
                                "chat_template_kwargs": chat_kwargs},
                                timeout=600)
                            content = resp["choices"][0]["message"].get("content") or ""
                            with tempfile.TemporaryDirectory(prefix="t2b-") as raw:
                                d = pathlib.Path(raw)
                                seed(d, task)
                                (d / task["entry"]).write_text(extract_code(content), encoding="utf-8")
                                ok, detail = run_test(d, task["test"])
                            gen_n = resp.get("timings", {}).get("predicted_n")
                        except Exception as e:
                            if proc.poll() is not None and restarts < MAX_RESTARTS:
                                restarts += 1
                                print(f"server died (exit {proc.returncode}); restart {restarts}/{MAX_RESTARTS}",
                                      flush=True)
                                proc = start_server()
                                t = time.time()
                                continue  # retry this sample; a dead server is not a model failure
                            ok, detail, gen_n = False, f"{type(e).__name__}: {e}"[:240], None
                        break
                    passed += ok
                    total += 1
                    # The raw answer is kept so failures can be diagnosed afterwards
                    # (format vs logic) instead of guessed from token counts.
                    f.write(json.dumps({"task": task["name"], "category": task["category"],
                                        "sample": sample, "ok": ok, "detail": detail,
                                        "gen_n": gen_n, "secs": round(time.time() - t, 1),
                                        "content": content[:8000] if gen_n is not None else None}) + "\n")
                    f.flush()
                    print(f"{task['name']}#{sample} {'PASS' if ok else 'fail'} ({passed}/{total})", flush=True)
            summary = {"summary": True, "model": pathlib.Path(a.model).name, "server": a.server,
                       "ncmoe": a.ncmoe, "mtp": a.mtp, "spec_type": a.spec_type if a.mtp else None,
                       "budget": a.budget, "chat_kwargs": chat_kwargs, "passed": passed,
                       "total": total, "server_restarts": restarts,
                       "minutes": round((time.time() - t_start) / 60, 1)}
            f.write(json.dumps(summary) + "\n")
            print(json.dumps(summary), flush=True)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()


if __name__ == "__main__":
    main()
