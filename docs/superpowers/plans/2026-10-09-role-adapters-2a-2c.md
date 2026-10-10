# Role adapters, phases 2a to 2c: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the teacher data pipeline, the local QLoRA training and the pre-registered role and retention gates, then train and score the arm-S adapters (plan, build, fix) on Qwen3.5-9B and Qwen3.5-4B.

**Architecture:** `scripts/roles/` holds small focused modules: frozen field splits, Ecosystem-Lab exclusion, sample and fault builders (they reuse `scripts/teacher/teacher_gen.py`), a QLoRA trainer that runs in Unsloth Studio's Python, a llama-server wrapper, and the evaluation harness. Adapters are trained on the 4-bit HF weights and served as GGUF LoRAs on a Q5_K_M base in llama-server 836d571 for evaluation.

**Tech Stack:** Python 3.12 (benchmark venv, `$PY`) for data and evaluation; Unsloth Studio's Python 3.11 (`$UPY`: torch 2.10+cu130, transformers 5.5, peft 0.18, bitsandbytes 0.50, trl 0.23) for training; llama.cpp converters from `~/.unsloth/llama.cpp`; DeepSeek v4.1 Flash through OpenCode Go (key read inside Python, never printed).

**Spec:** `docs/superpowers/specs/2026-10-09-role-adapters-design.md` (read it first). **Later plans (written when reached, each after the owner's sign-off on the previous results):** 2d arm O, 2e headline and Build B2, 2f report.

**Conventions.** Repo root is the micro-agent-swarm worktree. `PY=/c/qwen3-forge-stage/venv/Scripts/python.exe`, `UPY=$HOME/.unsloth/studio/unsloth_studio/Scripts/python.exe`. Code blocks with `file=<path>` in the fence header are the files; `python scripts/roles/plan_extract.py <this plan> <path>` writes one (Task 0 creates the extractor). Tests are `unittest`, run from `scripts/roles`. Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never print a key; scrub paths (`scripts/moe-bench/scrub_paths.py`) and grep for the account name before every push. Data lives on E: (`E:/AI/teacher-data/gen-v0`, `E:/AI/role-adapters`), never D:, nothing big on C:.

**GPU hygiene for Tasks 8 to 16** (as in Step 1): pause the Versutus gate (`cd /c/Projects/Versutus && node gate/cli.mjs service stop`), keep `scripts/moe-bench/laya-runs/wsl_guard.sh <marker>` running, one GPU process at a time, no llama-server left behind, restore the gate at the end (`service start`, poll `service status` until `lastHealthyAt` is newer than the restart).

---

## File structure

| File | Responsibility |
|---|---|
| `scripts/roles/plan_extract.py` | writes files out of this plan |
| `scripts/roles/splits.py` | the frozen field split (train / dev / test) |
| `scripts/roles/exclude.py` | keeps the Ecosystem Lab out of the teacher data |
| `scripts/roles/prepare_seeds.py` | seeds.jsonl to seeds-clean.jsonl (split, exclusion) |
| `scripts/roles/samples.py` | prompts, file rendering, role samples and dataset files |
| `scripts/roles/faults.py` | teacher-authored faults for the fix role |
| `scripts/roles/llama_server.py` | llama-server wrapper (base GGUF, optional LoRA GGUF) |
| `scripts/roles/qlora_common.py` | 4-bit load, gradient checkpointing, reply-only chunked loss (runs in `$UPY`) |
| `scripts/roles/train_lora.py` | QLoRA SFT for one adapter (runs in `$UPY`) |
| `scripts/roles/smoke_qlora.py` | the memory and speed smoke test (runs in `$UPY`) |
| `scripts/roles/serve_lora_check.py` | trained LoRA to GGUF to llama-server reproduces its targets |
| `scripts/roles/eval_roles.py` | build / plan / fix gates, adapter versus base |
| `scripts/roles/retention.py` | tier2b and general-knowledge retention |
| `scripts/teacher/teacher_gen.py` | modified: `gen --seeds-file --splits`, split in each run record |

---

### Task 0: the plan extractor

**Files:** Create `scripts/roles/plan_extract.py`; Test `scripts/roles/test_plan_extract.py`.

- [ ] **Step 1: create the extractor and its test by hand** (they bootstrap everything else)

```python file=scripts/roles/plan_extract.py
"""Writes files out of a plan document: a fenced block whose header is `<lang> file=<path>` is that file.
usage: plan_extract.py PLAN.md PATH [PATH ...]   (paths as written in the plan, relative to the repo root)"""
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
BLOCK = re.compile(r"^```(\w+) file=(\S+)\n(.*?)\n```$", re.S | re.M)


def blocks(text):
    return {m.group(2): m.group(3) + "\n" for m in BLOCK.finditer(text)}


def main():
    found = blocks(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    for want in sys.argv[2:]:
        if want not in found:
            sys.exit(f"{want}: no such block in the plan")
        path = REPO / want
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(found[want], encoding="utf-8", newline="\n")
        print("wrote", want)


if __name__ == "__main__":
    main()
```

```python file=scripts/roles/test_plan_extract.py
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import plan_extract  # noqa: E402

FENCE = "`" * 3


class ExtractTest(unittest.TestCase):
    def test_blocks(self):
        text = f"intro\n{FENCE}python file=a/b.py\nx = 1\ny = 2\n{FENCE}\n\n{FENCE}bash\necho hi\n{FENCE}\n"
        self.assertEqual(plan_extract.blocks(text), {"a/b.py": "x = 1\ny = 2\n"})


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: run the test**

Run: `cd scripts/roles && $PY -m unittest test_plan_extract -v`
Expected: `OK` (1 test).

- [ ] **Step 3: commit**

```bash
git add scripts/roles/plan_extract.py scripts/roles/test_plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md
git commit -m "feat(roles): plan extractor and the 2a-2c implementation plan"
```

---

### Task 1: frozen field splits

**Files:** Create `scripts/roles/splits.py`; Test `scripts/roles/test_splits.py`.

- [ ] **Step 1: extract and run the test (it must fail)**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/test_splits.py && cd scripts/roles && $PY -m unittest test_splits`
Expected: FAIL, `ModuleNotFoundError: No module named 'splits'`.

```python file=scripts/roles/test_splits.py
import pathlib
import random
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
for p in (HERE, HERE.parent / "teacher", HERE.parent / "moe-bench"):
    sys.path.insert(0, str(p))
import splits  # noqa: E402


class SplitsTest(unittest.TestCase):
    def test_counts(self):
        counts = {s: sum(v == s for v in splits.SPLITS.values()) for s in ("train", "dev", "test")}
        self.assertEqual(counts, {"train": 14, "dev": 2, "test": 4})

    def test_matches_the_seeded_shuffle(self):
        import teacher_gen
        fields = list(teacher_gen.FIELDS)
        random.Random(20261009).shuffle(fields)
        want = {f: "test" for f in fields[:4]} | {f: "dev" for f in fields[4:6]} | {f: "train" for f in fields[6:]}
        self.assertEqual(splits.SPLITS, want)

    def test_unknown_field_raises(self):
        with self.assertRaises(KeyError):
            splits.split_of("not a field")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: write the implementation**

```python file=scripts/roles/splits.py
"""Frozen field splits for the role-adapter experiment (spec 2026-10-09-role-adapters-design.md, section 2).
Fixed on 2026-10-09 by random.Random(20261009).shuffle over teacher_gen.FIELDS (test: first 4, dev: next 2, train: the
rest), before any teacher data was looked at; test_splits.py checks this table against that rule."""

SPLITS = {
    "developer tooling": "test", "accessibility": "test", "small business operations": "test",
    "security and privacy": "test",
    "media and libraries": "dev", "team collaboration": "dev",
    "casual games and puzzles": "train", "hobbies and crafts": "train", "personal productivity": "train",
    "open-source maintenance": "train", "system administration": "train", "documentation and writing": "train",
    "health and fitness": "train", "home and family organisation": "train", "data analysis": "train",
    "education and study": "train", "science and mathematics": "train", "creative tools": "train",
    "travel and maps": "train", "networking and the web": "train",
}


def split_of(field):
    return SPLITS[field]
```

- [ ] **Step 3: run the tests**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/splits.py && cd scripts/roles && $PY -m unittest test_splits -v`
Expected: `OK` (3 tests).

- [ ] **Step 4: commit**

```bash
git add scripts/roles/splits.py scripts/roles/test_splits.py
git commit -m "feat(roles): frozen field splits"
```

---

### Task 2: keep the Ecosystem Lab out of the data

**Files:** Create `scripts/roles/exclude.py`; Test `scripts/roles/test_exclude.py`.

- [ ] **Step 1: extract the test and watch it fail**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/test_exclude.py && cd scripts/roles && $PY -m unittest test_exclude`
Expected: FAIL, `ModuleNotFoundError: No module named 'exclude'`.

```python file=scripts/roles/test_exclude.py
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import exclude  # noqa: E402


class ExcludeTest(unittest.TestCase):
    def test_lab_terms_hit(self):
        self.assertIn("term", exclude.lab_hit("Simulate rabbits and foxes moving on a grid."))

    def test_phrase_hit(self):
        self.assertIn("phrase", exclude.lab_hit("A study of population dynamics over time."))

    def test_unrelated_request_is_clean(self):
        self.assertIsNone(exclude.lab_hit(
            "A command-line tool that converts CSV files to Markdown tables, aligning columns and escaping pipes."))

    def test_copy_of_the_lab_prompt_hits(self):
        text = exclude.LAB_PROMPT.read_text(encoding="utf-8")[:1500]
        self.assertIsNotNone(exclude.lab_hit(text))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: write the implementation**

```python file=scripts/roles/exclude.py
"""Keeps the Ecosystem Lab (and anything near it) out of the teacher data (spec section 2)."""
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE.parent / "moe-bench" / "train_tasks"))
import make  # noqa: E402

LAB_PROMPT = REPO / "docs" / "benchmarks" / "oneshot" / "ecosystem-lab" / "prompt.md"
TERMS = {"ecosystem", "predator", "prey", "lotka", "volterra", "rabbit", "rabbits", "fox", "foxes", "rk4"}
PHRASES = ("population dynamics", "food chain", "predator-prey")
JACCARD_LIMIT = 0.3
_lab = None


def lab_words():
    global _lab
    if _lab is None:
        _lab = make.words(LAB_PROMPT.read_text(encoding="utf-8"))
    return _lab


def lab_hit(text):
    """A reason string if the text names a Lab topic or is within JACCARD_LIMIT of the Lab prompt, else None."""
    low = text.lower()
    hit = sorted(set(re.findall(r"[a-z0-9]+", low)) & TERMS)
    if hit:
        return "term: " + ",".join(hit)
    for phrase in PHRASES:
        if phrase in low:
            return "phrase: " + phrase
    j = make.jaccard(make.words(text), lab_words())
    return f"jaccard {j:.2f}" if j >= JACCARD_LIMIT else None
```

- [ ] **Step 3: run the tests**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/exclude.py && cd scripts/roles && $PY -m unittest test_exclude -v`
Expected: `OK` (4 tests).

- [ ] **Step 4: commit**

```bash
git add scripts/roles/exclude.py scripts/roles/test_exclude.py
git commit -m "feat(roles): exclude Ecosystem Lab topics from teacher data"
```

---

### Task 3: seeds-clean.jsonl and the `gen` options

**Files:** Create `scripts/roles/prepare_seeds.py`; Test `scripts/roles/test_prepare_seeds.py`; Modify `scripts/teacher/teacher_gen.py` (`gen`, argparse).

- [ ] **Step 1: extract the test and watch it fail**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/test_prepare_seeds.py && cd scripts/roles && $PY -m unittest test_prepare_seeds`
Expected: FAIL, `ModuleNotFoundError: No module named 'prepare_seeds'`.

```python file=scripts/roles/test_prepare_seeds.py
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import prepare_seeds  # noqa: E402


def row(i, request, field="data analysis", **kw):
    return dict({"lang": "python", "kind": "library module with a small API", "field": field, "i": i,
                 "title": "t", "request": request, "entry": "a.py", "tests": "x"}, **kw)


