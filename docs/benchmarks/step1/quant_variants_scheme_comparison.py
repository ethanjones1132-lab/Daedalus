"""Which int8 scheme keeps Laya's answers? Pool queries only (60 classify + 60 verify answered by the root checkpoint)."""
import copy, os, sys, time, json, statistics, warnings
warnings.filterwarnings("ignore")
os.environ["USE_TF"] = "0"; os.environ.setdefault("TIER2B_DIR", "docs/benchmarks/laya-calib")
sys.path.insert(0, "scripts/moe-bench")
import torch, torch.nn as nn, torch.nn.functional as F
import laya_partner as lp, laya_lean_eval as le

class W8Linear(nn.Module):
    """Weight-only int8, per output channel; activations stay fp32."""
    def __init__(self, lin):
        super().__init__()
        w = lin.weight.data
        scale = (w.abs().amax(dim=1).clamp_min(1e-8) / 127.0)
        self.register_buffer("q", torch.round(w / scale[:, None]).clamp(-127, 127).to(torch.int8))
        self.register_buffer("scale", scale)
        self.bias = None if lin.bias is None else nn.Parameter(lin.bias.data.clone(), requires_grad=False)
        self.in_features, self.out_features = lin.in_features, lin.out_features
    def forward(self, x):
        return F.linear(x, self.q.to(x.dtype) * self.scale[:, None].to(x.dtype), self.bias)

def swap_linears(module, make, skip=lambda name: False, prefix=""):
    for n, c in list(module.named_children()):
        full = f"{prefix}{n}"
        if isinstance(c, nn.Linear) and not skip(full):
            setattr(module, n, make(c))
        else:
            swap_linears(c, make, skip, full + ".")
    return module

def dyn(model, per_channel=False, skip=None):
    enc = model.encoder
    if skip is None:
        return torch.ao.quantization.quantize_dynamic(enc, {nn.Linear}, dtype=torch.qint8, inplace=True) and model
    # skip some linears: temporarily mark them so quantize_dynamic ignores them via qconfig_spec by name
    spec = {n: torch.ao.quantization.default_dynamic_qconfig for n, m in enc.named_modules()
            if isinstance(m, nn.Linear) and not skip(n)}
    torch.ao.quantization.quantize_dynamic(enc, spec, dtype=torch.qint8, inplace=True)
    return model

msgs = le.make_msgs("docs/benchmarks/laya3/laya3-calib-nested.jsonl", 120)
L = lp.Laya()
agent = L.agent("root")
base = agent.model

def run():
    out = []
    for m in msgs:
        with torch.inference_mode():
            if m["op"] == "classify":
                r = L.classify(m["state"], "v1"); 
                if r["ckpt"] != "root": continue
                out.append(("c", r["kind_p"]["unseen"], r["kind_p"]["library"], r["unseen"]))
            else:
                p, ck = L.verify(m["requirement"], m["entry"], m["code"], "rubric")
                if ck != "root": continue
                out.append(("v", p))
    return out

t = time.time(); ref = run(); print("ref", len(ref), round(time.time() - t, 1), "s", flush=True)

def cmp(name, fn):
    agent.model = fn(copy.deepcopy(base))
    t = time.time(); got = run(); dt = time.time() - t
    d = [abs(a - b) for r, g in zip(ref, got) for a, b in zip(r[1:], g[1:])]
    print(f"{name:34s} median|dp| {statistics.median(d):.4f}  p95 {sorted(d)[int(.95*len(d))]:.4f}  max {max(d):.3f}  {dt:.1f}s", flush=True)
    agent.model = base

is_wo = lambda n: n.endswith("mlp.Wo")
cmp("dyn per-tensor (current)", lambda m: dyn(m))
cmp("dyn, mlp.Wo kept fp32", lambda m: dyn(m, skip=is_wo))
cmp("dyn, mlp.Wo + attn.Wo kept fp32", lambda m: dyn(m, skip=lambda n: n.endswith(".Wo")))
cmp("weight-only int8 per-channel", lambda m: (swap_linears(m.encoder, W8Linear), m)[1])
cmp("weight-only int8, mlp.Wo fp32", lambda m: (swap_linears(m.encoder, W8Linear, is_wo), m)[1])
