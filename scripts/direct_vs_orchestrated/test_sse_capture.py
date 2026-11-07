import unittest


def frame(frame_type, received_ms, **fields):
    return {"frame": {"type": frame_type, **fields}, "received_ms": received_ms}


def summarize(events, **kwargs):
    from scripts.direct_vs_orchestrated.sse_capture import summarize_events

    return summarize_events(events, **kwargs)


class SseSummaryTests(unittest.TestCase):
    def test_stream_event_delta_text_starts_first_visible_clock(self):
        observation = summarize([
            frame("stream_event", 12, delta={"text": "Hello"}),
            frame("result", 30, subtype="success", is_error=False, result="Hello", route={"attempts": []}),
        ])
        self.assertEqual(observation["first_visible_ms"], 12)
        self.assertEqual(observation["visible_text"], "Hello")

    def test_reasoning_and_stage_frames_do_not_count_as_visible(self):
        observation = summarize([
            frame("reasoning_chunk", 4, text="private reasoning"),
            frame("orchestrator_stage", 8, stage="planner", text="planning"),
            frame("stage_route", 9, actual_provider="llama_cpp", actual_model="local"),
            frame("stream_event", 11, delta={"type": "thinking_delta", "thinking": "hidden"}),
        ])
        self.assertIsNone(observation["first_visible_ms"])
        self.assertEqual(observation["visible_text"], "")

    def test_message_stop_is_nonterminal_until_result(self):
        observation = summarize([
            frame("message_stop", 12),
            frame("result", 25, subtype="success", is_error=False, result="done"),
        ])
        self.assertEqual(observation["message_stop_ms"], 12)
        self.assertEqual(observation["terminal_ms"], 25)
        self.assertEqual(observation["outcome"], "success")

    def test_result_without_stream_deltas_is_visible_at_result_time(self):
        observation = summarize([
            frame("result", 20, subtype="success", is_error=False, result="aggregate answer"),
        ])
        self.assertEqual(observation["first_visible_ms"], 20)
        self.assertEqual(observation["visible_text"], "aggregate answer")

    def test_result_only_partial_is_visible_at_result_time(self):
        observation = summarize([
            frame("result", 20, subtype="partial", is_error=False, result="partial answer"),
        ])
        self.assertEqual(observation["first_visible_ms"], 20)
        self.assertEqual(observation["visible_text"], "partial answer")
        self.assertEqual(observation["outcome"], "partial")

    def test_error_result_text_is_not_answer_text(self):
        observation = summarize([
            frame("result", 20, subtype="error", is_error=True, result="provider credential failure", code="auth"),
        ])
        self.assertIsNone(observation["first_visible_ms"])
        self.assertEqual(observation["visible_text"], "")
        self.assertEqual(observation["outcome"], "error")

    def test_partial_and_error_result_are_not_success(self):
        partial = summarize([frame("result", 18, subtype="partial", is_error=False, result="unfinished")])
        error = summarize([frame("result", 22, subtype="error", is_error=True, result="failure")])
        self.assertEqual(partial["outcome"], "partial")
        self.assertEqual(error["outcome"], "error")

    def test_cancelled_is_terminal(self):
        observation = summarize([frame("cancelled", 33, reason="user_stop")])
        self.assertEqual(observation["outcome"], "cancelled")
        self.assertEqual(observation["terminal_ms"], 33)
        self.assertEqual(observation["reason"], "user_stop")

    def test_eof_without_terminal_is_transport_failure(self):
        observation = summarize([frame("stream_event", 7, delta={"text": "partial"})])
        self.assertEqual(observation["outcome"], "transport_failure")
        self.assertIsNone(observation["terminal_ms"])

    def test_tool_counts_without_complete_trace_remain_unknown(self):
        observation = summarize([frame("stream_event", 5, delta={"text": "partial"})])
        self.assertIsNone(observation["tool_use_count"])
        self.assertIsNone(observation["tool_result_count"])
        self.assertIsNone(observation["failed_tool_result_count"])
    def test_route_and_metrics_missing_remain_unknown(self):
        observation = summarize([frame("result", 10, subtype="success", is_error=False, result="ok")])
        self.assertIsNone(observation["route_attempts"])
        self.assertIsNone(observation["answered_by"])
        self.assertIsNone(observation["orchestration_metrics"])
        self.assertIsNone(observation["tokens_in"])
        self.assertIsNone(observation["tokens_out"])

    def test_first_visible_terminal_and_delay_use_receipt_timestamps(self):
        observation = summarize([
            frame("stream_event", 41, delta={"text": "A"}),
            frame("stream_event", 58, delta={"text": "B"}),
            frame("message_stop", 81),
            frame("result", 97, subtype="success", is_error=False, result="AB"),
        ])
        self.assertEqual(observation["first_visible_ms"], 41)
        self.assertEqual(observation["last_visible_ms"], 58)
        self.assertEqual(observation["terminal_ms"], 97)
        self.assertEqual(observation["last_visible_to_terminal_ms"], 39)

    def test_total_wall_time_uses_frame_timestamps(self):
        observation = summarize([
            frame("orchestration_metrics", 106, duration_ms=5),
            frame("result", 139, subtype="success", is_error=False, result="ok"),
        ])
        self.assertEqual(observation["total_wall_ms"], 139)


