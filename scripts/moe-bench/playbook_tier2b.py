"""The Laya partner on tier2b-format task sets (Laya partner spec §3-§7, 2026-10-05).

  nested     both nested runs per task and trial, for calibration and for configurations 1, 2 and 6:
               an 8-candidate run with 2 suites (S = candidate 0; R = candidates 0-2 + suite r8s0; R8 = all) and a
               probe run (the probe, then 1 suite and 3 candidates that all see its output; P = probe + candidate 0;
               PR = all). Every candidate is checked against all three suites; every call is timed.
  live       configurations 3-5 end to end: Laya classifies, the committed rule picks the playbook, the playbook
               runs; with --verify on, Laya's P(correct) breaks ties, stops early and escalates (as playbook.outcome).
  summarize  totals for a live file.

Seeds match bestofn_tier2b.py and probe_tier2b.py: candidate 0 uses the trial's seed at temperature 0.2, other
candidates 1000 + 100 * trial + c at --temp-alt, suites 20000 + 100 * trial + s, the probe 30000 + trial.
Probe-run candidates 1-2 use 40000 + 100 * trial + c; the probe-run suite 50000 + 100 * trial.
Cost is model seconds: Qwen generation, probe execution and Laya calls. Self-test and grading runs are excluded
everywhere (bon.check runs them together; they cost the same per candidate in every configuration).

usage: playbook_tier2b.py nested --out NESTED.jsonl [--trials 3] [--temp-alt 0.7] [--model qwen36keep96]
       playbook_tier2b.py live --out LIVE.jsonl --rule RULE.json --calib CALIB.json [--note on|off] [--verify on|off]
                               [--model qwen36keep96]
       playbook_tier2b.py summarize LIVE.jsonl
(TIER2B_DIR selects the task set, as for the other harnesses. --model is a bestofn_tier2b config, keep96 by default.
Every row records the GGUF it ran on, including a BON_GGUF override.)
"""
import argparse
import collections
import ctypes
import json
import os
import pathlib
import queue
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bestofn_tier2b as bon  # noqa: E402
import playbook  # noqa: E402
from bestofn_tier2b import TASKS, baseline_prompt, extract_code, test_names, test_prompt  # noqa: E402
from probe_tier2b import fix_prompt, probe_prompt, run_probe  # noqa: E402
import laya_v3_text as lt  # noqa: E402
import probe_v3 as pv  # noqa: E402

LAYA_PY = r"C:\qwen3-forge-stage\venv-laya\Scripts\python.exe"
MIN_FREE_MB = 2048
SUITE_KEYS = ("r8s0", "r8s1", "prs0")
# One fixed line per Laya `kind`, put at the top of every Qwen prompt for the task (spec §3.1).
NOTES = {
    "algorithm": "Note: this fix is about getting the algorithm right, including its edge cases.",
    "input": "Note: this fix is about handling bad or missing input.",
    "files": "Note: this fix is about reading or writing files or running processes safely.",
    "library": "Note: this fix is about using the available library helpers correctly.",
    "unseen": "Note: the fix depends on code whose source isn't shown.",
}


def note_for(card, play, rule):
    """Spec v2 §5: under the targeted form only probed tasks get the unseen-code note; v1 rules keep per-kind
    notes. No card (Laya failed) -> no note."""
    if card is None:
        return ""
    if rule.get("form") == "targeted":
        return NOTES["unseen"] + "\n\n" if play == "P" else ""
    return NOTES[card["kind"]] + "\n\n"


def probe_test_prompt(task, script, output):
    return (test_prompt(task) + f"\n\nThis script was run in the package directory:\n```python\n{script}\n```\n"
            f"Its output:\n```\n{output}\n```\nUse what it shows about how the code behaves.")


def timed_chat(prompt, seed_, temperature=None):
    t = time.time()
    text, n = bon.chat(prompt, seed_, temperature)
    return text, n, round(time.time() - t, 3)


def available_mb():
    class Status(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
    s = Status()
    s.dwLength = ctypes.sizeof(Status)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(s))
    return s.ullAvailPhys // 2 ** 20


