"""Short / Late / Early long-session runs on keep96, their report, and bar (a) (2026-10-07).
Spec: docs/superpowers/specs/2026-10-07-long-context-design.md §3-§6.

run     one llama-server at --window for the given conditions (short, late, early). Each sample is the recipe's
        candidate 0 (seed = trial, temperature 0.2, thinking off, 2,048 tokens), graded by the task's own test. A
        session with Late or Early counts every filler unit with the server's /tokenize (cached in --counts) and
        builds filler t with seed t + 1. Trials are the outer loop, so Late reuses filler t across the 39 tasks.
        Rows resume per (cond, window, target, task, trial). Exit 0 complete, 2 RAM guard, 3 stop file.
report  per window and target: solved by condition and category, Late and Early against Short (exact McNemar on
        samples, exact sign test on tasks), bar (b), prompt time; Short against the stored 16k candidate 0.
query   one word for the chain: ctk:W, target:W, top, barb:W, bara:W, chosen.
bar-a   the recipe at a window against the stored 16k recipe run (paired, the same seeds).

usage: longctx_sessions.py run --window W --target T --conds short,late --out RUNS.jsonl --counts COUNTS.json
                               [--extra JSON] [--trials 3] [--tasks 0] [--min-free-mb 2048] [--stop-file F]
       longctx_sessions.py report --runs RUNS.jsonl --stored RECIPE16K.jsonl --out REPORT.json
       longctx_sessions.py query --verdict GRID.verdict.json --report REPORT.json --bar-a-dir DIR WHAT
       longctx_sessions.py bar-a --stored RECIPE16K.jsonl --new RECIPE_W.jsonl --out BAR_A.json
"""
import argparse
import collections
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bestofn_tier2b as bon  # noqa: E402
import longctx_build as lb  # noqa: E402
import moe_sweep  # noqa: E402
from bestofn_tier2b import TASKS, extract_code, run_test, seed  # noqa: E402
from pair_bestofn import outcomes  # noqa: E402
from playbook import mcnemar_p, task_sign  # noqa: E402

TARGETS = {32768: 28000, 65536: 56000, 98304: 86000, 131072: 116000}  # filler tokens per window
CONDS = ("short", "late", "early")
P_BAR = 0.10
EXPECTED = 117  # 39 tier2b tasks x 3 trials


def tokenize(text):
    return len(bon.post("/tokenize", {"content": text})["tokens"])


def unit_counts(units, path, count=tokenize):
    """uid -> tokens, cached in path under uid#sha1, so a changed unit is counted again."""
    cache = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    out = {}
    for uid, msgs in units:
        key = uid + "#" + hashlib.sha1(json.dumps(msgs).encode()).hexdigest()[:10]
        if key not in cache:
            cache[key] = lb.unit_tokens(msgs, count)
        out[uid] = cache[key]
    path.write_text(json.dumps(cache, sort_keys=True), encoding="utf-8")
    return out


def chat(msgs, trial):
    """The recipe's candidate 0 (bestofn_tier2b.chat with budget 0) on a whole message list."""
    t = time.time()
    r = bon.post("/v1/chat/completions", {"messages": msgs, "max_tokens": 2048, "temperature": 0.2, "top_p": 0.95,
                                          "seed": trial, "cache_prompt": True,
                                          "chat_template_kwargs": {"enable_thinking": False}}, timeout=1800)
    tm = r.get("timings", {})
    return r["choices"][0]["message"].get("content") or "", {
        "prompt_n": tm.get("prompt_n"), "cache_n": tm.get("cache_n"), "prompt_ms": round(tm.get("prompt_ms", 0)),
        "gen_n": tm.get("predicted_n"), "gen_ms": round(tm.get("predicted_ms", 0)),
        "wall_s": round(time.time() - t, 2)}


def grade(task, content):
    g = pathlib.Path(tempfile.mkdtemp(prefix="lc-grade-"))
    try:
        seed(g, task)
        (g / task["entry"]).write_text(extract_code(content), encoding="utf-8")
        return run_test(g, task["test"])
    finally:
        shutil.rmtree(g, ignore_errors=True)


