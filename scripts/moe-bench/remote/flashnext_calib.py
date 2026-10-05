"""Calibration text and expert-usage summary for Qwen3.8-Flash-Next (ISTA GSQ-RCO Coder),
run on a rented GPU (2026-10-04; see modal_flashnext.py). Standalone: needs only numpy and gguf.

  gen        start llama-server with the Coder, answer ~96 coding prompts built from Python
             standard-library functions (fix an injected bug / implement from a docstring /
             write tests), half with thinking off and half with a 1,024-token thinking
             budget, and write the transcripts in the model's own chat format, plus a slice
             of raw stdlib source so library-API experts are exercised too.
  summarize  read a llama-imatrix GGUF: per-layer, per-expert activation energy on the
             ffn_down_exps inputs, the energy kept at each candidate expert count, and
             the top-N expert indices per layer (the input to slice_experts.py).

Lessons from the gpt-oss pruning rounds (2026-10-04): calibrate on the model's own
chat-format answers (raw code alone removed the experts its reasoning used), and do not
skip library areas (that deleted library knowledge). Nothing here comes from tier2b.

usage: flashnext_calib.py gen --server PATH --model PATH --out DIR [--prompts 96] [--parallel 4]
                              [--server-args="--load-mode none ..."]
       flashnext_calib.py summarize --imatrix PATH --out DIR
"""
import argparse
import ast
import importlib
import inspect
import json
import pathlib
import random
import re
import subprocess
import sys
import textwrap
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

STDLIB = [
    "colorsys:rgb_to_hsv", "colorsys:hsv_to_rgb", "colorsys:rgb_to_hls", "colorsys:hls_to_rgb",
    "textwrap:dedent", "textwrap:indent", "textwrap:shorten", "textwrap:TextWrapper._wrap_chunks",
    "fnmatch:translate", "fnmatch:filter", "difflib:get_close_matches", "difflib:SequenceMatcher.ratio",
    "difflib:SequenceMatcher.get_opcodes", "statistics:median", "statistics:median_low", "statistics:mode",
    "statistics:multimode", "statistics:quantiles", "statistics:harmonic_mean", "statistics:correlation",
    "fractions:Fraction.limit_denominator", "calendar:isleap", "calendar:leapdays", "calendar:monthrange",
    "string:capwords", "string:Formatter._vformat", "shlex:quote", "shlex:split", "html:escape",
    "urllib.parse:urlsplit", "urllib.parse:urljoin", "urllib.parse:parse_qsl", "urllib.parse:unquote",
    "ipaddress:collapse_addresses", "ipaddress:summarize_address_range", "base64:_b32decode",
    "email.utils:formataddr", "email.utils:unquote", "encodings.punycode:adapt",
    "encodings.punycode:segregate", "encodings.punycode:decode_generalized_number",
    "tomllib._parser:skip_chars", "tomllib._parser:parse_basic_str_escape", "glob:has_magic",
    "glob:escape", "posixpath:relpath", "posixpath:commonpath", "posixpath:normpath", "genericpath:commonprefix",
    "json.encoder:py_encode_basestring_ascii", "json.decoder:py_scanstring", "shutil:_copyfileobj_readinto",
    "_pydatetime:_ymd2ord", "_pydatetime:_ord2ymd", "_pydatetime:_days_before_year",
    "_pydecimal:_sqrt_nearest", "_pydecimal:_rshift_nearest", "random:Random.shuffle", "random:Random.sample",
    "random:Random.choices", "heapq:nsmallest", "heapq:_siftup", "http.cookiejar:split_header_words",
    "ftplib:parse227", "_strptime:_calc_julian_from_U_or_W", "locale:_strip_padding", "gettext:_expand_lang",
    "tempfile:_RandomNameSequence.__next__", "hmac:HMAC.hexdigest", "uuid:UUID.__str__",
    "pathlib._local:PurePath.with_suffix" if sys.version_info >= (3, 13) else "pathlib:PurePath.with_suffix",
]
# Raw library source, so the experts that hold library knowledge see real use.
SOURCE_MODULES = ["json.encoder", "json.decoder", "posixpath", "textwrap", "string", "shlex", "csv",
                  "hashlib", "hmac", "base64", "statistics", "fractions", "pathlib", "tempfile", "shutil",
                  "logging", "argparse", "dataclasses", "functools", "subprocess"]

SWAP_CMP = {ast.Lt: ast.LtE, ast.LtE: ast.Lt, ast.Gt: ast.GtE, ast.GtE: ast.Gt, ast.Eq: ast.NotEq, ast.NotEq: ast.Eq}
SWAP_BIN = {ast.Add: ast.Sub, ast.Sub: ast.Add, ast.Mult: ast.FloorDiv, ast.FloorDiv: ast.Mult}


