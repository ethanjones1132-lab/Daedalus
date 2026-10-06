"""Keep the N most important routed experts per layer in a MoE GGUF.

Importance comes from a llama-imatrix GGUF: for each layer, the summed squared
activation entering the expert down-projection (`blk.L.ffn_down_exps.weight.in_sum2`),
i.e. how much signal each expert actually carried on the calibration text.
This approximates REAP's router-weighted activation criterion without router weights.
Several imatrix files can be combined (repeat --imatrix): each one's per-layer energies
are normalized to sum to 1, then added, so experts that matter on any of the
calibration sets survive. Layers without imatrix data (e.g. an MTP/nextn layer the
imatrix run never executed) fall back to router-weight row norms.

Slicing is exact: the stacked expert tensors keep the expert index on the slowest
axis and quantization blocks live inside rows, so a pruned expert is a removed
slab of bytes. The router (`ffn_gate_inp`) and its bias (`exp_probs_b`) are sliced
the same way, as are per-expert biases where the architecture has them (gpt-oss:
`ffn_{gate,up,down}_exps.bias` and the router bias `ffn_gate_inp.bias`);
`<arch>.expert_count` is rewritten. Everything else is copied verbatim.

usage: slice_experts.py IN.gguf OUT.gguf --keep N --imatrix IMATRIX.gguf [--imatrix ...] [--report keep.json]
"""
import argparse
import json
import re
import sys

import numpy as np
from gguf import GGUFReader, GGUFValueType, GGUFWriter

EXPERT_TENSOR = re.compile(r"^blk\.(\d+)\.(ffn_(gate|up|down)_exps\.(weight|bias)|ffn_gate_up_exps\.(weight|bias)|"
                           r"ffn_gate_inp\.(weight|bias)|exp_probs_b\.bias)$")


def field_value(field):
    t = field.types[0]
    if t == GGUFValueType.ARRAY:
        sub = field.types[1]
        if sub == GGUFValueType.STRING:
            return [bytes(field.parts[i]).decode("utf-8", "replace") for i in field.data], t, sub
        return [field.parts[i].tolist()[0] for i in field.data], t, sub
    if t == GGUFValueType.STRING:
        return bytes(field.parts[field.data[0]]).decode("utf-8", "replace"), t, None
    return field.parts[field.data[0]].tolist()[0], t, None


def importance_from_imatrix(path):
    """layer -> np.array of per-expert importance."""
    r = GGUFReader(path, "r")
    out = {}
    for t in r.tensors:
        m = re.match(r"^blk\.(\d+)\.ffn_down_exps\.weight\.in_sum2$", t.name)
        if m:
            arr = np.asarray(t.data, dtype=np.float64)
            out[int(m.group(1))] = arr.reshape(arr.shape[0], -1).sum(axis=1)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inp")
    ap.add_argument("out")
    ap.add_argument("--keep", type=int, default=0, help="experts to keep per layer, ranked by --imatrix")
    ap.add_argument("--keep-list", default="",
                    help="JSON {layer: [expert indices]}: keep exactly these (adapters phase 1, 2026-10-05)")
    ap.add_argument("--imatrix", action="append", default=[],
                    help="imatrix GGUF; repeat to combine several calibration sets")
    ap.add_argument("--report", default="")
    a = ap.parse_args()

    r = GGUFReader(a.inp, "r")
    arch = field_value(r.fields["general.architecture"])[0]
    n_expert = field_value(r.fields[f"{arch}.expert_count"])[0]
    n_used = field_value(r.fields[f"{arch}.expert_used_count"])[0]
    tensors = {t.name: t for t in r.tensors}
    layers = sorted({int(m.group(1)) for n in tensors if (m := EXPERT_TENSOR.match(n))})
    keep = {}
    if a.keep_list:
        given = {int(k): v for k, v in json.load(open(a.keep_list)).items()}
        sizes = {len(set(v)) for v in given.values()}
        if set(given) != set(layers) or len(sizes) != 1 or any(len(set(v)) != len(v) for v in given.values()) \
                or not all(0 <= i < n_expert for v in given.values() for i in v):
            sys.exit("--keep-list needs every expert layer, the same count everywhere, unique in-range indices")
        a.keep = sizes.pop()
        keep = {L: (np.array(sorted(v)), "list", float("nan")) for L, v in given.items()}
    if not n_used <= a.keep < n_expert:
        sys.exit(f"--keep must be in [{n_used}, {n_expert})")
    if not keep and not a.imatrix:
        sys.exit("give --imatrix (with --keep) or --keep-list")
    imps = [importance_from_imatrix(p) for p in a.imatrix]

    for layer in ([] if keep else layers):
        found = [v[layer] / max(v[layer].sum(), 1e-30) for v in imps
                 if layer in v and len(v[layer]) == n_expert]
        if found:
            score, source = np.sum(found, axis=0), "imatrix"
        else:  # no calibration signal for this layer: fall back to router row norms
            router = np.asarray(tensors[f"blk.{layer}.ffn_gate_inp.weight"].data, dtype=np.float64)
            score, source = np.linalg.norm(router, axis=1), "router-norm"
        idx = np.sort(np.argsort(-score)[: a.keep])
        keep[layer] = (idx, source, float(score[idx].sum() / max(score.sum(), 1e-30)))

    w = GGUFWriter(a.out, arch=arch)
    for key, field in r.fields.items():
        if key.startswith("GGUF.") or key == "general.architecture":
            continue
        val, t, sub = field_value(field)
        if key == f"{arch}.expert_count":
            val = a.keep
        if t == GGUFValueType.ARRAY:
            w.add_key_value(key, val, t, sub_type=sub)
        else:
            w.add_key_value(key, val, t)

    def sliced(t):
        m = EXPERT_TENSOR.match(t.name)
        return t.data[keep[int(m.group(1))][0]] if m else t.data

    for t in r.tensors:
        d = sliced(t)
        w.add_tensor_info(t.name, d.shape, d.dtype, d.nbytes, t.tensor_type)
    w.write_header_to_file()
    w.write_kv_data_to_file()
    w.write_ti_data_to_file()
    for t in r.tensors:
        w.write_tensor_data(np.ascontiguousarray(sliced(t)))
    w.close()

    retained = {L: round(f, 4) for L, (_, _, f) in keep.items()}
    print(json.dumps({"arch": arch, "experts": f"{n_expert}->{a.keep}",
                      "mean_importance_retained": round(float(np.mean(list(retained.values()))), 4),
                      "fallback_layers": [L for L, (_, s, _) in keep.items() if s not in ("imatrix", "list")]}))
    if a.report:
        with open(a.report, "w") as f:
            json.dump({"keep": {L: idx.tolist() for L, (idx, _, _) in keep.items()},
                       "importance_retained": retained}, f)


if __name__ == "__main__":
    main()
