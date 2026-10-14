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
