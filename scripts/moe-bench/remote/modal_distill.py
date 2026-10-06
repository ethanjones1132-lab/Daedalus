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
LLAMA_SRC = pathlib.Path(r"C:\build\wt-master")  # llama.cpp 836d571, the local build's source

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
    # the LoRA converter from the same 836d571 tree as the local llama.cpp that will load the LoRA
    .add_local_file(LLAMA_SRC / "convert_lora_to_gguf.py", "/opt/llama/convert_lora_to_gguf.py")
    .add_local_dir(LLAMA_SRC / "conversion", "/opt/llama/conversion")
    .add_local_dir(LLAMA_SRC / "gguf-py", "/opt/llama/gguf-py")
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


def flashnext_server(parallel, ctx_per_slot, log_path):
    """Flash-Next Coder on the L40S as in the teacher test (all on the GPU, the n-gram table resident), with
    `parallel` slots. -> (process, base URL) once /health answers."""
    import urllib.request
    from huggingface_hub import snapshot_download
    snapshot_download(REPO, allow_patterns=["IQ1_M/*"], local_dir=MD, max_workers=16)
    log = open(log_path, "w")
    srv = subprocess.Popen([f"{BIN}/llama-server", "-m", M, "--host", "127.0.0.1", "--port", "8080", "-ngl", "99",
                            "-c", str(ctx_per_slot * parallel), "-np", str(parallel), "--jinja", "--no-webui",
                            "--flash-attn", "on", *RESIDENT], stdout=log, stderr=subprocess.STDOUT)
    for _ in range(1800):
        try:
            if json.load(urllib.request.urlopen("http://127.0.0.1:8080/health", timeout=5)).get("status") == "ok":
                return srv, "http://127.0.0.1:8080"
        except Exception:  # noqa: BLE001
            pass
        if srv.poll() is not None:
            raise RuntimeError("llama-server exited: " + "".join(open(log_path).readlines()[-20:]))
        time.sleep(2)
    raise RuntimeError("llama-server never became healthy")