class Mutator(ast.NodeTransformer):
    def __init__(self, target):
        self.seen, self.target = 0, target

    def _hit(self):
        self.seen += 1
        return self.seen - 1 == self.target

    def visit_Compare(self, node):
        self.generic_visit(node)
        if type(node.ops[0]) in SWAP_CMP and self._hit():
            node.ops[0] = SWAP_CMP[type(node.ops[0])]()
        return node

    def visit_BinOp(self, node):
        self.generic_visit(node)
        if type(node.op) in SWAP_BIN and self._hit():
            node.op = SWAP_BIN[type(node.op)]()
        return node

    def visit_BoolOp(self, node):
        self.generic_visit(node)
        if self._hit():
            node.op = ast.Or() if isinstance(node.op, ast.And) else ast.And()
        return node

    def visit_Constant(self, node):
        if type(node.value) is int and self._hit():
            node.value += 1
        return node


def mutate(src, rng):
    c = Mutator(-1)
    c.visit(ast.parse(src))
    if not c.seen:
        return None
    out = ast.unparse(Mutator(rng.randrange(c.seen)).visit(ast.parse(src)))
    return out if out != ast.unparse(ast.parse(src)) else None


def functions():
    found = []
    for spec in STDLIB:
        mod, qual = spec.split(":")
        try:
            obj = importlib.import_module(mod)
            for part in qual.split("."):
                obj = getattr(obj, part)
            src = textwrap.dedent(inspect.getsource(obj))
            ast.parse(src)
        except Exception:
            continue
        if 5 <= src.count("\n") <= 90:
            found.append((mod, qual, src))
    return found


def requirement(mod, qual, src):
    fn = ast.parse(src).body[0]
    doc = ast.get_docstring(fn) if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) else None
    first = " ".join(doc.strip().split("\n\n")[0].split()) if doc else ""
    return first or f"Behave exactly like `{mod}.{qual}` in the Python standard library."


def stub(src):
    fn = ast.parse(src).body[0]
    if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return None
    fn.body = (fn.body[:1] if ast.get_docstring(fn) else []) + [ast.Expr(ast.Constant(...))]
    fn.decorator_list = []
    return ast.unparse(fn)


def build_prompts(n):
    rng = random.Random(20261004)
    out = []
    for round_ in range(3):
        for i, (mod, qual, src) in enumerate(functions()):
            name, req = qual.split(".")[-1], requirement(mod, qual, src)
            kind = ("fix", "implement", "fix", "tests")[(i + round_) % 4]
            bad = mutate(src, rng) if kind == "fix" else None
            sig = stub(src) if kind == "implement" else None
            if bad:
                text = f"Fix {name}.py.\n\n```python\n{bad}\n```\n\nRequirement: {req}\nReturn only the complete corrected file."
            elif sig:
                text = (f"Implement this function from Python's `{mod}` module.\n\n```python\n{sig}\n```\n\n"
                        f"Requirement: {req}\nReturn the complete implementation in one ```python block.")
            else:
                kind = "tests"
                text = f"Write pytest tests for this function from Python's `{mod}` module.\n\n```python\n{src}```"
            out.append({"kind": kind, "func": f"{mod}.{qual}", "prompt": text})
    rng.shuffle(out)
    return out[:n]


PORT = 8094


def post(path, payload, timeout=1200):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=json.dumps(payload).encode(),
                                 method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def answer(i, p):
    think = i % 2 == 1  # half thinking off (how we serve it), half with a 1,024-token budget
    kw = {"enable_thinking": think}
    msgs = [{"role": "user", "content": p["prompt"]}]
    t = time.time()
    r = post("/v1/chat/completions", {"messages": msgs, "max_tokens": 3072, "temperature": 0.2,
                                      "top_p": 0.95, "seed": i, "chat_template_kwargs": kw})
    head = post("/apply-template", {"messages": msgs, "chat_template_kwargs": kw})["prompt"]
    m = r["choices"][0]["message"]
    return {"i": i, **p, "think": think, "template_prompt": head,
            "reasoning": m.get("reasoning_content") or "", "content": m.get("content") or "",
            "gen_n": r.get("timings", {}).get("predicted_n"),
            "tps": r.get("timings", {}).get("predicted_per_second"),
            "secs": round(time.time() - t, 1)}