class LayaClient:
    """laya_partner.py worker in Laya's own venv, over JSON lines. It never raises: once the worker fails to start,
    crashes or misses the deadline, every later call returns (None, secs) and tasks fall back (spec §7)."""

    def __init__(self, calib, timeout=5.0, start_timeout=300.0):
        self.timeout, self.dead, self.q, self.proc = timeout, False, queue.Queue(), None
        try:
            self.proc = subprocess.Popen([LAYA_PY, str(HERE / "laya_partner.py"), "worker", "--calib", str(calib)],
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                         text=True, encoding="utf-8", bufsize=1)
        except OSError:
            self.dead = True
            return
        threading.Thread(target=self._read, daemon=True).start()
        r = self._get(start_timeout)
        if not (r and r.get("ready")):
            self.close()
            self.dead = True

    def _read(self):
        for line in self.proc.stdout:
            if line.startswith("{"):
                try:
                    self.q.put(json.loads(line))
                except json.JSONDecodeError:
                    pass
        self.q.put(None)

    def _get(self, timeout):
        try:
            return self.q.get(timeout=timeout)
        except queue.Empty:
            return None

    def call(self, msg):
        """(reply or None, secs)."""
        if self.dead:
            return None, 0.0
        t = time.time()
        try:
            self.proc.stdin.write(json.dumps(msg) + "\n")
            self.proc.stdin.flush()
        except OSError:
            self.dead = True
            return None, round(time.time() - t, 3)
        r = self._get(self.timeout)
        if r is None:
            self.dead = True  # a late reply would answer the next question: stop asking
        return r, round(time.time() - t, 3)

    def close(self):
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.stdin.close()
                self.proc.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                self.proc.kill()


def start(model):
    """Set the server config; returns the GGUF file name the rows record."""
    bon.CFG.update(bon.CONFIGS[model], budget=0)
    return pathlib.Path(os.environ.get("BON_GGUF") or bon.CFG["model"]).name


def stop(proc, log):
    proc.terminate()
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
    log.close()


def done_keys(out):
    if not out.exists():
        return set()
    return {(r["task"], r["trial"]) for r in map(json.loads, out.read_text(encoding="utf-8").splitlines())}


def nested_trial(task, trial, temp_alt, ex):
    suites = {}
    for s in (0, 1):
        text, n, secs = timed_chat(test_prompt(task), 20000 + 100 * trial + s, temp_alt if s else None)
        code = extract_code(text)
        suites[f"r8s{s}"] = {"code": code, "tests": test_names(code), "secs": secs, "gen_n": n}
    cands = []
    for c in range(8):
        sd = trial if c == 0 else 1000 + 100 * trial + c
        text, n, secs = timed_chat(baseline_prompt(task), sd, temp_alt if c else None)
        cands.append({"run": "r8", "cand": c, "seed": sd, "gen_n": n, "secs": secs, "content": text})
    text, n_probe, s_gen = timed_chat(probe_prompt(task), 30000 + trial)
    script = extract_code(text)
    t = time.time()
    output = run_probe(task, script)
    probe = {"script": script, "output": output, "gen_n": n_probe, "secs_gen": s_gen,
             "secs_exec": round(time.time() - t, 3)}
    text, n, secs = timed_chat(probe_test_prompt(task, script, output), 50000 + 100 * trial)
    code = extract_code(text)
    suites["prs0"] = {"code": code, "tests": test_names(code), "secs": secs, "gen_n": n}
    for c in range(3):
        sd = trial if c == 0 else 40000 + 100 * trial + c
        text, n, secs = timed_chat(fix_prompt(task, script, output), sd, temp_alt if c else None)
        cands.append({"run": "pr", "cand": c, "seed": sd, "gen_n": n, "secs": secs, "content": text})
    suite_list = [(suites[k]["code"], suites[k]["tests"]) for k in SUITE_KEYS]
    for c in cands:
        c["code"] = extract_code(c["content"])
    for c, chk in zip(cands, ex.map(lambda c: bon.check(task, c["code"], suite_list), cands)):
        c.update(compiles=chk["compiles"], imports=chk["imports"], graded_ok=chk["graded_ok"],
                 graded_detail=chk["graded_detail"],
                 self={k: chk["self"][f"s{i}"] for i, k in enumerate(SUITE_KEYS)})
    return {"type": "trial", "task": task["name"], "category": task["category"], "trial": trial,
            "suites": suites, "probe": probe, "cands": cands}


