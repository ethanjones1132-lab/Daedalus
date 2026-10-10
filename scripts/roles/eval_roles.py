"""Role gates (spec section 4): build, plan and fix, adapter versus plain base, on the held-out fields.
Tasks are the held-out seeds the teacher solved (request, tests, entry, the teacher's plan). Phases write JSONL under
--work/<size>/<split>/ and resume. Pass rule per role: adapter minus base >= +5 points and exact one-sided McNemar p < 0.10.
usage:
  eval_roles.py baseline     --size 4B --split dev|test --work DIR --data E:/AI/teacher-data/gen-v0
  eval_roles.py plan-adapter --size 4B --split dev --work DIR --data ... --name NAME --lora X.gguf
  eval_roles.py build-adapter ... / fix-adapter ...
  eval_roles.py report       --size 4B --split dev --work DIR --plan NAME --build NAME --fix NAME"""
import argparse
import concurrent.futures
import json
import pathlib
import random
import sys
from math import comb

HERE = pathlib.Path(__file__).resolve().parent
for p in (HERE, HERE.parent / "teacher", HERE.parent / "moe-bench"):
    sys.path.insert(0, str(p))
import compare_tasks as ct  # noqa: E402
import edits  # noqa: E402
import llama_server  # noqa: E402
import samples  # noqa: E402
import teacher_gen as tg  # noqa: E402

BASES = {"9B": "E:/models/gguf/unsloth-Qwen3.5-9B-Q5_K_M.gguf", "4B": "E:/AI/role-adapters/gguf/Qwen3.5-4B-Q5_K_M.gguf",
         "2B": "E:/AI/role-adapters/gguf/Qwen3.5-2B-Q5_K_M.gguf"}
MAX_TOKENS = {"plan": 2048, "build": 6144, "fix": 6144}
MIN_GAIN, MAX_P = 0.05, 0.10


def p_one_sided(b, c):
    """Exact one-sided McNemar: P(X >= b) for X ~ Binomial(b + c, 0.5), H1 = the adapter is better."""
    n = b + c
    return 1.0 if n == 0 else sum(comb(n, k) for k in range(b, n + 1)) / 2 ** n


def gate(adapter, base, seed=0):
    ids = sorted(set(adapter) & set(base))
    a, b = [bool(adapter[i]) for i in ids], [bool(base[i]) for i in ids]
    n = len(ids)
    b10 = sum(x and not y for x, y in zip(a, b))
    b01 = sum(y and not x for x, y in zip(a, b))
    rng, diffs = random.Random(seed), []
    for _ in range(2000):
        pick = [rng.randrange(n) for _ in range(n)]
        diffs.append(sum(a[i] - b[i] for i in pick) / n)
    diffs.sort()
    diff = (sum(a) - sum(b)) / n
    p = p_one_sided(b10, b01)
    return {"n": n, "adapter_pass": sum(a), "base_pass": sum(b), "diff": round(diff, 4), "adapter_only": b10,
            "base_only": b01, "p": round(p, 4), "ci90": [round(diffs[100], 4), round(diffs[1899], 4)],
            "passed": diff >= MIN_GAIN and p < MAX_P}


def load_tasks(runs_path, split, cap=None):
    seen, out = set(), []
    for r in samples.read_jsonl(runs_path):
        if samples.split_of_rec(r) != split or not (r.get("build_ok") or r.get("fix_ok")) or not r.get("plan"):
            continue
        sid = samples.sid_of(r)
        if sid not in seen:
            seen.add(sid)
            out.append({"sid": sid, "lang": r["lang"], "request": r["request"], "entry": r["entry"],
                        "tests": r["tests"], "plan": r["plan"]})
    out.sort(key=lambda t: t["sid"])
    return out[:cap] if cap else out


def run_phase(path, items, fn, workers):
    path = pathlib.Path(path)
    done = {r["sid"] for r in samples.read_jsonl(path)}
    todo = [t for t in items if t["sid"] not in done]
    with concurrent.futures.ThreadPoolExecutor(workers) as ex, open(path, "a", encoding="utf-8") as f:
        for row in ex.map(fn, todo):
            f.write(json.dumps(row) + "\n")
            f.flush()
    return {r["sid"]: r for r in samples.read_jsonl(path)}


def plan_fn(server):
    def fn(t):
        r = server.chat(samples.chat_messages(ct.PLAN_PROMPT.format(request=t["request"])), MAX_TOKENS["plan"])
        return {"sid": t["sid"], "plan": r["text"], "finish": r["finish"]}
    return fn


def build_fn(server, plans):
    def fn(t):
        user = tg.BUILD_FROM_PLAN_PROMPT.format(request=t["request"], plan=plans[t["sid"]])
        r = server.chat(samples.chat_messages(user), MAX_TOKENS["build"])
        files = tg.extract_files(r["text"], t["entry"])
        ok, out = tg.run_tests(t["lang"], files, t["tests"]) if files else (False, "no files")
        return {"sid": t["sid"], "ok": ok, "out": out, "text": r["text"], "finish": r["finish"]}
    return fn


