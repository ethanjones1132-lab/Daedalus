# Long context for keep96 — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** find the largest llama-server window (at least 64k) at which Qwen3.6 keep96 keeps today's short-task results and speed, and does no significantly worse at the end of a long agent session. Then roll it out after the Laya v3 run.

**Architecture:**
- `speed_pair.py --grid` measures memory, overflow and speed per window.
- `longctx_build.py` builds synthetic agent sessions from the calibration pool and standard-library files. It is pure Python and needs no model.
- `longctx_sessions.py` runs the Short, Late and Early conditions on one llama-server per window. It grades answers with tier2b's own tests and scores the bar.
- `run_longctx.sh` chains everything, with the Versutus gate paused, the RAM guard, and a watchdog before 01:00.

**Tech stack:**
- Python 3.12 stdlib in `C:\qwen3-forge-stage\venv` and unittest;
- llama-server 836d571 (CUDA);
- Git Bash for the chain.

**Spec:** `docs/superpowers/specs/2026-10-07-long-context-design.md` (commit 0c55967).

**Implementation details the spec leaves open, fixed here:**
- **Unit counts.** Filler units are counted with the running server's `/tokenize` at the start of each session and cached. The venv has no Qwen tokenizer, and the session's server is already up.
- **File split.** The pure builder is `longctx_build.py`, separate from the runner `longctx_sessions.py`. That keeps the tested part model-free.
- **Run order.** Bar (a) runs at 64k as soon as Late passes there, before the larger window, so the 64k decision is certain to land before 01:00. Early runs last, since it is reported only.
- **Deep prompts in the grid** are sized at 4.5 characters per token (long10k and long15k, measured 2026-10-06), and each one fits in 85% of its window. Every run records the real prompt token count.
- **Filler targets:** 28k for a 32k window, 56k for 64k, 86k for 96k, 116k for 128k. Tier2b's task turns are at most about 210 tokens, so each target plus the task turn plus 2,048 reply tokens fits.

**Paths:**
- `WT=C:\Projects\home-base-recovered\.claude\worktrees\micro-agent-swarm-design-929d42`
- `MB=$WT\scripts\moe-bench`
- `PY=C:\qwen3-forge-stage\venv\Scripts\python.exe`
- logs: `C:\qwen3-forge-stage\logs\longctx`

Run every test from `$MB` with `$PY -m unittest test_<name> -v`.

---

### Task 1: `moe_sweep.py` options: cache type, a warm-up subset, per-prompt errors, follow-up probe

**Files:**
- Modify: `scripts/moe-bench/moe_sweep.py` (`run_config`, lines 98–186)
- Test: `scripts/moe-bench/test_speed_grid.py` (new; Task 2 adds to it)

- [ ] **Step 1: Write the failing test** in `test_speed_grid.py`:

```python
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import moe_sweep  # noqa: E402


class ServerCmdTest(unittest.TestCase):
    def test_cache_type_and_window(self):
        args = moe_sweep.server_cmd("m.gguf", 0, 2, 65536, 512, None, "q4_0")
        self.assertEqual(args[args.index("-c") + 1], "65536")
        self.assertEqual(args[args.index("-ctk") + 1], "q4_0")
        self.assertEqual(args[args.index("-ctv") + 1], "q4_0")

    def test_default_is_q8(self):
        args = moe_sweep.server_cmd("m.gguf", 0, 2, 16384, 512, None)
        self.assertEqual(args[args.index("-ctk") + 1], "q8_0")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it and check that it fails.** `$PY -m unittest test_speed_grid -v`: AttributeError, no `server_cmd`.

- [ ] **Step 3: Implement.** In `moe_sweep.py`, insert before `def run_config`:

```python
def server_cmd(model, ncmoe, mtp, ctx, ubatch, threads, ctk="q8_0"):
    args = [SERVER, "-m", model, "--host", "127.0.0.1", "--port", str(PORT),
            "-ngl", "99", "--n-cpu-moe", str(ncmoe), "-c", str(ctx),
            "-ctk", ctk, "-ctv", ctk, "--flash-attn", "on",
            "-b", str(max(ubatch, 512)), "-ub", str(ubatch), "-np", "1",
            "--jinja", "--reasoning-budget", "0", "--no-webui",
            "--cache-ram", "0"] + list(EXTRA_ARGS)  # default 8 GiB host prompt cache starves 16 GB RAM
    if threads:
        args += ["-t", str(threads)]
    if mtp:
        args += ["--spec-type", SPEC_TYPE, "--spec-draft-n-max", str(mtp)]
        if DRAFT_MODEL:  # Gemma ships its MTP head as a separate file
            args += ["-md", DRAFT_MODEL]
    return args


def chat_once(messages, max_tokens, cache_prompt):
    """One chat request at temperature 0 with thinking off; llama-server's timings plus the text."""
    t = time.time()
    _, resp = http("POST", "/v1/chat/completions", {
        "messages": messages, "max_tokens": max_tokens, "temperature": 0, "cache_prompt": cache_prompt,
        "chat_template_kwargs": {"enable_thinking": False}})
    tm = resp.get("timings", {})
    return {"wall_s": round(time.time() - t, 2), "prompt_n": tm.get("prompt_n"), "cache_n": tm.get("cache_n"),
            "prompt_ms": round(tm.get("prompt_ms", 0)), "prompt_tps": round(tm.get("prompt_per_second", 0), 1),
            "gen_n": tm.get("predicted_n"), "gen_tps": round(tm.get("predicted_per_second", 0), 2),
            "draft_n": tm.get("draft_n"), "draft_accepted": tm.get("draft_n_accepted"),
            "text": resp["choices"][0]["message"].get("content") or ""}


def followup_probe(content):
    """Reuse across turns on a hybrid model (2026-10-07): the deep prompt with the cache on, the same chat plus one
    more turn, then the same text with a different closing question. prompt_n is what the server actually read."""
    msgs = [{"role": "user", "content": content}]
    first = chat_once(msgs, 300, True)
    turn = chat_once(msgs + [{"role": "assistant", "content": first["text"]},
                             {"role": "user", "content": "Now list every top-level function defined above, "
                                                         "one per line."}], 200, True)
    head = content.rsplit("\n\n", 1)[0]
    alt = chat_once([{"role": "user", "content": head + "\n\nHow many classes are defined above? "
                                                        "Reply with one number."}], 20, True)
    return {k: {f: v for f, v in r.items() if f != "text"}
            for k, r in (("first", first), ("next_turn", turn), ("new_ending", alt))}
