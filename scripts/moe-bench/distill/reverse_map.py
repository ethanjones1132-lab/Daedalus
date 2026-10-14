"""qwen35moe GGUF tensors, as llama.cpp 836d571 writes them, back to transformers' Qwen3_5Moe text layout
(adapters spec section 4.4, gate 1; plan 2026-10-06-adapters-phase2.md, Task 2).

Each step inverts one transform of conversion/qwen.py (Qwen3_5MoeTextModel and its bases). forward() runs
llama.cpp's own code on the result, so the round trip checks this module against the converter itself.
Arrays are numpy in torch order, the reverse of a GGUF tensor's ne. The MTP layer is not mapped: it is neither
trained nor used by the forward pass.

usage: reverse_map.py roundtrip GGUF [--layers 0,3] [--out report.json]
       (needs torch, and llama.cpp's conversion package at LLAMA)
"""
import argparse
import json
import sys
import time

import numpy as np

LLAMA = r"C:\build\wt-master"
HP_KEYS = ("linear_num_key_heads", "linear_num_value_heads", "linear_key_head_dim", "linear_value_head_dim",
           "hidden_size", "num_hidden_layers")
GLOBAL = {"token_embd.weight": "model.embed_tokens.weight", "output.weight": "lm_head.weight",
          "output_norm.weight": "model.norm.weight"}
LAYER = {"attn_norm.weight": "input_layernorm.weight", "post_attention_norm.weight": "post_attention_layernorm.weight",
         "attn_q.weight": "self_attn.q_proj.weight", "attn_k.weight": "self_attn.k_proj.weight",
         "attn_v.weight": "self_attn.v_proj.weight", "attn_output.weight": "self_attn.o_proj.weight",
         "attn_q_norm.weight": "self_attn.q_norm.weight", "attn_k_norm.weight": "self_attn.k_norm.weight",
         "attn_qkv.weight": "linear_attn.in_proj_qkv.weight", "attn_gate.weight": "linear_attn.in_proj_z.weight",
         "ssm_alpha.weight": "linear_attn.in_proj_a.weight", "ssm_beta.weight": "linear_attn.in_proj_b.weight",
         "ssm_conv1d.weight": "linear_attn.conv1d.weight", "ssm_a": "linear_attn.A_log",
         "ssm_dt.bias": "linear_attn.dt_bias", "ssm_norm.weight": "linear_attn.norm.weight",
         "ssm_out.weight": "linear_attn.out_proj.weight", "ffn_gate_inp.weight": "mlp.gate.weight",
         "ffn_down_exps.weight": "mlp.experts.down_proj",
         "ffn_gate_shexp.weight": "mlp.shared_expert.gate_proj.weight",
         "ffn_up_shexp.weight": "mlp.shared_expert.up_proj.weight",
         "ffn_down_shexp.weight": "mlp.shared_expert.down_proj.weight",
         "ffn_gate_inp_shexp.weight": "mlp.shared_expert_gate.weight"}
# the converter adds 1 to every "*norm.weight" except linear_attn.norm
PLUS_ONE = {"attn_norm.weight", "post_attention_norm.weight", "attn_q_norm.weight", "attn_k_norm.weight"}
# tensors the converter changes arithmetically (exp, +1); everything else is a pure permutation or rename
ARITH = PLUS_ONE | {"ssm_a", "output_norm.weight"}


def untile(x, axis, k_heads, v_per_k, d):
    """Inverse of the converter's _reorder_v_heads: V heads tiled [v_per_k, k_heads, d] -> grouped
    [k_heads, v_per_k, d] along `axis`."""
    x = np.moveaxis(x, axis, 0)
    rest = x.shape[1:]
    x = x.reshape(v_per_k, k_heads, d, *rest).swapaxes(0, 1).reshape(k_heads * v_per_k * d, *rest)
    return np.moveaxis(x, 0, axis)


def global_to_hf(name, x):
    x = np.asarray(x, dtype=np.float32)
    return GLOBAL[name], (x - 1 if name == "output_norm.weight" else x)


def layer_to_hf(bid, t, hp):
    """t: {GGUF suffix, e.g. 'attn_qkv.weight': array} for one layer -> {HF name: float32 array}."""
    kh, vh = hp["linear_num_key_heads"], hp["linear_num_value_heads"]
    dk, dv = hp["linear_key_head_dim"], hp["linear_value_head_dim"]
    r, qk = vh // kh, 2 * kh * dk  # V heads per K head; q + k channels ahead of v in qkv and conv1d
    p = f"model.layers.{bid}."
    out = {}
    for k, x in t.items():
        if k in ("ffn_gate_exps.weight", "ffn_up_exps.weight"):
            continue
        x = np.asarray(x, dtype=np.float32)
        if k in PLUS_ONE:
            x = x - 1
        elif k == "ssm_a":  # forward: -exp(A_log), V heads tiled
            x = untile(np.log(-x)[:, None], 0, kh, r, 1)[:, 0]
        elif k == "ssm_dt.bias":
            x = untile(x[:, None], 0, kh, r, 1)[:, 0]
        elif k == "attn_qkv.weight":  # only the V rows are tiled
            x = np.concatenate([x[:qk], untile(x[qk:], 0, kh, r, dv)])
        elif k == "attn_gate.weight":
            x = untile(x, 0, kh, r, dv)
        elif k in ("ssm_alpha.weight", "ssm_beta.weight"):
            x = untile(x, 0, kh, r, 1)
        elif k == "ssm_conv1d.weight":  # forward squeezes [C, 1, K] and tiles the V channels
            x = np.concatenate([x[:qk], untile(x[qk:], 0, kh, r, dv)])[:, None, :]
        elif k == "ssm_out.weight":  # V heads are its input columns
            x = untile(x, 1, kh, r, dv)
        elif k == "ffn_gate_inp_shexp.weight":
            x = x[None, :]
        out[p + LAYER[k]] = x
    if "ffn_gate_exps.weight" in t:  # transformers fuses gate and up on the n_ff axis
        out[p + "mlp.experts.gate_up_proj"] = np.concatenate(
            [np.asarray(t["ffn_gate_exps.weight"], np.float32), np.asarray(t["ffn_up_exps.weight"], np.float32)], axis=1)
    return out


