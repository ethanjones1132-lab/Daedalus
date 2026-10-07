"""One-shot build benchmark harness: Ecosystem Lab (spec docs/superpowers/specs/2026-10-07-oneshot-bench-design.md).

run     generate builds: --model keep96 (llama-server 836d571, 64k window, batch 512, MTP + n-gram, thinking off,
        temperature 0.2, seed per build) or --model deepseek (OpenCode Go, DeepSeek v4.1 Flash, temperature 0.2).
        Writes RUNS/<model>/<seed>/response.md and meta.json; existing builds are skipped.
check   extract plan.md and app.html from each response, run the hidden checks (checks.mjs) for one parameter set,
        and with --shots take the judging screenshots. Writes checks-<set>.json and static.json per build.
blind   copy each build's plan, app and screenshots to BLIND/<random id>/ in shuffled order; the id -> build map goes
        to --map, which stays outside the repo until the judged scores are committed.
report  per-model and per-area check scores, the judged scores (after unblinding), the static report and the
        gallery, as markdown.

usage: oneshot_bench.py run --model keep96|deepseek --seeds 1-5 --runs RUNS
       oneshot_bench.py check --runs RUNS --params PARAMS.json --set dev|sealed [--shots]
       oneshot_bench.py blind --runs RUNS --out BLIND --map MAP.json
       oneshot_bench.py report --runs RUNS --map MAP.json --judge JUDGE.json --out REPORT.md
"""
import argparse
import json
import os
import pathlib
import random
import re
import shutil
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
LAB = REPO / "docs" / "benchmarks" / "oneshot" / "ecosystem-lab"
MB = REPO / "scripts" / "moe-bench"
FENCE = re.compile(r"```([^\n`]*)\n(.*?)```", re.S)
DOC = re.compile(r"<!doctype|<html", re.I)


def extract(text):
    """{plan, app, truncated}: the app is the longest closed fenced block that is html; else an open html fence
    running to the end; else the text from <!doctype/<html on. The plan is everything before the app."""
    blocks = [(m.start(), m.group(2)) for m in FENCE.finditer(text)
              if m.group(1).strip().lower() == "html" or DOC.search(m.group(2))]
    if blocks:
        start, body = max(blocks, key=lambda b: len(b[1]))
        app, plan = body.strip(), text[:start]
    else:
        open_fence = re.search(r"```html[^\n]*\n", text, re.I)
        doc = DOC.search(text)
        if open_fence:
            app, plan = text[open_fence.end():].strip(), text[:open_fence.start()]
        elif doc:
            app, plan = text[doc.start():].strip(), text[:doc.start()]
        else:
            app, plan = "", text
        app = re.sub(r"\n?```\s*$", "", app).strip()
    heading = re.search(r"^#+\s*Plan\b", text, re.M | re.I)
    if heading:  # the plan section wherever it is: from its heading to the next code fence
        end = text.find("```", heading.end())
        plan = text[heading.start(): end if end >= 0 else len(text)]
    return {"plan": plan.strip(), "app": app, "truncated": "</html>" not in app.lower()}


SCRIPT = re.compile(r"<script[^>]*>(.*?)</script>", re.S | re.I)


def assemble(text):
    """Exploratory, not the pre-registered score: when the extracted app carries no real script (under 200 chars of
    inline code) but the response has separate JS/CSS blocks, inline the first of each into the HTML. Repeated
    blocks are dropped. Measures what a build does once its output format is forgiven."""
    app = extract(text)["app"]
    if any(len(code.strip()) >= 200 for code in SCRIPT.findall(app)):
        return app
    blocks = [(m.group(1).strip().lower(), m.group(2).strip()) for m in FENCE.finditer(text)]
    js = next((body for lang, body in blocks if lang in ("js", "javascript")), None)
    css = next((body for lang, body in blocks if lang == "css"), None)
    if js is None:
        return app
    if css is not None:
        style = f"<style>\n{css}\n</style>"
        app = app.replace("</head>", style + "</head>", 1) if "</head>" in app else style + app
    script = f"<script>\n{js}\n</script>"
    return app.replace("</body>", script + "</body>", 1) if "</body>" in app else app + script


def summarize(scores):
    return {"mean": statistics.mean(scores), "sd": statistics.stdev(scores) if len(scores) > 1 else 0.0,
            "min": min(scores), "max": max(scores), "n": len(scores)}


def area_means(runs):
    areas = sorted({a for r in runs for a in r["areas"]})
    return {a: statistics.mean(r["areas"].get(a, 0.0) for r in runs) for a in areas}


