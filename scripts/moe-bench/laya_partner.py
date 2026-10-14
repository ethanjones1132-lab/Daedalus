"""Laya beside Qwen3.6 keep96: classify a task, verify one candidate file (Laya partner spec §3, §6, 2026-10-05).

Laya (convaiinnovations/laya, 421M ModernBERT) is used as shipped, on the CPU. Two wordings of the task questions
and two forms of the verify question are defined here; laya_calibrate.py picks one of each on the calibration pool,
never on tier2b or the judge set. Inputs longer than the English checkpoint's 512 tokens go to typed-decisions
(1,024 tokens); longer than that get no answer.

  worker  JSON lines for playbook_tier2b.py, model loaded once. Requests:
            {"op": "ping"} | {"op": "classify", "state": text} | {"op": "verify", "requirement", "entry", "code"}
          The first line out is {"ok": true, "ready": true}; every request gets one line back with "secs".
  label   every wording and form in batch: a card per task in TIER2B_DIR and P(correct) per stored candidate
          (rows of type "trial" from playbook_tier2b.py nested, or "cand" from bestofn_tier2b.py). Resumable.

LAYA_INT8=1 (lean Laya, 2026-10-09): each checkpoint is streamed into weight-only int8 (per output channel) on the
encoder's nn.Linear layers, one tensor at a time, so the fp32 encoder is never held; activations and the matmul stay
fp32. (Dynamic int8, which also quantizes activations, moved the answers too far: hidden-code AUC 1.00 -> 0.72.)
The worker also answers {"op": "mem"}. Nothing else changes.

usage: laya_partner.py worker [--calib CALIB.json]
       laya_partner.py label --runs RUNS.jsonl --out LABELS.jsonl      (TIER2B_DIR = the runs' task set)
"""
import argparse
import ctypes
import gc
import json
import os
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from laya_calibrate import IDENTITY, calibrate_card, platt_apply  # noqa: E402
from laya_v3_text import EVIDENCE_OPTIONS, valid_state  # noqa: E402

REPO_ID = "convaiinnovations/laya"
INT8 = os.environ.get("LAYA_INT8") == "1"
CLASSIFY = {
    "v1": {
        "kind": {"type": "choice", "instructions": "What kind of fix is this?",
                 "criteria": {"algorithm": "get an algorithm right", "input": "handle bad or missing input",
                              "files": "read or write files or run processes",
                              "library": "use a library helper correctly",
                              "unseen": "depends on code whose source is not shown"}},
        "unseen": {"type": "noul", "instructions": "The fix depends on how code that is not shown behaves."},
        "effort": {"type": "score", "instructions": "How much reasoning does this fix need?",
                   "criteria": ["little", "some", "a lot"]},
    },
    "v2": {
        "kind": {"type": "choice", "instructions": "Which kind of bug is this?",
                 "criteria": {"algorithm": "wrong logic", "input": "breaks on bad input",
                              "files": "file or process handling", "library": "misuses a library",
                              "unseen": "misreads a module it cannot see"}},
        "unseen": {"type": "noul",
                   "instructions": "Fixing this needs facts about a module whose source is unavailable."},
        "effort": {"type": "score", "instructions": "How hard is this fix?", "criteria": ["easy", "medium", "hard"]},
    },
}
VERIFY = {
    "noul": {"ok": {"type": "noul", "instructions": "The corrected file does what the requirement asks."}},
    "rubric": {"ok": {"type": "choice", "instructions": "Does the corrected file meet the requirement?",
                      "criteria": {"meets": "yes, it does what the requirement asks",
                                   "misses": "no, it still misses the requirement"}}},
}

# Laya v3 (spec 2026-10-07-laya-v3-design.md §3): A reads the probe output, B gates the repair
EVIDENCE = {"shows": {"type": "choice", "instructions": "What does the probe output show about the helper?",
                      "criteria": dict(EVIDENCE_OPTIONS)}}