def p3_block(task, trial, lc):
    """Laya v3 §5: probe v3 (+ one retry), Laya's evidence answer, fix without and with Laya's note, example asserts,
    their results on both fixes and the reference, and one repair per fix that fails any assert. Seeds: probe
    60000+t, retry 61000+t, fixes the trial's seed, examples 62000+100t, repairs 63000+100t+fix."""
    text, n, s_gen = timed_chat(pv.probe_prompt_v3(task), 60000 + trial)
    script = extract_code(text)
    t = time.time()
    output = pv.run_probe(task, script)
    probe = {"script": script, "output": output, "gen_n": n, "secs_gen": s_gen,
             "secs_exec": round(time.time() - t, 3), "retried": False}
    if "Traceback" in output:
        text, n2, s2 = timed_chat(pv.retry_prompt_v3(task, script, output), 61000 + trial)
        script = extract_code(text)
        t = time.time()
        output = pv.run_probe(task, script)
        probe.update(retried=True, retry_script=script, retry_output=output, secs_retry_gen=s2,
                     secs_retry_exec=round(time.time() - t, 3))
    rep, ev_secs = lc.call({"op": "evidence", "state": lt.evidence_state(task["spec"], script, output)})
    evidence = {"choice": rep["choice"], "probabilities": rep["probabilities"]} if rep and rep.get("ok") else None
    fixes = []
    notes = [None] + ([lt.note_text(evidence["choice"])] if evidence and evidence["choice"] != "none" else [])
    for note in notes:
        text, n, s = timed_chat(pv.fix_prompt_v3(task, script, output, note), trial)
        fixes.append({"note": note, "code": extract_code(text), "secs": s, "gen_n": n})
    text, n, s_ex = timed_chat(pv.example_prompt(task), 62000 + 100 * trial)
    n_ex = n
    imports, asserts = pv.split_asserts(extract_code(text))
    valid = [ok for ok, _ in pv.run_asserts(task, task["reference"], imports, asserts)] if asserts else []
    for i, f in enumerate(fixes):
        res = pv.run_asserts(task, f["code"], imports, asserts) if asserts else []
        f["asserts_ok"], f["assert_errors"] = [ok for ok, _ in res], [e for _, e in res]
        f["graded_ok"], f["graded_detail"] = pv.grade(task, f["code"])
        f["repair"] = None
        failing = [(asserts[j], f["assert_errors"][j]) for j, ok in enumerate(f["asserts_ok"]) if not ok]
        if failing:
            text, n, s = timed_chat(pv.repair_prompt(task, f["code"], imports, failing), 63000 + 100 * trial + i)
            code = extract_code(text)
            ok, detail = pv.grade(task, code)
            f["repair"] = {"code": code, "secs": s, "gen_n": n, "graded_ok": ok, "graded_detail": detail}
    return {"probe": probe, "evidence": evidence, "evidence_secs": ev_secs,
            "examples": {"imports": imports, "asserts": asserts, "secs": s_ex, "gen_n": n_ex},
            "asserts_valid": valid, "fixes": fixes}


