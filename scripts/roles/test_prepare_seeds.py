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
