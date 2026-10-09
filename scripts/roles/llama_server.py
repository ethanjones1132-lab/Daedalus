"""llama-server (build 836d571) for the role-adapter evaluation: one base GGUF, optionally one LoRA GGUF."""
import json
import subprocess
import time
import urllib.error
import urllib.request

SERVER = r"C:\qwen3-forge-stage\tools\llama-master-836d57176\llama-server.exe"
PORT = 8096


class Server:
    def __init__(self, gguf, lora=None, slot_ctx=16384, parallel=4, port=PORT, log_path=None, extra=()):
        self.port, self.parallel = port, parallel
        self.args = [SERVER, "-m", str(gguf), "--host", "127.0.0.1", "--port", str(port), "-ngl", "99",
                     "-c", str(slot_ctx * parallel), "-np", str(parallel), "-ctk", "q8_0", "-ctv", "q8_0",
                     "--flash-attn", "on", "-b", "512", "-ub", "512", "--jinja", "--reasoning-budget", "0",
                     "--no-webui", "--cache-ram", "0"] + (["--lora", str(lora)] if lora else []) + list(extra)
        self.log = open(log_path, "a", encoding="utf-8", errors="replace") if log_path else subprocess.DEVNULL
        self.proc = None

    def __enter__(self):
        self.proc = subprocess.Popen(self.args, stdout=self.log, stderr=subprocess.STDOUT)
        t0 = time.time()
        while time.time() - t0 < 900:
            if self.proc.poll() is not None:
                raise RuntimeError(f"llama-server exited {self.proc.returncode} during load")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=2) as r:
                    if r.status == 200:
                        return self
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                pass
            time.sleep(2)
        self.__exit__(None, None, None)
        raise RuntimeError("llama-server did not become healthy in 900 s")

    def __exit__(self, *exc):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        time.sleep(15)  # let the driver release VRAM before the next load

    def chat(self, messages, max_tokens=4096, temperature=0.2, seed=0, timeout=3000):
        payload = {"messages": messages, "max_tokens": max_tokens, "temperature": temperature, "top_p": 0.95,
                   "seed": seed, "cache_prompt": False, "chat_template_kwargs": {"enable_thinking": False}}
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/v1/chat/completions",
                                     data=json.dumps(payload).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        t = time.time()
        with urllib.request.urlopen(req, timeout=timeout) as r:
            resp = json.loads(r.read())
        choice, tm = resp["choices"][0], resp.get("timings", {})
        return {"text": choice["message"].get("content") or "", "finish": choice.get("finish_reason"),
                "prompt_n": tm.get("prompt_n"), "gen_n": tm.get("predicted_n"), "secs": round(time.time() - t, 1)}
