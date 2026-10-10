"""Teacher data for role specialization (roadmap step 2, 2026-10-08).

Two teachers on equal terms, the same prompts and the same short system message:
- DeepSeek v4.1 Flash through OpenCode Go (key read from OpenCode's auth.json, never printed);
- Grok 4.7 through the Grok CLI: headless single turn, no tools, no web, no subagents, in an empty temp directory.

`compare` runs the six comparison builds in compare_tasks.py (written for this only, from no benchmark family) for both
teachers: a plan and a build for each, acceptance checks on the build, one repair round on any failing build, and a
blind pack of the plans for judging. Output goes under E:/AI/teacher-data (not the public repo).

usage: teacher_gen.py compare --out E:/AI/teacher-data/compare-2026-10-08
"""
import argparse
import concurrent.futures
import json
import pathlib
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "moe-bench"))
sys.path.insert(0, str(HERE))
import compare_tasks as ct  # noqa: E402
import opencode_go  # noqa: E402

SYSTEM = "You are an expert software engineer. Answer directly in text. Do not call tools, browse or ask questions."
GROK_MODEL = "grok-4.7"
_local = threading.local()


USAGE_LOG = pathlib.Path("E:/AI/teacher-data/usage.jsonl")
_usage_lock = threading.Lock()


def log_usage(usage, backend, secs):
    """One JSON line per reply: token counts as the API reports them, so spend can be metered (monthly quota, 2026-10-09)."""
    usage = usage or {}
    with _usage_lock, open(USAGE_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps({"t": round(time.time()), "backend": backend, "secs": secs,
                            "prompt_tokens": usage.get("prompt_tokens"), "completion_tokens": usage.get("completion_tokens"),
                            "total_tokens": usage.get("total_tokens")}) + "\n")


def deepseek(prompt, max_tokens=32768):
    if not hasattr(_local, "ds"):
        _local.ds = opencode_go.Client()
        assert _local.ds.model == "deepseek-v4.1-flash", _local.ds.model
    t = time.time()
    text = _local.ds.chat(prompt, temperature=0.7, max_tokens=max_tokens, json_mode=False, system=SYSTEM)
    log_usage(getattr(_local.ds, "last_usage", None), "deepseek", round(time.time() - t, 1))
    return text


