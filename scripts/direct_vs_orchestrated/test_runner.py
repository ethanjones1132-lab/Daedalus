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
    def test_warm_schedule_has_three_pairs_per_task_and_counterbalances_order(self):
        from scripts.direct_vs_orchestrated.runner import build_trial_schedule

        schedule = build_trial_schedule(load_tasks())
        warm = [trial for trial in schedule if trial["phase"] == "warm"]
        self.assertEqual(len(warm), 24)
        for task in load_tasks():
            task_trials = [trial for trial in warm if trial["task_id"] == task["id"]]
            pairs = {}
            for trial in task_trials:
                pairs.setdefault(trial["pair_id"], []).append(trial)
            self.assertEqual(len(pairs), 3)
            orders = []
            for pair in sorted(pairs.values(), key=lambda group: group[0]["order_index"]):
                orders.append(pair[0]["pair_order"])
                expected_modes = ["direct", "orchestrated"] if pair[0]["pair_order"] == "direct_then_orchestrated" else ["orchestrated", "direct"]
                self.assertEqual([trial["mode"] for trial in pair], expected_modes)
            self.assertEqual(orders, ["direct_then_orchestrated", "orchestrated_then_direct", "direct_then_orchestrated"])

    def test_cold_start_observations_are_separate_from_warm_pairs(self):
        from scripts.direct_vs_orchestrated.runner import build_trial_schedule

        schedule = build_trial_schedule(load_tasks())
        cold = [trial for trial in schedule if trial["phase"] == "process_cold"]
        warmups = [trial for trial in schedule if trial["phase"] == "warmup"]
        warm = [trial for trial in schedule if trial["phase"] == "warm"]
        self.assertEqual([(trial["mode"], trial["task_id"]) for trial in cold], [
            ("direct", "arithmetic"), ("orchestrated", "arithmetic"),
        ])
        self.assertEqual(len(warm), 24)
        self.assertEqual(len(warmups), 2)
        self.assertTrue(all(not trial["reported"] for trial in warmups))
        self.assertTrue(all(trial["pair_id"] is None for trial in cold))
        self.assertTrue(all(trial["reported"] for trial in cold + warm))

    def test_cold_means_llama_process_and_kv_cold_not_os_cache_cold(self):
        from scripts.direct_vs_orchestrated.runner import cold_observation_metadata

        metadata = cold_observation_metadata(model_ready_ms=1400, first_output_ms=8200)
        self.assertEqual(metadata["cold_label"], "process-cold")
        self.assertEqual(metadata["cold_state"], "llama_process_and_kv")
        self.assertFalse(metadata["os_page_cache_cold"])
        self.assertFalse(metadata["whole_machine_cold"])
        self.assertEqual(metadata["model_process_ready_ms"], 1400)
        self.assertEqual(metadata["first_output_ms"], 8200)

    def test_failed_timeout_and_blocked_trials_are_retained(self):
        from scripts.direct_vs_orchestrated.runner import run_trial_schedule

        schedule = [{"observation_id": f"trial-{index}"} for index in range(4)]
        outcomes = iter([
            {"outcome": "error"},
            {"outcome": "timeout", "cancel_confirmed": True},
            {"outcome": "blocked", "stop_campaign": True, "safety_reasons": ["web_tool_attempt"]},
            {"outcome": "success"},
        ])
        seen = []

        records = run_trial_schedule(schedule, lambda trial: (seen.append(trial["observation_id"]), next(outcomes))[1])

        self.assertEqual([record["outcome"] for record in records], ["error", "timeout", "blocked"])
        self.assertEqual(seen, ["trial-0", "trial-1", "trial-2"])
        self.assertEqual(records[2]["safety_reasons"], ["web_tool_attempt"])

    def test_direct_and_orchestrated_attempts_have_observed_local_route_attribution(self):
        from scripts.direct_vs_orchestrated.runner import validate_trial_safety

        with tempfile.TemporaryDirectory() as temp_dir:
            fixture = Path(temp_dir) / "stock.csv"
            fixture.write_text("name,quantity\nbeans,14\n", encoding="utf-8")
            import hashlib

            digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
            for mode, attribution in (
                ("direct", {"route_attempts": [{"provider": "llama_cpp", "model": "alias", "cloud": False}]}),
                ("orchestrated", {"stage_routes": [{"actual_provider": "llama_cpp", "actual_model": "alias", "cloud": False}]}),
            ):
                observation = {"mode": mode, **attribution, "fixture_sha256_before": digest, "fixture_sha256_after": digest}
                with self.subTest(mode=mode):
                    self.assertEqual(validate_trial_safety(observation, served_alias="alias", fixture_root=fixture.parent, fixture_sha256=digest), [])

    def test_observed_alias_matches_for_every_attempt(self):
        from scripts.direct_vs_orchestrated.runner import validate_trial_safety

        with tempfile.TemporaryDirectory() as temp_dir:
            fixture = Path(temp_dir) / "stock.csv"
            fixture.write_text("fixture\n", encoding="utf-8")
            import hashlib

            digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
            observation = {
                "route_attempts": [
                    {"provider": "llama_cpp", "model": "alias", "cloud": False},
                    {"provider": "llama_cpp", "model": "unexpected", "cloud": False},
                ],
                "fixture_sha256_before": digest,
                "fixture_sha256_after": digest,
            }
            self.assertIn("unexpected_alias", validate_trial_safety(observation, served_alias="alias", fixture_root=fixture.parent, fixture_sha256=digest))

    def test_fixture_hash_is_checked_before_and_after_each_tool_trial(self):
        import hashlib

        from scripts.direct_vs_orchestrated.runner import capture_trial

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fixture = root / "stock.csv"
            fixture.write_text("name,quantity\nbeans,14\n", encoding="utf-8")
            original_hash = hashlib.sha256(fixture.read_bytes()).hexdigest()

            def mutate_fixture(**_kwargs):
                fixture.write_text("name,quantity\nbeans,0\n", encoding="utf-8")
                return {"outcome": "success", "route_attempts": [{"provider": "llama_cpp", "model": "alias", "cloud": False}], "tool_use_frames": [{"id": "r1", "name": "read_file", "input": {"path": "stock.csv"}}], "tool_result_frames": [{"call_id": "r1", "name": "read_file", "is_error": False}]}

            record = capture_trial(
                {"observation_id": "tool-trial", "phase": "warm", "mode": "direct", "task_id": "fixture_tool_read"},
                load_tasks()[2],
                base_url="http://127.0.0.1:19004",
                fixture_path=fixture,
                fixture_root=root,
                fixture_sha256=original_hash,
                out_path=root / "capture.jsonl",
                served_alias="alias",
                worker=mutate_fixture,
            )

            self.assertEqual(record["fixture_sha256_before"], original_hash)
            self.assertNotEqual(record["fixture_sha256_after"], original_hash)
            self.assertIn("fixture_mutated", record["safety_reasons"])
            self.assertTrue(record["stop_campaign"])

    def test_no_session_or_fixture_state_is_reused_between_observations(self):
        import hashlib

        from scripts.direct_vs_orchestrated.runner import capture_trial

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fixture = root / "stock.csv"
            fixture.write_text("fixture\n", encoding="utf-8")
            digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
            seen = []

            def worker(**kwargs):
                seen.append(kwargs["session_id"])
                return {"outcome": "success", "route_attempts": [{"provider": "llama_cpp", "model": "alias", "cloud": False}]}

            records = [
                capture_trial(
                    {"observation_id": f"trial-{index}", "phase": "warm", "mode": "direct", "task_id": "arithmetic"},
                    load_tasks()[0],
                    base_url="http://127.0.0.1:19005",
                    fixture_path=fixture,
                    fixture_root=root,
                    fixture_sha256=digest,
                    out_path=root / f"{index}.jsonl",
                    served_alias="alias",
                    worker=worker,
                )
                for index in range(2)
            ]

            self.assertNotEqual(seen[0], seen[1])
            self.assertEqual([record["fixture_sha256_before"] for record in records], [digest, digest])
            self.assertEqual([record["fixture_sha256_after"] for record in records], [digest, digest])
            self.assertEqual([record["history_reset"] for record in records], [True, True])

    def test_fixture_baseline_mismatch_blocks_before_capture_worker_starts(self):
        import hashlib

        from scripts.direct_vs_orchestrated.runner import capture_trial

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fixture = root / "stock.csv"
            fixture.write_text("mutated\n", encoding="utf-8")
            current_hash = hashlib.sha256(fixture.read_bytes()).hexdigest()
            worker_calls = []
            record = capture_trial(
                {"observation_id": "trial-before", "phase": "warm", "mode": "direct", "task_id": "fixture_tool_read"},
                load_tasks()[2],
                base_url="http://127.0.0.1:19008",
                fixture_path=fixture,
                fixture_root=root,
                fixture_sha256="frozen-baseline",
                out_path=root / "capture.jsonl",
                served_alias="alias",
                worker=lambda **kwargs: worker_calls.append(kwargs),
            )

        self.assertEqual(record["outcome"], "blocked")
        self.assertEqual(record["fixture_sha256_before"], current_hash)
        self.assertIn("fixture_baseline_mismatch", record["safety_reasons"])
        self.assertTrue(record["stop_campaign"])
        self.assertEqual(worker_calls, [])

    def test_exact_and_fixture_acceptance_are_scored_mechanically(self):
        import hashlib

        from scripts.direct_vs_orchestrated.runner import evaluate_acceptance

        arithmetic = evaluate_acceptance(
            load_tasks()[0],
            {"observation_id": "cold-1", "visible_text": "42"},
            fixture_sha256_before=None,
            fixture_sha256_after=None,
        )
        self.assertEqual(arithmetic["mechanical_results"][0]["status"], "pass")

        fixture_task = load_tasks()[2]
        digest = hashlib.sha256(FIXTURE_PATH.read_bytes()).hexdigest()
        fixture = evaluate_acceptance(
            fixture_task,
            {
                "observation_id": "fixture-1",
                "visible_text": "beans: 14",
                "tool_use_frames": [{"id": "read-1", "name": "read_file"}],
                "tool_result_frames": [{"call_id": "read-1", "is_error": False}],
            },
            fixture_sha256_before=digest,
            fixture_sha256_after=digest,
            expected_fixture_sha256=digest,
        )
        self.assertEqual([result["status"] for result in fixture["mechanical_results"]], ["pass", "pass", "pass", "pass"])

    def test_fixture_read_acceptance_is_unknown_when_tool_call_ids_are_missing(self):
        import hashlib

        from scripts.direct_vs_orchestrated.runner import evaluate_acceptance

        fixture_task = load_tasks()[2]
        digest = hashlib.sha256(FIXTURE_PATH.read_bytes()).hexdigest()
        result = evaluate_acceptance(
            fixture_task,
            {
                "observation_id": "fixture-missing-ids",
                "visible_text": "beans: 14",
                "tool_use_frames": [{"name": "read_file"}],
                "tool_result_frames": [{"name": "read_file", "is_error": False}],
            },
            fixture_sha256_before=digest,
            fixture_sha256_after=digest,
            expected_fixture_sha256=digest,
        )

        successful_read = next(row for row in result["mechanical_results"] if row["criterion_id"] == "successful_read_file")
        self.assertEqual(successful_read["status"], "unknown")

    def test_missing_tool_call_ids_fail_trace_safety_check(self):
        import hashlib
        import tempfile

        from scripts.direct_vs_orchestrated.runner import validate_trial_safety

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fixture = root / "stock.csv"
            fixture.write_text("fixture\n", encoding="utf-8")
            digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
            reasons = validate_trial_safety(
                {
                    "route_attempts": [{"provider": "llama_cpp", "model": "alias", "cloud": False}],
                    "tool_use_frames": [{"name": "read_file"}],
                    "tool_result_frames": [{"name": "read_file", "is_error": False}],
                    "fixture_sha256_before": digest,
                    "fixture_sha256_after": digest,
                },
                served_alias="alias",
                fixture_root=root,
                fixture_sha256=digest,
            )

        self.assertIn("tool_trace_identity_missing", reasons)

    def test_duplicate_tool_call_ids_are_unknown_and_fail_trace_safety_check(self):
        import hashlib
        import tempfile

        from scripts.direct_vs_orchestrated.runner import evaluate_acceptance, validate_trial_safety

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fixture = root / "stock.csv"
            fixture.write_text("fixture\n", encoding="utf-8")
            digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
            observation = {
                "observation_id": "fixture-duplicate-ids",
                "visible_text": "beans: 14",
                "route_attempts": [{"provider": "llama_cpp", "model": "alias", "cloud": False}],
                "tool_use_frames": [
                    {"id": "duplicate", "name": "read_file"},
                    {"id": "duplicate", "name": "unknown_tool"},
                ],
                "tool_result_frames": [
                    {"call_id": "duplicate", "is_error": False},
                    {"call_id": "duplicate", "is_error": False},
                ],
                "fixture_sha256_before": digest,
                "fixture_sha256_after": digest,
            }
            acceptance = evaluate_acceptance(
                load_tasks()[2],
                observation,
                fixture_sha256_before=digest,
                fixture_sha256_after=digest,
                expected_fixture_sha256=digest,
            )
            reasons = validate_trial_safety(
                observation,
                served_alias="alias",
                fixture_root=root,
                fixture_sha256=digest,
            )

        successful_read = next(row for row in acceptance["mechanical_results"] if row["criterion_id"] == "successful_read_file")
        self.assertEqual(successful_read["status"], "unknown")
        self.assertIn("tool_trace_identity_duplicate", reasons)

    def test_web_tool_and_escaped_fixture_path_stop_the_campaign(self):
        import hashlib

        from scripts.direct_vs_orchestrated.runner import validate_trial_safety

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fixture = root / "stock.csv"
            fixture.write_text("fixture\n", encoding="utf-8")
            digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
            observation = {
                "route_attempts": [{"provider": "llama_cpp", "model": "alias", "cloud": False}],
                "tool_use_frames": [
                    {"id": "web", "name": "web_fetch", "input": {"url": "https://example.invalid"}},
                    {"id": "read", "name": "read_file", "input": {"path": "..\\outside.txt"}},
                ],
                "fixture_sha256_before": digest,
                "fixture_sha256_after": digest,
            }
            reasons = validate_trial_safety(observation, served_alias="alias", fixture_root=root, fixture_sha256=digest)

            self.assertIn("web_tool_attempt", reasons)
            self.assertIn("escaped_tool_path", reasons)

    def test_subjective_acceptance_stays_pending_with_blind_labels(self):
        from scripts.direct_vs_orchestrated.runner import evaluate_acceptance

        task = load_tasks()[1]
        observation = {"observation_id": "pair-1-code", "mode": "orchestrated", "pair_order": "orchestrated_then_direct", "visible_text": "A list comprehension maps values. Example: [x*x for x in range(5)]."}
        results = evaluate_acceptance(task, observation, fixture_sha256_before="same", fixture_sha256_after="same")
        self.assertTrue(all(result["score"] == "pending" for result in results["rubric_results"]))
        self.assertTrue(all(result["reviewer"]["type"] == "pending" for result in results["rubric_results"]))
        self.assertTrue(all("blind_label" in result and "mode" not in result for result in results["rubric_results"]))

    def test_capture_worker_deadline_includes_spawn_and_caps_cancel_settlement(self):
        from unittest.mock import patch

        from scripts.direct_vs_orchestrated import runner

        class TimedOutWorker:
            pid = 321
            returncode = None

            def __init__(self):
                self.timeouts = []

            def communicate(self, timeout=None):
                self.timeouts.append(timeout)
                if len(self.timeouts) < 3:
                    raise subprocess.TimeoutExpired(["capture-worker"], timeout)
                return (b"", None)

            def poll(self):
                return self.returncode

            def terminate(self):
                self.returncode = -15

            def kill(self):
                self.returncode = -9

            def wait(self, timeout=None):
                return self.returncode

        process = TimedOutWorker()

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with patch.object(runner.time, "monotonic", side_effect=[100.0, 221.0, 222.0, 222.0, 222.0]):
                with patch.object(runner, "_cancel_session", return_value=True) as cancel:
                    result = runner._run_capture_worker(
                        base_url="http://127.0.0.1:19006",
                        session_id="session-timeout",
                        task=load_tasks()[0],
                        wall_cap_ms=120_000,
                        out_path=root / "capture.jsonl",
                        worker_home=root / "home",
                        port=19007,
                        workspace=root / "fixture",
                        repo_root=root,
                        popen_factory=lambda *_args, **_kwargs: process,
                    )

        self.assertEqual(process.timeouts[0], 0.0)
        self.assertEqual(process.timeouts[1], 5.0)
        cancel.assert_called_once_with("http://127.0.0.1:19006", "session-timeout", deadline_mono=227.0)
        self.assertEqual(result["outcome"], "timeout")
        self.assertTrue(result["cancel_confirmed"])
        self.assertFalse(result["capture_worker_settled"])
        self.assertTrue(result["stop_campaign"])
        self.assertEqual(result["capture_worker_wall_ms"], 122_000.0)

    def test_campaign_restarts_only_owned_llama_between_cold_modes_and_runs_full_schedule(self):
        from unittest.mock import patch

        from scripts.direct_vs_orchestrated import runner

        class FakeProcess:
            next_pid = 700

            def __init__(self, command, kwargs):
                self.pid = FakeProcess.next_pid
                FakeProcess.next_pid += 1
                self.command = command
                self.kwargs = kwargs
                self.returncode = None
                self.role = "llama" if "llama-server" in str(command[0]).lower() else "bun"

            def poll(self):
                return self.returncode

            def terminate(self):
                events.append(("stop", self.role, self.pid))
                self.returncode = -15

            def kill(self):
                self.returncode = -9

            def wait(self, timeout=None):
                return self.returncode

        events = []
        processes = []

        def spawn(command, **kwargs):
            process = FakeProcess(command, kwargs)
            processes.append(process)
            events.append(("spawn", process.role, process.pid))
            return process

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            out_dir = root / "out"
            out_dir.mkdir()
            fixture_dir = out_dir / "fixture"
            fixture_dir.mkdir()
            fixture = fixture_dir / "stock.csv"
            fixture.write_bytes(FIXTURE_PATH.read_bytes())
            digest = runner.artifact_sha256(fixture)
            homes = out_dir / "homes"
            for mode in ("model", "direct", "orchestrated"):
                (homes / mode).mkdir(parents=True)
            ports = {}
            while len(set(ports.values())) != 3:
                ports = {name: runner.allocate_loopback_port() for name in ("llama_cpp", "direct", "orchestrated")}
            runner.ensure_loopback_ports_free(list(ports.values()))
            model_url = f"http://127.0.0.1:{ports['llama_cpp']}/v1"
            configs = runner.build_mode_configs(
                isolated_home=homes,
                workspace=fixture_dir,
                llama_base_url=model_url,
                served_alias="alias",
                llama_server_path=root / "llama-server.exe",
                model_path=root / "model.gguf",
            )
            schedule = runner.build_trial_schedule(load_tasks())
            manifest = {"processes": [], "readiness": []}
            manifest_path = out_dir / "manifest.json"
            manifest_path.write_text("{}\n", encoding="utf-8")
            trial_events = []

            def fake_capture(trial, task, **_kwargs):
                events.append(("trial", trial["phase"], trial["mode"], trial["observation_id"]))
                trial_events.append((trial["phase"], trial["mode"], trial["task_id"]))
                return {
                    **trial,
                    "outcome": "success",
                    "trial_status": "success",
                    "safety_reasons": [],
                    "stop_campaign": False,
                    "visible_text": "42" if task["id"] == "arithmetic" else "example answer",
                    "first_visible_ms": 12,
                    "route_attempts": [{"provider": "llama_cpp", "model": "alias", "cloud": False}],
                    "fixture_sha256_before": digest,
                    "fixture_sha256_after": digest,
                    "tool_use_frames": [],
                    "tool_result_frames": [],
                }

            def fake_readiness(url, _process, **kwargs):
                parsed = runner.urllib.parse.urlsplit(url)
                if parsed.path == "/v1/models":
                    return {"data": [{"id": kwargs["expected_alias"]}]}
                if parsed.path == "/health" and parsed.port == ports["llama_cpp"]:
                    return {"status": "ok"}
                if parsed.path == "/health":
                    return {"ok": True, "backend": "llama_cpp", "configured_model": "alias"}
                mode = "direct" if parsed.port == ports["direct"] else "orchestrated"
                return configs[mode]

            with patch.object(runner, "capture_trial", side_effect=fake_capture):
                with patch.object(runner, "_wait_for_json", side_effect=fake_readiness):
                    runner._execute_campaign(
                        out_dir=out_dir,
                        manifest=manifest,
                        manifest_path=manifest_path,
                        tasks=load_tasks(),
                        configs=configs,
                        llama_argv=["llama-server.exe", "--host", "127.0.0.1"],
                        bun_path=root / "bun.exe",
                        repo_root=root,
                        homes=homes,
                        fixture_dir=fixture_dir,
                        fixture_path=fixture,
                        fixture_sha=digest,
                        ports=ports,
                        served_alias="alias",
                        model_url=model_url,
                        popen_factory=spawn,
                    )

        self.assertEqual(manifest["run_status"], "complete")
        self.assertEqual(len(manifest["observations"]), 28)
        self.assertEqual(len([trial for trial in trial_events if trial[0] == "warm"]), 24)
        model_spawns = [event for event in events if event[:2] == ("spawn", "llama")]
        self.assertEqual(len(model_spawns), 2)
        direct_trial_index = next(i for i, event in enumerate(events) if event[0] == "trial" and event[1:3] == ("process_cold", "direct"))
        model_stop_index = next(i for i, event in enumerate(events) if event[:2] == ("stop", "llama"))
        second_model_spawn_index = events.index(model_spawns[1])
        orchestrated_trial_index = next(i for i, event in enumerate(events) if event[0] == "trial" and event[1:3] == ("process_cold", "orchestrated"))
        self.assertLess(direct_trial_index, model_stop_index)
        self.assertLess(model_stop_index, second_model_spawn_index)
        self.assertLess(second_model_spawn_index, orchestrated_trial_index)
        self.assertEqual({process.role for process in processes}, {"llama", "bun"})
        self.assertTrue(all(process.returncode is not None for process in processes))

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
        from types import SimpleNamespace
        from unittest.mock import patch

        from scripts.direct_vs_orchestrated import runner

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            server_dir = root / "server-jarvis" / "src"
            server_dir.mkdir(parents=True)
            (server_dir / "index.ts").write_text("const BIND_TARGET = resolveBindTarget(PORT);\n", encoding="utf-8")
            (server_dir / "server-guards.ts").write_text('export const DEFAULT_BIND_HOSTNAME = "0.0.0.0";\n', encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "loopback"):
                runner.require_bun_loopback_bind(root)

            out_dir = root / "comparison-output"
            args = SimpleNamespace(
                llama_server=root / "llama-server.exe",
                model=root / "model.gguf",
                out_dir=out_dir,
                bun=root / "bun.exe",
                served_alias="alias",
                llama_arg=[],
            )
            with patch.object(runner, "REPO_ROOT", root), patch.object(runner.subprocess, "Popen") as spawn:
                with self.assertRaisesRegex(RuntimeError, "loopback"):
                    runner.run_comparison(args)
            spawn.assert_not_called()
            self.assertFalse(out_dir.exists())

            (server_dir / "index.ts").write_text('const BIND_TARGET = resolveBindTarget(PORT, "127.0.0.1");\n', encoding="utf-8")
            self.assertEqual(runner.require_bun_loopback_bind(root), "127.0.0.1")
if __name__ == "__main__":
    unittest.main()
