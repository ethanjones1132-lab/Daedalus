"""Adapters phase 2 on Modal (spec docs/superpowers/specs/2026-10-05-adapters-design.md section 4).

First piece, the teacher test (section 4.1): Qwen3.8-Flash-Next Coder (ISTA GSQ-RCO IQ1_M, all 256 experts)
answers the calibration pool single shot (60 tasks x 3 samples, temperature 0.2 / top-p 0.95, the sample index as
seed), thinking off and then at a 2,048-token budget, in one L40S container so the 58 GB model downloads once.

    python -m modal run --detach scripts/moe-bench/remote/modal_distill.py::teacher_test
    python -m modal volume get distill teacher <local dir>

- Same image, model files and server settings as modal_flashnext.py's tier2b run (b11382, one commit after the
  local 836d571 and WebGPU-only; the n-gram table held resident with --load-mode none --lazy-mode off).
- The pool's loaders find their files by relative path (tasks.py loads validation-b's B tasks, runbench2b.py loads
  tier2b's harness), so the container mirrors the repo layout under /opt/repo.
- Qualifies (spec 4.1) if single shot beats keep96's pool recipe by at least 8 of 180: 147 measured 2026-10-06,
  so at least 155.
- Cost: L40S $0.000542/s + 8 cores + 64 GiB, about $2.84/h. The 2 h timeout caps a run at about $5.70.
"""
import json
import os
import pathlib
import subprocess
import sys
import time

import modal

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent.parent.parent  # the repo (not parents[2]: the container re-imports this file from /root)
REPO = "ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF"
LLAMA_IMAGE = "ghcr.io/ggml-org/llama.cpp@sha256:3e57be4957bb34ab46a7a5e18165177d1356ac5ffb7b9a553f5b74b1788d17a5"
W, MD, BIN, R = "/vol", "/model", "/app", "/opt/repo"
M = f"{MD}/IQ1_M/Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M-00001-of-00002.gguf"
RESIDENT = ["--load-mode", "none", "--lazy-mode", "off"]
RATE = 0.000542 + 8 * 0.0000131 + 64 * 0.00000222  # $/s: L40S + 8 cores + 64 GiB
POOL = f"{R}/docs/benchmarks/laya-calib"

image = (
    modal.Image.from_registry(LLAMA_IMAGE, add_python="3.12")
    .entrypoint([])
    .pip_install("huggingface_hub[hf_xet]", "numpy")
    .env({"HF_XET_HIGH_PERFORMANCE": "1", "HF_HUB_DISABLE_PROGRESS_BARS": "1", "LD_LIBRARY_PATH": "/app"})
    .add_local_file(HERE.parent / "tier2b_llama.py", "/opt/tier2b_llama.py")
    .add_local_file(ROOT / "scripts" / "benchmark-tier2b" / "runbench2b.py", f"{R}/scripts/benchmark-tier2b/runbench2b.py")
    .add_local_file(ROOT / "docs" / "benchmarks" / "2026-10-05" / "validation-b" / "tasks.py",
                    f"{R}/docs/benchmarks/2026-10-05/validation-b/tasks.py")
    .add_local_dir(ROOT / "docs" / "benchmarks" / "laya-calib", POOL)
)
# the student side (plan Task 2): torch + transformers 5.18 (qwen3_5_moe, fused experts) next to the same llama.cpp
torch_image = (
    modal.Image.from_registry(LLAMA_IMAGE, add_python="3.12")
    .entrypoint([])
    .pip_install("torch", "transformers==5.18.0", "peft", "accelerate", "safetensors", "numpy",
                 "huggingface_hub[hf_xet]", "flash-linear-attention")
    .env({"LD_LIBRARY_PATH": "/app", "PYTHONPATH": "/app/gguf-py:/opt/distill", "HF_HUB_DISABLE_PROGRESS_BARS": "1"})
    .add_local_file(HERE.parent / "distill" / "reverse_map.py", "/opt/distill/reverse_map.py")
    .add_local_file(ROOT / "docs" / "benchmarks" / "adapters" / "heldout.txt", "/opt/heldout.txt")
)
A100_RATE = 0.000694 + 8 * 0.0000131 + 64 * 0.00000222  # $/s
KEEP96 = f"{W}/keep96/keep96.gguf"  # the served file, uploaded with `modal volume put`
vol = modal.Volume.from_name("distill", create_if_missing=True)
app = modal.App("adapters-distill", image=image)


def summarize(path):
    rows = [json.loads(l) for l in open(path) if l.strip()] if os.path.exists(path) else []
    by = {}
    for r in rows:
        if "task" in r:
            c = by.setdefault(r["category"], [0, 0])
            c[0] += r["ok"]
            c[1] += 1
    return {"passed": sum(v[0] for v in by.values()), "samples": sum(v[1] for v in by.values()),
            "by_category": {k: f"{v[0]}/{v[1]}" for k, v in sorted(by.items())}}


