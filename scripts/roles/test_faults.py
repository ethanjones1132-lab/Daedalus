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