def nested(a):
    out = pathlib.Path(a.out)
    done = done_keys(out)
    gguf = start(a.model)
    log = open(out.with_suffix(".server.log"), "a", encoding="utf-8", errors="replace")
    proc = bon.start_server(log)
    t_start = time.time()
    lc = None
    base = {}
    if getattr(a, "v3", False) and a.base:  # Laya v3: extend stored rows with the p3 block instead of re-running them
        base = {(r["task"], r["trial"]): r for r in map(json.loads, open(a.base, encoding="utf-8")) if r.get("type") == "trial"}
    try:
        if getattr(a, "v3", False):
            lc = LayaClient(a.calib)
            free = available_mb()
            print(f"Laya worker {'down' if lc.dead else 'up'}; {free} MB available with Qwen and Laya loaded", flush=True)
            if free < a.min_free_mb:
                sys.exit(f"only {free} MB available; the guard is {a.min_free_mb} (spec default {MIN_FREE_MB})")
        with out.open("a", encoding="utf-8") as f, ThreadPoolExecutor(8) as ex:
            for task in TASKS:
                for trial in range(a.trials):
                    if (task["name"], trial) in done:
                        continue
                    t = time.time()
                    if lc is not None and (task["name"], trial) in base:
                        row = dict(base[(task["name"], trial)])
                    else:
                        row = dict(nested_trial(task, trial, a.temp_alt, ex), model=gguf)
                    if lc is not None:
                        row["p3"] = p3_block(task, trial, lc)
                    f.write(json.dumps(row) + "\n")
                    f.flush()
                    ok = collections.Counter(c["run"] for c in row["cands"] if c["graded_ok"])
                    extra = ""
                    if "p3" in row:
                        extra = (f"; p3 fixes {[fx['graded_ok'] for fx in row['p3']['fixes']]} "
                                 f"evidence {(row['p3']['evidence'] or {}).get('choice')}")
                    print(f"{task['name']} t{trial}: r8 {ok['r8']}/8, pr {ok['pr']}/3 pass grading{extra}; "
                          f"{time.time() - t:.0f} s", flush=True)
    finally:
        if lc:
            lc.close()
        stop(proc, log)
    print(f"done in {(time.time() - t_start) / 60:.1f} min", flush=True)


def live_trial(task, trial, rule, lc, note_on, use_p, temp_alt):
    """One task-trial of configurations 3-5. Mirrors playbook.outcome step for step."""
    t0, calls, pvals = time.time(), [], {}

    def gen(what, prompt, sd, temp=None):
        text, n, secs = timed_chat(note + prompt, sd, temp)
        calls.append([what, secs, n])
        return text

    def new(run, i, prompt, sd, temp, suites):
        c = {"run": run, "cand": i, "code": extract_code(gen(f"{run}{i}", prompt, sd, temp))}
        chk = bon.check(task, c["code"], suites)  # self-tests for the pick; the grade is read only at the end
        c.update(compiles=chk["compiles"], imports=chk["imports"], graded_ok=chk["graded_ok"], self=chk["self"])
        return c

    def p_of(c):  # Laya's calibrated P(correct), asked at most once per candidate
        k = (c["run"], c["cand"])
        if k not in pvals:
            r, s = lc.call({"op": "verify", "requirement": task["spec"], "entry": task["entry"], "code": c["code"]})
            calls.append(["laya_verify", s, 0])
            pvals[k] = r["p"] if r and r.get("ok") else None
        return -1.0 if pvals[k] is None else pvals[k]

    probe = {}

    def run_probe_step():
        script = extract_code(gen("probe", probe_prompt(task), 30000 + trial))
        t = time.time()
        probe.update(script=script, output=run_probe(task, script))
        calls.append(["probe_exec", round(time.time() - t, 3), 0])

    note = ""
    reply, secs = lc.call({"op": "classify", "state": baseline_prompt(task)})
    calls.append(["laya_classify", secs, 0])
    card = reply["card"] if reply and reply.get("ok") else None
    play = playbook.choose(card, rule)
    if note_on:
        note = note_for(card, play, rule)
    early = escalated = False
    suites, names = [], ()
    if play in ("R", "R8"):
        code = extract_code(gen("suite0", test_prompt(task), 20000 + 100 * trial))
        suites, names = [(code, test_names(code))], ("s0",)
        c0 = new("r8", 0, baseline_prompt(task), trial, None, suites)
        if use_p and rule["t_hi"] <= 1.0 and playbook.allpass(c0, "s0") and p_of(c0) >= rule["t_hi"]:
            pool, early = [c0], True
        else:
            if play == "R8":
                code = extract_code(gen("suite1", test_prompt(task), 20000 + 100 * trial + 1, temp_alt))
                suites, names = suites + [(code, test_names(code))], ("s0", "s1")
                c0 = dict(c0, self=bon.check(task, c0["code"], suites)["self"])
            pool = [c0] + [new("r8", c, baseline_prompt(task), 1000 + 100 * trial + c, temp_alt, suites)
                           for c in range(1, 3 if play == "R" else 8)]
    elif play == "PR":
        run_probe_step()
        code = extract_code(gen("suite0", probe_test_prompt(task, probe["script"], probe["output"]),
                                50000 + 100 * trial))
        suites, names = [(code, test_names(code))], ("s0",)
        pool = [new("pr", c, fix_prompt(task, probe["script"], probe["output"]),
                    trial if c == 0 else 40000 + 100 * trial + c, temp_alt if c else None, suites) for c in range(3)]
    elif play == "S":
        pool = [new("r8", 0, baseline_prompt(task), trial, None, [])]
    else:  # P
        run_probe_step()
        pool = [new("pr", 0, fix_prompt(task, probe["script"], probe["output"]), trial, None, [])]
    best = pool[0] if early else playbook.pick(pool, names, p_of if use_p else None)
    if (use_p and not early and rule["t_lo"] > -1.0 and play in ("S", "R", "R8")
            and p_of(best) >= 0 and p_of(best) < rule["t_lo"]):
        run_probe_step()
        extra = new("pr", 100, fix_prompt(task, probe["script"], probe["output"]), trial, None, suites)
        escalated = True
        best = playbook.pick(pool + [extra], names, p_of)
    return {"type": "live", "task": task["name"], "category": task["category"], "trial": trial, "card": card,
            "laya_ok": card is not None, "laya_dead": lc.dead, "playbook": play, "note": bool(note),
            "verify": use_p, "early_stop": early, "escalated": escalated,
            "pick": {"run": best["run"], "cand": best["cand"]}, "p_pick": pvals.get((best["run"], best["cand"])),
            "graded_ok": best["graded_ok"], "calls": calls,
            "model_secs": round(sum(c[1] for c in calls), 3), "gen_tokens": sum(c[2] or 0 for c in calls),
            "wall_secs": round(time.time() - t0, 3)}