def grok(prompt, timeout=1500):
    d = pathlib.Path(tempfile.mkdtemp(prefix="grok-"))
    try:
        pf = d.parent / (d.name + ".prompt.txt")
        pf.write_text(prompt, encoding="utf-8")
        r = subprocess.run(["grok", "--prompt-file", str(pf), "-m", GROK_MODEL, "--output-format", "plain",
                            "--disable-web-search", "--no-subagents", "--max-turns", "1", "--tools", "", "--verbatim",
                            "--system-prompt-override", SYSTEM], cwd=d, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
        if r.returncode != 0:
            raise RuntimeError(f"grok exit {r.returncode}: {r.stderr[-300:]}")
        if any(d.iterdir()):
            raise RuntimeError("grok wrote files")  # it must answer in text only
        return r.stdout
    finally:
        shutil.rmtree(d, ignore_errors=True)
        pf.unlink(missing_ok=True)


def _opencode(keyname, base, model):
    """A free OpenCode model (owner, 2026-10-08: Exo Free was retired, HTTP 410; try Step 5 and Space Bunny)."""
    def call_(prompt, max_tokens=32768):
        attr = "oc_" + model
        if not hasattr(_local, attr):
            key = json.loads(opencode_go.AUTH.read_text(encoding="utf-8"))[keyname]["key"]
            setattr(_local, attr, opencode_go.Client(key=key, model=model, base=base))
        return getattr(_local, attr).chat(prompt, temperature=0.7, max_tokens=max_tokens, json_mode=False,
                                          system=SYSTEM)
    return call_


BACKENDS = {"deepseek": deepseek, "grok": grok,
            "step5": _opencode("opencode-go", opencode_go.BASE, "step-5-preview-free"),
            "bunny": _opencode("opencode", "https://opencode.ai/zen/v1", "space-bunny-free")}
LIMITS = {"deepseek": threading.Semaphore(6), "grok": threading.Semaphore(3), "step5": threading.Semaphore(4),
          "bunny": threading.Semaphore(4)}

MARK = re.compile(r"^\s*(?:#|//|<!--|/\*)\s*file:\s*([\w./-]+)\s*(?:-->|\*/)?\s*$", re.I)


def extract_files(text, entry):
    """{path: content} from fenced blocks whose first line names the file; one unnamed block becomes the entry."""
    files, unnamed = {}, []
    for m in re.finditer(r"```[\w+-]*\n(.*?)```", text, re.S):
        body = m.group(1)
        first, _, rest = body.partition("\n")
        mk = MARK.match(first)
        if mk:
            files[mk.group(1).lstrip("./")] = rest
        else:
            unnamed.append(body)
    if entry not in files and unnamed:
        files[entry] = max(unnamed, key=len)
    if not files:  # no fences at all: a reply that starts with a file marker is that one file (DeepSeek, 2026-10-08)
        first, _, rest = text.strip().partition("\n")
        mk = MARK.match(first)
        if mk:
            files[mk.group(1).lstrip("./")] = rest
    return files


TRANSIENT = ("429", "RemoteDisconnected", "timed out", "Connection", "502", "503", "504")


def call(backend, prompt, retries=4, **kw):
    """(text, seconds, error). Transient failures (rate limits, dropped connections) are retried with backoff while the
    concurrency slot is held, which also slows the other workers down."""
    with LIMITS[backend]:
        t = time.time()
        err = None
        for attempt in range(retries):
            try:
                return BACKENDS[backend](prompt, **kw), round(time.time() - t, 1), None
            except Exception as e:  # recorded, never fatal for the comparison
                err = repr(e)[:300]
                if attempt + 1 < retries and any(k in err for k in TRANSIENT):
                    time.sleep(20 * 2 ** attempt)
                    continue
                break
        return "", round(time.time() - t, 1), err


def valid_path(p):
    """A relative file name that is safe to create on Windows (a model once answered with a whole HTML page as the name)."""
    return (bool(p) and len(p) < 200 and not re.search(r'[\n\r<>:"|?*]', p) and ".." not in p and not p.startswith("/"))


def run_build(task, files):
    d = pathlib.Path(tempfile.mkdtemp(prefix=f"tb-{task['id']}-"))
    try:
        for p, c in files.items():
            if ".." in p or p.startswith("/"):
                continue
            (d / p).parent.mkdir(parents=True, exist_ok=True)
            (d / p).write_text(c, encoding="utf-8")
        return ct.check(task, d)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def one(task, backend, out):
    rec = {"task": task["id"], "backend": backend}
    plan, rec["plan_secs"], rec["plan_err"] = call(backend, ct.PLAN_PROMPT.format(request=task["request"]))
    rec["plan"] = plan
    build, rec["build_secs"], rec["build_err"] = call(backend, ct.BUILD_PROMPT.format(request=task["request"]))
    rec["build"] = build
    files = extract_files(build, task["entry"])
    rec["files"] = sorted(files)
    rec["checks"], rec["stderr"] = run_build(task, files)
    if not all(rec["checks"].values()):
        failures = "\n".join(f"- {k}: failed" for k, v in rec["checks"].items() if not v)
        if rec["stderr"]:
            failures += f"\n\nstderr (tail):\n{rec['stderr']}"
        shown = "\n\n".join(f"```\n# file: {p}\n{c}```" for p, c in files.items())
        fix, rec["fix_secs"], rec["fix_err"] = call(backend, ct.FIX_PROMPT.format(request=task["request"], files=shown,
                                                                                 failures=failures))
        rec["fix"] = fix
        rec["fix_checks"], rec["fix_stderr"] = run_build(task, extract_files(fix, task["entry"]) or files)
    with _lock:
        with open(out / "raw.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
    passed = sum(rec["checks"].values())
    fixed = sum(rec.get("fix_checks", rec["checks"]).values())
    print(f"{task['id']:14} {backend:8} build {passed}/{len(rec['checks'])} -> after fix {fixed}/"
          f"{len(rec.get('fix_checks', rec['checks']))}; plan {rec['plan_secs']} s, build {rec['build_secs']} s"
          f"{'; ERR ' + str(rec['plan_err'] or rec['build_err']) if rec['plan_err'] or rec['build_err'] else ''}",
          flush=True)
    return rec


_lock = threading.Lock()


def compare(a):
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    done = set()
    if (out / "raw.jsonl").exists():
        done = {(r["task"], r["backend"]) for r in map(json.loads, open(out / "raw.jsonl", encoding="utf-8"))}
    chosen = a.backends.split(",") if a.backends else list(BACKENDS)
    jobs = [(t, b) for t in ct.TASKS for b in chosen if (t["id"], b) not in done]
    with concurrent.futures.ThreadPoolExecutor(12) as ex:
        list(ex.map(lambda j: one(j[0], j[1], out), jobs))
    recs = [json.loads(line) for line in open(out / "raw.jsonl", encoding="utf-8")]
    # blind pack of plans for the --pack backends (letters per task, the mapping kept separately)
    packed = a.pack.split(",") if a.pack else ["deepseek", "grok"]
    tag = "" if packed == ["deepseek", "grok"] else "-" + "-".join(packed)
    rng, pack, key = random.Random(20261008 + len(tag)), [], {}
    for t in ct.TASKS:
        group = [r for r in recs if r["task"] == t["id"] and r["backend"] in packed]
        rng.shuffle(group)
        labels = "XYZW"[:len(group)]
        key[t["id"]] = {lab: r["backend"] for lab, r in zip(labels, group)}
        pack.append(f"# {t['id']}\n\n## Request\n\n{t['request']}\n" +
                    "".join(f"\n## Plan {lab}\n\n{r['plan']}\n" for lab, r in zip(labels, group)))
    (out / f"plans-blind{tag}.md").write_text("\n\n---\n\n".join(pack), encoding="utf-8")
    (out / f"plans-key{tag}.json").write_text(json.dumps(key, indent=1), encoding="utf-8")
    summary = {}
    for b in sorted({r["backend"] for r in recs}):
        rs = [r for r in recs if r["backend"] == b]
        summary[b] = {"build_checks": f"{sum(sum(r['checks'].values()) for r in rs)}/{sum(len(r['checks']) for r in rs)}",
                      "after_fix": f"{sum(sum(r.get('fix_checks', r['checks']).values()) for r in rs)}/"
                                   f"{sum(len(r.get('fix_checks', r['checks'])) for r in rs)}",
                      "builds_all_pass": sum(all(r["checks"].values()) for r in rs),
                      "after_fix_all_pass": sum(all(r.get("fix_checks", r["checks"]).values()) for r in rs),
                      "mean_plan_secs": round(sum(r["plan_secs"] for r in rs) / len(rs), 1),
                      "mean_build_secs": round(sum(r["build_secs"] for r in rs) / len(rs), 1),
                      "errors": sum(bool(r["plan_err"] or r["build_err"]) for r in rs)}
    (out / "summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    print(json.dumps(summary, indent=1))


# ---- generation (v0): seeds -> plan -> build from the plan -> run the seed's tests -> one fix on failure ----------
# Seeds are feature builds from broad fields, never the benchmark formats (small bug fixes, families A-E) or their
# topics, and every seed must pass the judge-set writer's wording check against all scored sets (tier2b, pool, both
# judge sets). Only executable runtimes for now: Python (stdlib), Node (no deps), single-file web apps.

LANGS = {
    "python": dict(desc="Python 3, standard library only", entry_hint="a .py file",
                   interface="a command-line program (exact arguments, exit codes and output format) or an importable "
                             "module (exact function and class signatures)",
                   tests="one Python unittest file named test_acceptance.py that exercises only that interface (run "
                         "the program with subprocess and sys.executable, or import the module)"),
    "node": dict(desc="Node.js, no dependencies, CommonJS", entry_hint="a .js file",
                 interface="exported functions or classes with exact signatures, or a command-line program with exact "
                           "arguments and output",
                 tests="one file test_acceptance.js that uses node:assert, exercises only that interface and exits "
                       "non-zero on failure"),
    "web": dict(desc="a single-file web app index.html with inline CSS and JavaScript, no external resources",
                entry_hint="index.html",
                interface="the exact element ids of every control and display, and what each shows",
                tests="one ES module test_acceptance.mjs whose default export is `async function (page)` using the "
                      "Playwright page API (fill, click, textContent, inputValue, evaluate) after the page is loaded; "
                      "it throws an Error on any failure"),
}
KINDS = {
    "python": ["command-line tool", "data processing or reporting script", "library module with a small API",
               "small JSON HTTP service using http.server (port from a command-line argument)", "text-processing utility",
               "file organisation or automation utility"],
    "node": ["library module with a small API", "command-line tool", "small HTTP server using node:http",
             "data transformation script"],
    "web": ["interactive single-page tool that saves state in localStorage", "canvas game or visual toy",
            "form-based productivity tool", "chart or visualisation of data the user enters"],
}
FIELDS = ["developer tooling", "personal productivity", "education and study", "data analysis", "creative tools",
          "casual games and puzzles", "networking and the web", "system administration", "documentation and writing",
          "accessibility", "science and mathematics", "small business operations", "hobbies and crafts",
          "health and fitness", "travel and maps", "media and libraries", "home and family organisation",
          "security and privacy", "open-source maintenance", "team collaboration"]

SEED_PROMPT = """Propose {k} distinct, realistic programming tasks of this kind:
- Runtime: {desc}
- Kind: {kind}
- Field: {field}

Each task is a small but complete build (about 80-300 lines) that would be useful in real work. Specify an exact
interface so it can be tested automatically: {interface}. For each task, also write acceptance tests: {tests}.
The tests must follow only from the request text.

Do not propose: simulations of ecosystems or animal populations; tasks that are mainly about fixing a bug in given
code; reimplementing one standard-library function; or anything about these topics: {topics}.

Return ONLY a JSON object: {{"tasks": [{{"title": "...", "request": "the full request text, including the exact
interface", "entry": "{entry_hint} the request asks for", "tests": "the full acceptance test file"}}]}}"""

PLAN_GEN_PROMPT = ct.PLAN_PROMPT
BUILD_FROM_PLAN_PROMPT = """Implement this request completely, following the plan.

Request:
{request}

Plan:
{plan}

Reply with every file in full, each in its own fenced code block whose first line is a comment naming the file,
e.g. `# file: tool.py`, `// file: lib.js` or `<!-- file: index.html -->`. No placeholders, TODOs or omitted parts."""


def scored_specs():
    """Word sets of every scored task's spec: tier2b, pool, the old judge set and the new judge set."""
    sys.path.insert(0, str(HERE.parent / "moe-bench" / "train_tasks"))
    import make
    _, _, _, specs = make.scored_index()
    for t in make.load_tasks(HERE.parents[1] / "docs" / "benchmarks" / "laya-judge3" / "tasks.py", "judge3"):
        specs.append(make.words(t["spec"]))
    return make, specs


def run_tests(lang, files, tests):
    """(passed, output tail): the seed's acceptance tests against the files, in a temp directory."""
    d = pathlib.Path(tempfile.mkdtemp(prefix=f"tg-{lang}-"))
    try:
        for p, c in files.items():
            if valid_path(p):
                (d / p).parent.mkdir(parents=True, exist_ok=True)
                (d / p).write_text(c, encoding="utf-8")
        name = {"python": "test_acceptance.py", "node": "test_acceptance.js", "web": "test_acceptance.mjs"}[lang]
        (d / name).write_text(tests, encoding="utf-8")
        cmd = {"python": [sys.executable, "-m", "unittest", "test_acceptance"], "node": ["node", name],
               "web": ["node", str(HERE / "run_web_test.mjs"), str(d / "index.html"), str(d / name)]}[lang]
        try:
            r = subprocess.run(cmd, cwd=d, capture_output=True, text=True, encoding="utf-8", errors="replace",
                               timeout=180)
            return r.returncode == 0, (r.stdout + r.stderr)[-1500:]
        except subprocess.TimeoutExpired:
            return False, "timeout after 180 s"
    finally:
        shutil.rmtree(d, ignore_errors=True)


def seeds(a):
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    make, specs = scored_specs()
    import families  # train_tasks is on sys.path after scored_specs()
    topics = ", ".join(families.TOPICS)
    cells = [(lang, kind, field) for lang in LANGS for kind in KINDS[lang] for field in FIELDS]
    random.Random(a.seed).shuffle(cells)
    cells = cells[:a.cells]
    path = out / "seeds.jsonl"
    done = {(r["lang"], r["kind"], r["field"]) for r in map(json.loads, open(path, encoding="utf-8"))
            if not r.get("empty")} if path.exists() else set()  # an empty (failed or killed) cell is retried

    def cell(c):
        lang, kind, field = c
        L = LANGS[lang]
        text, secs, err = call(a.backend, SEED_PROMPT.format(k=a.k, desc=L["desc"], kind=kind, field=field,
                                                             interface=L["interface"], tests=L["tests"], topics=topics,
                                                             entry_hint=L["entry_hint"]))
        obj = opencode_go.extract_json(text) or {}
        kept = 0
        with _lock, open(path, "a", encoding="utf-8") as f:
            for i, t in enumerate(obj.get("tasks", [])):
                if not all(isinstance(t.get(k), str) and t.get(k) for k in ("request", "entry", "tests")):
                    continue
                low = (t.get("title", "") + " " + t["request"]).lower()
                near = max((make.jaccard(make.words(t["request"]), s) for s in specs), default=0.0)
                clash = near >= 0.5 or any(tp.lower() in low for tp in families.TOPICS)
                rec = dict(t, lang=lang, kind=kind, field=field, i=i, backend=a.backend, secs=secs, near=round(near, 3),
                           excluded=bool(clash))
                f.write(json.dumps(rec) + "\n")
                kept += not clash
            if not obj.get("tasks"):
                f.write(json.dumps({"lang": lang, "kind": kind, "field": field, "empty": True, "err": err}) + "\n")
        print(f"seeds {lang:6} {kind[:28]:28} {field[:22]:22} kept {kept}; {secs} s{'; ' + err if err else ''}", flush=True)

    with concurrent.futures.ThreadPoolExecutor(a.workers) as ex:
        list(ex.map(cell, [c for c in cells if c not in done]))


def gen(a):
    out = pathlib.Path(a.out)
    keep_splits = set(a.splits.split(",")) if a.splits else None
    seeds_ = [r for r in map(json.loads, open(out / a.seeds_file, encoding="utf-8"))
              if not r.get("empty") and not r.get("excluded") and not r.get("lab_excluded")
              and (keep_splits is None or r.get("split") in keep_splits)]
    path = out / "runs.jsonl"
    done = {(r["lang"], r["kind"], r["field"], r["i"]) for r in map(json.loads, open(path, encoding="utf-8"))} if path.exists() else set()

    def run(s):
        try:
            run_one(s)
        except Exception as e:  # one bad seed must not stop the pool; it is not recorded, so a rerun retries it
            print(f"gen ERROR {s['lang']} {s['field']} #{s['i']}: {e!r}"[:300], flush=True)

    def run_one(s):
        key = (s["lang"], s["kind"], s["field"], s["i"])
        rec = {"lang": s["lang"], "kind": s["kind"], "field": s["field"], "i": s["i"], "backend": a.backend,
               "split": s.get("split"),
               "request": s["request"], "entry": s["entry"], "tests": s["tests"]}
        rec["plan"], rec["plan_secs"], e1 = call(a.backend, PLAN_GEN_PROMPT.format(request=s["request"]))
        rec["build"], rec["build_secs"], e2 = call(a.backend, BUILD_FROM_PLAN_PROMPT.format(request=s["request"],
                                                                                           plan=rec["plan"]))
        files = extract_files(rec["build"], s["entry"])
        rec["build_ok"], rec["build_out"] = run_tests(s["lang"], files, s["tests"]) if files else (False, "no files")
        if not rec["build_ok"] and files:
            shown = "\n\n".join(f"```\n# file: {p}\n{c}```" for p, c in files.items())
            rec["fix"], rec["fix_secs"], e3 = call(a.backend, ct.FIX_PROMPT.format(
                request=s["request"], files=shown, failures=f"The acceptance tests failed:\n{rec['build_out']}"))
            fx = extract_files(rec["fix"], s["entry"])
            rec["fix_ok"], rec["fix_out"] = run_tests(s["lang"], fx, s["tests"]) if fx else (False, "no files")
        rec["errors"] = [e for e in (e1, e2) if e]
        with _lock, open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
        print(f"gen {key[0]:6} {key[2][:20]:20} #{key[3]}: build {'PASS' if rec['build_ok'] else 'fail'}"
              f"{' -> fix ' + ('PASS' if rec.get('fix_ok') else 'fail') if 'fix_ok' in rec else ''}", flush=True)

    with concurrent.futures.ThreadPoolExecutor(a.workers) as ex:
        list(ex.map(run, [s for s in seeds_ if (s["lang"], s["kind"], s["field"], s["i"]) not in done]))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("compare")
    c.add_argument("--out", required=True)
    c.add_argument("--backends", help="comma-separated backends to run (default all; finished pairs are skipped)")
    c.add_argument("--pack", help="comma-separated backends in the blind plan pack (default deepseek,grok)")
    for name in ("seeds", "gen"):
        s = sub.add_parser(name)
        s.add_argument("--out", required=True)
        s.add_argument("--backend", choices=list(BACKENDS), required=True)
        s.add_argument("--workers", type=int, default=6)
        if name == "gen":
            s.add_argument("--seeds-file", default="seeds.jsonl", help="seeds.jsonl or seeds-clean.jsonl")
            s.add_argument("--splits", default="", help="comma-separated splits to generate (default all)")
        if name == "seeds":
            s.add_argument("--cells", type=int, default=60)
            s.add_argument("--k", type=int, default=4)
            s.add_argument("--seed", type=int, default=11)
    a = ap.parse_args()
    {"compare": compare, "seeds": seeds, "gen": gen}[a.cmd](a)


if __name__ == "__main__":
    main()