VALID = {"ok": {"type": "noul", "instructions": "The check tests exactly what the requirement states."}}


def verify_state(requirement, entry, code):
    return f"Requirement: {requirement}\n\nCorrected {entry}:\n```python\n{code}\n```"


def mem_stats():
    """This process's working set and private (commit) bytes in MiB, with their peaks. Windows only."""
    class Counters(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_ulong), ("faults", ctypes.c_ulong), ("peak_ws", ctypes.c_size_t),
                    ("ws", ctypes.c_size_t), ("q1", ctypes.c_size_t), ("q2", ctypes.c_size_t),
                    ("q3", ctypes.c_size_t), ("q4", ctypes.c_size_t), ("pagefile", ctypes.c_size_t),
                    ("peak_pagefile", ctypes.c_size_t), ("private", ctypes.c_size_t)]
    c = Counters()
    c.cb = ctypes.sizeof(c)
    k32 = ctypes.windll.kernel32
    k32.GetCurrentProcess.restype = ctypes.c_void_p
    ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
    ctypes.windll.psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(c), c.cb)
    mib = 2 ** 20
    return {"ws_mib": c.ws // mib, "peak_ws_mib": c.peak_ws // mib, "private_mib": c.private // mib,
            "peak_private_mib": c.peak_pagefile // mib}


def trim_memory():
    """Give freed pages back: collect garbage, shrink the heap and empty the working set."""
    gc.collect()
    try:
        ctypes.cdll.msvcrt._heapmin()
        k32 = ctypes.windll.kernel32
        k32.GetCurrentProcess.restype = ctypes.c_void_p
        k32.SetProcessWorkingSetSize.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_size_t]
        k32.SetProcessWorkingSetSize(k32.GetCurrentProcess(), ctypes.c_size_t(-1).value, ctypes.c_size_t(-1).value)
    except (AttributeError, OSError, ctypes.ArgumentError):
        pass


class LazyWeights:
    """A safetensors file read one tensor at a time: keys, shapes and tensors on demand, nothing held."""

    def __init__(self, path):
        from safetensors import safe_open
        self.f = safe_open(path, framework="pt", device="cpu")
        self._keys = list(self.f.keys())
        self._set = set(self._keys)

    def keys(self):
        return self._keys

    def __iter__(self):
        return iter(self._keys)

    def __len__(self):
        return len(self._keys)

    def __contains__(self, k):
        return k in self._set

    def __getitem__(self, k):
        return self.f.get_tensor(k)

    def get(self, k, default=None):
        return self.f.get_tensor(k) if k in self._set else default

    def shape(self, k):
        return tuple(self.f.get_slice(k).get_shape())


def _lean_verify(model, cfg, weights, model_id):
    """laya.agent._verify_compatibility for LazyWeights: the same checks, from shapes only."""
    for key in ("encoder", "head_layers"):
        if key not in cfg:
            raise ValueError(f"Incompatible model config for {model_id!r}: missing {key!r}")
    for prefix in ("encoder.", "type_emb.", "scorer.", "act_head."):
        if not any(k.startswith(prefix) for k in weights.keys()):
            raise ValueError(f"Incompatible model weights for {model_id!r}: no {prefix!r} parameters")
    bad = [n for n, p in model.named_parameters() if n not in weights or weights.shape(n) != tuple(p.shape)]
    if bad:
        raise ValueError(f"Model weights do not match the architecture for {model_id!r}: {bad[:3]}")