@app.function(gpu="L40S", volumes={W: vol}, timeout=2 * 3600, cpu=8, memory=64 * 1024)
def teacher(budgets: list):
    from huggingface_hub import snapshot_download

    t0 = time.time()
    snapshot_download(REPO, allow_patterns=["IQ1_M/*"], local_dir=MD, max_workers=16)
    print(f"model downloaded in {time.time() - t0:.0f} s", flush=True)
    res = f"{W}/teacher"
    os.makedirs(res, exist_ok=True)
    out = {}
    for b in budgets:
        path = f"{res}/flashnext-pool-budget{b}.jsonl"
        t1 = time.time()
        r = subprocess.run([sys.executable, "/opt/tier2b_llama.py", "--model", M, "--server", f"{BIN}/llama-server",
                            "--ncmoe", "0", "--mtp", "0", "--budget", str(b), "--extra-args", json.dumps(RESIDENT),
                            "--out", path], env={**os.environ, "TIER2B_DIR": POOL})
        vol.commit()
        out[str(b)] = {"exit": r.returncode, "minutes": round((time.time() - t1) / 60, 1), **summarize(path)}
        print(json.dumps({str(b): out[str(b)]}), flush=True)
    secs = time.time() - t0
    return {"results": out, "job_minutes": round(secs / 60, 1), "cost_usd_est": round(secs * RATE, 2)}


