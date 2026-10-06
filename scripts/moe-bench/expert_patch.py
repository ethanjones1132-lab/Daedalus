"""Per-layer keep lists for the phase-1 expert patch (adapters spec §3.2, 2026-10-05).

  energy(path)               {layer: per-expert energy} from a llama-imatrix GGUF (ffn_down_exps in_sum2)
  combine(*energies)         per layer, each normalized to sum 1, then summed (slice_experts.py's rule)
  variants(keep96, new, code, fallback)
      swap96   top 96 of the combined ranking
      add108   keep96's 96 plus the 12 highest *dropped* experts by the new (failure-targeted) energy
      swap108  top 108 of the combined ranking
  Layers with no imatrix data (the MTP layer, which imatrix never runs) use `fallback` scores (the full
  model's router row norms, slice_experts.py's own fallback), so their swap96 choice equals keep96's.

usage: expert_patch.py --keep96 keep96.json --new NEW.gguf --code CODE.gguf --full FULL.gguf --out DIR
"""
import argparse
import json
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from slice_experts import importance_from_imatrix  # noqa: E402


def energy(path):
    return importance_from_imatrix(path)


def combine(*energies):
    layers = set.intersection(*(set(e) for e in energies))
    return {L: sum(e[L] / max(e[L].sum(), 1e-30) for e in energies) for L in layers}


def top(scores, n):
    return sorted(int(i) for i in np.argsort(-scores, kind="stable")[:n])


def variants(keep96, new, code, fallback=None, n_extra=12):
    """keep96: {layer: [indices]}; new, code, fallback: {layer: np.array}. -> {name: {layer: sorted indices}}"""
    fallback = fallback or {}
    comb = combine(new, code)
    out = {"swap96": {}, "add108": {}, "swap108": {}}
    for L, kept in keep96.items():
        n = len(kept)
        if L in comb:
            ranked, by_new = comb[L], new[L]
        elif L in fallback:
            ranked = by_new = fallback[L]
        else:
            raise ValueError(f"layer {L}: no energy and no fallback")
        out["swap96"][L] = top(ranked, n)
        out["swap108"][L] = top(ranked, n + n_extra)
        dropped = np.array([i for i in range(len(by_new)) if i not in set(kept)])
        extra = dropped[np.argsort(-by_new[dropped], kind="stable")[:n_extra]]
        out["add108"][L] = sorted(int(i) for i in list(kept) + list(extra))
    return out


def router_norms(full_path, layers):
    """slice_experts.py's fallback score, from the full model's router rows."""
    from gguf import GGUFReader
    r = GGUFReader(full_path, "r")
    t = {x.name: x for x in r.tensors}
    return {L: np.linalg.norm(np.asarray(t[f"blk.{L}.ffn_gate_inp.weight"].data, dtype=np.float64), axis=1)
            for L in layers}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep96", required=True)
    ap.add_argument("--new", required=True)
    ap.add_argument("--code", required=True)
    ap.add_argument("--full", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    keep96 = {int(k): v for k, v in json.load(open(a.keep96))["keep"].items()}
    new, code = energy(a.new), energy(a.code)
    missing = sorted(set(keep96) - set(new) - set(code))
    vs = variants(keep96, new, code, router_norms(a.full, missing) if missing else None)
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for name, lists in vs.items():
        (out / f"{name}.json").write_text(json.dumps({str(L): v for L, v in sorted(lists.items())}))
        changed = sum(len(set(lists[L]) - set(keep96[L])) for L in lists)
        print(f"{name}: {len(next(iter(lists.values())))} per layer, {changed} expert slots differ from keep96 "
              f"(fallback layers {missing})")


if __name__ == "__main__":
    main()
