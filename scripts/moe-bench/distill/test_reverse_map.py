"""reverse_map against llama.cpp's own forward converter on a toy qwen35moe layer (run with venv-laya: needs torch).
The converter's GGUF output, mapped back, must give the original HF tensors."""
import pathlib
import sys
import unittest

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import reverse_map as rm  # noqa: E402

HP = {"linear_num_key_heads": 2, "linear_num_value_heads": 4, "linear_key_head_dim": 3, "linear_value_head_dim": 5,
      "hidden_size": 8, "num_hidden_layers": 2}


def toy_layers(rng):
    kh, vh, dk, dv, h = 2, 4, 3, 5, 8
    qkv = 2 * kh * dk + vh * dv
    lin = {"input_layernorm.weight": (h,), "post_attention_layernorm.weight": (h,),
           "linear_attn.in_proj_qkv.weight": (qkv, h), "linear_attn.in_proj_z.weight": (vh * dv, h),
           "linear_attn.in_proj_a.weight": (vh, h), "linear_attn.in_proj_b.weight": (vh, h),
           "linear_attn.conv1d.weight": (qkv, 1, 4), "linear_attn.dt_bias": (vh,),
           "linear_attn.norm.weight": (dv,), "linear_attn.out_proj.weight": (h, vh * dv),
           "mlp.gate.weight": (3, h), "mlp.experts.gate_up_proj": (3, 2 * 6, h), "mlp.experts.down_proj": (3, h, 6),
           "mlp.shared_expert.gate_proj.weight": (6, h), "mlp.shared_expert.up_proj.weight": (6, h),
           "mlp.shared_expert.down_proj.weight": (h, 6), "mlp.shared_expert_gate.weight": (1, h)}
    full = {"input_layernorm.weight": (h,), "post_attention_layernorm.weight": (h,),
            "self_attn.q_proj.weight": (16, h), "self_attn.k_proj.weight": (4, h), "self_attn.v_proj.weight": (4, h),
            "self_attn.o_proj.weight": (h, 8), "self_attn.q_norm.weight": (4,), "self_attn.k_norm.weight": (4,),
            "mlp.gate.weight": (3, h), "mlp.experts.gate_up_proj": (3, 12, h), "mlp.experts.down_proj": (3, h, 6),
            "mlp.shared_expert.gate_proj.weight": (6, h), "mlp.shared_expert.up_proj.weight": (6, h),
            "mlp.shared_expert.down_proj.weight": (h, 6), "mlp.shared_expert_gate.weight": (1, h)}
    hf = {f"model.layers.0.{k}": rng.standard_normal(s).astype(np.float32) for k, s in lin.items()}
    hf["model.layers.0.linear_attn.A_log"] = rng.standard_normal(vh).astype(np.float32)
    hf.update({f"model.layers.1.{k}": rng.standard_normal(s).astype(np.float32) for k, s in full.items()})
    return hf


class ReverseMapTest(unittest.TestCase):
    def test_untile_inverts_the_converter_reorder(self):
        sys.path[:0] = [rm.LLAMA, rm.LLAMA + r"\gguf-py"]
        import torch
        from conversion.qwen import _LinearAttentionVReorderBase as V
        x = np.arange(2 * 4 * 5 * 3, dtype=np.float32).reshape(2 * 4 * 5, 3)
        tiled = V._reorder_v_heads(torch.from_numpy(x), 0, 2, 4, 5).numpy()  # 2 K heads x 4 V each x 5 dims
        self.assertFalse(np.array_equal(tiled, x))
        np.testing.assert_array_equal(rm.untile(tiled, 0, 2, 4, 5), x)
        cols = V._reorder_v_heads(torch.from_numpy(x.T.copy()), 1, 2, 4, 5).numpy()
        np.testing.assert_array_equal(rm.untile(cols, 1, 2, 4, 5), x.T)

    def test_toy_layers_round_trip(self):
        hf = toy_layers(np.random.default_rng(0))
        gg = rm.forward(hf, HP, 2)  # llama.cpp's own transforms
        for b in (0, 1):
            t = {n.split(".", 2)[2]: x for n, x in gg.items() if n.startswith(f"blk.{b}.")}
            back = rm.layer_to_hf(b, t, HP)
            mine = {n: x for n, x in hf.items() if n.startswith(f"model.layers.{b}.")}
            self.assertEqual(set(back), set(mine))
            for n, x in mine.items():
                np.testing.assert_allclose(back[n].reshape(x.shape), x, rtol=1e-5, atol=1e-6, err_msg=n)
        # and forward(reverse(GGUF)) gives the GGUF back
        again = rm.forward({n: x for b in (0, 1) for n, x in rm.layer_to_hf(
            b, {n.split(".", 2)[2]: x for n, x in gg.items() if n.startswith(f"blk.{b}.")}, HP).items()}, HP, 2)
        self.assertEqual(rm.verdict(rm.compare(gg, again)), {})


if __name__ == "__main__":
    unittest.main()