def session(cond, task, filler):
    if cond == "short":
        return lb.short(task)
    return lb.late(task, filler) if cond == "late" else lb.early(task, filler)


def key_of(r):
    return (r["cond"], r["window"], r["target"], r["task"], r["trial"])


def load_rows(path):
    latest = {}
    if pathlib.Path(path).exists():
        for line in open(path, encoding="utf-8"):
            if line.strip():
                r = json.loads(line)
                latest[key_of(r)] = r
    return latest


def stop(proc, log):
    proc.terminate()
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
    log.close()


def run(a):
    conds = a.conds.split(",")
    if not set(conds) <= set(CONDS):
        sys.exit(f"unknown condition in {conds}")
    os.environ["BON_EXTRA"] = json.dumps(["--load-mode", "none", "-c", str(a.window)] + json.loads(a.extra))
    bon.CFG.update(bon.CONFIGS["qwen36keep96"], budget=0)
    out = pathlib.Path(a.out)
    done = load_rows(out)
    tasks = TASKS[: a.tasks] if a.tasks else TASKS
    log = open(out.with_suffix(".server.log"), "a", encoding="utf-8", errors="replace")
    proc = bon.start_server(log)
    try:
        free = int(moe_sweep.ram_avail_gb() * 1000)
        if free < a.min_free_mb:
            print(f"only {free} MB available; the guard is {a.min_free_mb}", flush=True)
            return 2
        fillers = {}
        if conds != ["short"]:
            units = lb.all_units()
            by_id = dict(units)
            counts = unit_counts(units, pathlib.Path(a.counts))
            man = out.with_name(out.stem + ".fillers.json")
            manifest = json.loads(man.read_text(encoding="utf-8")) if man.exists() else {}
            for trial in range(a.trials):
                uids, total = lb.build_filler(list(by_id), counts, a.target, trial + 1)
                fillers[trial] = lb.messages(by_id, uids)
                manifest[f"{a.window}/{a.target}/{trial}"] = {"tokens_est": total, "units": uids}
            man.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
        with out.open("a", encoding="utf-8") as f:
            for cond in conds:
                target = 0 if cond == "short" else a.target
                for trial in range(a.trials):
                    for task in tasks:
                        if (cond, a.window, target, task["name"], trial) in done:
                            continue
                        if a.stop_file and pathlib.Path(a.stop_file).exists():
                            print("stop file found", flush=True)
                            return 3
                        content, tm = chat(session(cond, task, fillers.get(trial)), trial)
                        ok, detail = grade(task, content)
                        row = {"cond": cond, "window": a.window, "target": target, "extra": a.extra,
                               "task": task["name"], "category": task["category"], "trial": trial, **tm,
                               "graded_ok": ok, "graded_detail": detail, "content": content}
                        f.write(json.dumps(row) + "\n")
                        f.flush()
                        print(f"{time.strftime('%H:%M:%S')} {cond} w{a.window} t{trial} {task['name']}: "
                              f"{'PASS' if ok else 'fail'}; read {tm['prompt_n']} in {tm['prompt_ms'] / 1000:.1f} s "
                              f"(cached {tm['cache_n']}); {tm['wall_s']} s", flush=True)
        return 0
    finally:
        stop(proc, log)


def cat_counts(rows):
    return dict(sorted(collections.Counter(r["category"] for r in rows if r["graded_ok"]).items()))


def mean(vals):
    vals = [v for v in vals if v is not None]
    return round(sum(vals) / len(vals), 1) if vals else None


def paired(short, other):
    keys = sorted(set(short) & set(other))
    pairs = [(k[0], bool(short[k]["graded_ok"]), bool(other[k]["graded_ok"])) for k in keys]
    s_only = sum(a and not b for _, a, b in pairs)
    o_only = sum(b and not a for _, a, b in pairs)
    s_tasks, o_tasks, p = task_sign(pairs)
    return {"n": len(keys), "short_only": s_only, "cond_only": o_only, "mcnemar_p": round(mcnemar_p(s_only, o_only), 4),
            "short_tasks": s_tasks, "cond_tasks": o_tasks, "sign_p": round(p, 4)}