class PrepareTest(unittest.TestCase):
    def test_flags_and_split(self):
        d = pathlib.Path(tempfile.mkdtemp())
        rows = [row(0, "Parse CSV files and print a Markdown table."),
                row(1, "Simulate rabbits and foxes on a grid."),
                {"lang": "python", "kind": "k", "field": "data analysis", "empty": True},
                row(2, "A tool.", field="accessibility"),
                row(3, "Excluded upstream.", excluded=True)]
        (d / "seeds.jsonl").write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
        counts = prepare_seeds.prepare(d / "seeds.jsonl", d / "seeds-clean.jsonl")
        out = [json.loads(line) for line in (d / "seeds-clean.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(out), 3)
        self.assertEqual([r["split"] for r in out], ["train", "train", "test"])
        self.assertEqual([r["lab_excluded"] for r in out], [False, True, False])
        self.assertEqual(out[0]["sid"], "python|library module with a small API|data analysis|0")
        self.assertEqual(counts["usable"], {"train": 1, "test": 1})


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: write the implementation**

```python file=scripts/roles/prepare_seeds.py
"""seeds.jsonl -> seeds-clean.jsonl: drops empty and upstream-excluded rows, adds sid and split, flags Lab-near seeds.
usage: prepare_seeds.py --dir E:/AI/teacher-data/gen-v0"""
import argparse
import collections
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import exclude  # noqa: E402
import splits  # noqa: E402


def prepare(src, dst):
    kept, usable = 0, collections.Counter()
    with open(dst, "w", encoding="utf-8") as out:
        for line in open(src, encoding="utf-8"):
            r = json.loads(line)
            if r.get("empty") or r.get("excluded"):
                continue
            r["sid"] = "|".join([r["lang"], r["kind"], r["field"], str(r["i"])])
            r["split"] = splits.split_of(r["field"])
            reason = exclude.lab_hit(r.get("title", "") + " " + r["request"])
            r["lab_excluded"], r["lab_reason"] = bool(reason), reason
            out.write(json.dumps(r) + "\n")
            kept += 1
            usable[r["split"]] += not r["lab_excluded"]
    return {"rows": kept, "usable": dict(usable)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    a = ap.parse_args()
    d = pathlib.Path(a.dir)
    print(json.dumps(prepare(d / "seeds.jsonl", d / "seeds-clean.jsonl")))


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: run the tests**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/prepare_seeds.py && cd scripts/roles && $PY -m unittest test_prepare_seeds -v`
Expected: `OK` (1 test).

- [ ] **Step 4: patch `teacher_gen.gen` to read the cleaned seeds, filter by split and record the split**

```python
# run once from the repo root: $PY - < this block, or save as patch_gen.py
import pathlib

p = pathlib.Path("scripts/teacher/teacher_gen.py")
s = p.read_text(encoding="utf-8")


def swap(old, new):
    global s
    assert s.count(old) == 1, old[:60]
    s = s.replace(old, new, 1)


swap('''    seeds_ = [r for r in map(json.loads, open(out / "seeds.jsonl", encoding="utf-8"))
              if not r.get("empty") and not r.get("excluded")]''',
     '''    keep_splits = set(a.splits.split(",")) if a.splits else None
    seeds_ = [r for r in map(json.loads, open(out / a.seeds_file, encoding="utf-8"))
              if not r.get("empty") and not r.get("excluded") and not r.get("lab_excluded")
              and (keep_splits is None or r.get("split") in keep_splits)]''')
swap('''        rec = {"lang": s["lang"], "kind": s["kind"], "field": s["field"], "i": s["i"], "backend": a.backend,''',
     '''        rec = {"lang": s["lang"], "kind": s["kind"], "field": s["field"], "i": s["i"], "backend": a.backend,
               "split": s.get("split"),''')
swap('''        if name == "seeds":''',
     '''        if name == "gen":
            s.add_argument("--seeds-file", default="seeds.jsonl", help="seeds.jsonl or seeds-clean.jsonl")
            s.add_argument("--splits", default="", help="comma-separated splits to generate (default all)")
        if name == "seeds":''')
p.write_text(s, encoding="utf-8")
print("patched")
```

- [ ] **Step 5: check the patched CLI and commit**

Run: `$PY scripts/teacher/teacher_gen.py gen --help`
Expected: usage text listing `--seeds-file` and `--splits`.

```bash
git add scripts/roles/prepare_seeds.py scripts/roles/test_prepare_seeds.py scripts/teacher/teacher_gen.py
git commit -m "feat(roles): seeds-clean.jsonl and gen --seeds-file/--splits"
```

---

### Task 4: role samples

**Files:** Create `scripts/roles/samples.py`; Test `scripts/roles/test_samples.py`.

- [ ] **Step 1: extract the test and watch it fail**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/test_samples.py && cd scripts/roles && $PY -m unittest test_samples`
Expected: FAIL, `ModuleNotFoundError: No module named 'samples'`.

```python file=scripts/roles/test_samples.py
import json
import pathlib
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import edits  # noqa: E402
import samples  # noqa: E402

FENCE = "`" * 3
GOOD = f"{FENCE}python\n# file: calc.py\ndef add(a, b):\n    return a + b\n{FENCE}"
BAD_FIRST = f"{FENCE}python\n# file: calc.py\ndef add(a, b):\n    return a - b\n{FENCE}"


def rec(i, **kw):
    base = {"lang": "python", "kind": "library module with a small API", "field": "data analysis", "i": i,
            "request": "Write add(a, b).", "entry": "calc.py", "tests": "t", "plan": "PLAN", "build": GOOD,
            "build_ok": True, "build_out": ""}
    base.update(kw)
    return base


class SamplesTest(unittest.TestCase):
    def test_roles_by_outcome(self):
        runs = [rec(0),
                rec(1, build=BAD_FIRST, build_ok=False, build_out="AssertionError", fix=GOOD, fix_ok=True),
                rec(2, build=BAD_FIRST, build_ok=False, build_out="boom", fix="x", fix_ok=False)]
        got = samples.from_runs(runs)
        self.assertEqual(sorted((s["role"], s["sid"][-1]) for s in got),
                         [("build", "0"), ("fix", "1"), ("plan", "0"), ("plan", "1")])

    def test_fix_sample_uses_the_failing_files_and_output(self):
        s = [x for x in samples.from_runs([rec(1, build=BAD_FIRST, build_ok=False, build_out="AssertionError",
                                               fix=GOOD, fix_ok=True)]) if x["role"] == "fix"][0]
        user = s["messages"][1]["content"]
        self.assertIn("return a - b", user)
        self.assertIn("AssertionError", user)
        self.assertIn("Reply with edit blocks only", user)
        fixed, err = edits.apply_edits({"calc.py": "def add(a, b):\n    return a - b\n"}, s["messages"][2]["content"])
        self.assertIsNone(err)
        self.assertEqual(fixed, {"calc.py": "def add(a, b):\n    return a + b\n"})

    def test_fault_sample_target_is_the_original_rendered(self):
        fault = {"sid": "python|k|data analysis|5", "split": "train", "lang": "python", "request": "R", "entry": "calc.py",
                 "files_ok": {"calc.py": "def add(a, b):\n    return a + b\n"},
                 "files_bad": {"calc.py": "def add(a, b):\n    return a - b\n"}, "fail_out": "AssertionError"}
        s = samples.fault_sample(fault)
        self.assertEqual(s["role"], "fix")
        self.assertEqual(s["source"], "fault")
        fixed, err = edits.apply_edits(fault["files_bad"], s["messages"][2]["content"])
        self.assertIsNone(err)
        self.assertEqual(fixed, fault["files_ok"])
        self.assertIn("return a - b", s["messages"][1]["content"])

    def test_render_files_markers(self):
        self.assertIn("// file: lib.js", samples.render_files({"lib.js": "x\n"}, "node"))
        self.assertIn("<!-- file: index.html -->", samples.render_files({"index.html": "<p>x</p>\n"}, "web"))

    def test_datasets_written_per_role_and_split(self):
        d = pathlib.Path(tempfile.mkdtemp())
        runs = d / "runs.jsonl"
        runs.write_text(json.dumps(rec(0)) + "\n" + json.dumps(rec(1, field="accessibility")) + "\n", encoding="utf-8")
        manifest = samples.build_datasets(runs, None, d / "out")
        self.assertEqual(manifest["counts"]["plan"], {"train": 1, "test": 1})
        self.assertTrue((d / "out" / "build-train.jsonl").exists())
        self.assertTrue((d / "out" / "build-test.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: write the implementation**

```python file=scripts/roles/samples.py
"""Turns teacher runs and faults into role training samples (spec section 2). Prompts are the staged harness's:
ct.PLAN_PROMPT, tg.BUILD_FROM_PLAN_PROMPT, ct.FIX_PROMPT."""
import argparse
import collections
import hashlib
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
for p in (HERE, HERE.parent / "teacher", HERE.parent / "moe-bench"):
    sys.path.insert(0, str(p))
import compare_tasks as ct  # noqa: E402
import edits  # noqa: E402
import splits  # noqa: E402
import teacher_gen as tg  # noqa: E402

FENCE = "`" * 3
MARK = {"python": "# file: {}", "node": "// file: {}", "web": "<!-- file: {} -->"}
FENCE_LANG = {"python": "python", "node": "javascript", "web": "html"}
FAILED = "The acceptance tests failed:\n"
FIX_EDIT_PROMPT = """You implemented this request:

{request}

Your files:

{files}

Running acceptance checks against them gave these failures:

{failures}

Fix the implementation with the smallest edits that work. Reply with edit blocks only, no prose. Each block names a file
and replaces text that occurs exactly once in that file:

FILE: <path>
<<<<<<< SEARCH
<lines copied exactly from the file, with enough surrounding lines to be unique>
=======
<the replacement lines>
>>>>>>> REPLACE

Use as many blocks as needed. Do not rewrite whole files."""


def sid_of(rec):
    return "|".join([rec["lang"], rec["kind"], rec["field"], str(rec["i"])])


def split_of_rec(rec):
    return splits.split_of(rec["field"])


def show_files(files):
    """Files as the fix prompt shows them (the format teacher_gen.gen uses)."""
    return "\n\n".join(f"{FENCE}\n# file: {p}\n{c}{FENCE}" for p, c in files.items())


def render_files(files, lang):
    """Files as a reply: one fenced block per file, first line a comment naming the file."""
    blocks = []
    for path, content in files.items():
        body = content if content.endswith("\n") else content + "\n"
        blocks.append(f"{FENCE}{FENCE_LANG[lang]}\n{MARK[lang].format(path)}\n{body}{FENCE}")
    return "\n\n".join(blocks)


def chat_messages(user):
    return [{"role": "system", "content": tg.SYSTEM}, {"role": "user", "content": user}]


def make(role, user, assistant, sid, split, lang, source):
    return {"role": role, "source": source, "sid": sid, "split": split, "lang": lang,
            "messages": chat_messages(user) + [{"role": "assistant", "content": assistant}]}


def from_runs(runs):
    """plan: a build from it passed; build: the first build passed; fix: the first build failed and DeepSeek's fix passed."""
    out = []
    for r in runs:
        if not r.get("plan") or not r.get("build"):
            continue
        sid, split, lang = sid_of(r), split_of_rec(r), r["lang"]
        ok_build = bool(r.get("build_ok"))
        if ok_build or r.get("fix_ok"):
            out.append(make("plan", ct.PLAN_PROMPT.format(request=r["request"]), r["plan"], sid, split, lang, "teacher"))
        if ok_build:
            out.append(make("build", tg.BUILD_FROM_PLAN_PROMPT.format(request=r["request"], plan=r["plan"]),
                            r["build"], sid, split, lang, "teacher"))
        elif r.get("fix_ok") and r.get("fix"):
            files = tg.extract_files(r["build"], r["entry"])
            fixed = tg.extract_files(r["fix"], r["entry"])
            reply = edits.make_edits(files, fixed) if files and fixed else None
            if reply:
                user = FIX_EDIT_PROMPT.format(request=r["request"], files=show_files(files),
                                              failures=FAILED + r.get("build_out", ""))
                out.append(make("fix", user, reply, sid, split, lang, "teacher-fix"))
    return out


def fault_sample(f):
    """The fix sample of a teacher-authored fault, or None when no unambiguous edit turns the faulty files into the original."""
    reply = edits.make_edits(f["files_bad"], f["files_ok"])
    if not reply:
        return None
    user = FIX_EDIT_PROMPT.format(request=f["request"], files=show_files(f["files_bad"]), failures=FAILED + f["fail_out"])
    return make("fix", user, reply, f["sid"], f["split"], f["lang"], "fault")


def read_jsonl(path):
    return [json.loads(line) for line in open(path, encoding="utf-8")] if path and pathlib.Path(path).exists() else []


def build_datasets(runs_path, faults_path, out_dir):
    out_dir = pathlib.Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = from_runs(read_jsonl(runs_path)) + [x for x in (fault_sample(f) for f in read_jsonl(faults_path) if f.get("ok")) if x]
    by = collections.defaultdict(list)
    for s in rows:
        by[(s["role"], s["split"])].append(s)
    manifest = {"counts": collections.defaultdict(dict), "sources": collections.defaultdict(dict), "files": {}}
    for (role, split), group in sorted(by.items()):
        path = out_dir / f"{role}-{split}.jsonl"
        text = "".join(json.dumps(s) + "\n" for s in group)
        path.write_text(text, encoding="utf-8")
        manifest["counts"][role][split] = len(group)
        manifest["sources"][role][split] = dict(collections.Counter(s["source"] for s in group))
        manifest["files"][path.name] = hashlib.sha256(text.encode()).hexdigest()
    manifest = json.loads(json.dumps(manifest))
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    return manifest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="teacher data dir holding runs.jsonl and faults.jsonl")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    d = pathlib.Path(a.dir)
    print(json.dumps(build_datasets(d / "runs.jsonl", d / "faults.jsonl", a.out), indent=1))


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: run the tests**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/samples.py && cd scripts/roles && $PY -m unittest test_samples -v`
Expected: `OK` (5 tests).

- [ ] **Step 4: commit**

```bash
git add scripts/roles/samples.py scripts/roles/test_samples.py
git commit -m "feat(roles): role samples and dataset files"
```

---

### Task 4b: the fix role speaks in edits (added after the sequence-length measurements)

**Why:** a QLoRA step on the 4B holds up to 6,144 tokens (504 tok/s, 6.4 GB) and falls off a cliff at 7,168 (116 tok/s) and 8,192 (60 tok/s), because activation memory grows about 0.5 MB per token and the card has 8 GB. The teacher's builds are 4k to 6k tokens (median 5.4k) and fit (72% at 6,144). The teacher's fixes do not: the failing files appear in the prompt and again in the reply (median 8.8k tokens, 2 of 14 under 6,144). So the fix role replies with **SEARCH/REPLACE edit blocks**, converted deterministically from (failing files, fixed files) with no API call, which also matches the project's line-edit direction. The full-file fix prompt stays as the baseline prompt: the base model is scored on both formats and the adapter must beat the better one.

**Files:** Create `scripts/roles/edits.py`; Test `scripts/roles/test_edits.py`; Modify `scripts/roles/samples.py`, `scripts/roles/test_samples.py`, `scripts/roles/eval_roles.py` (blocks below).

- [ ] **Step 1: extract the test and watch it fail**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/test_edits.py && cd scripts/roles && $PY -m unittest test_edits`
Expected: FAIL, `ModuleNotFoundError: No module named 'edits'`.

```python file=scripts/roles/test_edits.py
import pathlib
import random
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import edits  # noqa: E402

OLD = {"calc.py": "def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n"}
NEW = {"calc.py": "def add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a * b\n"}


class EditsTest(unittest.TestCase):
    def test_one_changed_line_round_trips(self):
        text = edits.make_edits(OLD, NEW)
        self.assertIn("FILE: calc.py", text)
        self.assertIn("return a - b", text)
        out, err = edits.apply_edits(OLD, text)
        self.assertIsNone(err)
        self.assertEqual(out, NEW)

    def test_new_file_and_untouched_file(self):
        old = {"a.py": "x = 1\n", "b.py": "y = 2\n"}
        new = {"a.py": "x = 1\n", "b.py": "y = 3\n", "c.py": "z = 4\n"}
        out, err = edits.apply_edits(old, edits.make_edits(old, new))
        self.assertIsNone(err)
        self.assertEqual(out, new)

    def test_repeated_lines_get_enough_context(self):
        old = {"f.py": "a = 1\nb = 2\n" * 5 + "c = 3\n" + "a = 1\nb = 2\n" * 5}
        new = {"f.py": "a = 1\nb = 2\n" * 5 + "c = 4\n" + "a = 1\nb = 2\n" * 5}
        out, err = edits.apply_edits(old, edits.make_edits(old, new))
        self.assertIsNone(err)
        self.assertEqual(out, new)

    def test_random_edits_round_trip(self):
        rng = random.Random(7)
        vocab = ["    x = 0\n", "    x += 1\n", "    return x\n", "\n", "    if x:\n", "        pass\n", "    y = [x]\n"]
        made = 0
        for _ in range(200):
            old = [rng.choice(vocab) for _ in range(rng.randint(8, 60))]
            new = list(old)
            for _ in range(rng.randint(1, 4)):
                k, op = rng.randrange(len(new)), rng.choice(["replace", "insert", "delete"])
                if op == "replace":
                    new[k] = rng.choice(vocab) + "#\n"
                elif op == "insert":
                    new.insert(k, rng.choice(vocab))
                elif len(new) > 3:
                    del new[k]
            o, n = {"m.py": "".join(old)}, {"m.py": "".join(new)}
            if o == n:
                continue
            text = edits.make_edits(o, n)
            if text is None:
                continue
            made += 1
            out, err = edits.apply_edits(o, text)
            self.assertIsNone(err)
            self.assertEqual(out, n)
        self.assertGreater(made, 150)

    def test_apply_refuses_a_missing_or_ambiguous_search(self):
        files = {"f.py": "a = 1\na = 1\nb = 2\n"}
        block = "FILE: f.py\n<<<<<<< SEARCH\n{}=======\n{}>>>>>>> REPLACE\n"
        out, err = edits.apply_edits(files, block.format("a = 1\n", "a = 9\n"))
        self.assertIn("2 times", err)
        out, err = edits.apply_edits(files, block.format("zzz\n", "a = 9\n"))
        self.assertIn("0 times", err)
        self.assertEqual(out, files)
        self.assertIsNotNone(edits.apply_edits(files, "no blocks here")[1])

    def test_a_marker_line_in_the_code_makes_the_conversion_decline(self):
        old = {"f.py": "x = 1\n"}
        new = {"f.py": "x = 1\n=======\n"}
        self.assertIsNone(edits.make_edits(old, new))

    def test_unchanged_files_give_no_edits(self):
        self.assertIsNone(edits.make_edits(OLD, dict(OLD)))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: write the module**

```python file=scripts/roles/edits.py
"""SEARCH/REPLACE edit blocks for the fix role (design change 2026-10-09: the teacher's full-file fixes are 8.8k tokens
at the median and do not fit a QLoRA step on 8 GB). make_edits turns (failing files, fixed files) into blocks, verified by
applying them; apply_edits applies a reply's blocks and refuses any SEARCH that does not match exactly once.

Block format (payload lines keep their newlines; a new file has an empty SEARCH):
FILE: <path>
<<<<<<< SEARCH
<lines copied from the file>
=======
<replacement lines>
>>>>>>> REPLACE"""
import difflib
import re

OPEN, MID, CLOSE = "<<<<<<< SEARCH", "=======", ">>>>>>> REPLACE"
BLOCK = re.compile(r"^FILE: (\S+)\n<<<<<<< SEARCH\n(.*?)^=======\n(.*?)^>>>>>>> REPLACE$", re.S | re.M)
MARKERS = ("<<<<<<<", "=======", ">>>>>>>")


def _nl(text):
    return text if not text or text.endswith("\n") else text + "\n"


def _block(path, search, replace):
    return f"FILE: {path}\n{OPEN}\n{search}{MID}\n{replace}{CLOSE}\n"


def _hunks(old, new, ctx):
    a, b = old.splitlines(keepends=True), new.splitlines(keepends=True)
    ops = [op for op in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes() if op[0] != "equal"]
    groups = []
    for op in ops:
        if groups and op[1] - groups[-1][-1][2] <= 2 * ctx:
            groups[-1].append(op)
        else:
            groups.append([op])
    out = []
    for g in groups:
        i1, i2, j1, j2 = g[0][1], g[-1][2], g[0][3], g[-1][4]
        lo, hi = max(0, i1 - ctx), min(len(a), i2 + ctx)
        out.append(("".join(a[lo:hi]), "".join(b[j1 - (i1 - lo):j2 + (hi - i2)])))
    return out


def apply_edits(files, reply):
    """(new files, None) or (the unchanged files, a reason). Every SEARCH must match exactly once in its file."""
    blocks = BLOCK.findall(reply)
    if not blocks:
        return files, "no edit blocks"
    out = dict(files)
    for path, search, replace in blocks:
        text = out.get(path)
        if text is None:
            if search:
                return files, f"{path}: unknown file"
            out[path] = replace
            continue
        if not search:
            return files, f"{path}: empty SEARCH for an existing file"
        n = text.count(search)
        if n != 1:
            return files, f"{path}: SEARCH matches {n} times"
        out[path] = text.replace(search, replace, 1)
    return out, None


def make_edits(old, new, max_ctx=16):
    """Edit blocks that turn `old` into `new` (dicts path -> text), or None if the files are unchanged, a file was removed,
    an old file is empty, a payload line looks like a marker, or no amount of context makes the blocks unambiguous."""
    if any(p not in new for p in old) or any(not t for t in old.values()):
        return None
    want = {p: _nl(t) for p, t in new.items()}
    base = {p: _nl(t) for p, t in old.items()}
    ctx = 2
    while ctx <= max_ctx:
        pairs = []
        for path, text in want.items():
            if path not in base:
                pairs.append((path, "", text))
            elif base[path] != text:
                pairs += [(path, s, r) for s, r in _hunks(base[path], text, ctx)]
        if not pairs:
            return None
        if any(ln.startswith(MARKERS) for _, s, r in pairs for ln in (s + r).splitlines()):
            return None
        out = "".join(_block(*x) for x in pairs)
        done, err = apply_edits(base, out)
        if err is None and done == want:
            return out
        ctx *= 2
    return None
```

- [ ] **Step 3: run the tests**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/edits.py && cd scripts/roles && $PY -m unittest test_edits -v`
Expected: `OK` (7 tests).

- [ ] **Step 4: switch the fix samples to edits (patch `samples.py`, its test, and `eval_roles.py` in the plan, then re-extract)**

Save the block below as `patch_edits.py` in the scratchpad, run it from the repo root (it edits this plan's file blocks), then re-extract the three files and run the three test files.

```python
# run once from the repo root
import pathlib

import re

p = pathlib.Path("docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md")
s = p.read_text(encoding="utf-8")
FILE_BLOCK = re.compile(r"(```python file=\S+\n)(.*?)(\n```)", re.S)


def swap(old, new):
    """Replace `old` in the one file block of the plan that contains it (not in this patch's own text)."""
    global s
    hits = [m for m in FILE_BLOCK.finditer(s) if old in m.group(2)]
    assert len(hits) == 1 and hits[0].group(2).count(old) == 1, (len(hits), old[:70])
    m = hits[0]
    s = s[:m.start(2)] + m.group(2).replace(old, new, 1) + s[m.end(2):]


# --- samples.py: the fix prompt in edit form, edit-form fix samples
swap('''import compare_tasks as ct  # noqa: E402
import splits  # noqa: E402
import teacher_gen as tg  # noqa: E402

FENCE = "`" * 3''', '''import compare_tasks as ct  # noqa: E402
import edits  # noqa: E402
import splits  # noqa: E402
import teacher_gen as tg  # noqa: E402

FENCE = "`" * 3''')
swap('''FAILED = "The acceptance tests failed:\\n"
''', '''FAILED = "The acceptance tests failed:\\n"
FIX_EDIT_PROMPT = """You implemented this request:

{request}

Your files:

{files}

Running acceptance checks against them gave these failures:

{failures}

Fix the implementation with the smallest edits that work. Reply with edit blocks only, no prose. Each block names a file
and replaces text that occurs exactly once in that file:

FILE: <path>
<<<<<<< SEARCH
<lines copied exactly from the file, with enough surrounding lines to be unique>
=======
<the replacement lines>
>>>>>>> REPLACE

Use as many blocks as needed. Do not rewrite whole files."""
''')
swap('''            files = tg.extract_files(r["build"], r["entry"])
            if files:
                user = ct.FIX_PROMPT.format(request=r["request"], files=show_files(files),
                                            failures=FAILED + r.get("build_out", ""))
                out.append(make("fix", user, r["fix"], sid, split, lang, "teacher-fix"))''',
     '''            files = tg.extract_files(r["build"], r["entry"])
            fixed = tg.extract_files(r["fix"], r["entry"])
            reply = edits.make_edits(files, fixed) if files and fixed else None
            if reply:
                user = FIX_EDIT_PROMPT.format(request=r["request"], files=show_files(files),
                                              failures=FAILED + r.get("build_out", ""))
                out.append(make("fix", user, reply, sid, split, lang, "teacher-fix"))''')
swap('''def fault_sample(f):
    user = ct.FIX_PROMPT.format(request=f["request"], files=show_files(f["files_bad"]), failures=FAILED + f["fail_out"])
    return make("fix", user, render_files(f["files_ok"], f["lang"]), f["sid"], f["split"], f["lang"], "fault")''',
     '''def fault_sample(f):
    """The fix sample of a teacher-authored fault, or None when no unambiguous edit turns the faulty files into the original."""
    reply = edits.make_edits(f["files_bad"], f["files_ok"])
    if not reply:
        return None
    user = FIX_EDIT_PROMPT.format(request=f["request"], files=show_files(f["files_bad"]), failures=FAILED + f["fail_out"])
    return make("fix", user, reply, f["sid"], f["split"], f["lang"], "fault")''')
swap('''[fault_sample(f) for f in read_jsonl(faults_path) if f.get("ok")]''',
     '''[x for x in (fault_sample(f) for f in read_jsonl(faults_path) if f.get("ok")) if x]''')

# --- test_samples.py: the fix target is edit blocks that rebuild the fixed files
swap('''        self.assertIn("return a - b", user)
        self.assertIn("AssertionError", user)
        self.assertEqual(s["messages"][2]["content"], GOOD)''',
     '''        self.assertIn("return a - b", user)
        self.assertIn("AssertionError", user)
        self.assertIn("Reply with edit blocks only", user)
        fixed, err = edits.apply_edits({"calc.py": "def add(a, b):\\n    return a - b\\n"}, s["messages"][2]["content"])
        self.assertIsNone(err)
        self.assertEqual(fixed, {"calc.py": "def add(a, b):\\n    return a + b\\n"})''')
swap('''        self.assertEqual(s["source"], "fault")
        self.assertIn("# file: calc.py", s["messages"][2]["content"])
        self.assertIn("return a + b", s["messages"][2]["content"])
        self.assertIn("return a - b", s["messages"][1]["content"])''',
     '''        self.assertEqual(s["source"], "fault")
        fixed, err = edits.apply_edits(fault["files_bad"], s["messages"][2]["content"])
        self.assertIsNone(err)
        self.assertEqual(fixed, fault["files_ok"])
        self.assertIn("return a - b", s["messages"][1]["content"])''')
swap('''import samples  # noqa: E402

FENCE = "`" * 3
GOOD =''', '''import edits  # noqa: E402
import samples  # noqa: E402

FENCE = "`" * 3
GOOD =''')

# --- eval_roles.py: fixes are scored in both formats for the base model; adapters answer in edits
swap('''def fix_fn(server, failing):
    def fn(t):
        row = failing[t["sid"]]
        files = tg.extract_files(row["text"], t["entry"])
        shown = samples.show_files(files) if files else "(no files were produced)"
        user = ct.FIX_PROMPT.format(request=t["request"], files=shown, failures=samples.FAILED + row["out"])
        r = server.chat(samples.chat_messages(user), MAX_TOKENS["fix"])
        fixed = tg.extract_files(r["text"], t["entry"]) or files
        ok, out = tg.run_tests(t["lang"], fixed, t["tests"]) if fixed else (False, "no files")
        return {"sid": t["sid"], "ok": ok, "out": out, "finish": r["finish"]}
    return fn''', '''def fix_fn(server, failing, edit=True):
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
    return fn''')
swap('''import compare_tasks as ct  # noqa: E402
import llama_server  # noqa: E402''', '''import compare_tasks as ct  # noqa: E402
import edits  # noqa: E402
import llama_server  # noqa: E402''')
swap('''        run_phase(P("fixes-base"), [t for t in tasks if t["sid"] in failing], fix_fn(s, failing), s.parallel)''',
     '''        todo = [t for t in tasks if t["sid"] in failing]
        run_phase(P("fixes-base"), todo, fix_fn(s, failing, edit=False), s.parallel)
        run_phase(P("fixes-base-edit"), todo, fix_fn(s, failing, edit=True), s.parallel)''')
swap('''           "fix": gate(ok(f"fixes-{a.fix}"), ok("fixes-base"))}''',
     '''           "fix": gate(ok(f"fixes-{a.fix}"), ok("fixes-base")),
           "fix_vs_base_edit_format": gate(ok(f"fixes-{a.fix}"), ok("fixes-base-edit"))}''')
p.write_text(s, encoding="utf-8", newline="\n")
print("plan updated")
```

- [ ] **Step 5: run the affected tests**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/samples.py scripts/roles/test_samples.py scripts/roles/eval_roles.py && cd scripts/roles && $PY -m unittest test_edits test_samples test_eval_roles -v`
Expected: `OK`. (The `fix` pass rule is judged against the better of the two baselines: `fix` and `fix_vs_base_edit_format` must both pass.)

- [ ] **Step 6: commit**

```bash
git add scripts/roles/edits.py scripts/roles/test_edits.py scripts/roles/samples.py scripts/roles/test_samples.py scripts/roles/eval_roles.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md
git commit -m "feat(roles): fix role as SEARCH/REPLACE edits, deterministic conversion, two baselines"
```

---

### Task 5: teacher-authored faults

**Files:** Create `scripts/roles/faults.py`; Test `scripts/roles/test_faults.py`.

- [ ] **Step 1: extract the test and watch it fail**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/test_faults.py && cd scripts/roles && $PY -m unittest test_faults`
Expected: FAIL, `ModuleNotFoundError: No module named 'faults'`.

```python file=scripts/roles/test_faults.py
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import faults  # noqa: E402

ORIG = {"calc.py": "def add(a, b):\n    return a + b\n"}
TESTS = ("import unittest\nfrom calc import add\n\n\nclass T(unittest.TestCase):\n"
         "    def test_add(self):\n        self.assertEqual(add(1, 2), 3)\n")


class FaultTest(unittest.TestCase):
    def test_a_real_bug_is_kept_with_its_failure_output(self):
        out = faults.check_fault("python", TESTS, ORIG, {"calc.py": "def add(a, b):\n    return a - b\n"})
        self.assertIn("AssertionError", out)

    def test_a_crash_is_not_a_fault(self):
        self.assertIsNone(faults.check_fault("python", TESTS, ORIG, {"calc.py": "def add(a, b)\n    return a + b\n"}))

    def test_an_unchanged_or_passing_change_is_not_a_fault(self):
        self.assertIsNone(faults.check_fault("python", TESTS, ORIG, dict(ORIG)))
        self.assertIsNone(faults.check_fault("python", TESTS, ORIG, {"calc.py": "def add(a, b):\n    return b + a\n"}))
        self.assertIsNone(faults.check_fault("python", TESTS, ORIG, {}))

    def test_passing_files_prefers_the_first_build(self):
        fence = "`" * 3
        good = f"{fence}python\n# file: calc.py\nx = 1\n{fence}"
        rec = {"entry": "calc.py", "build": good, "build_ok": True, "fix": "no", "fix_ok": True}
        self.assertEqual(faults.passing_files(rec), {"calc.py": "x = 1\n"})
        self.assertIsNone(faults.passing_files({"entry": "calc.py", "build": good, "build_ok": False}))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: write the implementation**

```python file=scripts/roles/faults.py
"""Teacher-authored faults for the fix role (spec section 2): DeepSeek inserts one realistic bug into a build that passed
its acceptance tests; a fault is kept only if the tests then fail without a crash. The original code is the fix target.
usage: faults.py --dir E:/AI/teacher-data/gen-v0 [--per-seed 2] [--splits train,dev] [--workers 6]"""
import argparse
import concurrent.futures
import json
import pathlib
import sys
import threading

HERE = pathlib.Path(__file__).resolve().parent
for p in (HERE, HERE.parent / "teacher", HERE.parent / "moe-bench"):
    sys.path.insert(0, str(p))
import samples  # noqa: E402
import teacher_gen as tg  # noqa: E402

CRASH = ("SyntaxError", "IndentationError", "ModuleNotFoundError", "ImportError", "Cannot find module",
         "Unexpected token")
FAULT_PROMPT = """Here is a working implementation and the acceptance tests it passes.

Request:
{request}

Files:
{files}

Acceptance tests:
{tests}

Introduce exactly one realistic bug, the kind a careful engineer might make: an off-by-one, a wrong comparison or
operator, a missed edge case, a mishandled empty or malformed input, a wrong default, state that is not reset, or an
ordering or formatting mistake. The bug must make at least one acceptance test fail. The code must still load and run:
no syntax errors, no missing imports. Keep the change small (a few lines).

Reply with every file in full, each in its own fenced code block whose first line is a comment naming the file, e.g.
`# file: tool.py`, `// file: lib.js` or `<!-- file: index.html -->`. Do not explain the change or mark it in the code."""
_lock = threading.Lock()


def passing_files(rec):
    """The files that passed the seed's tests: the first build if it passed, else the fix."""
    text = rec["build"] if rec.get("build_ok") else rec.get("fix") if rec.get("fix_ok") else None
    return tg.extract_files(text, rec["entry"]) if text else None


def check_fault(lang, tests, original, bad):
    """The failure output if `bad` is a usable fault of `original`, else None."""
    if not bad or bad == original:
        return None
    ok, out = tg.run_tests(lang, bad, tests)
    return None if ok or any(m in out for m in CRASH) else out


def one(rec, k, path):
    files = passing_files(rec)
    prompt = FAULT_PROMPT.format(request=rec["request"], files=samples.show_files(files), tests=rec["tests"])
    text, secs, err = tg.call("deepseek", prompt)
    bad = tg.extract_files(text, rec["entry"]) if text else {}
    out = check_fault(rec["lang"], rec["tests"], files, bad)
    row = {"sid": samples.sid_of(rec), "k": k, "split": samples.split_of_rec(rec), "lang": rec["lang"],
           "request": rec["request"], "entry": rec["entry"], "tests": rec["tests"], "ok": out is not None,
           "secs": secs, "err": err}
    if out is not None:
        row.update(files_ok=files, files_bad=bad, fail_out=out)
    with _lock, open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")
    print(f"fault {row['sid'][:60]:60} k{k}: {'kept' if row['ok'] else 'dropped'}{'; ' + err if err else ''}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--per-seed", type=int, default=2, help="faults per train seed (dev gets 1)")
    ap.add_argument("--splits", default="train,dev")
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    d = pathlib.Path(a.dir)
    path = d / "faults.jsonl"
    done = {(r["sid"], r["k"]) for r in samples.read_jsonl(path) if not r.get("err")}
    jobs = []
    for rec in samples.read_jsonl(d / "runs.jsonl"):
        split = samples.split_of_rec(rec)
        if split not in a.splits.split(",") or not passing_files(rec):
            continue
        for k in range(a.per_seed if split == "train" else 1):
            if (samples.sid_of(rec), k) not in done:
                jobs.append((rec, k))
    print(f"{len(jobs)} fault jobs", flush=True)
    with concurrent.futures.ThreadPoolExecutor(a.workers) as ex:
        list(ex.map(lambda j: one(j[0], j[1], path), jobs))


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: run the tests**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/faults.py && cd scripts/roles && $PY -m unittest test_faults -v`
Expected: `OK` (4 tests; the first three run a real `python -m unittest` in a temp directory, a few seconds).

- [ ] **Step 4: commit**

```bash
git add scripts/roles/faults.py scripts/roles/test_faults.py
git commit -m "feat(roles): teacher-authored faults for the fix role"
```

---

### Task 6: run the data pipeline and freeze the manifest (2a)

**Files:** none new. Output under `E:/AI/teacher-data/gen-v0` and `E:/AI/role-adapters/data`.

Seed generation (`teacher_gen.py seeds --cells 280 --k 3`) has been running since the design session; it is resumable. `gen` is resumable too, so run it in rounds on whatever seeds exist.

- [ ] **Step 1: check the seed run**

Run: `tail -n 3 /e/AI/teacher-data/gen-v0/seeds.out; wc -l /e/AI/teacher-data/gen-v0/seeds.jsonl`
Expected: lines like `seeds python ... kept 3; 100 s`; the row count grows toward about 840. If the process died, restart with the original command (it skips finished cells).

- [ ] **Step 2: clean the seeds so far and report the split counts**

Run: `$PY scripts/roles/prepare_seeds.py --dir E:/AI/teacher-data/gen-v0`
Expected: `{"rows": N, "usable": {"train": ..., "dev": ..., "test": ...}}`.

- [ ] **Step 3: start `gen` in the background on the cleaned seeds (two processes by split, 12 concurrent calls in all; one process alone made about 110 seeds an hour)**

```bash
cd /c/Projects/home-base-recovered/.claude/worktrees/micro-agent-swarm-design-929d42
nohup $PY scripts/teacher/teacher_gen.py gen --out E:/AI/teacher-data/gen-v0 --backend deepseek --workers 6 \
  --seeds-file seeds-clean.jsonl > /e/AI/teacher-data/gen-v0/gen.out 2>&1 &
```
Expected: `gen.out` fills with lines `gen python <field> #i: build PASS` (or `fail -> fix PASS`).

- [ ] **Step 4: repeat rounds until the seeds are done**

When `seeds.jsonl` stops growing, re-run Steps 2 and 3 (gen skips finished seeds). Stop when `runs.jsonl` has a row for every usable seed:
`$PY -c "import json;u=[r for r in map(json.loads,open('E:/AI/teacher-data/gen-v0/seeds-clean.jsonl')) if not r['lab_excluded']];r=[json.loads(l) for l in open('E:/AI/teacher-data/gen-v0/runs.jsonl')];print(len(u),len(r))"` prints equal numbers.

- [ ] **Step 5: author the faults for train and dev**

Run: `$PY scripts/roles/faults.py --dir E:/AI/teacher-data/gen-v0 --per-seed 2 --splits train,dev --workers 6 > /e/AI/teacher-data/gen-v0/faults.out 2>&1`
Expected: `N fault jobs`, then `fault ... kept/dropped` lines. Re-run to retry API errors.

- [ ] **Step 6: build the datasets and freeze the manifest**

Run: `$PY scripts/roles/samples.py --dir E:/AI/teacher-data/gen-v0 --out E:/AI/role-adapters/data`
Expected: a manifest with counts per role and split. Targets (spec section 2): at least 600 train samples for each of plan, build and fix. If a count is short, run another seeds round (`--seed 12 --cells 120`) and repeat Steps 2 to 6.

- [ ] **Step 7: commit the manifest and the stats (not the teacher text)**

```bash
mkdir -p docs/benchmarks/roles
cp /e/AI/role-adapters/data/manifest.json docs/benchmarks/roles/data-manifest.json
git add docs/benchmarks/roles/data-manifest.json
git commit -m "data(roles): frozen dataset manifest for arm S"
```

---

### Task 6b: a second seed round (added during Task 6)

**Why:** all 280 (language, kind, field) cells are used by the first round, which gave 651 usable seeds (465 train). At the observed teacher pass rate (about 70% on the first build, 5% more after one fix) that is about 330 verified build samples, short of the spec's 600 per role. A second round with another random seed asks DeepSeek for 3 more tasks per cell; near-duplicates of existing requests are dropped on merge.

**Files:** Create `scripts/roles/merge_seeds.py`; Test `scripts/roles/test_merge_seeds.py`.

- [ ] **Step 1: start the second round in its own folder (resumable, API only)**

```bash
mkdir -p /e/AI/teacher-data/gen-v0b
nohup $PY scripts/teacher/teacher_gen.py seeds --out E:/AI/teacher-data/gen-v0b --backend deepseek --workers 4 \
  --cells 280 --k 3 --seed 12 > /e/AI/teacher-data/gen-v0b/seeds.out 2>&1 &
```
Expected: `seeds ... kept 3; ~100 s` lines; about 280 cells.

- [ ] **Step 2: extract the merge test and watch it fail**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/test_merge_seeds.py && cd scripts/roles && $PY -m unittest test_merge_seeds`
Expected: FAIL, `ModuleNotFoundError: No module named 'merge_seeds'`.

```python file=scripts/roles/test_merge_seeds.py
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import merge_seeds  # noqa: E402


def row(i, request, **kw):
    return dict({"lang": "python", "kind": "k", "field": "data analysis", "i": i, "title": "t", "request": request,
                 "entry": "a.py", "tests": "x"}, **kw)


class MergeTest(unittest.TestCase):
    def test_offsets_dedupes_and_flags_the_round(self):
        d = pathlib.Path(tempfile.mkdtemp())
        base, extra = d / "seeds.jsonl", d / "extra.jsonl"
        base.write_text(json.dumps(row(0, "Parse log files and report the slowest endpoints per day with percentiles.")) + "\n",
                        encoding="utf-8")
        rows = [row(0, "Parse log files and report the slowest endpoints per day with percentiles."),  # a duplicate
                row(1, "Convert temperatures between Celsius and Fahrenheit from a command line with rounding rules."),
                row(2, "Anything", excluded=True),
                {"lang": "python", "kind": "k", "field": "data analysis", "empty": True}]
        extra.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
        counts = merge_seeds.merge(base, extra, offset=3)
        out = [json.loads(line) for line in base.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(counts, {"added": 1, "duplicates": 1, "skipped": 2})
        self.assertEqual([r["i"] for r in out], [0, 4])
        self.assertEqual(out[1].get("round"), 2)

    def test_running_it_twice_does_not_add_twice(self):
        d = pathlib.Path(tempfile.mkdtemp())
        base, extra = d / "seeds.jsonl", d / "extra.jsonl"
        base.write_text("", encoding="utf-8")
        extra.write_text(json.dumps(row(0, "Summarize a CSV of expenses by category with totals and a monthly trend line.")),
                         encoding="utf-8")
        merge_seeds.merge(base, extra, offset=3)
        again = merge_seeds.merge(base, extra, offset=3)
        self.assertEqual(again["added"], 0)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: write the implementation**

```python file=scripts/roles/merge_seeds.py
"""Appends a second seed round to the first: task index shifted by --offset, near-duplicates (Jaccard >= 0.6 on the
request words) of anything already present dropped, rows tagged round 2. Idempotent.
usage: merge_seeds.py --base E:/AI/teacher-data/gen-v0/seeds.jsonl --extra E:/AI/teacher-data/gen-v0b/seeds.jsonl"""
import argparse
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "moe-bench" / "train_tasks"))
import make  # noqa: E402

LIMIT = 0.6


def read(path):
    p = pathlib.Path(path)
    return [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()] if p.exists() else []


def merge(base, extra, offset=3):
    have = [make.words(r["request"]) for r in read(base) if r.get("request")]
    added = duplicates = skipped = 0
    with open(base, "a", encoding="utf-8") as out:
        for r in read(extra):
            if r.get("empty") or r.get("excluded") or not r.get("request"):
                skipped += 1
                continue
            w = make.words(r["request"])
            if any(make.jaccard(w, h) >= LIMIT for h in have):
                duplicates += 1
                continue
            r["i"] = r["i"] + offset
            r["round"] = 2
            out.write(json.dumps(r) + "\n")
            have.append(w)
            added += 1
    return {"added": added, "duplicates": duplicates, "skipped": skipped}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--extra", required=True)
    ap.add_argument("--offset", type=int, default=3)
    a = ap.parse_args()
    print(json.dumps(merge(a.base, a.extra, a.offset)))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: run the tests**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/merge_seeds.py && cd scripts/roles && $PY -m unittest test_merge_seeds -v`
Expected: `OK` (2 tests).

- [ ] **Step 5: when round 2 has finished, merge it, clean, and generate its seeds**

```bash
$PY scripts/roles/merge_seeds.py --base E:/AI/teacher-data/gen-v0/seeds.jsonl --extra E:/AI/teacher-data/gen-v0b/seeds.jsonl
$PY scripts/roles/prepare_seeds.py --dir E:/AI/teacher-data/gen-v0
```
Then restart the two `gen` processes of Task 6 Step 3 (train, and dev plus test); they skip every finished seed.

- [ ] **Step 6: commit**

```bash
git add scripts/roles/merge_seeds.py scripts/roles/test_merge_seeds.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md
git commit -m "feat(roles): second seed round and idempotent merge"
```

---

### Task 6c: harden `teacher_gen` (added during Task 6)

**Why:** the first long `gen` run died on a reply whose "file path" was a whole HTML document (`mkdir` on Windows raised `OSError`, which killed the thread pool), and 55 of the first 394 runs failed on HTTP 429 and `RemoteDisconnected` (two `gen` processes plus the second seed round exceeded the endpoint's tolerance) yet were recorded as finished, with empty plans, so a rerun skipped them. Fixes: a path guard in `run_tests`, retry with backoff in `call`, one bad seed cannot stop the pool, and a cleaner that drops infrastructure failures from `runs.jsonl` so they are retried.

**Files:** Modify `scripts/teacher/teacher_gen.py`; Create `scripts/roles/clean_runs.py`; Test `scripts/roles/test_hardening.py`.

- [ ] **Step 1: extract the test and watch it fail**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/test_hardening.py && cd scripts/roles && $PY -m unittest test_hardening`
Expected: FAIL (`AttributeError: module 'teacher_gen' has no attribute 'valid_path'` and a missing `clean_runs`).

```python file=scripts/roles/test_hardening.py
import json
import pathlib
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
for p in (HERE, HERE.parent / "teacher", HERE.parent / "moe-bench"):
    sys.path.insert(0, str(p))
import clean_runs  # noqa: E402
import teacher_gen as tg  # noqa: E402


class PathGuardTest(unittest.TestCase):
    def test_valid_and_invalid_paths(self):
        for ok in ("tool.py", "src/lib.js", "index.html"):
            self.assertTrue(tg.valid_path(ok), ok)
        for bad in ("", "../x.py", "/etc/x", "<!DOCTYPE html>\n<html>", "a\nb.py", "x" * 300, "a:b.py", "a|b"):
            self.assertFalse(tg.valid_path(bad), repr(bad))

    def test_run_tests_survives_a_garbage_path(self):
        ok, out = tg.run_tests("python", {"<!DOCTYPE html>\n<html>": "x"}, "import unittest\n")
        self.assertFalse(ok)


class RetryTest(unittest.TestCase):
    def test_retries_a_429_then_succeeds(self):
        calls = []

        def flaky(prompt, **kw):
            calls.append(1)
            if len(calls) < 3:
                raise RuntimeError("<HTTPError 429: 'Too Many Requests'>")
            return "answer"
        tg.BACKENDS["flaky"] = flaky
        tg.LIMITS["flaky"] = tg.threading.Semaphore(1)
        orig = tg.time.sleep
        tg.time.sleep = lambda s: None
        try:
            text, secs, err = tg.call("flaky", "p")
        finally:
            tg.time.sleep = orig
        self.assertEqual((text, err, len(calls)), ("answer", None, 3))

    def test_gives_up_on_a_non_transient_error(self):
        tg.BACKENDS["broken"] = lambda prompt, **kw: (_ for _ in ()).throw(ValueError("bad request"))
        tg.LIMITS["broken"] = tg.threading.Semaphore(1)
        text, secs, err = tg.call("broken", "p")
        self.assertEqual(text, "")
        self.assertIn("bad request", err)


class CleanRunsTest(unittest.TestCase):
    def test_drops_infrastructure_failures_only(self):
        d = pathlib.Path(tempfile.mkdtemp())
        rows = [{"sid": 1, "plan": "p", "build": "b", "build_ok": True},
                {"sid": 2, "plan": "p", "build": "b", "build_ok": False, "fix_ok": False},   # a real failure: kept
                {"sid": 3, "plan": "", "build": "", "errors": ["429"]},
                {"sid": 4, "plan": "p", "build": ""}]
        (d / "runs.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
        kept, dropped = clean_runs.clean(d / "runs.jsonl")
        self.assertEqual((kept, dropped), (2, 2))
        self.assertTrue((d / "runs.jsonl.bak").exists())
        left = [json.loads(line)["sid"] for line in (d / "runs.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(left, [1, 2])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: write the cleaner**

```python file=scripts/roles/clean_runs.py
"""Drops infrastructure failures (an empty plan or build, or API errors) from runs.jsonl so `gen` retries them; real
test failures stay. The original is kept as runs.jsonl.bak. usage: clean_runs.py --dir E:/AI/teacher-data/gen-v0"""
import argparse
import json
import pathlib
import shutil


def clean(path):
    path = pathlib.Path(path)
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    keep = [r for r in rows if r.get("plan") and r.get("build") and not r.get("errors")]
    shutil.copy(path, str(path) + ".bak")
    path.write_text("".join(json.dumps(r) + "\n" for r in keep), encoding="utf-8")
    return len(keep), len(rows) - len(keep)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    a = ap.parse_args()
    print(clean(pathlib.Path(a.dir) / "runs.jsonl"))


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: patch `teacher_gen.py` (path guard, retry with backoff, a bad seed cannot kill the pool)**

```python
# run once from the repo root
import pathlib

p = pathlib.Path("scripts/teacher/teacher_gen.py")
s = p.read_text(encoding="utf-8")


def swap(old, new):
    global s
    assert s.count(old) == 1, old[:60]
    s = s.replace(old, new, 1)


swap('''def call(backend, prompt, **kw):
    with LIMITS[backend]:
        t = time.time()
        try:
            text, err = BACKENDS[backend](prompt, **kw), None
        except Exception as e:  # recorded, never fatal for the comparison
            text, err = "", repr(e)[:300]
        return text, round(time.time() - t, 1), err''',
     '''TRANSIENT = ("429", "RemoteDisconnected", "timed out", "Connection", "502", "503", "504")


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
        return "", round(time.time() - t, 1), err''')
swap('''def run_build(task, files):''',
     '''def valid_path(p):
    """A relative file name that is safe to create on Windows (a model once answered with a whole HTML page as the name)."""
    return (bool(p) and len(p) < 200 and not re.search(r'[\\n\\r<>:"|?*]', p) and ".." not in p and not p.startswith("/"))


def run_build(task, files):''')
swap('''        for p, c in files.items():
            if ".." not in p and not p.startswith("/"):
                (d / p).parent.mkdir(parents=True, exist_ok=True)
                (d / p).write_text(c, encoding="utf-8")
        name =''',
     '''        for p, c in files.items():
            if valid_path(p):
                (d / p).parent.mkdir(parents=True, exist_ok=True)
                (d / p).write_text(c, encoding="utf-8")
        name =''')
swap('''    def run(s):
        key = (s["lang"], s["kind"], s["field"], s["i"])''',
     '''    def run(s):
        try:
            run_one(s)
        except Exception as e:  # one bad seed must not stop the pool; it is not recorded, so a rerun retries it
            print(f"gen ERROR {s['lang']} {s['field']} #{s['i']}: {e!r}"[:300], flush=True)

    def run_one(s):
        key = (s["lang"], s["kind"], s["field"], s["i"])''')
p.write_text(s, encoding="utf-8")
print("patched")
```

- [ ] **Step 4: apply the patch, run the tests**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/clean_runs.py` then save the patch block above as `patch_hardening.py` in the scratchpad and run it from the repo root, then `cd scripts/roles && $PY -m unittest test_hardening -v`
Expected: `OK` (5 tests).

- [ ] **Step 5: clean the existing runs, restart `gen` with fewer workers, commit**

```bash
$PY scripts/roles/clean_runs.py --dir E:/AI/teacher-data/gen-v0
D=E:/AI/teacher-data/gen-v0
nohup $PY scripts/teacher/teacher_gen.py gen --out $D --backend deepseek --workers 5 --seeds-file seeds-clean.jsonl \
  --splits train > $D/gen-train.out 2>&1 &
nohup $PY scripts/teacher/teacher_gen.py gen --out $D --backend deepseek --workers 3 --seeds-file seeds-clean.jsonl \
  --splits dev,test > $D/gen-eval.out 2>&1 &
git add scripts/teacher/teacher_gen.py scripts/roles/clean_runs.py scripts/roles/test_hardening.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md
git commit -m "fix(roles): teacher_gen path guard, retry with backoff, and a cleaner for infrastructure failures"
```
(8 gen workers plus the 4-worker seed round is about the 12 concurrent calls that ran without 429s earlier.)

---

### Task 6d: the OpenCode Go quota, and a usage log (added during Task 6)

**What happened (2026-10-09, about 20:40 EDT):** every DeepSeek call began returning HTTP 429 with `GoUsageLimitError: Go usage limit exceeded`, `limitName: monthly`, `Retry-After: 24637` (about 6.8 hours, a reset near 03:30 EDT on 2026-10-10). The first seed round (280 calls), the second (about 300), roughly 1,200 `gen` calls and the Step 1 calls used up the account's monthly allowance, which the owner's other OpenCode Go uses share. All DeepSeek generation is stopped until the reset. After it, spend is metered: every call logs its token usage, and the remaining data is generated in priority order (dev and test first, then the train seeds), stopping when the data reaches the targets or the Go usage limit returns.

**Files:** Modify `scripts/moe-bench/opencode_go.py`, `scripts/teacher/teacher_gen.py`; Test `scripts/roles/test_usage.py`.

- [ ] **Step 1: extract the test and watch it fail**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/test_usage.py && cd scripts/roles && $PY -m unittest test_usage`
Expected: FAIL (`AttributeError: module 'teacher_gen' has no attribute 'log_usage'`).

```python file=scripts/roles/test_usage.py
import json
import pathlib
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
for p in (HERE, HERE.parent / "teacher", HERE.parent / "moe-bench"):
    sys.path.insert(0, str(p))
import teacher_gen as tg  # noqa: E402


class UsageTest(unittest.TestCase):
    def test_log_usage_appends_a_json_line(self):
        d = pathlib.Path(tempfile.mkdtemp())
        tg.USAGE_LOG = d / "usage.jsonl"
        tg.log_usage({"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}, "deepseek", 12.5)
        tg.log_usage(None, "deepseek", 1.0)
        rows = [json.loads(line) for line in tg.USAGE_LOG.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(rows[0]["completion_tokens"], 20)
        self.assertEqual(rows[0]["backend"], "deepseek")
        self.assertEqual(rows[1]["completion_tokens"], None)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: patch the client and `teacher_gen`**

```python
# run once from the repo root
import pathlib

p = pathlib.Path("scripts/moe-bench/opencode_go.py")
s = p.read_text(encoding="utf-8")
old = '''                r = self._req("/chat/completions", payload)
                return r["choices"][0]["message"].get("content") or ""'''
assert s.count(old) == 1
s = s.replace(old, '''                r = self._req("/chat/completions", payload)
                self.last_usage = r.get("usage")  # token counts of the last reply (teacher_gen logs them)
                return r["choices"][0]["message"].get("content") or ""''', 1)
p.write_text(s, encoding="utf-8")

p = pathlib.Path("scripts/teacher/teacher_gen.py")
s = p.read_text(encoding="utf-8")
old = '''def deepseek(prompt, max_tokens=32768):
    if not hasattr(_local, "ds"):
        _local.ds = opencode_go.Client()
        assert _local.ds.model == "deepseek-v4.1-flash", _local.ds.model
    return _local.ds.chat(prompt, temperature=0.7, max_tokens=max_tokens, json_mode=False, system=SYSTEM)'''
assert s.count(old) == 1
s = s.replace(old, '''USAGE_LOG = pathlib.Path("E:/AI/teacher-data/usage.jsonl")
_usage_lock = threading.Lock()


def log_usage(usage, backend, secs):
    """One JSON line per reply: token counts as the API reports them, so spend can be metered (monthly quota, 2026-10-09)."""
    usage = usage or {}
    with _usage_lock, open(USAGE_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps({"t": round(time.time()), "backend": backend, "secs": secs,
                            "prompt_tokens": usage.get("prompt_tokens"), "completion_tokens": usage.get("completion_tokens"),
                            "total_tokens": usage.get("total_tokens")}) + "\\n")


def deepseek(prompt, max_tokens=32768):
    if not hasattr(_local, "ds"):
        _local.ds = opencode_go.Client()
        assert _local.ds.model == "deepseek-v4.1-flash", _local.ds.model
    t = time.time()
    text = _local.ds.chat(prompt, temperature=0.7, max_tokens=max_tokens, json_mode=False, system=SYSTEM)
    log_usage(getattr(_local.ds, "last_usage", None), "deepseek", round(time.time() - t, 1))
    return text''', 1)
p.write_text(s, encoding="utf-8")
print("patched")
```

- [ ] **Step 3: apply the patch and run the test**

Save the block above as `patch_usage.py` in the scratchpad and run it from the repo root, then `cd scripts/roles && $PY -m unittest test_usage -v`
Expected: `OK` (1 test).

- [ ] **Step 4: commit**

```bash
git add scripts/moe-bench/opencode_go.py scripts/teacher/teacher_gen.py scripts/roles/test_usage.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md
git commit -m "feat(roles): meter DeepSeek token usage after the monthly quota ran out"
```

---

### Task 7: the llama-server wrapper

**Files:** Create `scripts/roles/llama_server.py`.

- [ ] **Step 1: extract it**

```python file=scripts/roles/llama_server.py
"""llama-server (build 836d571) for the role-adapter evaluation: one base GGUF, optionally one LoRA GGUF."""
import json
import subprocess
import time
import urllib.error
import urllib.request

SERVER = r"C:\qwen3-forge-stage\tools\llama-master-836d57176\llama-server.exe"
PORT = 8096


class Server:
    def __init__(self, gguf, lora=None, slot_ctx=16384, parallel=4, port=PORT, log_path=None, extra=()):
        self.port, self.parallel = port, parallel
        self.args = [SERVER, "-m", str(gguf), "--host", "127.0.0.1", "--port", str(port), "-ngl", "99",
                     "-c", str(slot_ctx * parallel), "-np", str(parallel), "-ctk", "q8_0", "-ctv", "q8_0",
                     "--flash-attn", "on", "-b", "512", "-ub", "512", "--jinja", "--reasoning-budget", "0",
                     "--no-webui", "--cache-ram", "0"] + (["--lora", str(lora)] if lora else []) + list(extra)
        self.log = open(log_path, "a", encoding="utf-8", errors="replace") if log_path else subprocess.DEVNULL
        self.proc = None

    def __enter__(self):
        self.proc = subprocess.Popen(self.args, stdout=self.log, stderr=subprocess.STDOUT)
        t0 = time.time()
        while time.time() - t0 < 900:
            if self.proc.poll() is not None:
                raise RuntimeError(f"llama-server exited {self.proc.returncode} during load")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=2) as r:
                    if r.status == 200:
                        return self
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                pass
            time.sleep(2)
        self.__exit__(None, None, None)
        raise RuntimeError("llama-server did not become healthy in 900 s")

    def __exit__(self, *exc):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        time.sleep(15)  # let the driver release VRAM before the next load

    def chat(self, messages, max_tokens=4096, temperature=0.2, seed=0, timeout=3000):
        payload = {"messages": messages, "max_tokens": max_tokens, "temperature": temperature, "top_p": 0.95,
                   "seed": seed, "cache_prompt": False, "chat_template_kwargs": {"enable_thinking": False}}
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/v1/chat/completions",
                                     data=json.dumps(payload).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        t = time.time()
        with urllib.request.urlopen(req, timeout=timeout) as r:
            resp = json.loads(r.read())
        choice, tm = resp["choices"][0], resp.get("timings", {})
        return {"text": choice["message"].get("content") or "", "finish": choice.get("finish_reason"),
                "prompt_n": tm.get("prompt_n"), "gen_n": tm.get("predicted_n"), "secs": round(time.time() - t, 1)}
```

- [ ] **Step 2: write it out, check it imports, commit**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/llama_server.py && cd scripts/roles && $PY -c "import llama_server; print('ok')"`
Expected: `ok`.

```bash
git add scripts/roles/llama_server.py
git commit -m "feat(roles): llama-server wrapper"
```

---

### Task 8: weights and GGUF bases (2b)

**Files:** none (downloads under `E:/AI/role-adapters`). Downloads are pre-authorized by the owner (2026-10-09).

- [ ] **Step 1: pause the gate, start the WSL guard, check disk**

```bash
(cd /c/Projects/Versutus && node gate/cli.mjs service stop)
rm -f /c/qwen3-forge-stage/logs/step2.done
nohup bash scripts/moe-bench/laya-runs/wsl_guard.sh /c/qwen3-forge-stage/logs/step2.done > /dev/null 2>&1 &
df -h /e | tail -1
```
Expected: E: has more than 60 GB free.

- [ ] **Step 2: download the three Qwen3.5 checkpoints to E: (about 33 GB)**

```bash
export HF_HOME=E:/AI/hf-cache
mkdir -p /e/AI/role-adapters/models /e/AI/role-adapters/gguf /e/AI/role-adapters/logs
nohup $UPY -c "
from huggingface_hub import snapshot_download as d
for r in ('Qwen/Qwen3.5-4B', 'Qwen/Qwen3.5-9B', 'Qwen/Qwen3.5-2B'):
    d(r, local_dir='E:/AI/role-adapters/models/' + r.split('/')[1])
    print('done', r, flush=True)
" > /e/AI/role-adapters/logs/download.out 2>&1 &
```
Expected (after a while): `done Qwen/Qwen3.5-4B`, then 9B, then 2B in `download.out`; each directory holds `model*.safetensors`, `config.json`, `tokenizer.json`.

- [ ] **Step 3: convert 4B and 2B to GGUF (Q5_K_M); the 9B base is already `E:/models/gguf/unsloth-Qwen3.5-9B-Q5_K_M.gguf`**

```bash
LC=$HOME/.unsloth/llama.cpp
Q=/c/qwen3-forge-stage/tools/llama-master-836d57176/llama-quantize.exe
for s in 4B 2B; do
  $UPY $LC/convert_hf_to_gguf.py E:/AI/role-adapters/models/Qwen3.5-$s --outfile E:/AI/role-adapters/gguf/Qwen3.5-$s-F16.gguf --outtype f16
  $Q E:/AI/role-adapters/gguf/Qwen3.5-$s-F16.gguf E:/AI/role-adapters/gguf/Qwen3.5-$s-Q5_K_M.gguf Q5_K_M
done
ls -la /e/AI/role-adapters/gguf
```
Expected: `Qwen3.5-4B-Q5_K_M.gguf` (about 3 GB) and `Qwen3.5-2B-Q5_K_M.gguf` (about 1.6 GB). If the converter reports an unknown architecture, update `~/.unsloth/llama.cpp` (`git pull` inside it) and retry; record the outcome.

- [ ] **Step 4: check the 4B GGUF serves**

Run: `$PY - <<'EOF'`
```python
import sys
sys.path.insert(0, "scripts/roles")
import llama_server
with llama_server.Server("E:/AI/role-adapters/gguf/Qwen3.5-4B-Q5_K_M.gguf", parallel=1) as s:
    print(s.chat([{"role": "user", "content": "Reply with the single word: ready"}], max_tokens=16)["text"])
```
`EOF`
Expected: a short reply containing `ready`.

- [ ] **Step 5: note the result (no commit; the downloads are outside the repo)**

---

### Task 9: the QLoRA trainer (memory-safe for a 248k vocabulary)

**Why a shared module:** Qwen3.5 has a 248,320-token vocabulary. `prepare_model_for_kbit_training` would upcast the embedding and output matrices to fp32 (about 4 GB at 9B) and a full-sequence loss would materialize 4,096 x 248k logits in fp32 (about 4 GB). `qlora_common.py` therefore (a) enables gradient checkpointing without the fp32 upcast, (b) swaps the output head for an identity so the forward returns hidden states, and (c) computes the loss only on the reply tokens, in checkpointed chunks through the real head.

**Files:** Create `scripts/roles/qlora_common.py`, `scripts/roles/train_lora.py`; Test `scripts/roles/test_qlora_common.py`, `scripts/roles/test_train_lora.py`.

- [ ] **Step 1: extract both tests and watch them fail** (run with Unsloth's Python; the tokenizer and the 0.6B model are the local HF cache's Qwen3-0.6B)

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/test_qlora_common.py scripts/roles/test_train_lora.py && cd scripts/roles && HF_HUB_OFFLINE=1 $UPY -m unittest test_qlora_common test_train_lora`
Expected: FAIL, `ModuleNotFoundError` for `qlora_common` and `train_lora`.

```python file=scripts/roles/test_qlora_common.py
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import qlora_common  # noqa: E402


class ReplyLossTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        try:
            cls.tok = AutoTokenizer.from_pretrained("Qwen/Qwen3-0.6B")
            cls.model = AutoModelForCausalLM.from_pretrained("Qwen/Qwen3-0.6B", dtype=torch.float32)
        except Exception as e:  # not cached: skip rather than fail
            raise unittest.SkipTest(f"Qwen3-0.6B unavailable: {e}")
        cls.model.eval()

    def test_matches_the_full_loss_on_the_reply_tokens(self):
        import torch
        ids = self.tok("Write add.\nA: def add(a, b): return a + b", return_tensors="pt")["input_ids"]
        labels = ids.clone()
        labels[0, :6] = -100
        full = self.model(input_ids=ids, labels=labels).loss.item()
        head = qlora_common.swap_head(self.model)
        with torch.no_grad():
            loss, n = qlora_common.reply_loss(self.model, head, ids, labels, chunk=4)
        self.assertEqual(n, int((labels[0, 1:] != -100).sum()))
        self.assertAlmostEqual(loss.item(), full, places=3)


if __name__ == "__main__":
    unittest.main()
```

```python file=scripts/roles/test_train_lora.py
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import train_lora  # noqa: E402

MSGS = [{"role": "system", "content": "S"}, {"role": "user", "content": "Write add."},
        {"role": "assistant", "content": "def add(a, b):\n    return a + b\n"}]


class EncodeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from transformers import AutoTokenizer
        try:
            cls.tok = AutoTokenizer.from_pretrained("Qwen/Qwen3-0.6B")
        except Exception as e:  # not cached: skip rather than fail
            raise unittest.SkipTest(f"tokenizer unavailable: {e}")

    def test_loss_only_on_the_reply(self):
        e = train_lora.encode(self.tok, MSGS, 4096)
        ids, labels = e["input_ids"], e["labels"]
        self.assertEqual(len(ids), len(labels))
        self.assertGreater(sum(1 for x in labels if x == -100), 5)
        reply_ids = [x for x in labels if x != -100]
        text = self.tok.decode(reply_ids)
        self.assertIn("return a + b", text)
        self.assertTrue(text.endswith(self.tok.eos_token))

    def test_prompt_matches_the_thinking_off_template(self):
        e = train_lora.encode(self.tok, MSGS, 4096)
        prompt = self.tok.apply_chat_template(MSGS[:-1], tokenize=False, add_generation_prompt=True,
                                              enable_thinking=False)
        n_prompt = sum(1 for x in e["labels"] if x == -100)
        self.assertEqual(self.tok.decode(e["input_ids"][:n_prompt]), prompt)

    def test_too_long_is_dropped(self):
        self.assertIsNone(train_lora.encode(self.tok, MSGS, 10))


class ScheduleTest(unittest.TestCase):
    def test_cosine_schedule_endpoints(self):
        self.assertAlmostEqual(train_lora.lr_at(0, 100, 1e-4, 5), 1e-4 / 5, places=9)
        self.assertAlmostEqual(train_lora.lr_at(99, 100, 1e-4, 5), 1e-5, delta=2e-6)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: write the shared module**

```python file=scripts/roles/qlora_common.py
"""QLoRA pieces shared by the trainer and the smoke test (runs in Unsloth Studio's Python)."""
ATTN_MLP = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]
EXCLUDE = r".*(visual|vision|merger).*"


def prefer_efficient_sdpa():
    """Qwen3.5 attention has 256-wide heads: PyTorch's flash kernel does not support them on this GPU, and HF's grouped-query
    shortcut (enable_gqa) then falls back to the math kernel, which materializes 16 x 4096 x 4096 scores (4.3 GB per layer).
    Expanding the keys and values instead lets the memory-efficient kernel run (250 MiB). Measured 2026-10-09."""
    import transformers.integrations.sdpa_attention as sa
    sa.use_gqa_in_sdpa = lambda *a, **k: False


def load_qlora(path, targets="all-linear", rank=16):
    """4-bit NF4 base with gradient checkpointing (no fp32 upcast of the embeddings) and a LoRA on top."""
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, BitsAndBytesConfig

    prefer_efficient_sdpa()
    bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                             bnb_4bit_compute_dtype=torch.bfloat16)
    model = AutoModelForCausalLM.from_pretrained(path, quantization_config=bnb, dtype=torch.bfloat16, device_map={"": 0})
    model.config.use_cache = False
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.enable_input_require_grads()
    cfg = LoraConfig(r=rank, lora_alpha=2 * rank, lora_dropout=0.05, task_type="CAUSAL_LM", exclude_modules=EXCLUDE,
                     target_modules="all-linear" if targets == "all-linear" else ATTN_MLP)
    return get_peft_model(model, cfg)


def swap_head(model):
    """Replace the output head with an identity (so forward returns hidden states) and return the real head."""
    import torch
    base = model.get_base_model() if hasattr(model, "get_base_model") else model
    head = base.get_output_embeddings()
    base.lm_head = torch.nn.Identity()
    return head


def _ce(head, x, y):
    import torch
    return torch.nn.functional.cross_entropy(head(x).float(), y, reduction="sum")


def reply_loss(model, head, ids, labels, chunk=512):
    """(mean loss over the reply tokens, their count): the forward gives hidden states; the real head and the
    cross-entropy run only on reply positions, in checkpointed chunks, so the 248k-wide logits never all exist."""
    import torch
    from torch.utils.checkpoint import checkpoint
    hidden = model(input_ids=ids).logits[0]
    target = labels[0, 1:]
    pos = (target != -100).nonzero(as_tuple=True)[0]
    hs, tg = hidden[:-1][pos], target[pos]
    total = hs.new_zeros((), dtype=torch.float32)
    for i in range(0, len(pos), chunk):
        total = total + checkpoint(_ce, head, hs[i:i + chunk], tg[i:i + chunk], use_reentrant=False)
    return total / len(pos), len(pos)
```

- [ ] **Step 3: write the trainer**

```python file=scripts/roles/train_lora.py
"""QLoRA SFT for one role adapter (spec section 3). Loss on the assistant reply only; the prompt is rendered the way
llama-server renders it with thinking off. Runs in Unsloth Studio's Python.
usage: train_lora.py --model E:/AI/role-adapters/models/Qwen3.5-4B --train build-train.jsonl --dev build-dev.jsonl
                     --out E:/AI/role-adapters/runs/4B-S-build [--epochs 2] [--lr 1e-4] [--rank 16] [--max-len 4096]"""
import argparse
import json
import math
import pathlib
import random
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))


def encode(tok, messages, max_len):
    """{input_ids, labels} with -100 on the prompt, or None if longer than max_len (dropped, not truncated)."""
    prompt = tok.apply_chat_template(messages[:-1], tokenize=False, add_generation_prompt=True, enable_thinking=False)
    reply = messages[-1]["content"] + tok.eos_token
    p = tok(prompt, add_special_tokens=False)["input_ids"]
    r = tok(reply, add_special_tokens=False)["input_ids"]
    if len(p) + len(r) > max_len:
        return None
    return {"input_ids": p + r, "labels": [-100] * len(p) + r}


def lr_at(step, total, peak, warmup):
    """Linear warmup then cosine decay to 10% of the peak."""
    if step < warmup:
        return peak * (step + 1) / warmup
    frac = (step - warmup) / max(1, total - warmup - 1)
    return peak * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(1.0, frac))))


def load_rows(path, tok, max_len, cap=None):
    rows = [json.loads(line) for line in open(path, encoding="utf-8")]
    enc = [encode(tok, r["messages"], max_len) for r in rows]
    kept = [e for e in enc if e]
    return (kept[:cap] if cap else kept), len(enc) - len(kept)


def train(a):
    import torch
    from transformers import AutoTokenizer
    import qlora_common

    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    tok = AutoTokenizer.from_pretrained(a.model)
    train_rows, dropped = load_rows(a.train, tok, a.max_len)
    dev_rows, _ = load_rows(a.dev, tok, a.max_len, a.dev_cap)
    model = qlora_common.load_qlora(a.model, a.targets, a.rank)
    model.print_trainable_parameters()
    head = qlora_common.swap_head(model)
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=0.0, betas=(0.9, 0.99))
    per_epoch = math.ceil(len(train_rows) / a.accum)
    total = min(per_epoch * a.epochs, a.max_steps) if a.max_steps else per_epoch * a.epochs
    warmup = max(1, int(0.05 * total))

    def tensors(row):
        return (torch.tensor([row["input_ids"]], device="cuda"), torch.tensor([row["labels"]], device="cuda"))

    @torch.no_grad()
    def dev_loss():
        model.eval()
        tot, n = 0.0, 0
        for row in dev_rows:
            ids, lab = tensors(row)
            loss, k = qlora_common.reply_loss(model, head, ids, lab)
            tot += loss.item() * k
            n += k
        model.train()
        return tot / max(1, n)

    log = open(out / "log.jsonl", "a", encoding="utf-8")
    rng, step, best, stale, t0, toks = random.Random(a.seed), 0, (float("inf"), None), 0, time.time(), 0
    model.train()
    done = False
    for epoch in range(a.epochs):
        order = list(range(len(train_rows)))
        rng.shuffle(order)
        for k in range(0, len(order), a.accum):
            group = order[k:k + a.accum]
            ntok = sum(sum(1 for x in train_rows[i]["labels"] if x != -100) for i in group)
            loss_sum = 0.0
            for i in group:
                ids, lab = tensors(train_rows[i])
                loss, n = qlora_common.reply_loss(model, head, ids, lab)
                (loss * n / ntok).backward()
                loss_sum += loss.item() * n
                toks += ids.numel()
            for g in opt.param_groups:
                g["lr"] = lr_at(step, total, a.lr, warmup)
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            opt.zero_grad(set_to_none=True)
            step += 1
            rec = {"step": step, "epoch": epoch, "loss": round(loss_sum / ntok, 4), "lr": opt.param_groups[0]["lr"],
                   "tok_s": round(toks / (time.time() - t0)),
                   "vram_gb": round(torch.cuda.max_memory_allocated() / 2**30, 2)}
            if step % a.eval_every == 0 or step >= total:
                rec["dev_loss"] = round(dev_loss(), 4)
                model.save_pretrained(out / f"step{step}")
                if rec["dev_loss"] < best[0]:
                    best, stale = (rec["dev_loss"], f"step{step}"), 0
                else:
                    stale += 1
            log.write(json.dumps(rec) + "\n")
            log.flush()
            print(json.dumps(rec), flush=True)
            if step >= total or stale >= a.patience:
                done = True
                break
        if done:
            break
    model.save_pretrained(out / "final")
    (out / "summary.json").write_text(json.dumps({
        "train_examples": len(train_rows), "dropped_too_long": dropped, "dev_examples": len(dev_rows), "steps": step,
        "best_dev_loss": best[0], "best": best[1], "final": "final", "args": vars(a),
        "secs": round(time.time() - t0), "peak_vram_gb": round(torch.cuda.max_memory_allocated() / 2**30, 2)}, indent=1),
        encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--train", required=True)
    ap.add_argument("--dev", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--accum", type=int, default=16)
    ap.add_argument("--max-len", type=int, default=4096)
    ap.add_argument("--max-steps", type=int, default=0)
    ap.add_argument("--eval-every", type=int, default=20)
    ap.add_argument("--dev-cap", type=int, default=100)
    ap.add_argument("--patience", type=int, default=3)
    ap.add_argument("--targets", choices=["all-linear", "attn-mlp"], default="all-linear")
    ap.add_argument("--seed", type=int, default=0)
    train(ap.parse_args())


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: run the tests**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/qlora_common.py scripts/roles/train_lora.py && cd scripts/roles && HF_HUB_OFFLINE=1 $UPY -m unittest test_qlora_common test_train_lora -v`
Expected: `OK` (5 tests; the model and tokenizer tests skip if Qwen3-0.6B is not cached, the schedule test still passes). After Task 8, rerun once with the 4B tokenizer by editing `from_pretrained("Qwen/Qwen3-0.6B")` to `from_pretrained("E:/AI/role-adapters/models/Qwen3.5-4B")` in `test_train_lora.py` to confirm the thinking-off prompt for the real family.

- [ ] **Step 5: commit**

```bash
git add scripts/roles/qlora_common.py scripts/roles/test_qlora_common.py scripts/roles/train_lora.py scripts/roles/test_train_lora.py
git commit -m "feat(roles): memory-safe QLoRA trainer (reply-only chunked loss, no fp32 upcast)"
```

---

### Task 10: the smoke test, and its verdict (gate for everything after)

**Files:** Create `scripts/roles/smoke_qlora.py`.

- [ ] **Step 1: extract the script**

```python file=scripts/roles/smoke_qlora.py
"""Smoke test (spec section 3): can a QLoRA step run at the given sequence lengths within about 7.5 GB and 400 tokens/s?
Runs in Unsloth Studio's Python. usage: smoke_qlora.py --model DIR [--seqs 4096,8192,12288] [--steps 3] [--targets all-linear|attn-mlp]"""
import argparse
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))


def has(mod):
    try:
        __import__(mod)
        return True
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--seqs", default="4096")
    ap.add_argument("--steps", type=int, default=3)
    ap.add_argument("--targets", default="all-linear")
    a = ap.parse_args()
    import torch
    import transformers
    import qlora_common

    t0 = time.time()
    model = qlora_common.load_qlora(a.model, a.targets, 16)
    load_s = time.time() - t0
    head = qlora_common.swap_head(model)
    model.train()  # gradient checkpointing is only active in train mode
    names = sorted({n.split(".")[-1] for n, m in model.named_modules() if hasattr(m, "lora_A") and "lora_A" not in n})
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=1e-4)
    report = {"model": a.model, "transformers": transformers.__version__, "torch": torch.__version__,
              "fla": has("fla"), "causal_conv1d": has("causal_conv1d"), "load_s": round(load_s, 1),
              "lora_target_modules": names, "runs": []}
    for seq in (int(x) for x in a.seqs.split(",")):
        ids = torch.randint(1000, 20000, (1, seq), device="cuda")
        labels = ids.clone()
        labels[0, : int(seq * 0.4)] = -100  # a realistic split: the reply is the last 60%
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        secs = []
        try:
            for _ in range(a.steps):
                torch.cuda.synchronize()
                t = time.time()
                loss, _ = qlora_common.reply_loss(model, head, ids, labels)
                loss.backward()
                opt.step()
                opt.zero_grad(set_to_none=True)
                torch.cuda.synchronize()
                secs.append(time.time() - t)
            steady = secs[1:] or secs
            tok_s = seq / (sum(steady) / len(steady))
            peak = torch.cuda.max_memory_allocated() / 2**30
            report["runs"].append({"seq": seq, "step_secs": [round(s, 2) for s in secs], "tok_s": round(tok_s),
                                   "peak_vram_gb": round(peak, 2), "pass": peak <= 7.5 and tok_s >= 400})
        except torch.OutOfMemoryError as e:
            report["runs"].append({"seq": seq, "error": "out of memory", "pass": False})
            opt.zero_grad(set_to_none=True)
        print(json.dumps(report["runs"][-1]), flush=True)
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: run it on the 4B first, then the 9B** (GPU quiet, gate paused, no llama-server)

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/smoke_qlora.py && $UPY scripts/roles/smoke_qlora.py --model E:/AI/role-adapters/models/Qwen3.5-4B --steps 4 > /e/AI/role-adapters/logs/smoke-4B.json 2> /e/AI/role-adapters/logs/smoke-4B.err; tail -n 25 /e/AI/role-adapters/logs/smoke-4B.json`
Expected: a JSON report. Then the same with `Qwen3.5-9B` into `smoke-9B.json`, and `Qwen3.5-2B` into `smoke-2B.json`.

- [ ] **Step 3: apply the verdict (spec section 3)**

The 9B passes if `pass` is true (peak at most 7.5 GB, at least 400 tokens/s). Branches:
1. **9B passes:** the ladder is 9B, 4B (2B optional).
2. **Out of memory or too slow:** first try the slow-path fix: if `fla` and `causal_conv1d` are false and the step time is the cause, create a separate environment (never modify Unsloth Studio's own): `uv venv E:/AI/role-adapters/venv --python 3.12`, then `uv pip install --python E:/AI/role-adapters/venv/Scripts/python.exe torch --index-url https://download.pytorch.org/whl/cu128` and `uv pip install --python E:/AI/role-adapters/venv/Scripts/python.exe transformers peft bitsandbytes accelerate datasets flash-linear-attention`, rerun the smoke test with that Python, and use it as `$UPY` from here on. Record versions. If the cause is memory (the 9B's bf16 embedding and output matrices alone are about 4 GB), no installation helps: go to branch 3.
3. **9B still fails:** drop it. The ladder becomes 4B, 2B and 0.8B (download `Qwen/Qwen3.5-0.8B` and make its GGUF as in Task 8), stated in the results. `BASES` in `eval_roles.py` gets a `0.8B` entry.
4. **LoRA targets:** `lora_target_modules` lists what `all-linear` reached; Task 11 decides whether llama.cpp can serve the delta-net projections.

- [ ] **Step 4: commit the reports (scrubbed)**

```bash
mkdir -p docs/benchmarks/roles
cp /e/AI/role-adapters/logs/smoke-*.json docs/benchmarks/roles/
$PY scripts/moe-bench/scrub_paths.py docs/benchmarks/roles/smoke-*.json
git add scripts/roles/smoke_qlora.py docs/benchmarks/roles/smoke-*.json
git commit -m "feat(roles): QLoRA smoke test and its verdict"
```

---

### Task 11: serve gate: a trained LoRA must load in llama-server and reproduce its targets

**Files:** Create `scripts/roles/serve_lora_check.py`.

- [ ] **Step 1: extract the script**

```python file=scripts/roles/serve_lora_check.py
"""Gate 2b (spec section 3): a LoRA trained on the HF weights, converted to GGUF, must load in llama-server, change the
output and reproduce its training targets (mean difflib similarity >= 0.9 on greedy replies).
usage: serve_lora_check.py --base-gguf X.gguf --lora Y.gguf --samples tiny.jsonl [--n 8] [--out report.json]"""
import argparse
import difflib
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import llama_server  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-gguf", required=True)
    ap.add_argument("--lora", required=True)
    ap.add_argument("--samples", required=True)
    ap.add_argument("--n", type=int, default=8)
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    rows = [json.loads(line) for line in open(a.samples, encoding="utf-8")][:a.n]
    report = {"n": len(rows)}
    for tag, lora in (("base", None), ("lora", a.lora)):
        with llama_server.Server(a.base_gguf, lora=lora, parallel=1, slot_ctx=8192) as s:
            sims = []
            for r in rows:
                reply = s.chat(r["messages"][:-1], max_tokens=3000, temperature=0)["text"]
                sims.append(difflib.SequenceMatcher(None, reply, r["messages"][-1]["content"]).ratio())
        report[tag] = round(sum(sims) / len(sims), 3)
    report["pass"] = report["lora"] >= 0.9 and report["lora"] > report["base"] + 0.1
    print(json.dumps(report, indent=1))
    if a.out:
        pathlib.Path(a.out).write_text(json.dumps(report, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: write a tiny overfit set (8 build samples) and overfit the 4B for a few minutes**

```bash
$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/serve_lora_check.py
head -n 8 /e/AI/role-adapters/data/build-train.jsonl > /e/AI/role-adapters/data/tiny-build.jsonl
$UPY scripts/roles/train_lora.py --model E:/AI/role-adapters/models/Qwen3.5-4B --train /e/AI/role-adapters/data/tiny-build.jsonl \
  --dev /e/AI/role-adapters/data/tiny-build.jsonl --out E:/AI/role-adapters/runs/overfit-4B --epochs 12 --accum 4 --lr 2e-4 \
  --eval-every 6 --patience 99 > /e/AI/role-adapters/logs/overfit-4B.out 2>&1
tail -n 3 /e/AI/role-adapters/logs/overfit-4B.out
```
Expected: dev loss (which here is the train loss) falls below 0.1; `runs/overfit-4B/final/adapter_model.safetensors` exists.

- [ ] **Step 3: convert the adapter to GGUF**

Run: `$UPY $HOME/.unsloth/llama.cpp/convert_lora_to_gguf.py --base E:/AI/role-adapters/models/Qwen3.5-4B --outfile E:/AI/role-adapters/runs/overfit-4B/lora.gguf --outtype f16 E:/AI/role-adapters/runs/overfit-4B/final`
Expected: `lora.gguf` written. **If the converter rejects tensors** (for example the delta-net projections), retrain Step 2 with `--targets attn-mlp`, record that every adapter must use `attn-mlp`, and carry that flag into Tasks 14 to 16.

- [ ] **Step 4: run the serve check**

Run: `$PY scripts/roles/serve_lora_check.py --base-gguf E:/AI/role-adapters/gguf/Qwen3.5-4B-Q5_K_M.gguf --lora E:/AI/role-adapters/runs/overfit-4B/lora.gguf --samples /e/AI/role-adapters/data/tiny-build.jsonl --out /e/AI/role-adapters/logs/serve-check-4B.json`
Expected: `"pass": true` (lora similarity at least 0.9, base far lower). If it fails, the usual cause is the prompt: compare `prompt_n` from llama-server with the token count of `apply_chat_template(..., enable_thinking=False)` and fix `encode` in Task 9 before any real training.

- [ ] **Step 5: commit**

```bash
cp /e/AI/role-adapters/logs/serve-check-4B.json docs/benchmarks/roles/
git add scripts/roles/serve_lora_check.py docs/benchmarks/roles/serve-check-4B.json
git commit -m "feat(roles): LoRA serve gate"
```

---

### Task 12: the role-gate harness

**Files:** Create `scripts/roles/eval_roles.py`; Test `scripts/roles/test_eval_roles.py`.

- [ ] **Step 1: extract the test and watch it fail**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/test_eval_roles.py && cd scripts/roles && $PY -m unittest test_eval_roles`
Expected: FAIL, `ModuleNotFoundError: No module named 'eval_roles'`.

```python file=scripts/roles/test_eval_roles.py
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import eval_roles  # noqa: E402


class StatsTest(unittest.TestCase):
    def test_one_sided_mcnemar(self):
        self.assertAlmostEqual(eval_roles.p_one_sided(8, 0), 1 / 256)
        self.assertEqual(eval_roles.p_one_sided(0, 0), 1.0)
        self.assertAlmostEqual(eval_roles.p_one_sided(3, 3), 0.65625)

    def test_gate_passes_with_a_clear_gain(self):
        base = {f"s{i}": i < 10 for i in range(40)}
        adapter = {f"s{i}": i < 10 or 10 <= i < 20 for i in range(40)}
        g = eval_roles.gate(adapter, base)
        self.assertEqual((g["n"], g["adapter_pass"], g["base_pass"]), (40, 20, 10))
        self.assertAlmostEqual(g["diff"], 0.25)
        self.assertTrue(g["passed"])
        self.assertLess(g["ci90"][0], 0.25)
        self.assertGreater(g["ci90"][1], 0.25)

    def test_gate_fails_on_a_small_or_noisy_gain(self):
        base = {f"s{i}": i < 20 for i in range(40)}
        small = {f"s{i}": i < 21 for i in range(40)}
        self.assertFalse(eval_roles.gate(small, base)["passed"])

    def test_only_shared_seeds_count(self):
        g = eval_roles.gate({"a": True, "b": True}, {"b": False, "c": True})
        self.assertEqual(g["n"], 1)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: write the implementation**

```python file=scripts/roles/eval_roles.py
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
```

- [ ] **Step 3: run the tests**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/eval_roles.py && cd scripts/roles && $PY -m unittest test_eval_roles -v`
Expected: `OK` (4 tests).

- [ ] **Step 4: commit**

```bash
git add scripts/roles/eval_roles.py scripts/roles/test_eval_roles.py
git commit -m "feat(roles): role-gate harness (build, plan, fix) with pre-registered pass rule"
```

---

### Task 13: the retention gate

**Files:** Create `scripts/roles/retention.py`; Test `scripts/roles/test_retention.py`.

- [ ] **Step 1: extract the test and watch it fail**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/test_retention.py && cd scripts/roles && $PY -m unittest test_retention`
Expected: FAIL, `ModuleNotFoundError: No module named 'retention'`.

```python file=scripts/roles/test_retention.py
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import retention  # noqa: E402


class RetentionTest(unittest.TestCase):
    def test_letter_parsing(self):
        self.assertEqual(retention.letter("B"), "B")
        self.assertEqual(retention.letter("The answer is C."), "C")
        self.assertEqual(retention.letter("(D) because"), "D")
        self.assertIsNone(retention.letter("no idea"))

    def test_prompt_lists_four_choices(self):
        q = {"question": "Q?", "choices": ["w", "x", "y", "z"]}
        text = retention.mmlu_prompt(q)
        for line in ("A. w", "B. x", "C. y", "D. z"):
            self.assertIn(line, text)

    def test_noninferiority(self):
        self.assertTrue(retention.noninferior(0.60, 0.62)["passed"])
        self.assertFalse(retention.noninferior(0.55, 0.62)["passed"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: write the implementation**

```python file=scripts/roles/retention.py
"""Retention gate (spec section 4): tier2b single-shot and a 200-question general-knowledge subset, adapter loaded versus
the plain base; non-inferiority within 3 points. The subset is drawn once with a fixed seed and listed before any adapter runs.
usage:
  retention.py mmlu-subset --out docs/benchmarks/roles/mmlu-200.json         (run with Unsloth's Python: needs `datasets`)
  retention.py run --size 4B --name base|NAME [--lora X.gguf] --work DIR       (benchmark Python)"""
import argparse
import concurrent.futures
import json
import pathlib
import random
import re
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
for p in (HERE, HERE.parent / "teacher", HERE.parent / "moe-bench", REPO / "scripts" / "benchmark-tier2b"):
    sys.path.insert(0, str(p))
SUBSET = REPO / "docs" / "benchmarks" / "roles" / "mmlu-200.json"
MARGIN = 0.03


def letter(text):
    m = re.search(r"\b([ABCD])\b", text.strip())
    return m.group(1) if m else None


def mmlu_prompt(q):
    body = "\n".join(f"{c}. {t}" for c, t in zip("ABCD", q["choices"]))
    return f"{q['question']}\n\n{body}\n\nAnswer with the letter of the correct option only."


def noninferior(adapter, base):
    return {"adapter": round(adapter, 4), "base": round(base, 4), "diff": round(adapter - base, 4),
            "passed": adapter >= base - MARGIN}


def make_subset(out):
    from datasets import load_dataset
    ds = load_dataset("cais/mmlu", "all", split="test")
    idx = sorted(random.Random(20261009).sample(range(len(ds)), 200))
    rows = [{"i": i, "subject": ds[i]["subject"], "question": ds[i]["question"], "choices": ds[i]["choices"],
             "answer": "ABCD"[ds[i]["answer"]]} for i in idx]
    pathlib.Path(out).write_text(json.dumps(rows, indent=1), encoding="utf-8")
    print("wrote", out, len(rows))


def run_mmlu(server):
    rows = json.loads(SUBSET.read_text(encoding="utf-8"))

    def one(q):
        r = server.chat([{"role": "user", "content": mmlu_prompt(q)}], max_tokens=16, temperature=0)
        return letter(r["text"]) == q["answer"]
    with concurrent.futures.ThreadPoolExecutor(server.parallel) as ex:
        res = list(ex.map(one, rows))
    return sum(res) / len(res)


def run_tier2b(server, trials=3):
    import runbench2b
    import tasks

    def one(job):
        task, trial = job
        reply = server.chat([{"role": "user", "content": runbench2b.baseline_prompt(task)}], max_tokens=3000,
                            temperature=0.2, seed=trial)["text"]
        d = pathlib.Path(tempfile.mkdtemp(prefix="rt-"))
        runbench2b.seed(d, task)
        (d / task["entry"]).write_text(runbench2b.extract_code(reply), encoding="utf-8")
        return runbench2b.run_test(d, task["test"])[0]
    jobs = [(t, k) for t in tasks.TASKS for k in range(trials)]
    with concurrent.futures.ThreadPoolExecutor(server.parallel) as ex:
        res = list(ex.map(one, jobs))
    return sum(res) / len(res)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["mmlu-subset", "run"])
    ap.add_argument("--out", default=str(SUBSET))
    ap.add_argument("--size", default="4B")
    ap.add_argument("--name", default="base")
    ap.add_argument("--lora", default="")
    ap.add_argument("--work", default="E:/AI/role-adapters/eval")
    a = ap.parse_args()
    if a.cmd == "mmlu-subset":
        return make_subset(a.out)
    import eval_roles
    import llama_server
    with llama_server.Server(eval_roles.BASES[a.size], lora=a.lora or None, log_path=f"{a.work}/{a.size}-ret-server.log") as s:
        res = {"size": a.size, "name": a.name, "mmlu200": run_mmlu(s), "tier2b": run_tier2b(s)}
    out = pathlib.Path(a.work) / a.size / f"retention-{a.name}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(res, indent=1), encoding="utf-8")
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: run the tests, then draw and commit the subset before any adapter exists**

Run: `$PY scripts/roles/plan_extract.py docs/superpowers/plans/2026-10-09-role-adapters-2a-2c.md scripts/roles/retention.py && cd scripts/roles && $PY -m unittest test_retention -v`
Expected: `OK` (3 tests).

Run: `cd ../.. && HF_HOME=E:/AI/hf-cache $UPY scripts/roles/retention.py mmlu-subset`
Expected: `wrote .../docs/benchmarks/roles/mmlu-200.json 200`.

- [ ] **Step 4: commit**

```bash
git add scripts/roles/retention.py scripts/roles/test_retention.py docs/benchmarks/roles/mmlu-200.json
git commit -m "feat(roles): retention gate and the fixed 200-question subset"
```

---

### Task 14: baselines, then train arm S (2c)

**Files:** none new (outputs under `E:/AI/role-adapters`).

**Preconditions:** Task 6 is complete (manifest committed with at least 600 train samples per role); Tasks 8 to 13 are done; the Versutus gate is paused and the guard is running; no llama-server is up.

- [ ] **Step 1: baselines on dev and test for each size (served base, no adapter)**

```bash
W=E:/AI/role-adapters/eval
for s in 4B 9B; do
  for sp in dev test; do
    $PY scripts/roles/eval_roles.py baseline --size $s --split $sp --work $W >> /e/AI/role-adapters/logs/baseline-$s-$sp.out 2>&1
  done
  $PY scripts/roles/retention.py run --size $s --name base --work $W >> /e/AI/role-adapters/logs/retention-$s-base.out 2>&1
done
```
Expected: JSONL files under `eval/<size>/<split>/`; `retention-base.json` per size. These baselines are computed once and shared by all arms.

- [ ] **Step 2: train the three arm-S adapters for the 4B, then the 9B**

```bash
D=E:/AI/role-adapters/data
for s in 4B 9B; do
  for role in plan build fix; do
    $UPY scripts/roles/train_lora.py --model E:/AI/role-adapters/models/Qwen3.5-$s --train $D/$role-train.jsonl \
      --dev $D/$role-dev.jsonl --out E:/AI/role-adapters/runs/$s-S-$role $TARGETS >> /e/AI/role-adapters/logs/train-$s-S-$role.out 2>&1
  done
done
```
(`TARGETS` is empty, or `--targets attn-mlp` if Task 11 found delta-net LoRA tensors cannot be served.) Expected: each run ends with a `summary.json`; `log.jsonl` shows the dev loss falling. If the first dev run underfits (dev loss flat), rerun that one adapter once with `--lr 2e-4` and record both.

- [ ] **Step 3: convert every kept adapter (`best` = the lowest dev-loss step, and `final`) to GGUF**

```bash
for s in 4B 9B; do for role in plan build fix; do
  R=E:/AI/role-adapters/runs/$s-S-$role
  best=$($PY -c "import json;print(json.load(open('$R/summary.json'))['best'])")
  for ck in $best final; do
    $UPY $HOME/.unsloth/llama.cpp/convert_lora_to_gguf.py --base E:/AI/role-adapters/models/Qwen3.5-$s \
      --outfile $R/$ck.gguf --outtype f16 $R/$ck
  done
done; done
```
Expected: `<ck>.gguf` next to each checkpoint.

---

### Task 15: dev gates and checkpoint choice

- [ ] **Step 1: dev role gates for `best` and `final` of each role**

For each size `s` and each role, run the matching adapter command with `--split dev --name $s-S-$role-$ck --lora $R/$ck.gguf`:

```bash
W=E:/AI/role-adapters/eval
for s in 4B 9B; do for role in plan build fix; do
  R=E:/AI/role-adapters/runs/$s-S-$role
  best=$($PY -c "import json;print(json.load(open('$R/summary.json'))['best'])")
  for ck in $best final; do
    $PY scripts/roles/eval_roles.py $role-adapter --size $s --split dev --work $W --name $s-S-$role-$ck --lora $R/$ck.gguf \
      >> /e/AI/role-adapters/logs/dev-$s-S-$role.out 2>&1
  done
done; done
```
Expected: per-phase JSONL under `eval/<size>/dev/`.

- [ ] **Step 2: choose one checkpoint per adapter on dev**

For each (size, role), compare the two checkpoints' dev pass counts from the phase files (`builds-<name>-from-teacher`, `builds-base-from-<name>`, `fixes-<name>` : count `ok`); pick the higher; ties go to the lower dev loss. Write the choices to `E:/AI/role-adapters/eval/chosen-S.json` as `{"4B": {"plan": "<ckpt>", ...}, "9B": {...}}`.

- [ ] **Step 3: commit the choice rule's outputs (counts only)**

```bash
cp /e/AI/role-adapters/eval/chosen-S.json docs/benchmarks/roles/chosen-S.json
git add docs/benchmarks/roles/chosen-S.json
git commit -m "data(roles): arm S checkpoint choices (made on dev only)"
```

---

### Task 16: test gates, retention, and the 2c results (touch test once per final model)

- [ ] **Step 1: test role gates for the chosen checkpoints**

Run the three adapter commands again with `--split test --name <size>-S-<role> --lora <chosen>.gguf` (same pattern as Task 15 Step 1, one checkpoint each). Then:

```bash
for s in 4B 9B; do
  $PY scripts/roles/eval_roles.py report --size $s --split test --work $W --plan $s-S-plan --build $s-S-build --fix $s-S-fix
done
```
Expected: `gates-test-*.json` with, per role, `n`, rates, `diff`, `p`, `ci90`, `passed`.

- [ ] **Step 2: retention with each adapter loaded**

```bash
for s in 4B 9B; do for role in plan build fix; do
  $PY scripts/roles/retention.py run --size $s --name $s-S-$role --lora <chosen>.gguf --work $W
done; done
```
Compare with `retention-base.json` using `retention.noninferior(adapter, base)` for `mmlu200` and `tier2b` (both within 3 points).

- [ ] **Step 3: write `docs/superpowers/specs/2026-10-09-role-adapters-2c-results.md`**

Contents: the data manifest counts; the smoke-test verdict and the final ladder; training summaries (steps, dev loss, time, peak VRAM) for all six adapters; per size and role: baseline rate, adapter rate, diff, 90% interval, McNemar p, passed or not; retention table; the scaling observation (9B effect versus 4B effect for each passing role); every deviation; what 2d (arm O) and 2e need. Report failures as plainly as passes.

- [ ] **Step 4: copy scrubbed run data and commit**

```bash
mkdir -p docs/benchmarks/roles/eval
cp -r /e/AI/role-adapters/eval/4B/test /e/AI/role-adapters/eval/9B/test docs/benchmarks/roles/eval/ 2>/dev/null
find docs/benchmarks/roles -type f \( -name "*.json" -o -name "*.jsonl" \) | xargs $PY scripts/moe-bench/scrub_paths.py | awk '$1>0'
grep -rIil "$(whoami)" docs/benchmarks/roles docs/superpowers/specs/2026-10-09-role-adapters-2c-results.md scripts/roles || echo "no account name"
git add docs/benchmarks/roles docs/superpowers/specs/2026-10-09-role-adapters-2c-results.md
git commit -m "docs(roles): 2c results - arm S role gates and retention at 4B and 9B"
git push origin claude/micro-agent-swarm-design-929d42
```
(The test-set model outputs contain generated code and teacher-free text only; the teacher plans are not copied. If any file embeds teacher text, leave it out.)

- [ ] **Step 5: restore the machine**

```bash
touch /c/qwen3-forge-stage/logs/step2.done
(cd /c/Projects/Versutus && node gate/cli.mjs service start)
```
Poll `service status` until `lastHealthyAt` is newer than the restart, then ask the owner to review the 2c results before 2d.

---

## Self-review against the spec

- **Splits, exclusion, seeds, three sample types, faults, arm S:** Tasks 1 to 6.
- **Arm O (student samples, DeepSeek fixes):** deliberately a later plan (2d), as the spec sequences it after 2c.
- **Bases, adapters, fixed recipe, stack, smoke test with fallbacks:** Tasks 8 to 10 (smoke gate and branches), 9 (recipe).
- **Served evaluation of LoRAs (llama-server) with the conversion check:** Task 11.
- **Role gates (+5 points and McNemar p < 0.10, interval reported), retention (within 3 points), dev-only selection, test touched once:** Tasks 12, 13, 15, 16.
- **Headline on the Ecosystem Lab and Build B2:** later plans (2e); the spec's rule that the headline is reported on the Lab alone until B2 is sealed stays.
- **Rules:** no benchmark text in data (Task 2, exclusion; the wording check upstream in `seeds`); tier2b and the general-knowledge subset only measure (Task 13); every run is kept; keys never printed (the teacher client reads the key inside Python).
- **Type consistency:** `sid_of`, `split_of_rec`, `show_files`, `render_files`, `chat_messages`, `read_jsonl`, `FAILED` are defined in `samples.py` and used by `faults.py` and `eval_roles.py` with the same signatures; `Server.chat` returns `text/finish/prompt_n/gen_n/secs` and is used that way everywhere; `gate` returns the keys the report prints.
