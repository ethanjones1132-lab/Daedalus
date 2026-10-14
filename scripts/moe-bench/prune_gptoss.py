"""Expert pruning for gpt-oss-20b (MXFP4): the Qwen3.6 method, with calibration
text that matches how gpt-oss works.

gpt-oss answers in two channels: English reasoning ("analysis"), then the answer
("final"). The Qwen pilot calibrated on raw source code, which suited a model
benchmarked with thinking off; for gpt-oss that would rank experts on code tokens
only and could prune the ones its reasoning runs through. So the calibration text
here is the full model's own transcripts, in its exact chat format, on coding
prompts built from Python standard-library functions (fix an injected bug,
implement from a docstring, write tests), generated at the benchmark's settings.
Nothing comes from tier2b, and stdlib topics that overlap its tasks are skipped.

Stages, each skipped when its output already exists (restart-safe):
  1. download gpt-oss-20b MXFP4 and its EAGLE3 draft (ggml-org), sha256-verified;
  2. generate the calibration transcripts with the full model;
  3. llama-imatrix on them, plus one on the stdlib code used for Qwen, kept only
     to report how far the two expert rankings agree;
  4. for each kept-expert count: slice, check the slice, probe placements (with
     and without the draft), then the full tier2b with the baseline's settings.
Baseline on the same build and settings: 109/117 at 22.5 tok/s, 15 CPU expert
layers, EAGLE3 draft. Results append to logs/prune-gptoss-results.jsonl.

usage: prune_gptoss.py [--prompts-only]
"""
import ast
import importlib
import inspect
import json
import pathlib
import random
import subprocess
import sys
import textwrap
import time
import urllib.error
import urllib.request

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import model_pipeline as mp  # noqa: E402
from slice_experts import EXPERT_TENSOR, field_value, importance_from_imatrix  # noqa: E402

REPO = "ggml-org/gpt-oss-20b-GGUF"
MODEL_FILE, DRAFT_FILE = "gpt-oss-20b-MXFP4.gguf", "eagle3-gpt-oss-20b-Q8_0.gguf"
WORK = mp.MODELS_DIR / "prune-gptoss20b"
CALIB = mp.STAGE / "calib"
SELFGEN_JSONL = CALIB / "gptoss-selfgen.jsonl"
SELFGEN_TXT = CALIB / "gptoss-selfgen.txt"
CODE_CALIB = CALIB / "code-calib.txt"
OUT = mp.LOGS / "prune-gptoss-results.jsonl"
BASE_NCMOE, BASE_MTP = 15, 3  # the full model's best measured placement
CHAT_KWARGS = {"reasoning_effort": "low"}
PORT = 8093
N_PROMPTS = 64