def vs_stored(short, stored):
    keys = sorted(set(short) & set(stored))
    return {"n": len(keys),
            "same_text": sum(short[k]["content"] == stored[k]["content"] for k in keys),
            "same_grade": sum(bool(short[k]["graded_ok"]) == bool(stored[k]["graded_ok"]) for k in keys),
            "stored_solved": sum(bool(stored[k]["graded_ok"]) for k in keys),
            "short_solved": sum(bool(short[k]["graded_ok"]) for k in keys)}


def summarize(rows, stored=None, expected=EXPECTED):
    """rows: key_of -> row. One group per (window, Late/Early target), each against Short at the same window."""
    shorts, groups = collections.defaultdict(dict), collections.defaultdict(dict)
    for r in rows.values():
        k = (r["task"], r["trial"])
        if r["cond"] == "short":
            shorts[r["window"]][k] = r
        else:
            groups[(r["window"], r["target"])].setdefault(r["cond"], {})[k] = r
    rep = {}
    for (w, t), by in sorted(groups.items()):
        g = {"window": w, "target": t, "n": {}, "solved": {}, "by_category": {}, "prompt_s_mean": {},
             "prompt_n_mean": {}, "cache_n_mean": {}}
        for cond, rs in [("short", shorts.get(w, {}))] + [(c, by[c]) for c in ("late", "early") if c in by]:
            g["n"][cond] = len(rs)
            g["solved"][cond] = sum(bool(r["graded_ok"]) for r in rs.values())
            g["by_category"][cond] = cat_counts(rs.values())
            g["prompt_s_mean"][cond] = mean(r["prompt_ms"] / 1000 for r in rs.values())
            g["prompt_n_mean"][cond] = mean(r["prompt_n"] for r in rs.values())
            g["cache_n_mean"][cond] = mean(r.get("cache_n") for r in rs.values())
            if cond != "short":
                g[f"{cond}_vs_short"] = paired(shorts.get(w, {}), rs)
        g["complete"] = g["n"]["short"] >= expected and g["n"].get("late", 0) >= expected
        lv = g.get("late_vs_short")
        g["bar_b_pass"] = bool(g["complete"] and lv
                               and not (lv["short_tasks"] > lv["cond_tasks"] and lv["sign_p"] < P_BAR))
        rep[f"{w}/{t}"] = g
    if stored is not None:
        rep["short_vs_stored"] = {str(w): vs_stored(s, stored) for w, s in sorted(shorts.items())}
    return rep


def answer(what, verdict, report, bar_a_pass):
    kind, _, arg = what.partition(":")
    ctk = {int(w): k for w, k in verdict["ctk"].items()}
    done = {g["window"]: g for g in report.values()
            if isinstance(g, dict) and "window" in g and g.get("target") == TARGETS.get(g["window"])
            and g.get("complete")}
    if kind == "ctk":
        return ctk.get(int(arg), "none")
    if kind == "target":
        return str(TARGETS[int(arg)])
    if kind == "top":
        fits = [w for w in ctk if w in TARGETS]
        return str(max(fits)) if fits else "none"
    if kind == "barb":
        g = done.get(int(arg))
        return "missing" if g is None else "pass" if g["bar_b_pass"] else "fail"
    if kind == "bara":
        p = bar_a_pass.get(int(arg))
        return "missing" if p is None else "pass" if p else "fail"
    if kind == "chosen":
        ok = [w for w, g in done.items() if g["bar_b_pass"] and bar_a_pass.get(w)]
        return str(max(ok)) if ok else "none"
    raise ValueError(what)


def bar_a(stored, new):
    """stored, new: pair_bestofn.outcomes of two recipe runs on the same seeds."""
    keys = sorted(set(stored) & set(new))
    pairs = [(k[0], stored[k]["recipe"], new[k]["recipe"]) for k in keys]
    s_only = sum(a and not b for _, a, b in pairs)
    n_only = sum(b and not a for _, a, b in pairs)
    s_tasks, n_tasks, p = task_sign(pairs)
    return {"n": len(keys), "stored_solved": sum(a for _, a, _ in pairs), "new_solved": sum(b for _, _, b in pairs),
            "stored_only": s_only, "new_only": n_only, "mcnemar_p": round(mcnemar_p(s_only, n_only), 4),
            "stored_tasks": s_tasks, "new_tasks": n_tasks, "sign_p": round(p, 4),
            "pass": not (s_tasks > n_tasks and p < P_BAR)}


