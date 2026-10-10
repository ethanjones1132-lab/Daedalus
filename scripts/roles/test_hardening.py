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