# Kept experts per layer (of 32; 4 are used per token), with the placements to
# probe as (CPU expert layers, draft depth), run in this order. Rough GPU need:
# 0.32 GB per kept expert across the 24 layers, ~1.4 GB of other weights, the
# 0.92 GB draft, plus KV cache and compute buffers, against the 7,168 MiB cap.
# gpt-oss spreads its routing far more evenly than Qwen3.6 (activation energy
# kept on the calibration text: 24 -> 95.6%, 16 -> 83.6%, 12 -> 73.4%, 8 -> 58.8%;
# Qwen at the same ratios kept 98.2/93.7/89.4/82.2%).
#
# Round 1 (selfgen calibration only): keep16 scored 77/117 vs 109, all of the loss
# in tier2b's knowledge categories (B hidden-package 16 -> 1, E library use
# 18 -> 2) while A/C/D held. The selfgen prompts deliberately skipped stdlib areas
# near tier2b's tasks (hashing, paths, formatting...), so the experts holding that
# library knowledge looked idle and were cut. Round 2 tests the calibration:
# plain stdlib source (as for Qwen, which kept E) and both sets combined.
# Entries: (label, kept experts, imatrix sets, placements as (CPU expert layers, draft depth)).
IMATRIX = {"selfgen": WORK / "imatrix-gptoss-selfgen.gguf", "code": WORK / "imatrix-gptoss-code.gguf"}
# 2026-10-04 11:13 the PC crashed (bugcheck 0x124 raised by stornvme for C:'s Kingston
# NV2) right after a 7 GB slice was written and llama-server began reading it back;
# the same drive needed a reset at 04:10 after a 13.6 GB download plus checksum read.
# C: was ~98% full, so this DRAM-less drive had almost no fast write cache and stalled
# for seconds at a time (ReadLatencyMax 2.7 s). Fresh slices now get a quiet spell
# before they are loaded, and each slice is deleted once it has been tested.
SETTLE_S = 180
# Placements leave ~1.1 GB of VRAM for the Versutus voice server, which auto-starts
# since the 11:13 reboot; at ncmoe 0 keep16 spilled into system RAM (15 tok/s vs 75.8).
# Round 2 result: keep16-code (plain stdlib-source calibration) was stopped at 6/35 with
# 21 of 29 failures running to the 4,096-token cap -- without the experts its reasoning
# channel uses, gpt-oss cannot finish thinking. So the code set is dropped (and the mix,
# which would import its picks); the next point is the mild prune on selfgen calibration.
# Resumed 2026-10-04 13:xx with the Versutus gate paused (+1.1 GB VRAM): earlier probes
# (no draft: ncmoe 10 = 35.7 tok/s; EAGLE3: ncmoe 14 = 20.9) were taken with it running,
# so the no-draft placement is re-probed lower; the draft was clearly slower and is dropped.
PLAN = [
    ("keep24-selfgen", 24, ["selfgen"], [([7, 8, 9], 0)]),
]

# Pure-Python stdlib functions the calibration prompts are built from.
STDLIB = [
    "colorsys:rgb_to_hsv", "colorsys:hsv_to_rgb", "colorsys:rgb_to_hls", "colorsys:hls_to_rgb",
    "colorsys:rgb_to_yiq", "textwrap:dedent", "textwrap:indent", "textwrap:TextWrapper._wrap_chunks",
    "textwrap:TextWrapper._handle_long_word", "fnmatch:translate", "fnmatch:filter",
    "difflib:get_close_matches", "difflib:SequenceMatcher.ratio", "difflib:SequenceMatcher.get_opcodes",
    "difflib:SequenceMatcher.get_matching_blocks", "difflib:_count_leading",
    "statistics:median", "statistics:median_low", "statistics:median_grouped", "statistics:mode",
    "statistics:multimode", "statistics:quantiles", "statistics:harmonic_mean", "statistics:geometric_mean",
    "statistics:correlation", "statistics:covariance", "fractions:Fraction.limit_denominator",
    "calendar:isleap", "calendar:leapdays", "calendar:monthrange", "calendar:weekday",
    "string:capwords", "string:Formatter._vformat", "shlex:quote", "shlex:split", "html:escape",
    "urllib.parse:urlsplit", "urllib.parse:urljoin", "urllib.parse:parse_qsl", "urllib.parse:unquote",
    "urllib.parse:quote_from_bytes", "ipaddress:collapse_addresses", "ipaddress:summarize_address_range",
    "ipaddress:_BaseV4._parse_octet", "ipaddress:_BaseV6._parse_hextet", "base64:_b32decode",
    "quopri:quote", "email.utils:formataddr", "email.utils:unquote", "encodings.punycode:adapt",
    "encodings.punycode:segregate", "encodings.punycode:insertion_unsort",
    "encodings.punycode:decode_generalized_number", "encodings.punycode:generate_generalized_integer",
    "tomllib._parser:skip_chars", "tomllib._parser:parse_basic_str_escape",
    "tomllib._parser:parse_inline_table", "tomllib._parser:parse_array", "glob:has_magic",
    "_pydatetime:_ymd2ord", "_pydatetime:_ord2ymd", "_pydatetime:_days_before_year",
    "_pydatetime:_days_in_month", "_pydecimal:_sqrt_nearest", "_pydecimal:_rshift_nearest",
    "_pydecimal:_nbits", "random:Random.shuffle", "random:Random.sample", "random:Random.randrange",
    "random:Random.choices", "heapq:nsmallest", "heapq:_siftup", "http.cookiejar:split_header_words",
    "ftplib:parse227", "_strptime:_calc_julian_from_U_or_W", "reprlib:Repr.repr_dict",
    "gettext:_expand_lang", "locale:_strip_padding",
]
# Keywords of tier2b's own tasks; stdlib functions touching them are skipped.
TIER2B_TOPICS = ("bisect", "merge", "norm", "csv", "json", "slug", "roman", "anagram", "lru", "cache",
                 "topo", "retry", "clamp", "hash", "digest", "grid", "chunk", "batch", "atomic", "bool",
                 "capture", "interval", "balanc", "bracket", "rotat", "lookup", "coalesce", "path", "log")