def chat(url, messages, **kw):
    import urllib.request
    body = {"messages": messages, "chat_template_kwargs": {"enable_thinking": False}, **kw}
    req = urllib.request.Request(f"{url}/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=900))


@app.function(gpu="L40S", volumes={W: vol}, timeout=3 * 3600, cpu=8, memory=64 * 1024)
def gen_tasks(prompts: list, parallel: int = 8):
    """Task 3: Flash-Next (thinking off) writes candidate training tasks, one JSON object per prompt from
    train_tasks/families.py, JSON-constrained. Resumable: /vol/train_tasks/raw.jsonl keeps every answer."""
    import concurrent.futures
    import zlib
    t0 = time.time()
    out = f"{W}/train_tasks/raw.jsonl"
    os.makedirs(os.path.dirname(out), exist_ok=True)
    done = {json.loads(l)["id"] for l in open(out) if l.strip()} if os.path.exists(out) else set()
    todo = [p for p in prompts if p[0] not in done]
    srv, url = flashnext_server(parallel, 6144, "/tmp/server.log")
    print(f"server up at {time.time() - t0:.0f} s; {len(todo)} prompts to go", flush=True)

    def ask(p):
        pid, fam, topic, text = p
        try:
            r = chat(url, [{"role": "user", "content": text}], temperature=0.8, top_p=0.95, max_tokens=2500,
                     seed=zlib.crc32(pid.encode()), response_format={"type": "json_object"})
            return {"id": pid, "family": fam, "topic": topic, "content": r["choices"][0]["message"]["content"],
                    "tokens": r["usage"]["completion_tokens"]}
        except Exception as e:  # noqa: BLE001  (not written: a rerun retries it)
            return {"id": pid, "error": repr(e)}

    n_ok = n_err = toks = 0
    with open(out, "a") as f, concurrent.futures.ThreadPoolExecutor(parallel) as ex:
        for i, res in enumerate(ex.map(ask, todo)):
            if "error" in res:
                n_err += 1
                continue
            f.write(json.dumps(res) + "\n")
            f.flush()
            n_ok += 1
            toks += res["tokens"]
            if n_ok % 50 == 0:
                vol.commit()
                print(f"{n_ok} written, {toks} tokens, {time.time() - t0:.0f} s", flush=True)
    vol.commit()
    srv.terminate()
    secs = time.time() - t0
    return {"written": n_ok, "errors": n_err, "tokens": toks, "minutes": round(secs / 60, 1),
            "cost_usd_est": round(secs * RATE, 2)}


def _post(url, path, body):
    import urllib.request
    req = urllib.request.Request(f"{url}{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=900))


def _probs(r):
    """llama-server completion_probabilities -> (sampled ids, [[ [id, logprob] x top ] per position])."""
    cp = r.get("completion_probabilities") or []
    return [e["id"] for e in cp], [[[t["id"], round(t["logprob"], 4)] for t in e["top_logprobs"]] for e in cp]


@app.function(gpu="L40S", volumes={W: vol}, timeout=3 * 3600, cpu=8, memory=64 * 1024)
def teacher_data(tasks: list, prefixes: list, parallel: int = 4, top: int = 20):
    """Task 4: the teacher (Flash-Next Coder, thinking off, the teacher test's sampling: temperature 0.2, top-p 0.95)
    answers each training task single shot through the pool's own prompt, with its top-20 log-probs per answer token.
    Only answers that pass the task's test are training targets. Then the regularizer: continuations of code
    prefixes (KL only). Resumable: /vol/teacher_data/{answers,regularizer}.jsonl."""
    import concurrent.futures
    import shutil
    import tempfile
    sys.path[:0] = [POOL, f"{R}/scripts/benchmark-tier2b"]
    from runbench2b import baseline_prompt, extract_code, run_test, seed
    t0 = time.time()
    d_out = f"{W}/teacher_data"
    os.makedirs(d_out, exist_ok=True)
    srv, url = flashnext_server(parallel, 8192, "/tmp/server.log")
    print(f"server up at {time.time() - t0:.0f} s", flush=True)

    def answer(task):
        try:
            prompt = _post(url, "/apply-template", {"messages": [{"role": "user", "content": baseline_prompt(task)}],
                                                     "chat_template_kwargs": {"enable_thinking": False}})["prompt"]
            r = _post(url, "/completion", {"prompt": prompt, "n_predict": 2048, "temperature": 0.2, "top_p": 0.95,
                                           "seed": 0, "n_probs": top, "cache_prompt": False})
            d = tempfile.mkdtemp(prefix="td-")
            try:
                seed(pathlib.Path(d), task)
                (pathlib.Path(d) / task["entry"]).write_text(extract_code(r["content"]), encoding="utf-8")
                ok = bool(run_test(pathlib.Path(d), task["test"])[0])
            finally:
                shutil.rmtree(d, ignore_errors=True)
            ids, tops = _probs(r)
            return {"task": task["name"], "category": task["category"], "prompt": prompt, "answer": r["content"],
                    "ok": ok, "ids": ids, "top": tops}
        except Exception as e:  # noqa: BLE001
            return {"task": task["name"], "error": repr(e)}

    def cont(item):
        pid, text = item
        try:
            r = _post(url, "/completion", {"prompt": text, "n_predict": 1000, "temperature": 0.8, "top_p": 0.95,
                                           "seed": 0, "n_probs": top, "cache_prompt": False})
            ids, tops = _probs(r)
            return {"id": pid, "prefix": text, "continuation": r["content"], "ids": ids, "top": tops}
        except Exception as e:  # noqa: BLE001
            return {"id": pid, "error": repr(e)}

    stats = {}
    for fname, items, fn, key in (("answers.jsonl", tasks, answer, "task"), ("regularizer.jsonl", prefixes, cont, "id")):
        path = f"{d_out}/{fname}"
        done = {json.loads(l)[key] for l in open(path) if l.strip()} if os.path.exists(path) else set()
        todo = [x for x in items if (x["name"] if key == "task" else x[0]) not in done]
        n = err = ok = toks = 0
        with open(path, "a") as f, concurrent.futures.ThreadPoolExecutor(parallel) as ex:
            for res in ex.map(fn, todo):
                if "error" in res:
                    err += 1
                    continue
                f.write(json.dumps(res) + "\n")
                f.flush()
                n += 1
                ok += res.get("ok", False)
                toks += len(res["ids"])
                if n % 50 == 0:
                    vol.commit()
                    print(f"{fname}: {n} written ({ok} passing), {toks} tokens, {time.time() - t0:.0f} s", flush=True)
        vol.commit()
        stats[fname] = {"written": n, "errors": err, "passing": ok, "tokens": toks}
    srv.terminate()
    secs = time.time() - t0
    return {**stats, "minutes": round(secs / 60, 1), "cost_usd_est": round(secs * RATE, 2)}


def kl_top(logits, top_ids, top_lp):
    """KL(teacher || student) per position over the teacher's top-k plus one bucket for the remaining mass.
    logits [n, V] (float32), top_ids / top_lp [n, k]."""
    import torch
    lsm = torch.log_softmax(logits, -1)
    p_top = lsm.gather(-1, top_ids).exp()
    q_top = top_lp.exp()
    p_rest = (1 - p_top.sum(-1)).clamp_min(1e-6)
    q_rest = (1 - q_top.sum(-1)).clamp_min(1e-6)
    return (q_top * (top_lp - torch.log(p_top.clamp_min(1e-9)))).sum(-1) + q_rest * (q_rest.log() - p_rest.log())


@app.function(gpu="A100-80GB", volumes={W: vol}, timeout=4 * 3600, cpu=8, memory=64 * 1024, image=torch_image)
def train(student: str = KEEP96, tag: str = "keep96-v1", epochs: int = 2, rank: int = 16, lr: float = 2e-4,
          kl_weight: float = 1.0, accum: int = 8, max_len: int = 2048):
    """Task 5 (spec 4.3): LoRA on full attention, DeltaNet and the shared expert of the dequantized served student.
    Loss: cross-entropy on the teacher's verified answers + kl_weight x KL to its top-20 there, and KL only on the
    regularizer continuations. bf16, gradient checkpointing, batch 1 x `accum`. Then convert_lora_to_gguf.py."""
    import random
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoTokenizer
    t0 = time.time()
    model, hp, rep = load_student(student)
    tok = AutoTokenizer.from_pretrained("Qwen/Qwen3.6-35B-A3B")
    end = tok.convert_tokens_to_ids("<|im_end|>")
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.config.use_cache = False
    model = get_peft_model(model, LoraConfig(r=rank, lora_alpha=2 * rank, lora_dropout=0.0, target_modules=LORA_TARGETS))
    ex = []
    for line in open(f"{W}/teacher_data/answers.jsonl"):
        r = json.loads(line)
        if r["ok"] and r["ids"]:
            ex.append(("answer", tok(r["prompt"], add_special_tokens=False).input_ids, r["ids"] + [end], r["top"]))
    n_ans = len(ex)
    for line in open(f"{W}/teacher_data/regularizer.jsonl"):
        r = json.loads(line)
        if r["ids"]:
            ex.append(("reg", tok(r["prefix"], add_special_tokens=False).input_ids, r["ids"], r["top"]))
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=lr, weight_decay=0.0)
    steps_total = epochs * len(ex) // accum
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 20) * max(0.05, 1 - s / max(1, steps_total)))
    rng = random.Random(0)
    log, step, acc = [], 0, {"ce": 0.0, "kl": 0.0, "n": 0}
    model.train()
    for ep in range(epochs):
        order = list(range(len(ex)))
        rng.shuffle(order)
        for i, k in enumerate(order):
            kind, p_ids, a_ids, tops = ex[k]
            a_ids = a_ids[:max(1, max_len - len(p_ids))]
            ids = torch.tensor([p_ids + a_ids], device="cuda")
            n_p = len(p_ids)
            logits = model(input_ids=ids).logits[0, n_p - 1:n_p - 1 + len(a_ids)].float()
            k_top = min(len(tops), len(a_ids))
            loss = 0.0
            if k_top:
                t_ids = torch.tensor([[t[0] for t in row] for row in tops[:k_top]], device="cuda")
                t_lp = torch.tensor([[t[1] for t in row] for row in tops[:k_top]], device="cuda")
                kl = kl_top(logits[:k_top], t_ids, t_lp).mean()
                loss = loss + kl_weight * kl
                acc["kl"] += float(kl)
            if kind == "answer":
                ce = torch.nn.functional.cross_entropy(logits, ids[0, n_p:])
                loss = loss + ce
                acc["ce"] += float(ce)
            (loss / accum).backward()
            acc["n"] += 1
            if acc["n"] % accum == 0:
                torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
                opt.step()
                sched.step()
                opt.zero_grad()
                step += 1
                if step % 10 == 0:
                    log.append({"step": step, "epoch": ep, "ce": round(acc["ce"] / acc["n"], 4),
                                "kl": round(acc["kl"] / acc["n"], 4), "s": round(time.time() - t0)})
                    print(json.dumps(log[-1]), flush=True)
                    acc = {"ce": 0.0, "kl": 0.0, "n": 0}
    out = f"{W}/train/{tag}"
    os.makedirs(out, exist_ok=True)
    model.save_pretrained(f"{out}/adapter")
    base = "/tmp/student-config"
    os.makedirs(base, exist_ok=True)
    student_config(rep["experts"]).save_pretrained(base)
    tok.save_pretrained(base)
    cfg = json.load(open(f"{base}/config.json"))
    cfg["architectures"] = ["Qwen3_5MoeForCausalLM"]
    json.dump(cfg, open(f"{base}/config.json", "w"))
    conv = subprocess.run([sys.executable, "/opt/llama/convert_lora_to_gguf.py", "--base", base, "--outfile",
                           f"{out}/lora.gguf", "--outtype", "f16", f"{out}/adapter"], capture_output=True, text=True)
    secs = time.time() - t0
    res = {"tag": tag, "student": student, "answers": n_ans, "regularizer": len(ex) - n_ans, "epochs": epochs,
           "optimizer_steps": step, "log": log, "convert_exit": conv.returncode,
           "convert_tail": (conv.stdout + conv.stderr)[-600:], "minutes": round(secs / 60, 1),
           "cost_usd_est": round(secs * A100_RATE, 2)}
    json.dump(res, open(f"{out}/train.json", "w"), indent=1)
    vol.commit()
    return res