def llama_top1(gguf_path, text, n_ctx=2048, chunks=2):
    """llama.cpp's own view of `text`: llama-perplexity --kl-divergence-base keeps the evaluated tokens and, for the
    second half of each chunk, every position's log-probs (uint16, monotonic in the logit). -> tokens
    [chunk, n_ctx], top-1 and the target's log-prob at positions n_ctx/2 .. n_ctx-2."""
    import numpy as np
    base = "/tmp/base.bin"
    subprocess.run([f"{BIN}/llama-perplexity", "-m", gguf_path, "-f", text, "-c", str(n_ctx), "--chunks", str(chunks),
                    "-ngl", "99", "-b", str(n_ctx), "-ub", "512", "--kl-divergence-base", base], check=True)
    with open(base, "rb") as f:
        assert f.read(8) == b"_logits_"
        n_ctx_, n_vocab, n_chunk = (int(x) for x in np.frombuffer(f.read(12), dtype=np.int32))
        tokens = np.frombuffer(f.read(4 * n_chunk * n_ctx_), dtype=np.int32).reshape(n_chunk, n_ctx_)
        nv, first = 2 * ((n_vocab + 1) // 2) + 4, n_ctx_ // 2
        n_tok = n_ctx_ - 1 - first
        top, logp = [], []
        for c in range(n_chunk):
            rows = np.frombuffer(f.read(2 * nv * n_tok), dtype=np.uint16).reshape(n_tok, nv)
            head = rows[:, :4].copy().view(np.float32)  # [scale, min_log_prob] per position
            q = rows[:, 4:4 + n_vocab]
            top.append(q.argmax(1))
            tgt = tokens[c, first + 1:first + 1 + n_tok]
            logp.append(head[:, 1] + q[np.arange(n_tok), tgt].astype(np.float32) * head[:, 0])
    return tokens, first, np.stack(top), np.stack(logp)


def student_config(n_experts):
    """The official Qwen3.6 text config with the served expert count."""
    from huggingface_hub import hf_hub_download
    from transformers import Qwen3_5MoeTextConfig
    tc = dict(json.load(open(hf_hub_download("Qwen/Qwen3.6-35B-A3B", "config.json")))["text_config"])
    tc.pop("model_type", None)
    tc["num_experts"] = n_experts
    return Qwen3_5MoeTextConfig(**tc)


@app.function(image=torch_image, cpu=2, memory=8 * 1024, timeout=1800)
def names(n_experts: int = 96):
    """transformers' own parameter names and shapes for the student (meta device, no weights): checked locally
    against reverse_map before any GPU spend."""
    import torch
    import transformers
    from transformers import Qwen3_5MoeForCausalLM
    with torch.device("meta"):
        m = Qwen3_5MoeForCausalLM(student_config(n_experts))
    try:
        import fla  # noqa: F401
        fla_ok = True
    except Exception as e:  # noqa: BLE001
        fla_ok = repr(e)
    return {"transformers": transformers.__version__, "torch": torch.__version__, "fla": fla_ok,
            "params": {n: list(p.shape) for n, p in m.named_parameters()}}


def load_student(gguf_path):
    """The served GGUF, dequantized tensor by tensor (gguf-py) and reverse-mapped straight into transformers'
    Qwen3_5MoeForCausalLM in bf16 on the GPU. -> (model, hparams, report of unmapped and unloaded names)."""
    import numpy as np
    import torch
    from gguf import GGUFReader
    from gguf.quants import dequantize
    from transformers import Qwen3_5MoeForCausalLM
    import reverse_map as rm

    r = GGUFReader(gguf_path)
    f = r.fields
    val = lambda k: int(f[k].parts[f[k].data[0]][0])  # noqa: E731
    n_exp = val("qwen35moe.expert_count")
    hp = {"linear_num_key_heads": val("qwen35moe.ssm.group_count"),
          "linear_num_value_heads": val("qwen35moe.ssm.time_step_rank"),
          "linear_key_head_dim": val("qwen35moe.ssm.state_size"),
          "linear_value_head_dim": val("qwen35moe.ssm.inner_size") // val("qwen35moe.ssm.time_step_rank"),
          "hidden_size": val("qwen35moe.embedding_length"),
          "num_hidden_layers": val("qwen35moe.block_count") - val("qwen35moe.nextn_predict_layers")}
    cfg = student_config(n_exp)
    torch.set_default_dtype(torch.bfloat16)
    with torch.device("cuda"):
        model = Qwen3_5MoeForCausalLM(cfg)
    model.eval()
    params = dict(model.named_parameters())
    loaded, unmapped = set(), []

    def put(name, x):
        if name not in params:
            unmapped.append(name)
            return
        p = params[name]
        y = torch.from_numpy(np.ascontiguousarray(x))
        if tuple(y.shape) != tuple(p.shape):
            unmapped.append(f"{name}: shape {tuple(y.shape)} vs {tuple(p.shape)}")
            return
        with torch.no_grad():
            p.copy_(y.to(p.device, p.dtype))
        loaded.add(name)

    by_layer = {}
    for t in r.tensors:
        if t.name.startswith("blk."):
            _, b, s = t.name.split(".", 2)
            by_layer.setdefault(int(b), {})[s] = t
        else:
            put(*rm.global_to_hf(t.name, dequantize(t.data, t.tensor_type)))
    for b in range(hp["num_hidden_layers"]):
        for n, x in rm.layer_to_hf(b, {s: dequantize(t.data, t.tensor_type) for s, t in by_layer[b].items()}, hp).items():
            put(n, x)
    return model, hp, {"experts": n_exp, "unmapped": unmapped, "not_loaded": sorted(set(params) - loaded),
                       "params": len(params), "loaded": len(loaded)}


@app.function(gpu="A100-80GB", volumes={W: vol}, timeout=3600, cpu=8, memory=64 * 1024, image=torch_image)
def parity():
    """Gate 2.4 (and the name half of 2.2): transformers on the dequantized served weights must pick llama.cpp's top
    token on at least 99% of about 2,000 held-out positions."""
    import numpy as np
    import torch
    t0 = time.time()
    tokens, first, top_l, logp_l = llama_top1(KEEP96, "/opt/heldout.txt")
    t1 = time.time()
    model, hp, rep = load_student(KEEP96)
    t2 = time.time()
    agree, nll_hf = [], []
    with torch.no_grad():
        for c in range(tokens.shape[0]):
            ids = torch.tensor(tokens[c][None].astype(np.int64), device="cuda")
            lg = model(input_ids=ids).logits[0].float()
            pos = slice(first, tokens.shape[1] - 1)
            agree.append((lg[pos].argmax(-1).cpu().numpy() == top_l[c]))
            lsm = torch.log_softmax(lg[pos], -1)
            nll_hf.append(-lsm[torch.arange(lsm.shape[0]), ids[0, first + 1:]].cpu().numpy())
    a = np.concatenate(agree)
    secs = time.time() - t0
    res = {"positions": int(a.size), "top1_agreement": round(float(a.mean()), 4), "pass": bool(a.mean() >= 0.99),
           "ppl_llama": round(float(np.exp(-np.concatenate(logp_l).mean())), 3),
           "ppl_transformers": round(float(np.exp(np.concatenate(nll_hf).mean())), 3),
           "names": {k: (v if not isinstance(v, list) else v[:12]) for k, v in rep.items()},
           "seconds": {"llama": round(t1 - t0), "load": round(t2 - t1), "total": round(secs)},
           "cost_usd_est": round(secs * A100_RATE, 2)}
    os.makedirs(f"{W}/gates", exist_ok=True)
    json.dump(res, open(f"{W}/gates/parity.json", "w"), indent=1)
    vol.commit()
    return res


@app.local_entrypoint()
def check_names(out: str = ""):
    """python -m modal run modal_distill.py::check_names --out names.json  (then compared locally)"""
    res = names.remote()
    print(json.dumps({k: v for k, v in res.items() if k != "params"}), len(res["params"]), "parameters")
    if out:
        open(out, "w").write(json.dumps(res, indent=1))


@app.local_entrypoint()
def gate_parity():
    print(json.dumps(parity.remote(), indent=1))


@app.local_entrypoint()
def teacher_test(budgets: str = "0,2048"):
    print(json.dumps(teacher.remote([int(b) for b in budgets.split(",")]), indent=1))