SWAP_CMP = {ast.Lt: ast.LtE, ast.LtE: ast.Lt, ast.Gt: ast.GtE, ast.GtE: ast.Gt, ast.Eq: ast.NotEq,
            ast.NotEq: ast.Eq}
SWAP_BIN = {ast.Add: ast.Sub, ast.Sub: ast.Add, ast.Mult: ast.FloorDiv, ast.FloorDiv: ast.Mult}
SERVER = mp.server_for("master")


class Mutator(ast.NodeTransformer):
    """Applies the `target`-th eligible single-token mutation; with target < 0 it only counts."""

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
    counter = Mutator(-1)
    counter.visit(ast.parse(src))
    if not counter.seen:
        return None
    out = ast.unparse(Mutator(rng.randrange(counter.seen)).visit(ast.parse(src)))
    return out if out != ast.unparse(ast.parse(src)) else None


def stdlib_functions():
    found = []
    for spec in STDLIB:
        mod_name, qual = spec.split(":")
        if any(k in qual.lower() for k in TIER2B_TOPICS):
            continue
        try:
            obj = importlib.import_module(mod_name)
            for part in qual.split("."):
                obj = getattr(obj, part)
            src = textwrap.dedent(inspect.getsource(obj))
            ast.parse(src)
        except Exception:
            continue
        if 6 <= src.count("\n") <= 90:
            found.append((mod_name, qual, src))
    return found


def requirement(mod_name, qual, src):
    fn = ast.parse(src).body[0]
    doc = ast.get_docstring(fn) if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) else None
    first = " ".join(doc.strip().split("\n\n")[0].split()) if doc else ""
    return first or f"Behave exactly like `{mod_name}.{qual}` in the Python standard library."


def stub(src):
    fn = ast.parse(src).body[0]
    if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return None
    fn.body = (fn.body[:1] if ast.get_docstring(fn) else []) + [ast.Expr(ast.Constant(...))]
    fn.decorator_list = []
    return ast.unparse(fn)


def build_prompts(n):
    """Calibration prompts, about 2 fix : 1 implement : 1 tests, topped up with more fixes."""
    rng = random.Random(20261004)
    primary, extra = [], []
    for i, (mod_name, qual, src) in enumerate(stdlib_functions()):
        name, req = qual.split(".")[-1], requirement(mod_name, qual, src)
        kind = ("fix", "implement", "fix", "tests")[i % 4]
        bad = mutate(src, rng) if kind == "fix" else None
        sig = stub(src) if kind == "implement" else None
        if bad:
            text = (f"Fix {name}.py.\n\n```python\n{bad}\n```\n\nRequirement: {req}\n"
                    "Return only the complete corrected file.")
        elif sig:
            text = (f"Implement this function from Python's `{mod_name}` module.\n\n```python\n{sig}\n```\n\n"
                    f"Requirement: {req}\nReturn the complete implementation in one ```python block.")
        else:
            kind = "tests"
            text = (f"Write pytest tests for this function from Python's `{mod_name}` module, "
                    f"covering normal and edge cases.\n\n```python\n{src}```")
        primary.append({"kind": kind, "func": f"{mod_name}.{qual}", "prompt": text})
        bad2 = mutate(src, rng)
        if bad2:
            extra.append({"kind": "fix", "func": f"{mod_name}.{qual}", "prompt":
                          "This function has a bug: one small change was made somewhere. Find it, say what "
                          f"it was in one sentence, and give the corrected function.\n\n```python\n{bad2}\n```"})
    rng.shuffle(extra)
    prompts = (primary + extra)[:n]
    rng.shuffle(prompts)
    return prompts