@app.local_entrypoint()
def run_train(tag: str = "keep96-v1", student: str = KEEP96, epochs: int = 2):
    print(json.dumps(train.remote(student, tag, epochs), indent=1))


@app.local_entrypoint()
def make_teacher_data(tasks_json: str, prefixes_json: str):
    tasks = json.load(open(tasks_json, encoding="utf-8"))
    prefixes = json.load(open(prefixes_json, encoding="utf-8"))
    print(json.dumps(teacher_data.remote(tasks, prefixes), indent=1))


@app.local_entrypoint()
def gen_train_tasks(per_family: int = 360):
    sys.path.insert(0, str(HERE.parent / "train_tasks"))
    import families
    print(json.dumps(gen_tasks.remote([list(p) for p in families.prompts(per_family)]), indent=1))


def llama_top1(gguf_path, text, n_ctx=2048, chunks=2, ngl=99):
    """llama.cpp's own view of `text`: llama-perplexity --kl-divergence-base keeps the evaluated tokens and, for the
    second half of each chunk, every position's log-probs (uint16, monotonic in the logit). -> tokens
    [chunk, n_ctx], top-1 and the target's log-prob at positions n_ctx/2 .. n_ctx-2."""
    import numpy as np
    base = "/tmp/base.bin"
    # -ngl 0 alone still offloads big-batch matmuls to the GPU (op offload): hide the GPU for a true CPU pass
    env = {**os.environ, **({"CUDA_VISIBLE_DEVICES": ""} if ngl == 0 else {})}
    subprocess.run([f"{BIN}/llama-perplexity", "-m", gguf_path, "-f", text, "-c", str(n_ctx), "--chunks", str(chunks),
                    "-ngl", str(ngl), "-b", str(n_ctx), "-ub", "512", "--kl-divergence-base", base], check=True, env=env)
    with open(base, "rb") as f:
        assert f.read(8) == b"_logits_"
        n_ctx_, n_vocab, n_chunk = (int(x) for x in np.frombuffer(f.read(12), dtype=np.int32))
        tokens = np.frombuffer(f.read(4 * n_chunk * n_ctx_), dtype=np.int32).reshape(n_chunk, n_ctx_)
        nv, first = 2 * ((n_vocab + 1) // 2) + 4, n_ctx_ // 2
        n_tok = n_ctx_ - 1 - first
        top, logp, qs, scales = [], [], [], []
        for c in range(n_chunk):
            rows = np.frombuffer(f.read(2 * nv * n_tok), dtype=np.uint16).reshape(n_tok, nv)
            head = rows[:, :4].copy().view(np.float32)  # [scale, min_log_prob] per position
            q = rows[:, 4:4 + n_vocab].copy()
            top.append(q.argmax(1))
            tgt = tokens[c, first + 1:first + 1 + n_tok]
            logp.append(head[:, 1] + q[np.arange(n_tok), tgt].astype(np.float32) * head[:, 0])
            qs.append(q)
            scales.append(head[:, 0])
    return tokens, first, np.stack(top), np.stack(logp), qs, scales


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
    return {"transformers": str(transformers.__version__), "torch": str(torch.__version__), "fla": fla_ok,
            "params": {n: [int(d) for d in p.shape] for n, p in m.named_parameters()}}  # plain types: no torch locally


def load_student(gguf_path, dtype="bfloat16"):
    """The served GGUF, dequantized tensor by tensor (gguf-py) and reverse-mapped straight into transformers'
    Qwen3_5MoeForCausalLM on the GPU (bf16 by default). -> (model, hparams, report of unmapped and unloaded names)."""
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
    torch.set_default_dtype(getattr(torch, dtype))
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
def parity(dtypes: list = ("bfloat16",)):
    """Gate 2.4 (and the name half of 2.2): transformers on the dequantized served weights must pick llama.cpp's top
    token on at least 99% of about 2,000 held-out positions. Loads in the first dtype and casts down for the rest.
    For each disagreement, llama.cpp's own log-prob gap between the two picks says whether it is a near-tie."""
    import numpy as np
    import torch
    t0 = time.time()
    tokens, first, top_l, logp_l, qs, scales = llama_top1(KEEP96, "/opt/heldout.txt")
    margin = []
    for q, s in zip(qs, scales):
        two = np.partition(q, -2, axis=1)[:, -2:].astype(np.float32)
        margin.append((two[:, 1] - two[:, 0]) * s)  # llama's own top-1 vs top-2, nats
    margin = np.concatenate(margin)
    t1 = time.time()
    model, hp, rep = load_student(KEEP96, dtypes[0])
    t2 = time.time()
    res = {"positions": int(margin.size), "ppl_llama": round(float(np.exp(-np.concatenate(logp_l).mean())), 3),
           "share_llama_margin_lt_0.1": round(float((margin < 0.1).mean()), 4),
           "names": {k: (v if not isinstance(v, list) else v[:12]) for k, v in rep.items()}, "by_dtype": {}}
    for dt in dtypes:
        model.to(getattr(torch, dt))
        agree, gap, nll_hf = [], [], []
        with torch.no_grad():
            for c in range(tokens.shape[0]):
                ids = torch.tensor(tokens[c][None].astype(np.int64), device="cuda")
                lg = model(input_ids=ids).logits[0].float()
                pos = slice(first, tokens.shape[1] - 1)
                top_h = lg[pos].argmax(-1).cpu().numpy()
                agree.append(top_h == top_l[c])
                n = np.arange(top_h.size)
                gap.append((qs[c][n, top_l[c]].astype(np.float32) - qs[c][n, top_h]) * scales[c])
                lsm = torch.log_softmax(lg[pos], -1)
                nll_hf.append(-lsm[torch.arange(lsm.shape[0]), ids[0, first + 1:]].cpu().numpy())
        a, g = np.concatenate(agree), np.concatenate(gap)
        d = g[~a]
        q3 = lambda p: round(float(np.quantile(d, p)), 3) if d.size else None  # noqa: E731
        res["by_dtype"][dt] = {
            "top1_agreement": round(float(a.mean()), 4), "pass": bool(a.mean() >= 0.99),
            "ppl_transformers": round(float(np.exp(np.concatenate(nll_hf).mean())), 3),
            "agreement_where_llama_margin_ge_0.1": round(float(a[margin >= 0.1].mean()), 4),
            "agreement_where_llama_margin_ge_0.5": round(float(a[margin >= 0.5].mean()), 4),
            "disagreements": int(d.size),
            "llama_gap_at_disagreements_nats": {"median": q3(0.5), "p90": q3(0.9), "max": q3(1.0)}}
    secs = time.time() - t0
    res.update({"seconds": {"llama": round(t1 - t0), "load": round(t2 - t1), "total": round(secs)},
                "cost_usd_est": round(secs * A100_RATE, 2)})
    os.makedirs(f"{W}/gates", exist_ok=True)
    json.dump(res, open(f"{W}/gates/parity-{'-'.join(dtypes)}.json", "w"), indent=1)
    vol.commit()
    return res


LORA_TARGETS = ["q_proj", "k_proj", "v_proj", "o_proj",  # full attention
                "in_proj_qkv", "in_proj_z", "in_proj_a", "in_proj_b", "out_proj",  # DeltaNet
                "shared_expert.gate_proj", "shared_expert.up_proj", "shared_expert.down_proj"]  # not the routed experts


@app.function(gpu="A100-80GB", volumes={W: vol}, timeout=3600, cpu=8, memory=64 * 1024, image=torch_image)
def overfit(examples: list, steps: int = 40, rank: int = 16, lr: float = 1e-3):
    """Gates 2.5 and 2.6: a LoRA on the dequantized student trains (DeltaNet path included), overfits `examples`
    ([prompt_text, answer_text] in the model's chat format) to >= 95% greedy token reproduction, and
    convert_lora_to_gguf.py turns it into a GGUF LoRA (on the volume, for the local served check)."""
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoTokenizer
    t0 = time.time()
    model, hp, rep = load_student(KEEP96)
    tok = AutoTokenizer.from_pretrained("Qwen/Qwen3.6-35B-A3B")
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})  # frozen inputs
    model.config.use_cache = False
    model = get_peft_model(model, LoraConfig(r=rank, lora_alpha=2 * rank, lora_dropout=0.0, target_modules=LORA_TARGETS))
    n_train = sum(p.numel() for p in model.parameters() if p.requires_grad)
    batch = []
    for prompt, answer in examples:
        p_ids = tok(prompt, add_special_tokens=False).input_ids
        a_ids = tok(answer, add_special_tokens=False).input_ids
        ids = torch.tensor([p_ids + a_ids], device="cuda")
        labels = torch.tensor([[-100] * len(p_ids) + a_ids], device="cuda")
        batch.append((ids, labels, len(p_ids)))

    def reproduction():
        model.eval()
        hit = tot = 0
        with torch.no_grad():
            for ids, labels, n_p in batch:
                pred = model(input_ids=ids).logits[0, n_p - 1:-1].argmax(-1)
                hit += int((pred == ids[0, n_p:]).sum())
                tot += ids.shape[1] - n_p
        model.train()
        return hit / max(tot, 1)

    before = reproduction()
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=lr)
    losses = []
    model.train()
    for step in range(steps):
        tot = 0.0
        for ids, labels, _ in batch:
            loss = model(input_ids=ids, labels=labels).loss
            loss.backward()
            tot += float(loss)
        opt.step()
        opt.zero_grad()
        losses.append(round(tot / len(batch), 4))
    after = reproduction()
    out = f"{W}/gates/overfit-lora"
    model.save_pretrained(out)
    # convert_lora_to_gguf.py needs the base's config: the official one with the served expert count
    base = "/tmp/student-config"
    os.makedirs(base, exist_ok=True)
    student_config(rep["experts"]).save_pretrained(base)
    tok.save_pretrained(base)
    cfg = json.load(open(f"{base}/config.json"))
    cfg["architectures"] = ["Qwen3_5MoeForCausalLM"]
    json.dump(cfg, open(f"{base}/config.json", "w"))
    conv = subprocess.run([sys.executable, "/opt/llama/convert_lora_to_gguf.py", "--base", base, "--outfile",
                           f"{W}/gates/overfit-lora.gguf", "--outtype", "f16", out], capture_output=True, text=True)
    secs = time.time() - t0
    res = {"trainable_params": n_train, "steps": steps, "losses": losses[::max(1, steps // 10)] + losses[-1:],
           "reproduction_before": round(before, 4), "reproduction_after": round(after, 4),
           "pass_pytorch": after >= 0.95, "convert_exit": conv.returncode, "convert_tail": (conv.stdout + conv.stderr)[-1500:],
           "lora_gguf_bytes": os.path.getsize(f"{W}/gates/overfit-lora.gguf") if os.path.exists(f"{W}/gates/overfit-lora.gguf") else 0,
           "names": {k: (v if not isinstance(v, list) else v[:12]) for k, v in rep.items()},
           "seconds": round(secs), "cost_usd_est": round(secs * A100_RATE, 2)}
    json.dump(res, open(f"{W}/gates/overfit.json", "w"), indent=1)
    vol.commit()
    return res


@app.local_entrypoint()
def gate_overfit(rows: str, n: int = 20, steps: int = 40):
    """rows: a patch_calib.py rows file; its first n single-shot turns (prompt, answer) are the overfit set."""
    ex = []
    for line in open(rows, encoding="utf-8"):
        r = json.loads(line)
        head, sep, rest = r["text_single"].rpartition("</think>\n\n")  # served prompts end with the empty think block
        ex.append([head + sep, rest.removesuffix("\n")])
        if len(ex) == n:
            break
    print(json.dumps(overfit.remote(ex, steps), indent=1))


@app.local_entrypoint()
def check_names(out: str = ""):
    """python -m modal run modal_distill.py::check_names --out names.json  (then compared locally)"""
    res = names.remote()
    print(json.dumps({k: v for k, v in res.items() if k != "params"}), len(res["params"]), "parameters")
    if out:
        open(out, "w").write(json.dumps(res, indent=1))


@app.function(gpu="A100-80GB", volumes={W: vol}, timeout=1800, cpu=8, memory=64 * 1024, image=torch_image)
def noise_floor():
    """The parity gate's reference: llama.cpp against itself, CUDA (the served path) vs CPU, same tokens and file.
    Two numerically different but correct implementations of the same quantized model."""
    import numpy as np
    t0 = time.time()
    tok_g, first, top_g, logp_g, qs, scales = llama_top1(KEEP96, "/opt/heldout.txt", ngl=99)
    tok_c, _, top_c, logp_c, _, _ = llama_top1(KEEP96, "/opt/heldout.txt", ngl=0)
    assert np.array_equal(tok_g, tok_c)
    a = (top_g == top_c).ravel()
    gaps = []
    for c in range(top_g.shape[0]):
        n = np.arange(top_g.shape[1])
        gaps.append((qs[c][n, top_g[c]].astype(np.float32) - qs[c][n, top_c[c]]) * scales[c])
    d = np.concatenate(gaps)[~a]
    secs = time.time() - t0
    res = {"positions": int(a.size), "cuda_vs_cpu_top1_agreement": round(float(a.mean()), 4),
           "ppl_cuda": round(float(np.exp(-logp_g.mean())), 3), "ppl_cpu": round(float(np.exp(-logp_c.mean())), 3),
           "disagreements": int(d.size),
           "cuda_gap_at_disagreements_nats": {"median": round(float(np.median(d)), 3) if d.size else None,
                                              "max": round(float(d.max()), 3) if d.size else None},
           "seconds": round(secs), "cost_usd_est": round(secs * A100_RATE, 2)}
    json.dump(res, open(f"{W}/gates/noise-floor.json", "w"), indent=1)
    vol.commit()
    return res


@app.local_entrypoint()
def gate_noise_floor():
    print(json.dumps(noise_floor.remote(), indent=1))


@app.local_entrypoint()
def gate_parity(dtypes: str = "bfloat16"):
    print(json.dumps(parity.remote(dtypes.split(",")), indent=1))


@app.local_entrypoint()
def teacher_test(budgets: str = "0,2048"):
    print(json.dumps(teacher.remote([int(b) for b in budgets.split(",")]), indent=1))
