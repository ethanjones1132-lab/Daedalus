import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import choose_ckpt  # noqa: E402


def write_phase(path, oks):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps({"sid": str(i), "ok": ok}) + "\n" for i, ok in enumerate(oks)), encoding="utf-8")


class ChooseTest(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp())
        self.work, self.runs = self.d / "eval", self.d / "runs"

    def summary(self, size, role, best, steps):
        r = self.runs / f"{size}-S-{role}"
        r.mkdir(parents=True)
        (r / "summary.json").write_text(json.dumps({"best": best, "final": "final", "steps": steps}), encoding="utf-8")

    def test_candidates_skip_final_when_best_is_the_last_step(self):
        self.assertEqual(choose_ckpt.candidates({"best": "step20", "final": "final", "steps": 37}), ["step20", "final"])
        self.assertEqual(choose_ckpt.candidates({"best": "step37", "final": "final", "steps": 37}), ["step37"])

    def test_higher_dev_pass_count_wins_and_a_tie_goes_to_best(self):
        self.summary("4B", "build", "step20", 37)
        self.summary("4B", "plan", "step20", 37)
        dev = self.work / "4B" / "dev"
        write_phase(dev / "builds-4B-S-build-step20-from-teacher.jsonl", [True, False, False])
        write_phase(dev / "builds-4B-S-build-final-from-teacher.jsonl", [True, True, False])
        write_phase(dev / "builds-base-from-4B-S-plan-step20.jsonl", [True, True])
        write_phase(dev / "builds-base-from-4B-S-plan-final.jsonl", [True, True])
        chosen, table = choose_ckpt.choose(self.work, self.runs, "S", ["4B"])
        self.assertEqual(chosen["4B"], {"build": "final", "plan": "step20"})
        self.assertEqual(len(table), 4)

    def test_a_role_without_a_summary_is_left_out(self):
        chosen, _ = choose_ckpt.choose(self.work, self.runs, "S", ["2B"])
        self.assertEqual(chosen, {"2B": {}})


if __name__ == "__main__":
    unittest.main()