def post(path, payload, timeout=900):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=json.dumps(payload).encode(),
                                 method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def start_server(model, draft, log):
    """The full model at its benchmarked placement, so transcripts match benchmark-time behavior."""
    args = [SERVER, "-m", str(model), "--host", "127.0.0.1", "--port", str(PORT), "-ngl", "99",
            "--n-cpu-moe", str(BASE_NCMOE), "-c", "16384", "-ctk", "q8_0", "-ctv", "q8_0",
            "--flash-attn", "on", "-b", "512", "-ub", "512", "-np", "1", "--jinja",
            "--reasoning-budget", "-1", "--no-webui", "--cache-ram", "0",
            "--spec-type", "draft-eagle3", "--spec-draft-n-max", str(BASE_MTP), "-md", str(draft)]
    proc = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT)
    t0 = time.time()
    while time.time() - t0 < 600:
        if proc.poll() is not None:
            raise RuntimeError(f"calibration server exited {proc.returncode}")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2) as r:
                if r.status == 200:
                    return proc
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(1)
    proc.kill()
    raise RuntimeError("calibration server load timeout")


def stop(proc):
    proc.terminate()
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()


def generate_calibration(model, draft):
    prompts = build_prompts(N_PROMPTS)
    done = set()
    if SELFGEN_JSONL.exists():
        done = {json.loads(l)["i"] for l in SELFGEN_JSONL.read_text(encoding="utf-8").splitlines() if l.strip()}
    todo = [i for i in range(len(prompts)) if i not in done]
    if not todo:
        return
    mp.log(f"gptoss-prune: generating {len(todo)} calibration transcripts with the full model")
    t_all = time.time()
    with open(mp.LOGS / f"calib-gptoss-server-{mp.DAY}.log", "a", encoding="utf-8", errors="replace") as log:
        proc, restarts = start_server(model, draft, log), 0
        try:
            with SELFGEN_JSONL.open("a", encoding="utf-8") as f:
                for k, i in enumerate(todo, 1):
                    msgs = [{"role": "user", "content": prompts[i]["prompt"]}]
                    t = time.time()
                    try:
                        r = post("/v1/chat/completions", {"messages": msgs, "max_tokens": 3072,
                                                          "temperature": 0.2, "top_p": 0.95, "seed": i,
                                                          "chat_template_kwargs": CHAT_KWARGS})
                        head = post("/apply-template", {"messages": msgs,
                                                        "chat_template_kwargs": CHAT_KWARGS})["prompt"]
                    except Exception as e:
                        mp.log(f"gptoss-prune: calibration prompt {i} failed: {type(e).__name__}: {e}")
                        if proc.poll() is not None and restarts < 3:
                            restarts += 1
                            proc = start_server(model, draft, log)
                        continue
                    msg = r["choices"][0]["message"]
                    f.write(json.dumps({"i": i, **prompts[i], "template_prompt": head,
                                        "reasoning": msg.get("reasoning_content") or "",
                                        "content": msg.get("content") or "",
                                        "gen_n": r.get("timings", {}).get("predicted_n"),
                                        "secs": round(time.time() - t, 1)}) + "\n")
                    f.flush()
                    if k % 8 == 0 or k == len(todo):
                        mp.log(f"gptoss-prune: calibration {k}/{len(todo)} "
                               f"({(time.time() - t_all) / 60:.0f} min so far)")
        finally:
            stop(proc)