def blind_ids(keys, rng):
    order = list(keys)
    rng.shuffle(order)
    out, used = {}, set()
    for key in order:
        bid = f"{rng.getrandbits(24):06x}"
        while bid in used:
            bid = f"{rng.getrandbits(24):06x}"
        used.add(bid)
        out[bid] = key
    return out


def seeds_of(spec):
    lo, _, hi = spec.partition("-")
    return list(range(int(lo), int(hi or lo) + 1))


def builds(runs):
    return sorted(p.parent for p in pathlib.Path(runs).glob("*/*/response.md"))


# ---------- generation ----------
def run_keep96(seeds, runs, prompt, max_tokens=32768):
    sys.path.insert(0, str(MB))
    import bestofn_tier2b as bon
    os.environ["BON_EXTRA"] = json.dumps(["--load-mode", "none", "-c", "65536"])  # harness default is b/ub 512
    bon.CFG.update(bon.CONFIGS["qwen36keep96"], budget=0)
    todo = [s for s in seeds if not (runs / "keep96" / str(s) / "response.md").exists()]
    if not todo:
        return
    log = open(runs / "keep96-server.log", "a", encoding="utf-8", errors="replace")
    proc = bon.start_server(log)
    try:
        for s in todo:
            t = time.time()
            r = bon.post("/v1/chat/completions", {
                "messages": [{"role": "user", "content": prompt}], "max_tokens": max_tokens, "temperature": 0.2,
                "top_p": 0.95, "seed": s, "cache_prompt": False, "chat_template_kwargs": {"enable_thinking": False}},
                timeout=3600)
            choice, tm = r["choices"][0], r.get("timings", {})
            meta = {"model": "keep96", "seed": s, "wall_s": round(time.time() - t, 1),
                    "finish_reason": choice.get("finish_reason"), "prompt_n": tm.get("prompt_n"),
                    "gen_n": tm.get("predicted_n"), "gen_tps": round(tm.get("predicted_per_second", 0), 1)}
            write_build(runs / "keep96" / str(s), choice["message"].get("content") or "", meta)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()


# Round two (2026-10-07, owner): every MoE tested on tier2b, at its 2026-10-04 tuned placement and speculation
# (model_pipeline.py and the final report). ncmoe is the starting placement; the fit step raises it until the model
# fits at the benchmark's window. Thinking off except gpt-oss, which keeps reasoning effort low (its best).
STAGE = pathlib.Path(r"C:\qwen3-forge-stage")
EM = pathlib.Path(r"E:\qwen3-forge\models")
BUILDS = {"master": STAGE / "tools" / "llama-master-836d57176" / "llama-server.exe",
          "xing4": STAGE / "tools" / "llama-xing4-63c16fb97" / "llama-server.exe",
          "k2h": STAGE / "tools" / "llama-k2h-50abacf42" / "llama-server.exe"}
GPTOSS = dict(spec="ngram", budget=-1, chat_kwargs={"reasoning_effort": "low"})
MODELS = {
    "qwen36full": dict(path=STAGE / "Qwen3.6-35B-A3B-UD-IQ2_M.gguf", ncmoe=22, spec="mtp"),
    "qwen36full-iq3xxs": dict(path=EM / "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf", ncmoe=26, spec="mtp"),
    "gptoss20b": dict(path=EM / "gpt-oss-20b-MXFP4.gguf", ncmoe=11, **GPTOSS),
    "gptoss20b-keep24": dict(path=EM / "gpt-oss-20b-MXFP4-keep24-selfgen.gguf", ncmoe=7, **GPTOSS),
    "gemma26b": dict(path=EM / "google_gemma-4-26B-A4B-it-IQ2_M.gguf", ncmoe=16, spec="mtp",
                     draft=EM / "mtp-gemma-4-26B-A4B-it.gguf"),
    "tiel": dict(path=EM / "Tiel-Coder-35B-A3B-MTP-UD-IQ3_XXS.gguf", ncmoe=24, spec="mtp"),
    "lfm25-8b-a1b": dict(path=pathlib.Path(r"E:\models\gguf\LFM2.5-8B-A1B-Q4_K_M.gguf"), ncmoe=0, spec="ngram"),
    "xing4": dict(path=EM / "Xing4.0-29B-A4B-IQ3_XXS.gguf", ncmoe=22, spec="none", build="xing4"),
    "k2h": dict(path=EM / "K2-Horizon-MoVA-36B-A4B-IQ3_XXS.gguf", ncmoe=30, spec="none", build="k2h",
                extra=["-ot", "attn_v_exps=CPU"]),
}
CTX = 40960  # prompt (~5k tokens) + the 32k output budget
PORT = 8095
VRAM_CAP_MIB = 8188 - 250  # absolute use, desktop included: above this, Windows spills VRAM into system RAM