def forward(hf, hp, n_blocks):
    """llama.cpp's own HF -> GGUF tensor transforms (836d571) on {HF name: array} -> {GGUF name: array}."""
    import torch
    sys.path[:0] = [LLAMA, LLAMA + r"\gguf-py"]
    import gguf
    from conversion.qwen import Qwen3_5MoeTextModel
    m = object.__new__(Qwen3_5MoeTextModel)
    m.hparams, m.block_count = dict(hp), n_blocks
    m.tensor_map = gguf.get_tensor_name_map(gguf.MODEL_ARCH.QWEN35MOE, n_blocks)
    m.fuse_gate_up_exps = m.fuse_qkv = False
    m._experts = None
    out = {}
    for name, x in hf.items():
        bid = int(name.split(".")[2]) if name.startswith("model.layers.") else None
        for n, y in m.modify_tensors(torch.from_numpy(np.ascontiguousarray(x)), name, bid):
            out[n] = y.numpy()
    return out


def compare(ref, got):
    """{GGUF name: array} pair -> {name: [exact, max |diff| / max |ref|]}; size-1 axes ignored."""
    res = {}
    for n, a in ref.items():
        b = got.get(n)
        if b is None:
            res[n] = [False, None]
            continue
        a, b = np.squeeze(np.asarray(a, np.float32)), np.squeeze(np.asarray(b, np.float32))
        if a.shape != b.shape:
            res[n] = [False, f"shape {a.shape} vs {b.shape}"]
            continue
        res[n] = [bool(np.array_equal(a, b)), float(np.max(np.abs(a - b)) / max(float(np.max(np.abs(a))), 1e-30))]
    for n in set(got) - set(ref):
        res[n] = [False, "not in the GGUF"]
    return res


def verdict(res):
    """The gate: pure permutations bitwise equal, arithmetic transforms within 1e-6 relative."""
    bad = {}
    for n, (exact, rel) in res.items():
        suffix = n.split(".", 2)[-1] if n.startswith("blk.") else n
        ok = exact or (suffix in ARITH and isinstance(rel, float) and rel <= 1e-6)
        if not ok:
            bad[n] = [exact, rel]
    return bad


def roundtrip(a):
    sys.path[:0] = [LLAMA + r"\gguf-py"]
    from gguf import GGUFReader
    from gguf.quants import dequantize
    r = GGUFReader(a.gguf)
    f = r.fields
    val = lambda k: int(f[k].parts[f[k].data[0]][0])  # noqa: E731
    hp = {"linear_num_key_heads": val("qwen35moe.ssm.group_count"),
          "linear_num_value_heads": val("qwen35moe.ssm.time_step_rank"),
          "linear_key_head_dim": val("qwen35moe.ssm.state_size"),
          "linear_value_head_dim": val("qwen35moe.ssm.inner_size") // val("qwen35moe.ssm.time_step_rank"),
          "hidden_size": val("qwen35moe.embedding_length"),
          "num_hidden_layers": val("qwen35moe.block_count") - val("qwen35moe.nextn_predict_layers")}
    n_blocks = val("qwen35moe.block_count")
    by_layer, globals_ = {}, {}
    for t in r.tensors:
        if t.name.startswith("blk."):
            _, b, suffix = t.name.split(".", 2)
            by_layer.setdefault(int(b), {})[suffix] = t
        else:
            globals_[t.name] = t
    layers = [int(x) for x in a.layers.split(",")] if a.layers else list(range(hp["num_hidden_layers"]))
    report, t0 = {"hparams": hp, "layers": {}, "failures": {}}, time.time()
    deq = lambda t: dequantize(t.data, t.tensor_type)  # noqa: E731
    for name, t in ([] if a.layers else globals_.items()):
        ref = {name: deq(t)}
        hn, x = global_to_hf(name, ref[name])
        res = compare(ref, forward({hn: x}, hp, n_blocks))
        report["layers"][name] = res
        report["failures"].update(verdict(res))
        print(f"{name}: {'ok' if not verdict(res) else verdict(res)} ({time.time() - t0:.0f} s)", flush=True)
    for b in layers:
        ref = {s: deq(t) for s, t in by_layer[b].items()}
        res = compare({f"blk.{b}.{s}": x for s, x in ref.items()}, forward(layer_to_hf(b, ref, hp), hp, n_blocks))
        report["layers"][str(b)] = res
        report["failures"].update(verdict(res))
        worst = max((v[1] for v in res.values() if isinstance(v[1], float)), default=0.0)
        print(f"layer {b}: {len(res)} tensors, {sum(v[0] for v in res.values())} bitwise equal, worst relative "
              f"{worst:.2e}, failures {len(verdict(res))} ({time.time() - t0:.0f} s)", flush=True)
    report["pass"] = not report["failures"]
    if a.out:
        open(a.out, "w").write(json.dumps(report, indent=1))
    print("ROUND TRIP", "PASS" if report["pass"] else f"FAIL: {list(report['failures'])[:8]}")
    sys.exit(0 if report["pass"] else 1)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    rt = sub.add_parser("roundtrip")
    rt.add_argument("gguf")
    rt.add_argument("--layers", default="")
    rt.add_argument("--out", default="")
    a = ap.parse_args()
    roundtrip(a)


if __name__ == "__main__":
    main()