def cand_texts(path):
    out = {}
    for line in open(path, encoding="utf-8"):
        r = json.loads(line)
        if r.get("type") == "cand":
            out[(r["task"], r["trial"], r["cand"])] = r
    return out


def stored_cand0(path):
    return {(k[0], k[1]): {"content": r["content"], "graded_ok": r["graded_ok"]}
            for k, r in cand_texts(path).items() if k[2] == 0}


def print_report(rep):
    for k, g in rep.items():
        if k == "short_vs_stored":
            print(f"Short against the stored 16k candidate 0: {g}")
            continue
        print(f"window {g['window']}, filler {g['target']}: solved {g['solved']} of {g['n']}; "
              f"prompt s {g['prompt_s_mean']}; cached tokens {g['cache_n_mean']}")
        for cond in ("late", "early"):
            v = g.get(f"{cond}_vs_short")
            if v:
                print(f"  {cond} vs short: samples {v['cond_only']} vs {v['short_only']} (McNemar p {v['mcnemar_p']}),"
                      f" tasks {v['cond_tasks']} vs {v['short_tasks']} (sign p {v['sign_p']})")
        print(f"  complete {g['complete']}; bar (b) {'PASS' if g['bar_b_pass'] else 'not passed'}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--window", type=int, required=True)
    r.add_argument("--target", type=int, default=0)
    r.add_argument("--conds", default="short,late")
    r.add_argument("--out", required=True)
    r.add_argument("--counts", required=True)
    r.add_argument("--extra", default="[]")
    r.add_argument("--trials", type=int, default=3)
    r.add_argument("--tasks", type=int, default=0)
    r.add_argument("--min-free-mb", type=int, default=2048)
    r.add_argument("--stop-file", default="")
    p = sub.add_parser("report")
    p.add_argument("--runs", required=True)
    p.add_argument("--stored", required=True)
    p.add_argument("--out", required=True)
    q = sub.add_parser("query")
    q.add_argument("--verdict", required=True)
    q.add_argument("--report", required=True)
    q.add_argument("--bar-a-dir", required=True)
    q.add_argument("what")
    b = sub.add_parser("bar-a")
    b.add_argument("--stored", required=True)
    b.add_argument("--new", required=True)
    b.add_argument("--out", required=True)
    a = ap.parse_args()
    if a.cmd == "run":
        sys.exit(run(a))
    if a.cmd == "report":
        rep = summarize(load_rows(a.runs), stored_cand0(a.stored))
        pathlib.Path(a.out).write_text(json.dumps(rep, indent=1), encoding="utf-8")
        print_report(rep)
    elif a.cmd == "query":
        rp = pathlib.Path(a.report)
        rep = json.loads(rp.read_text(encoding="utf-8")) if rp.exists() else {}
        bars = {int(f.stem.rsplit("-", 1)[1]): json.loads(f.read_text(encoding="utf-8"))["pass"]
                for f in pathlib.Path(a.bar_a_dir).glob("bar-a-*.json")}
        print(answer(a.what, json.loads(pathlib.Path(a.verdict).read_text(encoding="utf-8")), rep, bars))
    else:
        res = bar_a(outcomes(a.stored), outcomes(a.new))
        res["complete"] = res["n"] >= EXPECTED
        res["pass"] = res["pass"] and res["complete"]
        old, new = cand_texts(a.stored), cand_texts(a.new)
        keys = set(old) & set(new)
        res["answers"] = {"n": len(keys), "identical": sum(old[k]["content"] == new[k]["content"] for k in keys)}
        pathlib.Path(a.out).write_text(json.dumps(res, indent=1), encoding="utf-8")
        print(json.dumps(res))


if __name__ == "__main__":
    main()
