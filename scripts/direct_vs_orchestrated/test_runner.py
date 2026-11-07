import csv
import json
import os
import shutil
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TASKS_PATH = ROOT / "tasks.json"
FIXTURE_PATH = ROOT / "fixtures" / "stock.csv"
EXPECTED_TASK_IDS = [
    "arithmetic",
    "code_explanation",
    "fixture_tool_read",
    "planning_no_implementation",
]


def load_tasks():
    return json.loads(TASKS_PATH.read_text(encoding="utf-8"))["tasks"]


class ComparisonCorpusTests(unittest.TestCase):
    def test_corpus_has_four_fixed_task_ids(self):
        tasks = load_tasks()
        self.assertEqual([task["id"] for task in tasks], EXPECTED_TASK_IDS)

    def test_fixture_task_expected_answer_matches_fixture_data(self):
        tasks = load_tasks()
        task = next(task for task in tasks if task["id"] == "fixture_tool_read")
        with FIXTURE_PATH.open(newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        winner = max(rows, key=lambda row: int(row["quantity"]))
        expected = f'{winner["name"]}: {winner["quantity"]}'
        self.assertEqual(task["acceptance"]["expected_answer"], expected)

    def test_all_tasks_define_generation_limits_and_acceptance_ids(self):
        tasks = load_tasks()
        self.assertEqual(len(tasks), 4)
        for task in tasks:
            with self.subTest(task=task.get("id")):
                self.assertIsInstance(task.get("max_tokens"), int)
                self.assertGreater(task["max_tokens"], 0)
                self.assertIsInstance(task.get("temperature"), (int, float))
                self.assertIsInstance(task.get("top_p"), (int, float))
                acceptance = task.get("acceptance")
                self.assertIsInstance(acceptance, dict)
                self.assertTrue(acceptance.get("id"))
                self.assertTrue(acceptance.get("criteria"))


class ProcessHarnessTests(unittest.TestCase):
    def test_llama_health_status_contract_is_accepted(self):
        from unittest.mock import patch

        from scripts.direct_vs_orchestrated import runner

        class RunningProcess:
            def poll(self):
                return None

        with patch.object(runner.time, "monotonic", side_effect=[0.0, 0.0, 2.0]):
            with patch.object(runner, "_local_json_request", return_value={"status": "ok"}):
                self.assertEqual(
                    runner._wait_for_json("http://127.0.0.1:19003/health", RunningProcess(), timeout_s=1),
                    {"status": "ok"},
                )

    def test_llama_extra_args_cannot_override_local_server_identity(self):
        from scripts.direct_vs_orchestrated.runner import validate_llama_extra_args

        for args in (
            ["--host", "0.0.0.0"],
            ["--host=0.0.0.0"],
            ["--port", "8080"],
            ["--model", "other.gguf"],
            ["-m", "other.gguf"],
            ["--alias", "other-model"],
            ["--rpc", "remote.example:50052"],
        ):
            with self.subTest(args=args), self.assertRaisesRegex(ValueError, "reserved"):
                validate_llama_extra_args(args)
        self.assertEqual(validate_llama_extra_args(["--n-gpu-layers", "99"]), ["--n-gpu-layers", "99"])

    def test_process_logs_are_created_under_out_dir(self):
        from scripts.direct_vs_orchestrated.runner import _open_process_logs

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with _open_process_logs(root, ["llama_cpp", "direct"]) as logs:
                self.assertEqual([Path(log.name).name for log in logs], ["llama_cpp.log", "direct.log"])

            self.assertTrue((root / "logs" / "llama_cpp.log").is_file())
            self.assertTrue((root / "logs" / "direct.log").is_file())

    def test_child_env_has_only_isolated_paths_and_no_cloud_credentials(self):
        from unittest.mock import patch

        from scripts.direct_vs_orchestrated.runner import child_env

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            home = root / "isolated-home"
            workspace = root / "fixture"
            with patch.dict(os.environ, {
                "PATH": "C:/tools",
                "SYSTEMROOT": "C:/Windows",
                "HOME": "C:/real-user",
                "USERPROFILE": "C:/real-user",
                "OPENAI_API_KEY": "must-not-leak",
                "ANTHROPIC_API_KEY": "must-not-leak",
                "AWS_SECRET_ACCESS_KEY": "must-not-leak",
                "HTTP_PROXY": "http://proxy.invalid:8080",
                "HTTPS_PROXY": "http://proxy.invalid:8080",
            }, clear=True):
                env = child_env(home, port=19001, workspace=workspace)

        for secret in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "HTTP_PROXY", "HTTPS_PROXY"):
            self.assertNotIn(secret, env)
        self.assertEqual(env["HOME"], str(home))
        self.assertEqual(env["USERPROFILE"], str(home))
        self.assertEqual(env["JARVIS_SERVER_PORT"], "19001")
        self.assertEqual(env["JARVIS_WORKSPACE"], str(workspace))
        for name in ("APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TEMP", "TMP"):
            self.assertTrue(Path(env[name]).is_relative_to(home), name)
        self.assertLessEqual(set(env), {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "TEMP", "TMP", "JARVIS_SERVER_PORT", "JARVIS_WORKSPACE", "JARVIS_HOME"})

    def test_unavailable_or_occupied_loopback_ports_abort_before_spawn(self):
        from scripts.direct_vs_orchestrated.runner import owned_processes

        with tempfile.TemporaryDirectory() as temp_dir, socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            port = occupied.getsockname()[1]
            spawn_calls = []
            with self.assertRaises(OSError):
                with owned_processes(
                    [["bun", "server.ts"]],
                    ports=[port],
                    env={},
                    cwd=Path(temp_dir),
                    popen_factory=lambda *args, **kwargs: spawn_calls.append((args, kwargs)),
                ):
                    self.fail("occupied port unexpectedly started a child")
            self.assertEqual(spawn_calls, [])

    def test_runner_starts_only_owned_children_and_terminates_only_their_handles(self):
        from scripts.direct_vs_orchestrated.runner import owned_processes

        class FakeProcess:
            next_pid = 100

            def __init__(self, *_args, **_kwargs):
                self.pid = FakeProcess.next_pid
                FakeProcess.next_pid += 1
                self.terminated = 0
                self.waited = 0
                self.alive = True

            def poll(self):
                return None if self.alive else -15

            def terminate(self):
                self.terminated += 1
                self.alive = False

            def wait(self, timeout=None):
                self.waited += 1
                return -15

        foreign = FakeProcess()
        owned = []

        def spawn(*args, **kwargs):
            process = FakeProcess(*args, **kwargs)
            owned.append(process)
            return process

        with tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaisesRegex(RuntimeError, "trial failure"):
                with owned_processes([["bun", "server.ts"], ["bun", "server.ts"]], ports=[], env={}, cwd=Path(temp_dir), popen_factory=spawn) as children:
                    self.assertEqual(children, owned)
                    raise RuntimeError("trial failure")

        self.assertEqual([process.terminated for process in owned], [1, 1])
        self.assertEqual([process.waited for process in owned], [1, 1])
        self.assertEqual(foreign.terminated, 0)
        self.assertEqual(foreign.waited, 0)

    def test_mode_configs_differ_only_by_orchestrator_enabled(self):
        from scripts.direct_vs_orchestrated.runner import build_mode_configs

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            configs = build_mode_configs(
                isolated_home=root / "home",
                workspace=root / "fixture",
                llama_base_url="http://127.0.0.1:19002/v1",
                served_alias="comparison-local",
                llama_server_path=root / "llama-server",
                model_path=root / "model.gguf",
            )

        direct = json.loads(json.dumps(configs["direct"]))
        orchestrated = json.loads(json.dumps(configs["orchestrated"]))
        self.assertNotEqual(direct["orchestrator"]["enabled"], orchestrated["orchestrator"]["enabled"])
        direct["orchestrator"].pop("enabled")
        orchestrated["orchestrator"].pop("enabled")
        self.assertEqual(direct, orchestrated)
        config = configs["direct"]
        self.assertEqual(config["active_backend"], "llama_cpp")
        self.assertEqual(config["llama_cpp"]["base_url"], "http://127.0.0.1:19002/v1")
        self.assertEqual(config["llama_cpp"]["model"], "comparison-local")
        self.assertFalse(config["claude_cli"]["enabled"])
        self.assertFalse(config["orchestrator"]["allow_cloud_helpers"])
        self.assertFalse(config["orchestrator"]["session_memory"]["enabled"])
        self.assertFalse(config["orchestrator"]["conductor_learning"]["enabled"])
        self.assertFalse(config["orchestrator"]["conductor_learning"]["trajectory_export"])
        self.assertFalse(config["orchestrator"]["skill_distillation"]["enabled"])
        self.assertEqual(config["jarvis_path"], str(root / "fixture"))
        self.assertTrue({"web_search", "web_fetch"}.issubset(set(config["tools"]["require_approval"])))

    def test_source_fingerprint_covers_dirty_and_untracked_inputs(self):
        from scripts.direct_vs_orchestrated.runner import source_fingerprint

        git = shutil.which("git")
        self.assertIsNotNone(git)
        with tempfile.TemporaryDirectory() as temp_dir:
            repo = Path(temp_dir)
            subprocess.run([git, "init", "-q"], cwd=repo, check=True)
            subprocess.run([git, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "base"], cwd=repo, check=True)
            tracked = repo / "tracked.py"
            tracked.write_text("value = 1\n", encoding="utf-8")
            subprocess.run([git, "add", "tracked.py"], cwd=repo, check=True)
            subprocess.run([git, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "tracked"], cwd=repo, check=True)
            clean = source_fingerprint(repo)["source_tree_sha256"]
            tracked.write_text("value = 2\n", encoding="utf-8")
            dirty = source_fingerprint(repo)["source_tree_sha256"]
            (repo / "untracked.txt").write_text("new input\n", encoding="utf-8")
            untracked = source_fingerprint(repo)["source_tree_sha256"]

        self.assertNotEqual(clean, dirty)
        self.assertNotEqual(dirty, untracked)

    def test_missing_model_or_binary_hash_refuses_comparability(self):
        from scripts.direct_vs_orchestrated.runner import artifact_sha256

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            binary = root / "llama-server.exe"
            model = root / "model.gguf"
            binary.write_bytes(b"binary")
            self.assertEqual(len(artifact_sha256(binary)), 64)
            with self.assertRaises(FileNotFoundError):
                artifact_sha256(model)
            model.write_bytes(b"gguf")
            self.assertEqual(len(artifact_sha256(model)), 64)
            with self.assertRaises(FileNotFoundError):
                artifact_sha256(root / "missing-server.exe")
    def test_runner_refuses_non_loopback_bun_source_before_spawn(self):
        from scripts.direct_vs_orchestrated.runner import require_bun_loopback_bind

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            server_dir = root / "server-jarvis" / "src"
            server_dir.mkdir(parents=True)
            (server_dir / "index.ts").write_text("const BIND_TARGET = resolveBindTarget(PORT);\n", encoding="utf-8")
            (server_dir / "server-guards.ts").write_text('export const DEFAULT_BIND_HOSTNAME = "0.0.0.0";\n', encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "loopback"):
                require_bun_loopback_bind(root)

            (server_dir / "index.ts").write_text('const BIND_TARGET = resolveBindTarget(PORT, "127.0.0.1");\n', encoding="utf-8")
            self.assertEqual(require_bun_loopback_bind(root), "127.0.0.1")
if __name__ == "__main__":
    unittest.main()
