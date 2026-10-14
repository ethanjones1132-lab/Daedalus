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