class SseLineParserTests(unittest.TestCase):
    def test_parser_ignores_non_data_sse_lines(self):
        from scripts.direct_vs_orchestrated.sse_capture import parse_sse_data_line

        self.assertIsNone(parse_sse_data_line(": heartbeat"))
        self.assertIsNone(parse_sse_data_line("event: result"))
        self.assertIsNone(parse_sse_data_line("data: not-json"))

    def test_parser_keeps_json_data_object(self):
        from scripts.direct_vs_orchestrated.sse_capture import parse_sse_data_line

        self.assertEqual(parse_sse_data_line('data: {"type":"message_stop"}'), {"type": "message_stop"})


class CaptureTurnTests(unittest.TestCase):
    def test_capture_turn_posts_generation_settings_and_preserves_raw_frames(self):
        import io
        import json
        import tempfile
        from pathlib import Path
        from unittest.mock import patch

        from scripts.direct_vs_orchestrated.sse_capture import capture_turn

        class FakeResponse:
            def __init__(self, payload):
                self.stream = io.BytesIO(payload)

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def readline(self):
                return self.stream.readline()

        payload = (
            b'data: {"type":"stream_event","delta":{"text":"answer"}}\n\n'
            b'data: {"type":"message_stop"}\n\n'
            b'data: {"type":"result","subtype":"success","is_error":false,"result":"answer"}\n\n'
        )
        task = {
            "id": "arithmetic",
            "prompt": "What is 17 plus 25?",
            "max_tokens": 16,
            "temperature": 0,
            "top_p": 1,
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "frames.jsonl"
            with patch("scripts.direct_vs_orchestrated.sse_capture._open_local", return_value=FakeResponse(payload)) as open_url:
                observation = capture_turn(
                    "http://127.0.0.1:19877",
                    session_id="trial-1",
                    task=task,
                    wall_cap_ms=5000,
                    out_path=output_path,
                )

            request = open_url.call_args.args[0]
            body = json.loads(request.data.decode("utf-8"))
            self.assertEqual(request.full_url, "http://127.0.0.1:19877/chat/stream")
            self.assertEqual(body["message"], task["prompt"])
            self.assertEqual(body["session_id"], "trial-1")
            self.assertEqual(body["history"], [])
            self.assertEqual(body["config"], {"max_tokens": 16, "temperature": 0, "top_p": 1})
            self.assertEqual(observation["outcome"], "success")
            records = [json.loads(line) for line in output_path.read_text(encoding="utf-8").splitlines()]
            frames = [record["frame"] for record in records if record["frame"] is not None]
            self.assertEqual([frame["type"] for frame in frames], ["stream_event", "message_stop", "result"])
            self.assertIn('"type":"result"', records[-1]["raw_line"])

    def test_capture_turn_refuses_non_loopback_url(self):
        from pathlib import Path
        from unittest.mock import patch

        from scripts.direct_vs_orchestrated.sse_capture import capture_turn

        with patch("scripts.direct_vs_orchestrated.sse_capture._open_local") as open_url:
            with self.assertRaises(ValueError):
                capture_turn(
                    "https://example.com",
                    session_id="trial-1",
                    task={"id": "x", "prompt": "x", "max_tokens": 1, "temperature": 0, "top_p": 1},
                    wall_cap_ms=1000,
                    out_path=Path("unused.jsonl"),
                )
        open_url.assert_not_called()
class CaptureTimeoutTests(unittest.TestCase):
    def test_capture_timeout_cancels_the_same_session_and_keeps_partial_frames(self):
        import json
        import tempfile
        from pathlib import Path
        from unittest.mock import patch

        from scripts.direct_vs_orchestrated.sse_capture import capture_turn

        class StreamResponse:
            def __init__(self):
                self.lines = iter([
                    b'data: {"type":"stream_event","delta":{"text":"partial"}}\n',
                    TimeoutError("read timed out"),
                ])

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def readline(self):
                value = next(self.lines)
                if isinstance(value, Exception):
                    raise value
                return value

        class CancelResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                return b'{"ok":true,"cancelled":true}'

        requests = []

        def fake_open(request, timeout):
            requests.append(request)
            if request.full_url.endswith("/chat/stream"):
                return StreamResponse()
            return CancelResponse()

        task = {"id": "arithmetic", "prompt": "17 + 25", "max_tokens": 16, "temperature": 0, "top_p": 1}
        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "partial.jsonl"
            with patch("scripts.direct_vs_orchestrated.sse_capture._open_local", side_effect=fake_open):
                observation = capture_turn(
                    "http://127.0.0.1:19877",
                    session_id="session-timeout",
                    task=task,
                    wall_cap_ms=5000,
                    out_path=output_path,
                )
            records = [json.loads(line) for line in output_path.read_text(encoding="utf-8").splitlines()]

        self.assertEqual(observation["outcome"], "timeout")
        self.assertTrue(observation["cancel_confirmed"])
        self.assertEqual(records[0]["frame"]["type"], "stream_event")
        self.assertEqual(requests[1].full_url, "http://127.0.0.1:19877/chat/cancel")
        self.assertEqual(json.loads(requests[1].data.decode("utf-8")), {"session_id": "session-timeout"})
class CaptureWorkerTests(unittest.TestCase):
    def test_worker_loads_task_and_calls_capture_with_explicit_deadline(self):
        import json
        import tempfile
        from pathlib import Path
        from unittest.mock import patch

        from scripts.direct_vs_orchestrated.capture_worker import main

        task = {"id": "arithmetic", "prompt": "17 plus 25", "max_tokens": 16, "temperature": 0, "top_p": 1}
        with tempfile.TemporaryDirectory() as temp_dir:
            task_path = Path(temp_dir) / "task.json"
            output_path = Path(temp_dir) / "capture.jsonl"
            task_path.write_text(json.dumps(task), encoding="utf-8")
            expected = {"outcome": "success", "terminal_ms": 10, "total_wall_ms": 10}
            with patch("scripts.direct_vs_orchestrated.capture_worker.capture_turn", return_value=expected) as capture:
                status = main([
                    "--base-url", "http://127.0.0.1:19877",
                    "--session-id", "session-1",
                    "--task-json", str(task_path),
                    "--out", str(output_path),
                    "--wall-cap-ms", "4500",
                ])

        self.assertEqual(status, 0)
        capture.assert_called_once_with(
            "http://127.0.0.1:19877",
            session_id="session-1",
            task=task,
            wall_cap_ms=4500,
            out_path=output_path,
        )

    def test_worker_exits_nonzero_for_transport_failure(self):
        import contextlib
        import io
        import json
        import tempfile
        from pathlib import Path
        from unittest.mock import patch

        from scripts.direct_vs_orchestrated.capture_worker import main

        with tempfile.TemporaryDirectory() as temp_dir:
            task_path = Path(temp_dir) / "task.json"
            task_path.write_text(json.dumps({"id": "x", "prompt": "x"}), encoding="utf-8")
            with patch("scripts.direct_vs_orchestrated.capture_worker.capture_turn", return_value={"outcome": "transport_failure"}):
                with contextlib.redirect_stdout(io.StringIO()):
                    status = main([
                        "--base-url", "http://127.0.0.1:19877",
                        "--session-id", "s",
                        "--task-json", str(task_path),
                        "--out", str(Path(temp_dir) / "out.jsonl"),
                        "--wall-cap-ms", "1000",
                    ])
        self.assertNotEqual(status, 0)


class LoopbackRedirectTests(unittest.TestCase):
    def test_capture_does_not_follow_redirect_out_of_isolated_server(self):
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from pathlib import Path
        import tempfile

        from scripts.direct_vs_orchestrated.sse_capture import capture_turn

        redirected_request_seen = threading.Event()

        class SinkHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                redirected_request_seen.set()
                self.send_response(204)
                self.end_headers()

            def do_POST(self):
                redirected_request_seen.set()
                self.send_response(204)
                self.end_headers()

            def log_message(self, *_args):
                pass

        sink = ThreadingHTTPServer(("127.0.0.1", 0), SinkHandler)
        sink_thread = threading.Thread(target=sink.serve_forever, daemon=True)
        sink_thread.start()
        sink_url = f"http://127.0.0.1:{sink.server_port}/sink"

        class RedirectHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(302)
                self.send_header("Location", sink_url)
                self.end_headers()

            def log_message(self, *_args):
                pass

        redirect = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
        redirect_thread = threading.Thread(target=redirect.serve_forever, daemon=True)
        redirect_thread.start()
        task = {"id": "x", "prompt": "x", "max_tokens": 1, "temperature": 0, "top_p": 1}
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                observation = capture_turn(
                    f"http://127.0.0.1:{redirect.server_port}",
                    session_id="redirect-test",
                    task=task,
                    wall_cap_ms=1000,
                    out_path=Path(temp_dir) / "redirect.jsonl",
                )
            self.assertEqual(observation["outcome"], "transport_failure")
            self.assertFalse(redirected_request_seen.wait(0.1))
        finally:
            redirect.shutdown()
            redirect.server_close()
            sink.shutdown()
            sink.server_close()
            redirect_thread.join(timeout=2)
            sink_thread.join(timeout=2)
class RedirectHandlerTests(unittest.TestCase):
    def test_rejected_redirect_closes_the_response_body(self):
        import urllib.error
        import urllib.request

        from scripts.direct_vs_orchestrated.sse_capture import _RejectRedirectHandler

        class ClosableResponse:
            closed = False

            def close(self):
                self.closed = True

        response = ClosableResponse()
        request = urllib.request.Request("http://127.0.0.1:19877/chat/stream")
        handler = _RejectRedirectHandler()
        with self.assertRaises(urllib.error.URLError) as raised:
            handler.redirect_request(request, response, 302, "Found", {}, "http://127.0.0.1:19878/next")
        self.assertTrue(response.closed)
        self.assertIs(type(raised.exception), urllib.error.URLError)
class RouteObservationTests(unittest.TestCase):
    def test_live_route_attempt_survives_empty_terminal_attempt_summary(self):
        attempt = {
            "stage": "agent_loop",
            "provider": "llama_cpp",
            "model": "local-alias",
            "outcome": "success",
            "answered": True,
            "cloud": False,
        }
        live_attempt = {"type": "route_attempt", **attempt}
        answer = {"stage": "agent_loop", "provider": "llama_cpp", "model": "local-alias", "cloud": False}
        observation = summarize([
            frame("route_attempt", 9, **attempt),
            frame("orchestration_metrics", 10, actual_provider="llama_cpp", actual_model="local-alias", tokens_in=5, tokens_out=7),
            frame("result", 15, subtype="success", is_error=False, result="ok", route={"answered_by": answer, "attempts": []}),
        ])
        self.assertEqual(observation["route_attempts"], [live_attempt])
        self.assertEqual(observation["answered_by"], answer)
        self.assertEqual(observation["direct_path_route_attribution"], [live_attempt])
        self.assertEqual(observation["tokens_in"], 5)
        self.assertEqual(observation["tokens_out"], 7)


class ProxyHandlerTests(unittest.TestCase):
    def test_local_opener_bypasses_proxy_environment(self):
        import urllib.request
        from types import SimpleNamespace
        from unittest.mock import Mock, patch

        from scripts.direct_vs_orchestrated.sse_capture import _open_local

        opener = SimpleNamespace(open=Mock(return_value="response"))
        request = urllib.request.Request("http://127.0.0.1:19877/chat/stream")
        with patch("scripts.direct_vs_orchestrated.sse_capture.urllib.request.build_opener", return_value=opener) as build_opener:
            self.assertEqual(_open_local(request, timeout=1.0), "response")

        proxy_handlers = [handler for handler in build_opener.call_args.args if isinstance(handler, urllib.request.ProxyHandler)]
        self.assertEqual(len(proxy_handlers), 1)
        self.assertEqual(proxy_handlers[0].proxies, {})
if __name__ == "__main__":
    unittest.main()