def fix_fn(server, failing, edit=True):
    """One fix round. edit=True: the edit-block prompt and reply (the role adapters' format); edit=False: the full-file
    prompt and reply (the base model's natural format, the other baseline)."""
    def fn(t):
        row = failing[t["sid"]]
        files = tg.extract_files(row["text"], t["entry"])
        shown = samples.show_files(files) if files else "(no files were produced)"
        template = samples.FIX_EDIT_PROMPT if edit else ct.FIX_PROMPT
        user = template.format(request=t["request"], files=shown, failures=samples.FAILED + row["out"])
        r = server.chat(samples.chat_messages(user), MAX_TOKENS["fix"] if not edit else 2048)
        if edit:
            fixed, err = edits.apply_edits(files, r["text"]) if files else (files, "no files")
        else:
            fixed, err = tg.extract_files(r["text"], t["entry"]) or files, None
        ok, out = tg.run_tests(t["lang"], fixed, t["tests"]) if fixed and err is None else (False, err or "no files")
        return {"sid": t["sid"], "ok": ok, "out": out, "finish": r["finish"]}
    return fn


def teacher_plans(tasks):
    return {t["sid"]: t["plan"] for t in tasks}


def srv(a, lora=None):
    return llama_server.Server(BASES[a.size], lora=lora, log_path=f"{a.work}/{a.size}-server.log")


def paths(a):
    d = pathlib.Path(a.work) / a.size / a.split
    d.mkdir(parents=True, exist_ok=True)
    return lambda name: d / f"{name}.jsonl"


def cmd_baseline(a):
    tasks, P = load_tasks(pathlib.Path(a.data) / "runs.jsonl", a.split, a.cap), paths(a)
    with srv(a) as s:
        plans = run_phase(P("plans-base"), tasks, plan_fn(s), s.parallel)
        run_phase(P("builds-base-from-teacher"), tasks, build_fn(s, teacher_plans(tasks)), s.parallel)
        run_phase(P("builds-base-from-base"), tasks, build_fn(s, {k: v["plan"] for k, v in plans.items()}), s.parallel)
        failing = {sid: r for sid, r in samples_map(P("builds-base-from-teacher")).items() if not r["ok"]}
        todo = [t for t in tasks if t["sid"] in failing]
        run_phase(P("fixes-base"), todo, fix_fn(s, failing, edit=False), s.parallel)
        run_phase(P("fixes-base-edit"), todo, fix_fn(s, failing, edit=True), s.parallel)


def samples_map(path):
    return {r["sid"]: r for r in samples.read_jsonl(path)}


def cmd_plan_adapter(a):
    tasks, P = load_tasks(pathlib.Path(a.data) / "runs.jsonl", a.split, a.cap), paths(a)
    with srv(a, a.lora) as s:
        plans = run_phase(P(f"plans-{a.name}"), tasks, plan_fn(s), s.parallel)
    with srv(a) as s:
        run_phase(P(f"builds-base-from-{a.name}"), tasks, build_fn(s, {k: v["plan"] for k, v in plans.items()}), s.parallel)


def cmd_build_adapter(a):
    tasks, P = load_tasks(pathlib.Path(a.data) / "runs.jsonl", a.split, a.cap), paths(a)
    with srv(a, a.lora) as s:
        run_phase(P(f"builds-{a.name}-from-teacher"), tasks, build_fn(s, teacher_plans(tasks)), s.parallel)


def cmd_fix_adapter(a):
    tasks, P = load_tasks(pathlib.Path(a.data) / "runs.jsonl", a.split, a.cap), paths(a)
    failing = {sid: r for sid, r in samples_map(P("builds-base-from-teacher")).items() if not r["ok"]}
    with srv(a, a.lora) as s:
        run_phase(P(f"fixes-{a.name}"), [t for t in tasks if t["sid"] in failing], fix_fn(s, failing), s.parallel)


def cmd_report(a):
    P = paths(a)
    ok = lambda name: {sid: r["ok"] for sid, r in samples_map(P(name)).items()}  # noqa: E731
    res = {"size": a.size, "split": a.split,
           "build": gate(ok(f"builds-{a.build}-from-teacher"), ok("builds-base-from-teacher")),
           "plan": gate(ok(f"builds-base-from-{a.plan}"), ok("builds-base-from-base")),
           "fix": gate(ok(f"fixes-{a.fix}"), ok("fixes-base")),
           "fix_vs_base_edit_format": gate(ok(f"fixes-{a.fix}"), ok("fixes-base-edit"))}
    (pathlib.Path(a.work) / a.size / f"gates-{a.split}-{a.plan}-{a.build}-{a.fix}.json").write_text(
        json.dumps(res, indent=1), encoding="utf-8")
    print(json.dumps(res, indent=1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["baseline", "plan-adapter", "build-adapter", "fix-adapter", "report"])
    ap.add_argument("--size", required=True, choices=list(BASES))
    ap.add_argument("--split", required=True, choices=["dev", "test"])
    ap.add_argument("--work", required=True)
    ap.add_argument("--data", default="E:/AI/teacher-data/gen-v0")
    ap.add_argument("--cap", type=int, default=0)
    ap.add_argument("--name", default="")
    ap.add_argument("--lora", default="")
    ap.add_argument("--plan", default="")
    ap.add_argument("--build", default="")
    ap.add_argument("--fix", default="")
    a = ap.parse_args()
    {"baseline": cmd_baseline, "plan-adapter": cmd_plan_adapter, "build-adapter": cmd_build_adapter,
     "fix-adapter": cmd_fix_adapter, "report": cmd_report}[a.cmd](a)


if __name__ == "__main__":
    main()