def live_trial_v3(task, trial, rule, lc, temp_alt):
    """One task-trial of the full v3 system (spec §3); mirrors playbook.outcome_v3 with FULL, step for step, with the
    seeds and prompts of nested_trial and p3_block, so the live run matches the simulation."""
    t0, calls = time.time(), []
    flags = dict(note=False, repaired=False, escalated=False, early=False)

    def gen(what, prompt, sd, temp=None):
        text, n, secs = timed_chat(prompt, sd, temp)
        calls.append([what, secs, n])
        return text

    def laya(what, msg):
        r, s = lc.call(msg)
        calls.append([what, s, 0])
        return r if r and r.get("ok") else None

    def probe_run(script):
        t = time.time()
        out = pv.run_probe(task, script)
        calls.append(["probe_exec", round(time.time() - t, 3), 0])
        return out

    reply = laya("laya_classify", {"op": "classify", "state": baseline_prompt(task)})
    card = reply["card"] if reply else None
    play = playbook.route_v3(card, rule)
    if play == "P3":
        script = extract_code(gen("probe", pv.probe_prompt_v3(task), 60000 + trial))
        output = probe_run(script)
        if "Traceback" in output:
            script = extract_code(gen("probe_retry", pv.retry_prompt_v3(task, script, output), 61000 + trial))
            output = probe_run(script)
        ev = laya("laya_evidence", {"op": "evidence", "state": lt.evidence_state(task["spec"], script, output)})
        note = None
        if ev and ev["choice"] != "none" and ev["probabilities"].get(ev["choice"], 0.0) >= rule["c_note"]:
            note, flags["note"] = lt.note_text(ev["choice"]), True
        code = extract_code(gen("fix", pv.fix_prompt_v3(task, script, output, note), trial))
        imports, asserts = pv.split_asserts(extract_code(gen("examples", pv.example_prompt(task),
                                                             62000 + 100 * trial)))
        if asserts:
            failing = [(asserts[j], e) for j, (ok, e) in enumerate(pv.run_asserts(task, code, imports, asserts))
                       if not ok]
            ps = []
            for a_src, _ in failing:
                r = laya("laya_valid", {"op": "valid", "state": lt.valid_state(task["spec"], imports, a_src)})
                ps.append(r["p"] if r else None)
            if any(p is not None and p >= rule["c_valid"] for p in ps):
                code = extract_code(gen("repair", pv.repair_prompt(task, code, imports, failing),
                                        63000 + 100 * trial + (1 if note else 0)))
                flags["repaired"] = True
        ok = pv.grade(task, code)[0]
    elif play == "P":  # v1's probe and one fix (amendment 2026-10-08), as nested_trial's pr candidate 0: no note
        script = extract_code(gen("probe", probe_prompt(task), 30000 + trial))
        output = probe_run(script)
        code = extract_code(gen("pr0", fix_prompt(task, script, output), trial))
        ok = bon.check(task, code, [])["graded_ok"]
    else:
        pvals = {}

        def p_of(c):
            k = (c["run"], c["cand"])
            if k not in pvals:
                r = laya("laya_verify", {"op": "verify", "requirement": task["spec"], "entry": task["entry"],
                                         "code": c["code"]})
                pvals[k] = r["p"] if r else None
            return -1.0 if pvals[k] is None else pvals[k]

        def new(i, sd, temp, suites):
            c = {"run": "r8", "cand": i, "code": extract_code(gen(f"r8{i}", baseline_prompt(task), sd, temp))}
            chk = bon.check(task, c["code"], suites)
            c.update(compiles=chk["compiles"], imports=chk["imports"], graded_ok=chk["graded_ok"], self=chk["self"])
            return c

        s0 = extract_code(gen("suite0", test_prompt(task), 20000 + 100 * trial))
        suites = [(s0, test_names(s0))]
        c0 = new(0, trial, None, suites)
        if rule["t_hi"] <= 1.0 and playbook.allpass(c0, "s0") and p_of(c0) >= rule["t_hi"]:
            best, flags["early"] = c0, True
        else:
            pool = [c0] + [new(c, 1000 + 100 * trial + c, temp_alt, suites) for c in (1, 2)]
            best = playbook.pick(pool, ("s0",), p_of)
            low = rule["t_lo"] > -1.0 and 0 <= p_of(best) < rule["t_lo"]
            if low or (rule.get("e_fail", True) and not playbook.allpass(best, "s0")):
                s1 = extract_code(gen("suite1", test_prompt(task), 20000 + 100 * trial + 1, temp_alt))
                suites = suites + [(s1, test_names(s1))]
                pool = [dict(c, self=bon.check(task, c["code"], suites)["self"]) for c in pool]
                pool += [new(c, 1000 + 100 * trial + c, temp_alt, suites) for c in range(3, 8)]
                best, flags["escalated"] = playbook.pick(pool, ("s0", "s1"), p_of), True
        ok = best["graded_ok"]
    return {"type": "live", "task": task["name"], "category": task["category"], "trial": trial, "card": card,
            "laya_ok": card is not None, "laya_dead": lc.dead, "playbook": play, "note": flags["note"],
            "repaired": flags["repaired"], "escalated": flags["escalated"], "early_stop": flags["early"],
            "graded_ok": bool(ok), "calls": calls, "model_secs": round(sum(c[1] for c in calls), 3),
            "gen_tokens": sum(c[2] or 0 for c in calls), "wall_secs": round(time.time() - t0, 3)}


