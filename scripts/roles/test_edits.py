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