def llama_args(name, ncmoe):
    m = MODELS[name]
    args = [str(BUILDS[m.get("build", "master")]), "-m", str(m["path"]), "--host", "127.0.0.1", "--port", str(PORT),
            "-ngl", "99", "--n-cpu-moe", str(ncmoe), "-c", str(CTX), "-ctk", "q8_0", "-ctv", "q8_0",
            "--flash-attn", "on", "-b", "512", "-ub", "512", "-np", "1", "--jinja",
            "--reasoning-budget", str(m.get("budget", 0)), "--no-webui", "--cache-ram", "0"]
    if m["spec"] == "mtp":
        args += ["--spec-type", "draft-mtp,ngram-mod", "--spec-draft-n-max", "2"]
        if m.get("draft"):
            args += ["-md", str(m["draft"])]
    elif m["spec"] == "ngram":
        args += ["--spec-type", "ngram-mod"]
    return args + list(m.get("extra", []))


def next_placement(ncmoe, used_mib, loaded):
    """None if the placement fits; else the next number of CPU expert layers to try."""
    if not loaded:
        return ncmoe + 4
    return None if used_mib <= VRAM_CAP_MIB else ncmoe + 2


def _post(path, payload, timeout):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def _start(args, log):
    proc = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT)
    t0 = time.time()
    while time.time() - t0 < 900:
        if proc.poll() is not None:
            return None
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2) as r:
                if r.status == 200:
                    return proc
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(2)
    _stop(proc)
    return None


def _stop(proc):
    proc.terminate()
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
    time.sleep(15)  # let the driver release VRAM before the next load


def run_llama(name, seeds, runs, prompt, max_tokens=32768, stop_file=None):
    sys.path.insert(0, str(MB))
    import moe_sweep
    m = MODELS[name]
    todo = [s for s in seeds if not (runs / name / str(s) / "response.md").exists()]
    if not todo:
        return
    if not m["path"].exists():
        raise SystemExit(f"{name}: model file missing: {m['path']}")
    log = open(runs / f"{name}-server.log", "a", encoding="utf-8", errors="replace")
    ncmoe, proc, fit = m["ncmoe"], None, []
    try:
        for _ in range(6):
            proc = _start(llama_args(name, ncmoe), log)
            used = None
            if proc:
                _post("/v1/chat/completions", {"messages": [{"role": "user", "content": "Say hi."}], "max_tokens": 16,
                                               "temperature": 0, "chat_template_kwargs": m.get("chat_kwargs") or
                                               {"enable_thinking": False}}, 600)
                used = moe_sweep.vram_used_mib()
            fit.append({"ncmoe": ncmoe, "loaded": bool(proc), "vram_used_mib": used})
            nxt = next_placement(ncmoe, used, bool(proc))
            print(f"{time.strftime('%H:%M:%S')} {name}: ncmoe {ncmoe} loaded {bool(proc)} VRAM {used} MiB", flush=True)
            if nxt is None:
                break
            if proc:
                _stop(proc)
                proc = None
            ncmoe = nxt
        if proc is None:
            raise SystemExit(f"{name}: no placement fits ({fit})")
        for s in todo:
            if stop_file and pathlib.Path(stop_file).exists():
                print("stop file found", flush=True)
                return
            t = time.time()
            r = _post("/v1/chat/completions", {
                "messages": [{"role": "user", "content": prompt}], "max_tokens": max_tokens, "temperature": 0.2,
                "top_p": 0.95, "seed": s, "cache_prompt": False,
                "chat_template_kwargs": m.get("chat_kwargs") or {"enable_thinking": False}}, 4000)
            choice, tm = r["choices"][0], r.get("timings", {})
            msg = choice.get("message") or {}
            meta = {"model": name, "file": m["path"].name, "seed": s, "ncmoe": ncmoe, "fit": fit,
                    "wall_s": round(time.time() - t, 1), "finish_reason": choice.get("finish_reason"),
                    "prompt_n": tm.get("prompt_n"), "gen_n": tm.get("predicted_n"),
                    "gen_tps": round(tm.get("predicted_per_second", 0), 1),
                    "has_reasoning": bool(msg.get("reasoning_content")), "ram_avail_gb": moe_sweep.ram_avail_gb()}
            d = runs / name / str(s)
            write_build(d, msg.get("content") or "", meta)
            if msg.get("reasoning_content"):
                (d / "reasoning.md").write_text(msg["reasoning_content"], encoding="utf-8")
    finally:
        if proc:
            _stop(proc)
        log.close()