def live(a):
    rules = json.loads(pathlib.Path(a.rule).read_text(encoding="utf-8"))
    use_p = a.verify == "on"
    v3 = getattr(a, "v3", False)
    rule = rules["rule"] if v3 else rules["verify" if use_p else "noverify"]
    out = pathlib.Path(a.out)
    done = done_keys(out)
    gguf = start(a.model)
    log = open(out.with_suffix(".server.log"), "a", encoding="utf-8", errors="replace")
    proc = bon.start_server(log)
    lc = None
    t_start = time.time()
    try:
        lc = LayaClient(a.calib)
        free = available_mb()
        print(f"Laya worker {'down' if lc.dead else 'up'}; {free} MB available with Qwen and Laya loaded", flush=True)
        if free < a.min_free_mb:
            sys.exit(f"only {free} MB available; the guard is {a.min_free_mb} (spec default {MIN_FREE_MB})")
        with out.open("a", encoding="utf-8") as f:
            for task in TASKS:
                for trial in range(a.trials):
                    if (task["name"], trial) in done:
                        continue
                    row = dict(live_trial_v3(task, trial, rule, lc, a.temp_alt) if v3 else
                               live_trial(task, trial, rule, lc, a.note == "on", use_p, a.temp_alt), model=gguf)
                    f.write(json.dumps(row) + "\n")
                    f.flush()
                    print(f"{task['name']} t{trial}: {row['playbook']}{' early' if row['early_stop'] else ''}"
                          f"{' escalated' if row['escalated'] else ''} -> {'PASS' if row['graded_ok'] else 'fail'} "
                          f"({row['model_secs']:.1f} s)", flush=True)
    finally:
        if lc:
            lc.close()
        stop(proc, log)
    print(f"done in {(time.time() - t_start) / 60:.1f} min", flush=True)
    summarize(argparse.Namespace(path=a.out))


