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