def write_calibration_text():
    rows = [json.loads(l) for l in SELFGEN_JSONL.read_text(encoding="utf-8").splitlines() if l.strip()]
    parts = []
    for r in rows:
        # The chat template ends with the generation prompt "<|start|>assistant"; the
        # answer follows in gpt-oss's harmony format: analysis channel, then final.
        text = r["template_prompt"]
        if r["reasoning"]:
            text += f"<|channel|>analysis<|message|>{r['reasoning']}<|end|><|start|>assistant"
        parts.append(text + f"<|channel|>final<|message|>{r['content']}<|return|>")
    SELFGEN_TXT.write_text("\n".join(parts), encoding="utf-8")
    mp.log(f"gptoss-prune: calibration text {SELFGEN_TXT.stat().st_size / 1e3:.0f} KB from {len(rows)} "
           f"transcripts; template ends {rows[0]['template_prompt'][-30:]!r}")


def run_imatrix(model, calib, out, extra):
    exe = str(pathlib.Path(SERVER).with_name("llama-imatrix.exe"))
    tmp = out.with_name(out.stem + ".partial.gguf")
    t = time.time()
    p = subprocess.run([exe, "-m", str(model), "-f", str(calib), "-o", str(tmp), "-c", "1024", "-b", "1024",
                        "-ngl", "99", "--n-cpu-moe", str(BASE_NCMOE), *extra],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0 or not tmp.exists():
        raise RuntimeError(f"imatrix failed: {(p.stderr or p.stdout)[-600:]}")
    tmp.replace(out)
    mp.log(f"gptoss-prune: imatrix {out.name} done in {(time.time() - t) / 60:.1f} min")


def agreement(imx_a, imx_b, keep):
    """Mean fraction of the top-`keep` experts per layer that both rankings pick."""
    a, b = importance_from_imatrix(str(imx_a)), importance_from_imatrix(str(imx_b))
    shared = [len(set(np.argsort(-a[L])[:keep]) & set(np.argsort(-b[L])[:keep])) / keep
              for L in sorted(set(a) & set(b))]
    return round(float(np.mean(shared)), 3) if shared else None


def check_slice(path, keep):
    from gguf import GGUFReader
    r = GGUFReader(str(path), "r")
    arch = field_value(r.fields["general.architecture"])[0]
    count = field_value(r.fields[f"{arch}.expert_count"])[0]
    sliced = [t for t in r.tensors if EXPERT_TENSOR.match(t.name)]
    wrong = [t.name for t in sliced if int(t.shape[-1]) != keep]
    if count != keep or wrong or not sliced:
        raise RuntimeError(f"bad slice: expert_count={count}, {len(wrong)} of {len(sliced)} "
                           f"expert tensors with the wrong expert axis")


def slice_to(model, imxs, keep, label):
    dst = WORK / f"gpt-oss-20b-MXFP4-{label}.gguf"
    if dst.exists():
        return dst
    need = model.stat().st_size / 1e9 * (0.17 + 0.83 * keep / 32) + 1
    old = sorted(WORK.glob("gpt-oss-20b-MXFP4-keep*.gguf"), key=lambda q: q.stat().st_mtime)
    while mp.free_gb() < need + mp.SPACE_MARGIN_GB and old:  # only already-benchmarked slices
        q = old.pop(0)
        q.unlink()
        mp.log(f"gptoss-prune: removed benchmarked {q.name} for space (C: free {mp.free_gb():.1f} GB)")
    tmp = dst.with_name(dst.stem + ".partial.gguf")
    cmd = [mp.PY, str(pathlib.Path(__file__).with_name("slice_experts.py")), str(model), str(tmp),
           "--keep", str(keep), "--report", str(WORK / f"{label}.json")]
    for imx in imxs:
        cmd += ["--imatrix", str(imx)]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"slice {label} failed: {p.stderr[-600:]}")
    check_slice(tmp, keep)
    tmp.replace(dst)
    mp.log(f"gptoss-prune: sliced {label}: {p.stdout.strip()} ({dst.stat().st_size / 1e9:.2f} GB)")
    return dst


def probe(path, draft, label, groups):
    best = None
    for cands, mtp in groups:
        m = dict(name=f"gptoss20b-{label}" + ("" if mtp else "-nodraft"), ncmoe=cands, mtp=mtp,
                 spec="draft-eagle3")
        try:
            b = mp.probe_placement(m, path, SERVER, draft if mtp else None)
        except Exception as e:
            mp.log(f"gptoss-prune: {label} probe {cands} draft {mtp}: {type(e).__name__}: {e}")
            continue
        if best is None or (b.get("gen_tps_mean") or 0) > (best.get("gen_tps_mean") or 0):
            best = b
    if best is None:
        raise RuntimeError("no placement fits the VRAM cap")
    return best