def summarize(a):
    rows = [r for r in map(json.loads, open(a.path, encoding="utf-8")) if r.get("type") == "live"]
    by = collections.Counter()
    for r in rows:
        by[r["category"]] += r["graded_ok"]
    print(f"{sum(r['graded_ok'] for r in rows)}/{len(rows)} solved  "
          + "  ".join(f"{c}:{n}" for c, n in sorted(by.items())))
    print(f"mean model secs {sum(r['model_secs'] for r in rows) / max(len(rows), 1):.2f}; playbooks "
          f"{dict(collections.Counter(r['playbook'] for r in rows))}; early stops {sum(r['early_stop'] for r in rows)}; "
          f"escalations {sum(r['escalated'] for r in rows)}; Laya fallbacks {sum(not r['laya_ok'] for r in rows)}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("nested")
    n.add_argument("--out", required=True)
    n.add_argument("--trials", type=int, default=3)
    n.add_argument("--temp-alt", type=float, default=0.7)
    n.add_argument("--model", default="qwen36keep96", choices=sorted(bon.CONFIGS))
    n.add_argument("--v3", action="store_true", help="Laya v3: add the p3 block (needs --calib for the Laya worker)")
    n.add_argument("--base", help="v3: extend these stored trial rows instead of re-running nested_trial")
    n.add_argument("--calib")
    n.add_argument("--min-free-mb", type=int, default=MIN_FREE_MB)
    lv = sub.add_parser("live")
    lv.add_argument("--out", required=True)
    lv.add_argument("--rule", required=True)
    lv.add_argument("--calib", required=True)
    lv.add_argument("--note", choices=["on", "off"], default="on")
    lv.add_argument("--verify", choices=["on", "off"], default="on")
    lv.add_argument("--trials", type=int, default=3)
    lv.add_argument("--temp-alt", type=float, default=0.7)
    lv.add_argument("--model", default="qwen36keep96", choices=sorted(bon.CONFIGS))
    lv.add_argument("--v3", action="store_true", help="Laya v3: the full system (rule.json's 'rule')")
    lv.add_argument("--min-free-mb", type=int, default=MIN_FREE_MB,
                    help="RAM guard with Qwen and Laya loaded (spec 2048; an owner decision may set it per run)")
    s = sub.add_parser("summarize")
    s.add_argument("path")
    a = ap.parse_args()
    {"nested": nested, "live": live, "summarize": summarize}[a.cmd](a)


if __name__ == "__main__":
    main()
