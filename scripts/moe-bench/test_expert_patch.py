"""Tests for the adapters phase-1 tools (2026-10-05): expert_patch, kl_eval.parse, steer.discipline,
slice_experts --keep-list, and bestofn_tier2b.server_args overrides."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import expert_patch as ep  # noqa: E402
import kl_eval  # noqa: E402
import steer  # noqa: E402


class ExpertPatchTest(unittest.TestCase):
    def test_combine_normalizes_then_adds(self):
        c = ep.combine({0: np.array([1.0, 3.0])}, {0: np.array([10.0, 10.0])})
        np.testing.assert_allclose(c[0], [0.25 + 0.5, 0.75 + 0.5])

    def test_variants(self):
        rng = np.random.default_rng(0)
        new = {L: rng.random(256) for L in range(3)}
        code = {L: rng.random(256) for L in range(3)}
        keep96 = {L: sorted(rng.choice(256, 96, replace=False).tolist()) for L in range(3)}
        keep96[3] = list(range(96))  # an MTP-like layer without energy
        fb = {3: np.arange(256, 0, -1, dtype=float)}  # router norms: lower index scores higher
        v = ep.variants(keep96, new, code, fb)
        comb = ep.combine(new, code)
        for L in range(3):
            self.assertEqual(v["swap96"][L], sorted(np.argsort(-comb[L])[:96].tolist()))
            self.assertEqual(v["swap108"][L], sorted(np.argsort(-comb[L])[:108].tolist()))
            extra = set(v["add108"][L]) - set(keep96[L])
            self.assertTrue(set(keep96[L]) <= set(v["add108"][L]))
            dropped = [i for i in range(256) if i not in keep96[L]]
            best = sorted(dropped, key=lambda i: -new[L][i])[:12]
            self.assertEqual(extra, set(best))
        self.assertEqual(v["swap96"][3], keep96[3])
        for name, n in (("swap96", 96), ("add108", 108), ("swap108", 108)):
            for L, idx in v[name].items():
                self.assertEqual(len(idx), n)
                self.assertEqual(idx, sorted(set(idx)))
                self.assertTrue(all(0 <= i < 256 for i in idx))


class ParseTest(unittest.TestCase):
    def test_parse_kl_block(self):
        text = """====== KL divergence statistics ======