def main():
    if "--prompts-only" in sys.argv:
        prompts = build_prompts(N_PROMPTS)
        kinds = {}
        for p in prompts:
            kinds[p["kind"]] = kinds.get(p["kind"], 0) + 1
        print(json.dumps({"functions": len(stdlib_functions()), "prompts": len(prompts), "kinds": kinds}))
        for kind in kinds:
            print(f"--- {kind}\n" + next(p["prompt"] for p in prompts if p["kind"] == kind)[:900])
        return
    WORK.mkdir(parents=True, exist_ok=True)
    mp.log(f"=== gpt-oss-20b expert pruning  (C: free {mp.free_gb():.1f} GB)")
    model = mp.download(REPO, MODEL_FILE, WORK)
    draft = mp.download(REPO, DRAFT_FILE, WORK)
    if not SELFGEN_TXT.exists():
        generate_calibration(model, draft)
        write_calibration_text()
    imx, imx_code = WORK / "imatrix-gptoss-selfgen.gguf", WORK / "imatrix-gptoss-code.gguf"
    if not imx.exists():
        run_imatrix(model, SELFGEN_TXT, imx, ["--parse-special"])
    if not imx_code.exists():
        try:  # comparison only: how much would plain-code calibration have changed the picks?
            run_imatrix(model, CODE_CALIB, imx_code, ["--chunks", "60"])
        except Exception as e:
            mp.log(f"gptoss-prune: code imatrix (comparison only) failed: {e}")
    done = set()
    if OUT.exists():
        done = {json.loads(l)["name"] for l in OUT.read_text(encoding="utf-8").splitlines() if l.strip()}
    for label, keep, calib, groups in PLAN:
        if f"gptoss20b-{label}" in done:
            continue
        try:
            agree = agreement(imx, imx_code, keep) if imx_code.exists() else None
            fresh = not (WORK / f"gpt-oss-20b-MXFP4-{label}.gguf").exists()
            path = slice_to(model, [IMATRIX[c] for c in calib], keep, label)
            if fresh:
                mp.log(f"gptoss-prune: letting C: settle {SETTLE_S} s after writing {path.name}")
                time.sleep(SETTLE_S)
            retained = json.loads((WORK / f"{label}.json").read_text())["importance_retained"]
            best = probe(path, draft, label, groups)
            m = dict(name=f"gptoss20b-{label}", spec="draft-eagle3", budget=-1, chat_kwargs=CHAT_KWARGS)
            summary, out = mp.run_tier2b(m, path, SERVER, draft if best["mtp"] else None, best)
            with OUT.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"name": m["name"], "keep": keep, "calibration": calib,
                                    "file_gb": round(path.stat().st_size / 1e9, 2),
                                    "ncmoe": best["ncmoe"], "mtp": best["mtp"],
                                    "gen_tps_mean": best["gen_tps_mean"], "vram_mib": best["vram_delta_mib_peak"],
                                    "shared_spill_mib": best.get("shared_spill_mib"),
                                    "per_prompt": {r["prompt"]: [r["prompt_tps"], r["gen_tps"]]
                                                   for r in best.get("runs", [])},
                                    "importance_retained_mean": round(float(np.mean(list(retained.values()))), 4),
                                    "agreement_with_code_calibration": agree,
                                    "tier2b": summary, "results_file": str(out)}) + "\n")
            path.unlink()  # re-creatable in minutes from the full model and the imatrix files
            mp.log(f"gptoss-prune: removed tested {path.name} (C: free {mp.free_gb():.1f} GB)")
        except Exception as e:
            mp.log(f"gptoss-prune: {label} FAILED: {type(e).__name__}: {e}")
    mp.log("gptoss-prune done")


if __name__ == "__main__":
    main()