```

Then change `run_config`:
- Its signature becomes `def run_config(model, ncmoe, mtp, ctx, ubatch, threads, logdir, prompts, ctk="q8_0", warm=None, followup=None):`, with a docstring line: `"""warm: prompt names for the unrecorded warm-up pass (default all). followup: a deep prompt's text for followup_probe, run last. A failed prompt is recorded in its run and the others continue."""`
- After the `tag = ...` line, add `if ctk != "q8_0": tag += f"_k{ctk}"`. Replace the inline `args = [...]` block, including its `threads` and `mtp` additions, with `args = server_cmd(model, ncmoe, mtp, ctx, ubatch, threads, ctk)`.
- `row` gains `"ctk": ctk`.
- Guard the warm-up loop's request with `if warm is None or name in warm:`, which requires changing `for _, content, max_tokens in prompts:` to `for name, content, max_tokens in prompts:`.
- Replace the recorded loop with:

```python
        for name, content, max_tokens in prompts:
            try:
                r = chat_once([{"role": "user", "content": content}], max_tokens, False)
            except Exception as e:  # e.g. a deep prompt over the window: record it, keep the row
                results.append({"prompt": name, "error": f"{type(e).__name__}: {e}"[:300]})
                continue
            vram = vram_used_mib() - base_vram
            peak = max(peak, vram)
            text = r.pop("text")
            results.append({"prompt": name, **r, "thinking_leak": "<think>" in text, "head": text[:80],
                            "vram_mib": vram, "ram_gb": ram_avail_gb()})
        if followup:
            try:
                row["followup"] = followup_probe(followup)
                row["followup"]["ram_gb"] = ram_avail_gb()
                peak = max(peak, vram_used_mib() - base_vram)
            except Exception as e:
                row["followup"] = {"error": f"{type(e).__name__}: {e}"[:300]}
```

- Change `gen = [r["gen_tps"] for r in results if r["gen_tps"]]` to use `r.get("gen_tps")`.

- [ ] **Step 4: Run the tests.** `$PY -m unittest test_speed_grid -v`: 2 pass. Also run `$PY -c "import speed_pair, speedlab"`: no error.

- [ ] **Step 5: Commit.**
  ```
  git add scripts/moe-bench/moe_sweep.py scripts/moe-bench/test_speed_grid.py
  git commit -m "feat(longctx): moe_sweep cache type, warm-up subset, per-prompt errors, follow-up probe"
  ```

### Task 2: `speed_pair.py --grid`

**Files:**
- Modify: `scripts/moe-bench/speed_pair.py`
- Test: `scripts/moe-bench/test_speed_grid.py`

- [ ] **Step 1: Write the failing tests.** Append to `test_speed_grid.py`, above the `__main__` guard:

```python
import speed_pair as sp  # noqa: E402


def grow(ctx, ub, tps, spill, ctk="q8_0"):
    return {"tag": f"c{ctx}u{ub}{ctk}", "ctx": ctx, "ubatch": ub, "ctk": ctk, "shared_spill_mib": spill,
            "vram_delta_mib_peak": 6000,
            "runs": [{"prompt": "gen#0", "gen_tps": tps}, {"prompt": "edit2k#0", "gen_tps": 2 * tps},
                     {"prompt": "deep54k", "gen_tps": 1.0, "prompt_tps": 900}]}


class GridTest(unittest.TestCase):
    rows = [grow(16384, 512, 100, 200), grow(65536, 512, 97, 250), grow(98304, 512, 90, 200),
            grow(131072, 512, 100, 900)]

    def test_deep_for(self):
        self.assertEqual(sp.deep_for(16384), [])
        self.assertEqual(sp.deep_for(32768), [26000])
        self.assertEqual(sp.deep_for(65536), [26000, 54000])
        self.assertEqual(sp.deep_for(98304), [26000, 54000, 80000])
        self.assertEqual(sp.deep_for(131072), [26000, 54000, 80000, 108000])

    def test_deep_prompt(self):
        name, content, max_tokens = sp.deep_prompt(26000)
        self.assertEqual((name, max_tokens), ("deep26k", 300))
        self.assertLess(abs(len(content) - 26000 * sp.CHARS_PER_TOKEN), 200)
        self.assertTrue(content.endswith("with a one-line description of each."))

    def test_grid_prompt_names(self):
        self.assertEqual([n for n, _, _ in sp.grid_prompts(65536)],
                         ["gen#0", "edit2k#0", "gen#1", "edit2k#1", "gen#2", "edit2k#2", "long10k",
                          "deep26k", "deep54k"])

    def test_verdict(self):
        v = sp.verdict(self.rows + [grow(131072, 512, 99, 210, "q4_0")])
        self.assertEqual([r["pass"] for r in v["rows"]], [True, True, False, False, True])
        self.assertEqual(v["ctk"], {"16384": "q8_0", "65536": "q8_0", "131072": "q4_0"})
        self.assertEqual(v["largest_pass"], 131072)

    def test_a_failed_prompt_fails_the_row(self):
        bad = grow(32768, 512, 100, 200)
        bad["runs"][0] = {"prompt": "gen#0", "error": "HTTPError"}
        self.assertFalse(sp.verdict([self.rows[0], bad])["rows"][1]["pass"])

    def test_extra_and_top_rows(self):
        self.assertEqual(sp.extra_rows(self.rows), [(98304, 512, "q4_0"), (131072, 512, "q4_0")])
        self.assertEqual(sp.top_row(self.rows + [grow(131072, 512, 99, 210, "q4_0")]), [(131072, 1024, "q4_0")])
        self.assertEqual(sp.top_row(self.rows[:2]), [])