Mean    KLD:   0.102938 ±   0.001850
Maximum KLD:  12.345678
99.9%   KLD:   4.567890
99.0%   KLD:   1.234567
Median  KLD:   0.012345
====== Token probability statistics ======
Same top p:  88.456 ± 0.123 %"""
        self.assertEqual(kl_eval.parse(text), {"mean_kld": 0.102938, "p99_kld": 1.234567, "same_top_p": 88.456})

    def test_parse_missing(self):
        self.assertEqual(kl_eval.parse("nothing")["mean_kld"], None)


TASK = {"entry": "calc.py", "files": {"calc.py": "import math\nfrom rules import rate\n\n\ndef total(x):\n"
                                                 "    return x * rate(x)\n\n\nclass Cart:\n    pass\n"}}


class DisciplineTest(unittest.TestCase):
    def test_complete_file_passes(self):
        good = "import math\nfrom rules import rate\n\n\ndef total(x):\n    return round(x * rate(x), 2)\n\n\nclass Cart:\n    pass\n"
        self.assertTrue(steer.discipline(TASK, good)[0])

    def test_failures(self):
        self.assertFalse(steer.discipline(TASK, "def total(x:\n")[0])  # does not compile
        self.assertFalse(steer.discipline(TASK, "import calc\nprint(calc.total(3))\n")[0])  # a probe script
        no_import = "from rules import rate\n\n\ndef total(x):\n    return x\n\n\nclass Cart:\n    pass\n"
        self.assertEqual(steer.discipline(TASK, no_import)[1], "dropped ['import math']")


class PairsTest(unittest.TestCase):
    def test_pairs_share_their_prompt(self):
        import types
        from unittest import mock
        fake = types.SimpleNamespace(fix_prompt=lambda task, script, output: f"fix {task['name']}: {script} -> {output}")
        good = "import math\nfrom rules import rate\n\n\ndef total(x):\n    return x\n\n\nclass Cart:\n    pass\n"
        bad = "import calc\nprint(calc.total(3))\n"
        task, other = dict(TASK, name="t"), dict(TASK, name="u")
        rows = [(task, {"probe": "p1", "probe_output": "o1"}, good, True),
                (task, {"probe": "p2", "probe_output": "o2"}, bad, False),
                (other, {"probe": "p3", "probe_output": "o3"}, bad, False)]  # no disciplined row of its task: no pair
        with mock.patch.dict(sys.modules, {"probe_tier2b": fake}):
            pos, neg = steer.make_pairs(rows)
        self.assertEqual(len(pos), 3)
        for p, n in zip(pos, neg):
            self.assertEqual(p.split("</think>")[0], n.split("</think>")[0])  # the same prompt
            self.assertNotEqual(p, n)
        self.assertIn("p2 -> o2", pos[2])
        self.assertIn("def total", pos[2])  # the failed row's prompt with the disciplined opening
        self.assertIn("import calc", neg[2])
        no_imports = dict(TASK, name="v")
        plain = "def total(x):\n    return x\n"
        with mock.patch.dict(sys.modules, {"probe_tier2b": fake}):
            pos, neg = steer.make_pairs([(no_imports, {"probe": "p", "probe_output": "o"}, plain, True)])
        self.assertEqual(len(pos), 1)  # the import-less negative equals the positive and is skipped


class KeepListTest(unittest.TestCase):
    def test_slice_with_keep_list(self):
        from gguf import GGUFReader, GGUFWriter
        d = pathlib.Path(tempfile.mkdtemp())
        src, dst, kl = d / "in.gguf", d / "out.gguf", d / "keep.json"
        w = GGUFWriter(str(src), arch="toy")
        w.add_uint32("toy.expert_count", 4)
        w.add_uint32("toy.expert_used_count", 1)
        rng = np.random.default_rng(1)
        data = {}
        for L in (0, 1):
            for t, shape in (("ffn_gate_exps", (4, 3, 2)), ("ffn_up_exps", (4, 3, 2)), ("ffn_down_exps", (4, 2, 3)),
                             ("ffn_gate_inp", (4, 2))):
                name = f"blk.{L}.{t}.weight"
                data[name] = rng.random(shape).astype(np.float32)
                w.add_tensor(name, data[name])
        data["token_embd.weight"] = rng.random((5, 2)).astype(np.float32)
        w.add_tensor("token_embd.weight", data["token_embd.weight"])
        w.write_header_to_file()
        w.write_kv_data_to_file()
        w.write_tensors_to_file()
        w.close()
        keep = {"0": [1, 3], "1": [0, 2]}
        kl.write_text(json.dumps(keep))
        p = subprocess.run([sys.executable, str(HERE / "slice_experts.py"), str(src), str(dst), "--keep-list", str(kl)],
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        r = GGUFReader(str(dst))
        self.assertEqual(int(r.fields["toy.expert_count"].parts[-1][0]), 2)
        got = {t.name: np.asarray(t.data) for t in r.tensors}
        for L, idx in ((0, [1, 3]), (1, [0, 2])):
            for t in ("ffn_gate_exps", "ffn_up_exps", "ffn_down_exps", "ffn_gate_inp"):
                name = f"blk.{L}.{t}.weight"
                np.testing.assert_array_equal(got[name], data[name][idx])
        np.testing.assert_array_equal(got["token_embd.weight"], data["token_embd.weight"])

    def test_keep_list_rejects_unequal_counts(self):
        d = pathlib.Path(tempfile.mkdtemp())
        (d / "keep.json").write_text(json.dumps({"0": [1, 3], "1": [0]}))
        p = subprocess.run([sys.executable, str(HERE / "slice_experts.py"), "nonexistent.gguf", str(d / "o.gguf"),
                            "--keep-list", str(d / "keep.json")], capture_output=True, text=True)
        self.assertNotEqual(p.returncode, 0)


class ServerArgsTest(unittest.TestCase):
    def test_overrides(self):
        import bestofn_tier2b as bon
        bon.CFG.update(bon.CONFIGS["qwen36keep96"], budget=0)
        for k in ("BON_GGUF", "BON_EXTRA"):
            os.environ.pop(k, None)
        base = bon.server_args()
        self.assertEqual(base[2], str(bon.CONFIGS["qwen36keep96"]["model"]))
        os.environ["BON_GGUF"], os.environ["BON_EXTRA"] = "X.gguf", '["--control-vector-scaled", "cv.gguf:0.5"]'
        try:
            got = bon.server_args()
        finally:
            del os.environ["BON_GGUF"], os.environ["BON_EXTRA"]
        self.assertEqual(got[2], "X.gguf")
        self.assertEqual(got[-2:], ["--control-vector-scaled", "cv.gguf:0.5"])
        self.assertEqual(got[3:-2], base[3:])
        self.assertEqual(bon.server_args(), base)


if __name__ == "__main__":
    unittest.main()
