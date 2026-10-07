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
    return {"plan": plan.strip(), "app": app, "truncated": "</html>" not in app.lower()}


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
def run_keep96(seeds, runs, prompt):
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
                "messages": [{"role": "user", "content": prompt}], "max_tokens": 32768, "temperature": 0.2,
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


def run_deepseek(seeds, runs, prompt):
    import deepseek
    key = deepseek.read_key()
    model = deepseek.pick_model(key)
    for s in seeds:
        if (runs / "deepseek" / str(s) / "response.md").exists():
            continue
        t = time.time()
        r = deepseek.chat(key, model, [{"role": "user", "content": prompt}], temperature=0.2, max_tokens=32768)
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


def check(runs, params, set_name, shots):
    for d in builds(runs):
        ex = extract((d / "response.md").read_text(encoding="utf-8"))
        (d / "plan.md").write_text(ex["plan"], encoding="utf-8")
        (d / "app.html").write_text(ex["app"], encoding="utf-8")
        meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        static = {"truncated": ex["truncated"], "app_bytes": len(ex["app"].encode()), "app_lines": ex["app"].count("\n") + 1,
                  "external_refs": len(EXTERNAL.findall(ex["app"])), "plan_words": len(ex["plan"].split()),
                  "gen_n": meta.get("gen_n"), "gen_tps": meta.get("gen_tps"), "wall_s": meta.get("wall_s"),
                  "finish_reason": meta.get("finish_reason")}
        out = d / f"checks-{set_name}.json"
        cmd = ["node", str(LAB / "checks.mjs"), "--app", str(d / "app.html"), "--ref", str(LAB / "reference.html"),
               "--params", str(params), "--out", str(out)]
        if shots:
            cmd += ["--shots", str(d / "shots")]
        r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True, timeout=1800)
        if out.exists():
            res = json.loads(out.read_text(encoding="utf-8"))
            static["console_errors"] = len(res.get("console_errors", []))
            static["blocked_requests"] = res.get("blocked_requests")
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
    r.add_argument("--model", choices=["keep96", "deepseek"], required=True)
    r.add_argument("--seeds", default="1-5")
    r.add_argument("--runs", required=True)
    c = sub.add_parser("check")
    c.add_argument("--runs", required=True)
    c.add_argument("--params", required=True)
    c.add_argument("--set", default="dev")
    c.add_argument("--shots", action="store_true")
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
        (run_keep96 if a.model == "keep96" else run_deepseek)(seeds_of(a.seeds), runs, prompt)
    elif a.cmd == "check":
        check(a.runs, a.params, a.set, a.shots)
    elif a.cmd == "blind":
        blind(a.runs, a.out, a.map)
    else:
        report(a.runs, a.map, a.judge, a.out, a.set)


if __name__ == "__main__":
    main()