```

- [ ] **Step 2: Run them and check that they fail.** `$PY -m unittest test_speed_grid -v`: AttributeError, no `deep_for`.

- [ ] **Step 3: Implement.**
  - Add `import importlib.util` to the imports.
  - Extend the module docstring:

    ```
    --grid (2026-10-07, long-context spec §2): one GGUF over the window grid (GRID, a 16k control up to 128k). Each row
    runs the short prompts three times, long10k, the deep prompts that fit in 85% of the window and the follow-up probe
    on the deepest. Then q4_0 rows for windows from 64k up whose q8_0 row failed, and ub 1024 at the largest passing
    window above 64k. Writes OUT.jsonl and OUT.verdict.json. Models load with --load-mode none.

    usage: speed_pair.py --grid --out OUT.jsonl [--min-ram-gb 1.0] GGUF
    ```

  - Add after `prompts()`:

```python
# (window, ub, cache type) in run order, spec §2 rows 1-6
GRID = [(16384, 512, "q8_0"), (32768, 512, "q8_0"), (65536, 512, "q8_0"), (65536, 1024, "q8_0"),
        (98304, 512, "q8_0"), (131072, 512, "q8_0")]
DEEP = (26000, 54000, 80000, 108000)  # deep prompts, estimated tokens
CHARS_PER_TOKEN = 4.5  # 2026-10-06: long10k 40,000 chars -> 8,801 tokens, long15k 58,000 -> 12,789
DEEP_MODULES = ("argparse", "configparser", "difflib", "inspect", "tarfile", "zipfile", "http.client",
                "email.message", "logging", "dataclasses", "typing", "ast", "pickle", "calendar", "ipaddress",
                "fractions", "statistics", "textwrap", "shutil", "subprocess", "tempfile", "datetime", "random",
                "collections", "pathlib", "doctest", "optparse", "imaplib", "mailbox", "pdb", "threading",
                "traceback", "urllib.request", "http.server", "xml.dom.minidom", "html.parser", "unittest.case")


def stdlib_text(chars):
    parts, size = [], 0
    for mod in DEEP_MODULES:
        part = f"# file: {mod.replace('.', '/')}.py\n" + pathlib.Path(
            importlib.util.find_spec(mod).origin).read_text(encoding="utf-8") + "\n"
        parts.append(part)
        size += len(part)
        if size >= chars:
            return "".join(parts)[:chars]
    raise ValueError(f"the stdlib text runs out at {size} chars")


def deep_prompt(tokens):
    return (f"deep{tokens // 1000}k", "Here are several Python modules:\n\n```python\n"
            + stdlib_text(int(tokens * CHARS_PER_TOKEN))
            + "\n```\n\nList every class defined above with a one-line description of each.", 300)


def deep_for(window):
    return [t for t in DEEP if t <= 0.85 * window]


def grid_prompts(window):
    gen, edit, long10k = moe_sweep.build_prompts()
    short = [(f"{n}#{i}", c, m) for i in range(3) for n, c, m in (gen, edit)]
    return short + [long10k] + [deep_prompt(t) for t in deep_for(window)]


def short_tps(row):
    v = [r["gen_tps"] for r in row.get("runs", [])
         if r.get("gen_tps") and r["prompt"].split("#")[0] in ("gen", "edit2k")]
    return sum(v) / len(v) if v else None


def verdict(rows, tol=0.05, spill_tol=100):
    """A row passes if it loaded, every prompt was answered, short-prompt generation is within tol of the 16k
    control's, and overflow into shared memory is at most spill_tol MiB above the control's (spec §2). Returns the
    rows' verdicts, the cache type per passing window (ub 512 rows; q8_0 preferred) and the largest one."""
    control = next((r for r in rows if r["ctx"] == 16384 and r["ubatch"] == 512 and "error" not in r), None)
    if control is None or not short_tps(control):
        raise ValueError("no usable 16k control row")
    c_tps, c_spill = short_tps(control), control.get("shared_spill_mib") or 0
    out, ctk = [], {}
    for r in rows:
        ok = "error" not in r and bool(r.get("runs")) and all("error" not in x for x in r["runs"])
        ratio = short_tps(r) / c_tps if ok and short_tps(r) else None
        spill = (r.get("shared_spill_mib") or 0) - c_spill if ok else None
        passed = ratio is not None and ratio >= 1 - tol and spill <= spill_tol
        out.append({"tag": r["tag"], "ctx": r["ctx"], "ubatch": r["ubatch"], "ctk": r.get("ctk", "q8_0"),
                    "speed_ratio": round(ratio, 3) if ratio else None, "spill_over_control_mib": spill,
                    "vram_peak_mib": r.get("vram_delta_mib_peak"), "pass": passed,
                    "error": r.get("error") or next((x["error"] for x in r.get("runs", []) if "error" in x), None)})
        if passed and r["ubatch"] == 512 and ctk.get(str(r["ctx"])) != "q8_0":
            ctk[str(r["ctx"])] = r.get("ctk", "q8_0")
    return {"rows": out, "ctk": ctk, "largest_pass": max((int(w) for w in ctk), default=None)}


def extra_rows(rows):
    """q4_0 rows for each window from 64k up whose q8_0 ub-512 row failed."""
    return [(r["ctx"], 512, "q4_0") for r in verdict(rows)["rows"]
            if r["ubatch"] == 512 and r["ctk"] == "q8_0" and r["ctx"] >= 65536 and not r["pass"]]


def top_row(rows):
    """ub 1024 (Jarvis's batch) at the largest passing window above 64k; 64k's ub-1024 row is in GRID."""
    v = verdict(rows)
    w = v["largest_pass"]
    return [(w, 1024, v["ctk"][str(w)])] if w and w > 65536 else []


