import pathlib
import random
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import oneshot_bench as ob  # noqa: E402

APP = "<!doctype html>\n<html><body><script>window.lab = {};</script></body></html>"


class ExtractTest(unittest.TestCase):
    def test_plan_then_fenced_html(self):
        r = ob.extract("## Plan\nData model: grid.\n\n```html\n" + APP + "\n```\n")
        self.assertEqual(r["plan"], "## Plan\nData model: grid.")
        self.assertEqual(r["app"], APP)
        self.assertFalse(r["truncated"])

    def test_longest_html_block_wins(self):
        text = "## Plan\nx\n```html\n<p>stub</p>\n```\nthen\n```html\n" + APP + "\n```"
        self.assertEqual(ob.extract(text)["app"], APP)

    def test_unfenced_document(self):
        r = ob.extract("Here it is:\n" + APP)
        self.assertEqual(r["app"], APP)
        self.assertEqual(r["plan"], "Here it is:")

    def test_truncated_open_fence(self):
        r = ob.extract("## Plan\np\n```html\n<!doctype html>\n<html><body><script>let a = 1;")
        self.assertTrue(r["truncated"])
        self.assertTrue(r["app"].startswith("<!doctype html>"))

    def test_no_plan_heading(self):
        r = ob.extract("```html\n" + APP + "\n```")
        self.assertEqual(r["plan"], "")
        self.assertEqual(r["app"], APP)

    def test_js_block_is_not_the_app(self):
        text = "## Plan\n```js\nfunction mulberry32() {}\n```\n```html\n" + APP + "\n```"
        self.assertEqual(ob.extract(text)["app"], APP)

    def test_plan_found_after_the_app(self):
        text = "```html\n" + APP + "\n```\n\n## Plan\nTick order: grass first.\n\n```js\nlet a;\n```"
        self.assertEqual(ob.extract(text)["plan"], "## Plan\nTick order: grass first.")


SKELETON = "<!doctype html>\n<html><head><title>t</title></head><body><canvas></canvas></body></html>"
JS = "window.lab = { reset() {} };\n" + "// filler\n" * 30


class AssembleTest(unittest.TestCase):
    def test_inlines_first_js_and_css_into_a_scriptless_skeleton(self):
        text = ("```html\n" + SKELETON + "\n```\n```css\nbody { margin: 0; }\n```\n```javascript\n" + JS + "```\n"
                "```javascript\n" + JS + "```\n")
        app = ob.assemble(text)
        self.assertEqual(app.count("window.lab"), 1)
        self.assertIn("<style>\nbody { margin: 0; }\n</style></head>", app)
        self.assertLess(app.index("window.lab"), app.index("</body>"))

    def test_leaves_a_complete_app_alone(self):
        text = "```html\n" + APP.replace("window.lab = {};", JS) + "\n```\n```js\nconsole.log(1);\n```"
        self.assertEqual(ob.assemble(text), ob.extract(text)["app"])


class ScoreTest(unittest.TestCase):
    def test_summary(self):
        s = ob.summarize([0.5, 0.7, 0.9])
        self.assertAlmostEqual(s["mean"], 0.7)
        self.assertEqual((s["min"], s["max"], s["n"]), (0.5, 0.9, 3))
        self.assertAlmostEqual(s["sd"], 0.2)
        self.assertEqual(ob.summarize([0.4])["sd"], 0.0)

    def test_area_means(self):
        runs = [{"areas": {"logic": 1.0, "algo": 0.5}}, {"areas": {"logic": 0.5, "algo": 0.0}}]
        self.assertEqual(ob.area_means(runs), {"algo": 0.25, "logic": 0.75})


class ModelArgsTest(unittest.TestCase):
    def test_mtp_with_draft_head(self):
        a = ob.llama_args("gemma26b", 18)
        self.assertEqual(a[a.index("--n-cpu-moe") + 1], "18")
        self.assertEqual(a[a.index("-c") + 1], str(ob.CTX))
        self.assertEqual(a[a.index("--spec-type") + 1], "draft-mtp,ngram-mod")
        self.assertIn("-md", a)
        self.assertEqual(a[a.index("--reasoning-budget") + 1], "0")

    def test_ngram_reasoning_model(self):
        a = ob.llama_args("gptoss20b", 11)
        self.assertEqual(a[a.index("--spec-type") + 1], "ngram-mod")
        self.assertNotIn("-md", a)
        self.assertEqual(a[a.index("--reasoning-budget") + 1], "-1")

    def test_branch_build_without_speculation(self):
        a = ob.llama_args("k2h", 30)
        self.assertNotIn("--spec-type", a)
        self.assertTrue(a[0].endswith(str(ob.BUILDS["k2h"].name)) or "k2h" in a[0])
        self.assertEqual(a[a.index("-ot") + 1], "attn_v_exps=CPU")

    def test_fit_steps(self):
        self.assertEqual(ob.next_placement(16, used_mib=7600, loaded=True), None)
        self.assertEqual(ob.next_placement(16, used_mib=8100, loaded=True), 18)
        self.assertEqual(ob.next_placement(16, used_mib=None, loaded=False), 20)


class BlindTest(unittest.TestCase):
    def test_ids_unique_and_hide_models(self):
        keys = [f"keep96/{s}" for s in range(1, 6)] + [f"deepseek/{s}" for s in range(1, 6)]
        mapping = ob.blind_ids(keys, random.Random(3))
        self.assertEqual(sorted(mapping.values()), sorted(keys))
        self.assertEqual(len(set(mapping)), 10)
        for bid in mapping:
            self.assertNotIn("keep", bid)
            self.assertNotIn("deep", bid)
            self.assertRegex(bid, r"^[0-9a-f]{6}$")

    def test_order_is_shuffled_not_grouped(self):
        keys = [f"keep96/{s}" for s in range(1, 6)] + [f"deepseek/{s}" for s in range(1, 6)]
        order = list(ob.blind_ids(keys, random.Random(1)).values())
        self.assertNotEqual(order, keys)


if __name__ == "__main__":
    unittest.main()