def _w8_class():
    """nn.Linear with the weight kept as per-output-channel int8 (built lazily: torch is only in Laya's venv)."""
    import torch
    nn, F = torch.nn, torch.nn.functional

    class W8Linear(nn.Module):
        buf = None  # one fp32 scratch for the dequantized weight, shared by every layer (the worker is single-threaded)

        def __init__(self, weight, bias=None):
            super().__init__()
            scale = weight.abs().amax(dim=1).clamp_min(1e-8) / 127.0
            self.register_buffer("q", torch.round(weight / scale[:, None]).clamp_(-127, 127).to(torch.int8))
            self.register_buffer("scale", scale.float())
            self.bias = None if bias is None else nn.Parameter(bias.clone(), requires_grad=False)
            self.in_features, self.out_features = weight.shape[1], weight.shape[0]

        def forward(self, x):
            n = self.q.numel()
            if W8Linear.buf is None or W8Linear.buf.numel() < n:
                W8Linear.buf = torch.empty(n)
            w = W8Linear.buf[:n].view_as(self.q)
            w.copy_(self.q)
            y = F.linear(x, w).mul_(self.scale)  # scale after the matmul: the same result, one less pass over w
            return y if self.bias is None else y.add_(self.bias)

    return W8Linear


def _stream_load(model, weights):
    """DecisionModel.load_state_dict(strict=True) that never holds the fp32 encoder: the skeleton is on the meta device,
    every encoder nn.Linear is read and replaced by a W8Linear one at a time, and every other tensor (embeddings,
    norms, the fp32 two-layer decision head, ~25M of the 421M parameters) is assigned from the checkpoint."""
    import torch
    nn = torch.nn
    W8Linear = _w8_class()
    linears = {f"encoder.{n}": m for n, m in model.encoder.named_modules() if isinstance(m, nn.Linear)}
    handled = {f"{n}.{t}" for n in linears for t in ("weight", "bias")}
    state = model.state_dict()
    unexpected = set(weights.keys()) - set(state)
    missing = set(state) - set(weights.keys())
    if unexpected or missing:
        raise RuntimeError(f"strict load failed: unexpected {sorted(unexpected)[:3]}, missing {sorted(missing)[:3]}")
    for k in state:
        if k in handled:
            continue
        owner, _, leaf = k.rpartition(".")
        mod = model.get_submodule(owner) if owner else model
        t = weights[k]
        t = t.float() if t.is_floating_point() else t  # the checkpoint stores some tensors as fp16; copy_ used to cast
        if leaf in mod._parameters:
            mod._parameters[leaf] = nn.Parameter(t, requires_grad=False)
        else:
            mod._buffers[leaf] = t
    for full, mod in linears.items():
        name = full[len("encoder."):]
        bias = weights[f"{full}.bias"].float() if mod.bias is not None else None
        parent, _, leaf = name.rpartition(".")
        setattr(model.encoder.get_submodule(parent) if parent else model.encoder, leaf,
                W8Linear(weights[f"{full}.weight"].float(), bias))
    del state
    trim_memory()
    return torch.nn.modules.module._IncompatibleKeys([], [])


def _rebuild_meta_buffers(model):
    """Modules of the encoder that hold non-persistent buffers (ModernBERT's RoPE tables) were built on the meta
    device and are in no checkpoint: build them again on the CPU from their own config."""
    for name, mod in list(model.encoder.named_modules()):
        if name and any(b is not None and b.is_meta for b in mod._buffers.values()):
            real = type(mod)(mod.config)
            parent, _, leaf = name.rpartition(".")
            setattr(model.encoder.get_submodule(parent) if parent else model.encoder, leaf, real)


def install_lean_loader():
    """LAYA_INT8=1: make laya.load build each checkpoint straight into int8 (see _stream_load)."""
    import laya.agent as la
    import safetensors.torch as st
    build = la.build_model

    def lean_build(*args, **kw):
        import torch
        with torch.device("meta"):  # no fp32 skeleton: it would be ~1.7 GB of commit, and commit is what ran out
            model = build(*args, **kw)
        _rebuild_meta_buffers(model)
        model.load_state_dict = lambda weights, strict=True: _stream_load(model, weights)
        return model
    la.build_model, la._verify_compatibility, st.load_file = lean_build, _lean_verify, LazyWeights