def grid(a, model, out, logdir):
    moe_sweep.EXTRA_ARGS = ["--load-mode", "none"]  # identical answers, ~2.5 GB less RAM (2026-10-07)
    rows = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines() if line.strip()] \
        if out.exists() else []
    rows = [r for r in rows if not str(r.get("error", "")).startswith("skipped")]
    idle = moe_sweep.vram_used_mib()

    def run(w, ub, ctk):
        if any(r["ctx"] == w and r["ubatch"] == ub and r.get("ctk", "q8_0") == ctk for r in rows):
            return
        ram = moe_sweep.ram_avail_gb()
        if ram < a.min_ram_gb:
            row = {"tag": f"ctx{w}_ub{ub}_{ctk}", "ctx": w, "ubatch": ub, "ctk": ctk,
                   "error": f"skipped: {ram} GB available"}
        else:
            ps = grid_prompts(w)
            deep = [c for n, c, _ in ps if n.startswith("deep")]
            row = moe_sweep.run_config(model, 0, 2, w, ub, None, logdir, ps, ctk=ctk, warm={"gen#0", "edit2k#0"},
                                       followup=deep[-1] if deep else None)
            rows.append(row)
        row["vram_total_mib"] = 8188
        with out.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        deep_runs = {r["prompt"]: (r.get("prompt_n"), r.get("prompt_tps"), r.get("gen_tps"))
                     for r in row.get("runs", []) if r["prompt"].startswith("deep")}
        fu = {k: v.get("prompt_n") for k, v in row.get("followup", {}).items() if isinstance(v, dict)}
        print(f"{time.strftime('%H:%M:%S')} ctx {w} ub {ub} {ctk}: short tps {short_tps(row)}; deep (prompt_n, "
              f"prompt tps, gen tps) {deep_runs}; VRAM peak {row.get('vram_delta_mib_peak')} spill "
              f"{row.get('shared_spill_mib')}; RAM {row.get('ram_avail_gb_during')}; follow-up prompt_n {fu}; "
              f"error {row.get('error')}", flush=True)

    for spec in GRID:
        run(*spec)
    for spec in extra_rows(rows):
        run(*spec)
    for spec in top_row(rows):
        run(*spec)
    v = verdict(rows)
    v["idle_vram_mib"] = idle
    out.with_suffix(".verdict.json").write_text(json.dumps(v, indent=1), encoding="utf-8")
    print(json.dumps({k: v[k] for k in ("ctk", "largest_pass", "idle_vram_mib")}), flush=True)
```

  - In `main()`, add `ap.add_argument("--grid", action="store_true")`. After `moe_sweep.EXTRA_ARGS = []`, add:

```python
    if a.grid:
        if len(a.models) != 1:
            sys.exit("--grid takes one GGUF")
        grid(a, a.models[0], out, logdir)
        return
```

- [ ] **Step 4: Run the tests.** `$PY -m unittest test_speed_grid -v`: all 9 pass.

- [ ] **Step 5: Commit.**
  ```
  git add scripts/moe-bench/speed_pair.py scripts/moe-bench/test_speed_grid.py
  git commit -m "feat(longctx): speed_pair --grid, the window grid with deep prompts and a verdict"
  ```

### Task 3: `longctx_build.py`, the session builder

**Files:**
- Create: `scripts/moe-bench/longctx_build.py`
- Test: `scripts/moe-bench/test_longctx_build.py`

- [ ] **Step 1: Write the failing tests** in `test_longctx_build.py`:

```python
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import longctx_build as lb  # noqa: E402
from bestofn_tier2b import TASKS  # noqa: E402


def fake_count(text):
    return len(text) // 4


class FillerTest(unittest.TestCase):
    counts = {f"u{i}": 50 + (i * 37) % 200 for i in range(200)}

    def test_hits_target_within_tolerance(self):
        for target in (1000, 5000, 12000):
            uids, total = lb.build_filler(list(self.counts), self.counts, target, 1)
            self.assertGreaterEqual(total, target * 0.95)
            self.assertLessEqual(total, target * 1.05)
            self.assertEqual(total, sum(self.counts[u] for u in uids))

    def test_same_seed_same_filler(self):
        a = lb.build_filler(list(self.counts), self.counts, 5000, 1)
        self.assertEqual(a, lb.build_filler(list(reversed(list(self.counts))), self.counts, 5000, 1))
        self.assertNotEqual(a[0], lb.build_filler(list(self.counts), self.counts, 5000, 2)[0])

    def test_runs_out(self):
        with self.assertRaises(ValueError):
            lb.build_filler(["a"], {"a": 10}, 1000, 1)

    def test_unit_tokens(self):
        self.assertEqual(lb.unit_tokens([("user", "abcd"), ("assistant", "abcdefgh")], fake_count), 13)


class UnitsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.units = lb.all_units(failure=lambda t: "AssertionError")

    def test_only_pool_and_stdlib(self):
        pool = {t["name"] for t in lb.load_tasks(lb.DOCS / "laya-calib" / "tasks.py", "_t_pool")}
        for uid, _ in self.units:
            kind, _, rest = uid.partition(":")
            self.assertIn(kind, ("ep", "file"))
            if kind == "ep":
                self.assertIn(rest, pool)
        self.assertGreaterEqual(sum(u.startswith("ep:") for u, _ in self.units), 55)

    def test_no_tier2b_or_judge_names(self):
        rx = lb.block_regex()
        self.assertTrue(rx.search("x = merge_intervals(a)"))
        self.assertTrue(rx.search(TASKS[-1]["name"]))
        self.assertFalse(rx.search("merge the intervals"))
        for uid, msgs in self.units:
            self.assertIsNone(rx.search("\n".join(c for _, c in msgs)), uid)

    def test_units_alternate_roles(self):
        for uid, msgs in self.units:
            roles = [r for r, _ in msgs]
            self.assertEqual(roles, ["user", "assistant"] * (len(roles) // 2), uid)

    def test_enough_material_for_the_largest_target(self):
        total = sum(lb.unit_tokens(m, fake_count) for _, m in self.units)
        self.assertGreater(total, 116000 * 1.3)


class SessionTest(unittest.TestCase):
    filler = [{"role": "user", "content": "f1"}, {"role": "assistant", "content": "a1"}]

    def test_late_ends_with_short(self):
        for task in TASKS[:5]:
            late = lb.late(task, self.filler)
            self.assertEqual(late[-1], lb.short(task)[0])
            self.assertEqual(late[:-1], self.filler)

    def test_early_shape(self):
        e = lb.early(TASKS[0], self.filler)
        self.assertEqual(e[0], lb.short(TASKS[0])[0])
        self.assertEqual([m["role"] for m in e], ["user", "assistant", "user", "assistant", "user"])
        self.assertEqual(e[-1]["content"], lb.EARLY_BACK)

    def test_messages_expand_units(self):
        units = {"a": [("user", "x"), ("assistant", "y")], "b": [("user", "z"), ("assistant", "w")]}
        self.assertEqual([m["content"] for m in lb.messages(units, ["b", "a"])], ["z", "w", "x", "y"])


class FailureTest(unittest.TestCase):
    def test_failure_output_has_no_local_paths(self):
        pool = lb.load_tasks(lb.DOCS / "laya-calib" / "tasks.py", "_t_pool2")
        out = lb.failure_output(pool[0])
        self.assertTrue(out)
        self.assertNotIn("lc-", out)
        self.assertNotIn(sys.base_prefix, out)
        self.assertNotIn("Users", out)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run them and check that they fail.** `$PY -m unittest test_longctx_build -v`: ModuleNotFoundError.

- [ ] **Step 3: Implement** `longctx_build.py`:

```python
"""Long-session builder for the long-context check (2026-10-07; spec 2026-10-07-long-context-design.md §3).

A session is a chat in the model's own template. Filler is made of units, each a run of user and assistant turns:
  episode    a calibration-pool task: the tier2b-style fix request with the buggy file's failing test output,
             answered with the reference fix; then "the test passes now" and a one-line acknowledgement
  file read  a chunk of a standard-library module shown "for context", acknowledged in one line
No unit contains a tier2b or old judge set task name, or a tier2b function or class name with an underscore
(block_regex). Token counts come through an injected counter (the server's /tokenize in a run), so this module
needs no model.
"""
import ast
import importlib.util
import pathlib
import random
import re
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from bestofn_tier2b import TASKS, baseline_prompt, seed  # noqa: E402

DOCS = HERE.parents[1] / "docs" / "benchmarks"
MODULES = ("argparse", "configparser", "csv", "difflib", "inspect", "pprint", "shlex", "statistics", "string",
           "tarfile", "calendar", "ipaddress", "email.message", "http.client", "urllib.parse", "logging",
           "dataclasses", "enum", "typing", "ast", "tokenize", "pickle", "gettext", "zipfile", "shutil",
           "subprocess", "tempfile", "datetime", "random", "pathlib", "glob", "queue", "contextlib", "textwrap",
           "fractions", "optparse", "mailbox", "doctest", "traceback", "threading")
CHUNK_CHARS = 6000
MSG_OVERHEAD = 5  # <|im_start|>, the role, a newline, <|im_end|> and a newline around each message
EARLY_ACK = "I'll look at related code first."
EARLY_BACK = "Back to the first task: write the complete fixed file now. Return only the complete corrected file."


def load_tasks(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.TASKS


def block_regex():
    words = {t["name"] for t in TASKS}
    words |= {t["name"] for t in load_tasks(DOCS / "laya-judge" / "tasks.py", "_lc_judge")}
    for t in TASKS:
        for src in t["files"].values():
            try:
                body = ast.parse(src).body
            except SyntaxError:
                continue
            words |= {n.name for n in body
                      if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and "_" in n.name.strip("_")}
    return re.compile(r"\b(" + "|".join(map(re.escape, sorted(words))) + r")\b")


def failure_output(task):
    """The last 12 lines of the task's test run against its buggy files, with local paths removed."""
    d = pathlib.Path(tempfile.mkdtemp(prefix="lc-"))
    try:
        seed(d, task)
        r = subprocess.run([sys.executable, "_t.py"], cwd=d, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return "The test timed out after 15 s."
    finally:
        shutil.rmtree(d, ignore_errors=True)
    if r.returncode == 0:
        return "Exit code 0 (the test does not catch the bug)."
    out = (r.stderr or r.stdout).replace(str(d), ".")
    for prefix in sorted({sys.prefix, sys.base_prefix}, key=len, reverse=True):
        out = out.replace(prefix, "<python>")
    return "\n".join(out.strip().splitlines()[-12:])


def episode(task, failure):
    ask = baseline_prompt(task) + f"\n\nRunning its test now gives:\n```\n{failure}\n```"
    return [("user", ask), ("assistant", f"```python\n{task['reference']}```"),
            ("user", "I ran the test again: exit code 0, no output."), ("assistant", "Good, the fix holds.")]


def file_units():
    units = []
    for mod in MODULES:
        path = pathlib.Path(importlib.util.find_spec(mod).origin)
        lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
        name = mod.replace(".", "/") + ".py"
        i = 0
        while i < len(lines):
            j, size = i, 0
            while j < len(lines) and size < CHUNK_CHARS:
                size += len(lines[j])
                j += 1
            text = "".join(lines[i:j]).rstrip()
            units.append((f"file:{mod}:{i + 1}",
                          [("user", f"For context, here is {name}, lines {i + 1}-{j}:\n```python\n{text}\n```"),
                           ("assistant", f"Read {name}, lines {i + 1}-{j}.")]))
            i = j
    return units


def all_units(failure=failure_output):
    """(uid, messages) for every pool episode and stdlib chunk that block_regex lets through."""
    rx = block_regex()
    pool = load_tasks(DOCS / "laya-calib" / "tasks.py", "_lc_pool")
    units = [(f"ep:{t['name']}", episode(t, failure(t))) for t in pool] + file_units()
    return [(uid, msgs) for uid, msgs in units if not rx.search("\n".join(c for _, c in msgs))]


def unit_tokens(msgs, count):
    return sum(count(c) + MSG_OVERHEAD for _, c in msgs)


def build_filler(uids, counts, target, seed_, tol=0.05):
    """Shuffle the unit ids with the seed; take each unit that keeps the total within target * (1 + tol) until the
    total reaches target * (1 - tol). Returns (picked ids, estimated tokens)."""
    order = sorted(uids)
    random.Random(seed_).shuffle(order)
    picked, total = [], 0
    for uid in order:
        if total + counts[uid] <= target * (1 + tol):
            picked.append(uid)
            total += counts[uid]
            if total >= target * (1 - tol):
                return picked, total
    raise ValueError(f"the units run out at {total} tokens for a target of {target}")


def messages(units, uids):
    return [{"role": role, "content": text} for uid in uids for role, text in units[uid]]


def short(task):
    return [{"role": "user", "content": baseline_prompt(task)}]


def late(task, filler):
    return filler + short(task)


def early(task, filler):
    return (short(task) + [{"role": "assistant", "content": EARLY_ACK}] + filler
            + [{"role": "user", "content": EARLY_BACK}])
```

- [ ] **Step 4: Run the tests.** `$PY -m unittest test_longctx_build -v`: all 12 pass.

- [ ] **Step 5: Commit.**
  ```
  git add scripts/moe-bench/longctx_build.py scripts/moe-bench/test_longctx_build.py
  git commit -m "feat(longctx): session builder from the calibration pool and stdlib, tier2b names blocked"
  ```

### Task 4: `longctx_sessions.py`, the runner, report, query and bar (a)

**Files:**
- Create: `scripts/moe-bench/longctx_sessions.py`
- Test: `scripts/moe-bench/test_longctx_sessions.py`

- [ ] **Step 1: Write the failing tests** in `test_longctx_sessions.py`:

```python
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import longctx_sessions as ls  # noqa: E402


def row(cond, w, t, task, trial, ok):
    return {"cond": cond, "window": w, "target": t, "task": task, "category": "A", "trial": trial,
            "graded_ok": ok, "prompt_ms": 1000, "prompt_n": 100, "cache_n": 0, "content": f"{task}{trial}{ok}"}


def rows_for(late_ok, n_tasks=6, w=65536, t=56000):
    """Short solves everything; Late solves task i on every trial when late_ok(i)."""
    out = {}
    for i in range(n_tasks):
        for trial in range(3):
            for r in (row("short", w, 0, f"t{i}", trial, True), row("late", w, t, f"t{i}", trial, late_ok(i))):
                out[ls.key_of(r)] = r
    return out


class ReportTest(unittest.TestCase):
    def test_bar_b_fails_on_a_significant_loss(self):
        g = ls.summarize(rows_for(lambda i: False), expected=18)["65536/56000"]
        self.assertEqual(g["solved"], {"short": 18, "late": 0})
        self.assertEqual((g["late_vs_short"]["short_tasks"], g["late_vs_short"]["cond_tasks"]), (6, 0))
        self.assertLess(g["late_vs_short"]["sign_p"], 0.10)
        self.assertFalse(g["bar_b_pass"])

    def test_bar_b_passes_on_a_small_loss(self):
        g = ls.summarize(rows_for(lambda i: i > 0), expected=18)["65536/56000"]
        self.assertEqual(g["late_vs_short"]["short_tasks"], 1)
        self.assertTrue(g["bar_b_pass"])

    def test_incomplete_group_does_not_pass(self):
        g = ls.summarize(rows_for(lambda i: True), expected=117)["65536/56000"]
        self.assertFalse(g["complete"])
        self.assertFalse(g["bar_b_pass"])

    def test_short_against_stored(self):
        rs = rows_for(lambda i: True, n_tasks=2)
        stored = {(r["task"], r["trial"]): {"content": r["content"], "graded_ok": r["graded_ok"]}
                  for r in rs.values() if r["cond"] == "short"}
        stored[("t0", 0)] = {"content": "other", "graded_ok": False}
        rep = ls.summarize(rs, stored=stored, expected=6)
        self.assertEqual(rep["short_vs_stored"]["65536"],
                         {"n": 6, "same_text": 5, "same_grade": 5, "stored_solved": 5, "short_solved": 6})


class AnswerTest(unittest.TestCase):
    verdict = {"ctk": {"16384": "q8_0", "32768": "q8_0", "65536": "q8_0", "131072": "q4_0"}}

    @staticmethod
    def rep(passes):
        return {f"{w}/{ls.TARGETS[w]}": {"window": w, "target": ls.TARGETS[w], "complete": True, "bar_b_pass": p}
                for w, p in passes.items()}

    def ask(self, what, rep=None, bar_a=None):
        return ls.answer(what, self.verdict, rep or {}, bar_a or {})

    def test_queries(self):
        self.assertEqual(self.ask("ctk:65536"), "q8_0")
        self.assertEqual(self.ask("ctk:98304"), "none")
        self.assertEqual(self.ask("target:131072"), "116000")
        self.assertEqual(self.ask("top"), "131072")
        self.assertEqual(self.ask("barb:65536"), "missing")
        self.assertEqual(self.ask("barb:65536", self.rep({65536: True})), "pass")
        self.assertEqual(self.ask("barb:65536", self.rep({65536: False})), "fail")
        self.assertEqual(self.ask("bara:65536", bar_a={65536: True}), "pass")
        self.assertEqual(self.ask("bara:131072", bar_a={65536: True}), "missing")

    def test_chosen(self):
        both = self.rep({65536: True, 131072: True})
        self.assertEqual(self.ask("chosen", both, {65536: True, 131072: False}), "65536")
        self.assertEqual(self.ask("chosen", both, {65536: True, 131072: True}), "131072")
        self.assertEqual(self.ask("chosen", self.rep({65536: False}), {65536: True}), "none")

    def test_incomplete_group_is_missing(self):
        rep = self.rep({65536: True})
        rep["65536/56000"]["complete"] = False
        self.assertEqual(self.ask("barb:65536", rep), "missing")


class BarATest(unittest.TestCase):
    @staticmethod
    def outcomes(ok):
        return {(f"t{i}", "A", tr): {"single": ok(i), "recipe": ok(i)} for i in range(6) for tr in range(3)}

    def test_identical_runs_pass(self):
        o = self.outcomes(lambda i: i % 2 == 0)
        r = ls.bar_a(o, o)
        self.assertTrue(r["pass"])
        self.assertEqual((r["stored_only"], r["new_only"], r["new_solved"]), (0, 0, 9))

    def test_a_significant_loss_fails(self):
        r = ls.bar_a(self.outcomes(lambda i: True), self.outcomes(lambda i: False))
        self.assertFalse(r["pass"])
        self.assertEqual((r["stored_tasks"], r["new_tasks"]), (6, 0))


class CountsTest(unittest.TestCase):
    def test_cached_once_and_recounted_when_changed(self):
        calls = []

        def count(text):
            calls.append(text)
            return len(text)

        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d) / "c.json"
            units = [("a", [("user", "xx"), ("assistant", "y")])]
            self.assertEqual(ls.unit_counts(units, p, count), {"a": 13})
            n = len(calls)
            ls.unit_counts(units, p, count)
            self.assertEqual(len(calls), n)
            ls.unit_counts([("a", [("user", "xxx"), ("assistant", "y")])], p, count)
            self.assertGreater(len(calls), n)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run them and check that they fail.** `$PY -m unittest test_longctx_sessions -v`: ModuleNotFoundError.

- [ ] **Step 3: Implement** `longctx_sessions.py`:

```python
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
```

- [ ] **Step 4: Run the tests.** `$PY -m unittest test_longctx_sessions test_longctx_build test_speed_grid -v`: all pass.

- [ ] **Step 5: Commit.**
  ```
  git add scripts/moe-bench/longctx_sessions.py scripts/moe-bench/test_longctx_sessions.py
  git commit -m "feat(longctx): Short/Late/Early runner, report with bar (b), chain queries, bar (a)"
  ```

### Task 5: The chain script, README, and a short GPU smoke run

**Files:**
- Create: `scripts/moe-bench/longctx-runs/run_longctx.sh`
- Modify: `scripts/moe-bench/README.md`, adding rows for the new files

- [ ] **Step 1: Write `run_longctx.sh`:**

```bash
#!/usr/bin/env bash
# Long-context check for keep96 (spec docs/superpowers/specs/2026-10-07-long-context-design.md, plan
# docs/superpowers/plans/2026-10-07-long-context.md): the memory and speed grid; Short and Late at 64k; bar (a) at
# 64k if Late passes; Short and Late at the largest window that fits, then its bar (a); Early at 64k last (reported
# only). If Late fails at 64k, Short and Late at 32k instead. Every runner resumes per sample. The Versutus gate is
# paused here and restored on exit, even on failure. A watchdog stops everything before 01:00 on 2026-10-08 (the
# Laya v3 run starts at 01:30); an unfinished step resumes after that run.
set -u
PY=/c/qwen3-forge-stage/venv/Scripts/python.exe
WT=/c/Projects/home-base-recovered/.claude/worktrees/micro-agent-swarm-design-929d42
MB=$WT/scripts/moe-bench
L=/c/qwen3-forge-stage/logs/longctx
K96='C:\qwen3-forge-stage\models\prune-qwen36\Qwen3.6-35B-A3B-UD-IQ2_M-keep96.gguf'
STORED=$WT/docs/benchmarks/2026-10-06/tier2b-recipe-keep96-2026-10-06.jsonl
RUNS=$L/sessions.jsonl
mkdir -p "$L"
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$L/chain.log"; }
gpu_free() { while tasklist //FI "IMAGENAME eq llama-server.exe" 2>/dev/null | grep -qi llama-server; do sleep 15; done; }
gate() { powershell -NoProfile -Command "Set-Location C:\Projects\Versutus; node gate\cli.mjs service $1" >> "$L/chain.log" 2>&1; }
q() { "$PY" "$MB/longctx_sessions.py" query --verdict "$L/grid.verdict.json" --report "$L/report.json" --bar-a-dir "$L" "$1"; }
stopped() { [ -e "$L/STOP" ]; }
DEADLINE=$(date -d "2026-10-08 00:55" +%s)

rm -f "$L/STOP" "$L/chain.done"
finish() { gate start; log "Versutus gate start requested; chain done"; touch "$L/chain.done"; }
trap finish EXIT
( while [ "$(date +%s)" -lt "$DEADLINE" ]; do sleep 30; [ -e "$L/chain.done" ] && exit 0; done
  touch "$L/STOP"; sleep 150; taskkill //F //IM llama-server.exe > /dev/null 2>&1 ) &

log "start; idle VRAM $(nvidia-smi --query-gpu=memory.used --format=csv,noheader)"
gate stop
gpu_free

# 1. Memory and speed grid (spec §2)
if [ ! -e "$L/grid.verdict.json" ]; then
  "$PY" "$MB/speed_pair.py" --grid --out "$L/grid.jsonl" --min-ram-gb 1.0 "$K96" > "$L/grid.out" 2>&1
  log "grid exit $?; $(tail -1 "$L/grid.out")"
fi
[ -e "$L/grid.verdict.json" ] || { log "no grid verdict; stopping"; exit 1; }

session() {  # session WINDOW CONDS
  local w=$1 conds=$2 k guard=2048 rc
  k=$(q "ctk:$w")
  if [ "$k" = none ]; then log "session $w $conds skipped: the window did not pass the grid"; return 1; fi
  for try in 1 2 3; do
    stopped && return 1
    gpu_free
    sleep 20
    "$PY" "$MB/longctx_sessions.py" run --window "$w" --target "$(q "target:$w")" --conds "$conds" \
      --extra "[\"-ctk\",\"$k\",\"-ctv\",\"$k\"]" --out "$RUNS" --counts "$L/unit-tokens.json" \
      --stop-file "$L/STOP" --min-free-mb "$guard" >> "$L/sessions.out" 2>&1
    rc=$?
    log "session $w $conds try $try exit $rc (guard $guard MB)"
    [ $rc -eq 2 ] && guard=1024
    [ $rc -eq 0 ] || [ $rc -eq 3 ] && break
    sleep 30
  done
  "$PY" "$MB/longctx_sessions.py" report --runs "$RUNS" --stored "$STORED" --out "$L/report.json" > "$L/report.out" 2>&1
  log "report exit $?: $(grep -c 'bar (b) PASS' "$L/report.out") group(s) pass bar (b)"
}

bar_a() {  # bar_a WINDOW
  local w=$1 k
  k=$(q "ctk:$w")
  stopped && return 1
  gpu_free
  sleep 20
  BON_EXTRA="[\"--load-mode\",\"none\",\"-c\",\"$w\",\"-ctk\",\"$k\",\"-ctv\",\"$k\"]" "$PY" "$MB/bestofn_tier2b.py" run \
    --model qwen36keep96 --n 3 --suites 1 --trials 3 --temp-alt 0.7 --out "$L/recipe-$w.jsonl" > "$L/recipe-$w.out" 2>&1
  log "recipe $w exit $?"
  stopped && return 1
  "$PY" "$MB/longctx_sessions.py" bar-a --stored "$STORED" --new "$L/recipe-$w.jsonl" --out "$L/bar-a-$w.json" \
    > "$L/bar-a-$w.out" 2>&1
  log "bar (a) $w: $(q "bara:$w")"
}

# 2. Short and Late at 64k (bar (b)), then bar (a) at 64k; 3. the largest window that fits
session 65536 short,late
case "$(q barb:65536)" in
  pass)
    bar_a 65536
    TOP=$(q top)
    if [ "$TOP" != none ] && [ "$TOP" -gt 65536 ]; then
      session "$TOP" short,late
      [ "$(q "barb:$TOP")" = pass ] && bar_a "$TOP"
    fi ;;
  fail)
    session 32768 short,late
    [ "$(q barb:32768)" = pass ] && bar_a 32768 ;;
  *) log "64k Late incomplete; resume after the Laya v3 run" ;;
esac
# 4. Early at 64k (reported only)
session 65536 early
log "chosen window: $(q chosen)"
```

- [ ] **Step 2: Add README rows** to `scripts/moe-bench/README.md`, under the `speed_pair.py` row:

```
| `speed_pair.py --grid` | Long-context memory and speed grid (2026-10-07): windows 16k–128k with deep prompts, overflow into shared memory, a follow-up-turn probe, and a verdict per window. |
| `longctx_build.py` | Builds long agent sessions from the calibration pool and stdlib files; tier2b and judge-set names are blocked. |
| `longctx_sessions.py` | Short / Late / Early runs at a window, graded by tier2b's tests; the report with bar (b), the chain's queries, and bar (a). |
| `longctx-runs/run_longctx.sh` | The long-context GPU chain: grid, 64k, the largest window, bar (a), Early; a watchdog stops it before 01:00. |
```

- [ ] **Step 3: GPU smoke run** (about 3 min), with the gate paused and no llama-server running:

```bash
"$PY" "$MB/longctx_sessions.py" run --window 65536 --target 8000 --conds short,late,early --tasks 2 --trials 1 \
  --out /c/qwen3-forge-stage/logs/longctx-smoke/smoke.jsonl --counts /c/qwen3-forge-stage/logs/longctx-smoke/unit-tokens.json
```

Expected:
- exit 0;
- 6 rows;
- Late rows with `prompt_n` near 8,000 on the first task of the trial and fewer on the second if reuse works;
- graded results present;
- `smoke.fillers.json` lists the units.

Delete `logs/longctx-smoke` afterwards. The real unit-token cache is rebuilt in the chain.

- [ ] **Step 4: Commit and push.**
  ```
  git add scripts/moe-bench/longctx-runs/run_longctx.sh scripts/moe-bench/README.md
  git commit -m "feat(longctx): GPU chain with the gate paused, RAM guard and a 01:00 watchdog"
  git push
  ```

### Task 6: Run the chain

- [ ] **Step 1:** Confirm that no llama-server is running (`tasklist | grep llama-server`) and record the idle VRAM.
- [ ] **Step 2:** Start the chain in the background: `bash scripts/moe-bench/longctx-runs/run_longctx.sh`.
- [ ] **Step 3: Poll `chain.log` and the `.out` files.** No `tail -F` monitors (project memory: monitor orphans). Act on a failure only through the documented retries. Never start a second server.

### Task 7: Results (before 01:00)

- [ ] **Step 1: Copy into `docs/benchmarks/longctx/`:**
  - `grid.jsonl`, `grid.verdict.json`;
  - `sessions.jsonl`, `sessions.fillers.json`;
  - `report.json`;
  - `recipe-*.jsonl`, `bar-a-*.json`;
  - `chain.log`.

  Then run `scrub_paths.py` over them.
- [ ] **Step 2: Write `docs/superpowers/specs/2026-10-07-long-context-results.md`:**
  - the outcome per window;
  - the grid table (VRAM, spill, short-prompt speed ratio, prompt and generation speed at depth, follow-up prompt_n);
  - Short / Late / Early with both tests;
  - bar (a) with the identical-answer count;
  - the chosen window;
  - deviations;
  - what rollout changes.
- [ ] **Step 3: Update the project memory** with a new file plus a `MEMORY.md` line.
- [ ] **Step 4: Commit and push.** The worktree must be clean before 01:00.

### Task 8: Rollout (after the Laya v3 run has finished, about 15:00 on 2026-10-08; only if a window ≥ 64k passed)

With `W` the chosen window and `K` its cache type:
- [ ] **Step 1: Serve script.** In `serve-qwen36-35b.ps1`, set `'-c', '16384'` → `'-c', 'W'`, and `-ctk`/`-ctv` → `K` if it isn't q8_0. Add the measured row to the docblock table.
- [ ] **Step 2: Jarvis config.**
  - Back up `~/.openclaw/jarvis/config.json` and `%USERPROFILE%\.local\share\com.jarvis.desktop\jarvis.db` as `*.pre-longctx-<timestamp>.bak`.
  - Set `llama_cpp.context_window = W` in both. Set `batch_size = 512` too if the grid's ub-1024 row at `W` failed.
  - Cache type: if `K` is not q8_0, Jarvis has no field for it. Stop and ask the owner.
- [ ] **Step 3: Live check.**
  - Restart Jarvis and confirm `GET http://127.0.0.1:8080/props` reports `n_ctx = W`.
  - Hold one chat past 30k tokens.
- [ ] **Step 4: Commit and push** the serve-script change, then update memory.