def gen(a):
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    jl = out / "transcripts.jsonl"
    done = {json.loads(l)["i"] for l in jl.read_text().splitlines() if l.strip()} if jl.exists() else set()
    prompts = build_prompts(a.prompts)
    args = [a.server, "-m", a.model, "--host", "127.0.0.1", "--port", str(PORT), "-ngl", "99",
            "--n-cpu-moe", str(a.ncmoe), "-c", str(max(16384, 8192 * a.parallel)), "-ctk", "q8_0", "-ctv", "q8_0",
            "--flash-attn", "on", "-np", str(a.parallel), "--jinja", "--reasoning-budget", "1024", "--no-webui",
            "--cache-ram", "0"] + a.server_args.split()
    log = open(out / "server.log", "a")
    proc = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT)
    try:
        t0 = time.time()
        while True:
            if proc.poll() is not None:
                sys.exit(f"server exited {proc.returncode}; see {out / 'server.log'}")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2) as r:
                    if r.status == 200:
                        break
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                pass
            if time.time() - t0 > 1800:
                sys.exit("server load timeout")
            time.sleep(2)
        print(f"server up in {time.time() - t0:.0f} s", flush=True)
        todo = [(i, p) for i, p in enumerate(prompts) if i not in done]
        with jl.open("a") as f, ThreadPoolExecutor(a.parallel) as ex:  # one request per server slot
            futs = {ex.submit(answer, i, p): i for i, p in todo}
            for n, fut in enumerate(as_completed(futs), 1):
                try:
                    row = fut.result()
                except Exception as e:
                    print(f"prompt {futs[fut]} failed: {e}", flush=True)
                    continue
                f.write(json.dumps(row) + "\n")
                f.flush()
                print(f"{n}/{len(todo)} #{row['i']} {row['kind']:9s} think={row['think']} {row['gen_n']} tok "
                      f"{row['tps'] or 0:.0f} tok/s {row['secs']} s", flush=True)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            proc.kill()
    rows = [json.loads(l) for l in jl.read_text().splitlines() if l.strip()]
    parts = []
    for r in rows:
        text = r["template_prompt"]
        if r["reasoning"]:
            if text.rstrip().endswith("<think>"):  # the template already opened the thinking block
                text = text.rstrip() + f"\n{r['reasoning']}\n</think>\n\n"
            elif not text.rstrip().endswith("</think>"):
                text += f"<think>\n{r['reasoning']}\n</think>\n\n"
        parts.append(text + r["content"] + "<|im_end|>\n")
    for mod in SOURCE_MODULES:  # about a third of the text: raw library source
        try:
            parts.append(pathlib.Path(importlib.import_module(mod).__file__).read_text(encoding="utf-8")[:20000])
        except Exception:
            pass
    (out / "calib.txt").write_text("\n".join(parts), encoding="utf-8")
    print(f"calibration text: {(out / 'calib.txt').stat().st_size / 1e3:.0f} KB from {len(rows)} transcripts "
          f"+ {len(SOURCE_MODULES)} source modules; template ends {rows[0]['template_prompt'][-40:]!r}", flush=True)


def summarize(a):
    import numpy as np
    from gguf import GGUFReader
    r = GGUFReader(a.imatrix, "r")
    energy, counts = {}, {}
    for t in r.tensors:
        m = re.match(r"^blk\.(\d+)\.ffn_down_exps\.weight\.(in_sum2|counts)$", t.name)
        if not m:
            continue
        arr = np.asarray(t.data, dtype=np.float64)
        if m.group(2) == "in_sum2":
            energy[int(m.group(1))] = arr.reshape(arr.shape[0], -1).sum(axis=1)
        else:
            counts[int(m.group(1))] = arr.reshape(-1)
    layers = sorted(energy)
    n_exp = len(energy[layers[0]])
    kept = {}
    for n in [224, 192, 160, 128, 112, 96, 80, 64, 48]:
        if n < n_exp:
            fr = [np.sort(energy[L])[::-1][:n].sum() / energy[L].sum() for L in layers]
            kept[n] = {"mean": round(float(np.mean(fr)), 4), "min": round(float(np.min(fr)), 4),
                       "min_layer": int(layers[int(np.argmin(fr))])}
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    summary = {"experts_per_layer": n_exp, "layers": len(layers), "energy_kept": kept,
               "top": {n: {L: np.sort(np.argsort(-energy[L])[:n]).tolist() for L in layers} for n in (192, 160, 128, 96, 64) if n < n_exp},
               "energy": {L: energy[L].round(6).tolist() for L in layers},
               "counts": {L: counts[L].tolist() for L in counts}}
    (out / "expert-usage-summary.json").write_text(json.dumps(summary))
    print(json.dumps({"experts_per_layer": n_exp, "layers": len(layers), "energy_kept": kept}, indent=1))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("gen")
    g.add_argument("--server", required=True)
    g.add_argument("--model", required=True)
    g.add_argument("--out", required=True)
    g.add_argument("--prompts", type=int, default=96)
    g.add_argument("--ncmoe", type=int, default=0)
    g.add_argument("--parallel", type=int, default=1, help="server slots and concurrent requests")
    g.add_argument("--server-args", default="", help="extra llama-server flags, space-separated")
    s = sub.add_parser("summarize")
    s.add_argument("--imatrix", required=True)
    s.add_argument("--out", required=True)
    a = ap.parse_args()
    gen(a) if a.cmd == "gen" else summarize(a)


if __name__ == "__main__":
    main()