class Laya:
    def __init__(self):
        os.environ.setdefault("USE_TF", "0")
        import laya
        if INT8:
            install_lean_loader()
        self.laya, self.agents = laya, {}
        self.agent("root")

    def agent(self, name):
        if name not in self.agents:
            kw = {} if name == "root" else {"subfolder": name}
            self.agents[name] = self.laya.load(REPO_ID, device="cpu", **kw)
        return self.agents[name]

    def ask(self, state, questions):
        """(answers, checkpoint), or (None, None) when the input is too long for both checkpoints."""
        for name in ("root", "typed-decisions"):
            r = self.agent(name).predict(state, questions)
            if not r["usage"]["truncated"]:
                return r["answers"], name
        return None, None

    def classify(self, state, wording):
        ans, ckpt = self.ask(state, CLASSIFY[wording])
        if ans is None:
            raise ValueError("task text is too long for Laya")
        ep = ans["effort"]["probabilities"]
        return {"kind": ans["kind"]["choice"], "kind_p": ans["kind"]["probabilities"],
                "unseen": ans["unseen"]["noul"], "effort_p": [ep["0"], ep["1"], ep["2"]], "ckpt": ckpt}

    def verify(self, requirement, entry, code, form):
        """(P(correct), checkpoint), or (None, None) when the input is too long."""
        ans, ckpt = self.ask(verify_state(requirement, entry, code), VERIFY[form])
        if ans is None:
            return None, None
        a = ans["ok"]
        return (a["noul"] if form == "noul" else a["probabilities"]["meets"]), ckpt

    def evidence(self, state):
        ans, ckpt = self.ask(state, EVIDENCE)
        if ans is None:
            return None
        return {"choice": ans["shows"]["choice"], "probabilities": ans["shows"]["probabilities"], "ckpt": ckpt}

    def valid(self, state):
        ans, ckpt = self.ask(state, VALID)
        return (None, None) if ans is None else (ans["ok"]["noul"], ckpt)


def worker(a):
    out = sys.stdout
    sys.stdout = sys.stderr  # anything the libraries print goes to stderr; only our replies use stdout

    def say(obj):
        out.write(json.dumps(obj) + "\n")
        out.flush()

    import torch
    calib = json.loads(pathlib.Path(a.calib).read_text(encoding="utf-8")) if a.calib else IDENTITY
    lp = Laya()
    lp.classify("Fix solution.py.\n\nRequirement: warm-up.", calib["classify_wording"])  # first call is slow
    say({"ok": True, "ready": True, "wording": calib["classify_wording"], "form": calib["verify_form"],
         "int8": INT8, **mem_stats()})
    for line in sys.stdin:
        t = time.time()
        try:
            m = json.loads(line)
            with torch.inference_mode():
                rep = answer(lp, calib, m)
            rep["ok"] = True
        except Exception as e:  # any failure is a fallback for the caller, never a crash of the worker
            rep = {"ok": False, "error": repr(e)[:300]}
        rep["secs"] = round(time.time() - t, 3)
        say(rep)


def answer(lp, calib, m):
    """One worker request -> the reply (without ok and secs)."""
    op = m["op"]
    if op == "ping":
        return {}
    if op == "mem":
        return mem_stats()
    if op == "classify":
        raw = lp.classify(m["state"], calib["classify_wording"])
        return {"raw": raw, "card": calibrate_card(raw, calib["platt"], calib.get("hidden_signal", "noul"))}
    if op == "verify":
        p, ckpt = lp.verify(m["requirement"], m["entry"], m["code"], calib["verify_form"])
        return {"p_raw": p, "p": platt_apply(p, calib["platt"]["verify"]), "ckpt": ckpt}
    if op == "evidence":
        rep = lp.evidence(m["state"])
        if rep is None:
            raise ValueError("evidence state too long for Laya")
        return rep
    if op == "valid":
        p, ckpt = lp.valid(m["state"])
        return {"p_raw": p, "p": platt_apply(p, calib["platt"].get("valid", [1.0, 0.0])), "ckpt": ckpt}
    raise ValueError(f"unknown op {op!r}")