def run_deepseek(seeds, runs, prompt, max_tokens=32768):
    import deepseek
    key = deepseek.read_key()
    model = deepseek.pick_model(key)
    for s in seeds:
        if (runs / "deepseek" / str(s) / "response.md").exists():
            continue
        t = time.time()
        r = deepseek.chat(key, model, [{"role": "user", "content": prompt}], temperature=0.2, max_tokens=max_tokens)
        usage = r.get("usage") or {}
        meta = {"model": r["model"], "seed": s, "wall_s": round(time.time() - t, 1), "finish_reason": r["finish_reason"],
                "prompt_n": usage.get("prompt_tokens"), "gen_n": usage.get("completion_tokens"),
                "max_tokens": r["max_tokens"], "has_reasoning": bool(r["reasoning"])}
        meta["gen_tps"] = round(meta["gen_n"] / meta["wall_s"], 1) if meta["gen_n"] else None
        d = runs / "deepseek" / str(s)
        write_build(d, r["content"], meta)
        if r["reasoning"]:
            (d / "reasoning.md").write_text(r["reasoning"], encoding="utf-8")


def write_build(d, content, meta):
    d.mkdir(parents=True, exist_ok=True)
    (d / "response.md").write_text(content, encoding="utf-8")
    (d / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print(f"{time.strftime('%H:%M:%S')} {d.parent.name}/{d.name}: {meta.get('gen_n')} tokens in {meta['wall_s']} s, "
          f"finish {meta.get('finish_reason')}", flush=True)


# ---------- checking ----------
EXTERNAL = re.compile(r"""(?:src|href)\s*=\s*["']?(?:https?:)?//""", re.I)


def check(runs, params, set_name, shots, assembled=False, only=""):
    for d in builds(runs):
        if only and d.parent.name != only:
            continue
        text = (d / "response.md").read_text(encoding="utf-8")
        ex = extract(text)
        (d / "plan.md").write_text(ex["plan"], encoding="utf-8")
        (d / "app.html").write_text(ex["app"], encoding="utf-8")
        app_file, suffix = d / "app.html", ""
        if assembled:  # exploratory: the format forgiven (see assemble)
            app_file, suffix = d / "app-assembled.html", "-assembled"
            app_file.write_text(assemble(text), encoding="utf-8")
            shots = False
        meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        static = {"truncated": ex["truncated"], "app_bytes": len(ex["app"].encode()), "app_lines": ex["app"].count("\n") + 1,
                  "external_refs": len(EXTERNAL.findall(ex["app"])), "plan_words": len(ex["plan"].split()),
                  "gen_n": meta.get("gen_n"), "gen_tps": meta.get("gen_tps"), "wall_s": meta.get("wall_s"),
                  "finish_reason": meta.get("finish_reason")}
        out = d / f"checks-{set_name}{suffix}.json"
        cmd = ["node", str(LAB / "checks.mjs"), "--app", str(app_file), "--ref", str(LAB / "reference.html"),
               "--params", str(params), "--out", str(out)]
        if shots:
            cmd += ["--shots", str(d / "shots")]
        r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True, timeout=1800)
        if out.exists():
            res = json.loads(out.read_text(encoding="utf-8"))
            static["console_errors"] = len(res.get("console_errors", []))
            static["blocked_requests"] = res.get("blocked_requests")
        if not assembled:
            (d / "static.json").write_text(json.dumps(static, indent=1), encoding="utf-8")
        print(f"{d.parent.name}/{d.name}: {(r.stdout.strip().splitlines() or [r.stderr.strip()[-200:]])[-1]}", flush=True)


# ---------- blinding and report ----------
def blind(runs, out, map_path, seed=None):
    keys = [f"{d.parent.name}/{d.name}" for d in builds(runs)]
    mapping = blind_ids(keys, random.Random(seed if seed is not None else int.from_bytes(os.urandom(8), "big")))
    out = pathlib.Path(out)
    for bid, key in mapping.items():
        src, dst = pathlib.Path(runs) / key, out / bid
        dst.mkdir(parents=True, exist_ok=True)
        for name in ("plan.md", "app.html"):
            shutil.copy(src / name, dst / name)
        if (src / "shots").exists():
            shutil.copytree(src / "shots", dst / "shots", dirs_exist_ok=True)
    pathlib.Path(map_path).write_text(json.dumps(mapping, indent=1), encoding="utf-8")
    print(f"{len(mapping)} builds blinded into {out}; order: {', '.join(mapping)}")


def report(runs, map_path, judge_path, out, set_name="dev"):
    mapping = json.loads(pathlib.Path(map_path).read_text(encoding="utf-8")) if map_path else {}
    judge = json.loads(pathlib.Path(judge_path).read_text(encoding="utf-8")) if judge_path else {}
    by_key = {v: judge.get(k) for k, v in mapping.items()}
    models = {}
    for d in builds(runs):
        key = f"{d.parent.name}/{d.name}"
        chk = json.loads((d / f"checks-{set_name}.json").read_text(encoding="utf-8"))
        static = json.loads((d / "static.json").read_text(encoding="utf-8"))
        models.setdefault(d.parent.name, []).append({"key": key, "score": chk["score"], "areas": chk["areas"],
                                                      "passed": chk["passed"], "total": chk["total"],
                                                      "static": static, "judge": by_key.get(key)})
    lines = [f"# One-shot benchmark report ({set_name} checks)", ""]
    for model, rs in sorted(models.items()):
        s = summarize([r["score"] for r in rs])
        lines += [f"## {model}", "", f"Check score: mean {s['mean']:.3f}, sd {s['sd']:.3f}, range {s['min']:.3f}–{s['max']:.3f}, n {s['n']}", "",
                  "| Area | " + " | ".join(area_means(rs)) + " |", "|---|" + "---|" * len(area_means(rs)),
                  "| mean | " + " | ".join(f"{v:.2f}" for v in area_means(rs).values()) + " |", "",
                  "| Build | Score | Passed | Truncated | Tokens | tok/s | Wall s | Console errors | Plan | Code | Product |",
                  "|---|---|---|---|---|---|---|---|---|---|---|"]
        for r in rs:
            j, st = r["judge"] or {}, r["static"]
            tot = lambda part: sum(v["score"] for k, v in j.items() if k.startswith(part)) if j else ""
            lines.append(f"| {r['key']} | {r['score']:.3f} | {r['passed']}/{r['total']} | {st['truncated']} | {st['gen_n']} | "
                         f"{st['gen_tps']} | {st['wall_s']} | {st.get('console_errors')} | {tot('P')} | {tot('C')} | {tot('D')} |")
        lines.append("")
    pathlib.Path(out).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--model", choices=["keep96", "deepseek"] + sorted(MODELS), required=True)
    r.add_argument("--stop-file", default="")
    r.add_argument("--seeds", default="1-5")
    r.add_argument("--runs", required=True)
    r.add_argument("--max-tokens", type=int, default=32768,
                   help="output budget; for a reasoning model it includes the reasoning (deepseek round 1: 65536)")
    c = sub.add_parser("check")
    c.add_argument("--runs", required=True)
    c.add_argument("--params", required=True)
    c.add_argument("--set", default="dev")
    c.add_argument("--shots", action="store_true")
    c.add_argument("--assembled", action="store_true", help="exploratory: check the format-forgiven app")
    c.add_argument("--only", default="", help="one model's builds")
    b = sub.add_parser("blind")
    b.add_argument("--runs", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--map", required=True)
    p = sub.add_parser("report")
    p.add_argument("--runs", required=True)
    p.add_argument("--map", default="")
    p.add_argument("--judge", default="")
    p.add_argument("--set", default="dev")
    p.add_argument("--out", required=True)
    a = ap.parse_args()
    if a.cmd == "run":
        runs = pathlib.Path(a.runs)
        runs.mkdir(parents=True, exist_ok=True)
        prompt = (LAB / "prompt.md").read_text(encoding="utf-8")
        if a.model in MODELS:
            run_llama(a.model, seeds_of(a.seeds), runs, prompt, a.max_tokens, a.stop_file)
        else:
            (run_keep96 if a.model == "keep96" else run_deepseek)(seeds_of(a.seeds), runs, prompt, a.max_tokens)
    elif a.cmd == "check":
        check(a.runs, a.params, a.set, a.shots, a.assembled, a.only)
    elif a.cmd == "blind":
        blind(a.runs, a.out, a.map)
    else:
        report(a.runs, a.map, a.judge, a.out, a.set)


if __name__ == "__main__":
    main()