def run_candidates(path, extract_code):
    """(task, trial, run, cand, code) for every stored candidate; the last copy of a candidate wins."""
    found = {}
    for r in map(json.loads, open(path, encoding="utf-8")):
        if r.get("type") == "trial":
            for c in r["cands"]:
                found[(r["task"], r["trial"], c["run"], c["cand"])] = c["code"]
        elif r.get("type") == "cand":
            found[(r["task"], r["trial"], "bon", r["cand"])] = extract_code(r["content"])
    return [k + (code,) for k, code in sorted(found.items())]


def label(a):
    sys.path.insert(0, os.environ["TIER2B_DIR"])
    from runbench2b import baseline_prompt, extract_code
    from tasks import TASKS
    tasks = {t["name"]: t for t in TASKS}
    out = pathlib.Path(a.out)
    done = set()
    if out.exists():
        for r in map(json.loads, out.read_text(encoding="utf-8").splitlines()):
            done.add(("card", r["task"], r["wording"]) if r["type"] == "card"
                     else ("valid", r["task"], r["trial"], r["assert"]) if r["type"] == "valid"
                     else ("verify", r["task"], r["trial"], r["run"], r["cand"], r["form"]))
    lp = Laya()
    t0, n = time.time(), 0
    with out.open("a", encoding="utf-8") as f:
        for name, task in tasks.items():
            for w in CLASSIFY:
                if ("card", name, w) not in done:
                    t = time.time()
                    card = lp.classify(baseline_prompt(task), w)
                    f.write(json.dumps({"type": "card", "task": name, "wording": w, "card": card,
                                        "secs": round(time.time() - t, 3)}) + "\n")
        f.flush()
        for name, trial, run, c, code in run_candidates(a.runs, extract_code):
            task = tasks[name]
            for form in (a.forms.split(",") if getattr(a, "forms", "") else VERIFY):
                if ("verify", name, trial, run, c, form) in done:
                    continue
                t = time.time()
                p, ckpt = lp.verify(task["spec"], task["entry"], code, form)
                f.write(json.dumps({"type": "verify", "task": name, "trial": trial, "run": run, "cand": c,
                                    "form": form, "p": p, "ckpt": ckpt, "secs": round(time.time() - t, 3)}) + "\n")
                n += 1
                if n % 100 == 0:
                    f.flush()
                    print(f"{n} verify answers, {time.time() - t0:.0f} s", flush=True)
        if getattr(a, "v3", False):  # Laya v3: P(valid) for every example assert (the repair gate's labels)
            for r in map(json.loads, open(a.runs, encoding="utf-8")):
                p3 = r.get("p3") if r.get("type") == "trial" else None
                if not p3:
                    continue
                task = tasks[r["task"]]
                for i, src in enumerate(p3["examples"]["asserts"]):
                    if ("valid", r["task"], r["trial"], i) in done:
                        continue
                    t = time.time()
                    p, ckpt = lp.valid(valid_state(task["spec"], p3["examples"]["imports"], src))
                    f.write(json.dumps({"type": "valid", "task": r["task"], "trial": r["trial"], "assert": i, "p": p,
                                        "ckpt": ckpt, "secs": round(time.time() - t, 3)}) + "\n")
    print(f"labelled in {time.time() - t0:.0f} s -> {out}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    w = sub.add_parser("worker")
    w.add_argument("--calib")
    lab = sub.add_parser("label")
    lab.add_argument("--runs", required=True)
    lab.add_argument("--out", required=True)
    lab.add_argument("--v3", action="store_true")
    lab.add_argument("--forms", default="", help="verify forms to label, comma-separated (default: all)")
    a = ap.parse_args()
    worker(a) if a.cmd == "worker" else label(a)


if __name__ == "__main__":
    main()
