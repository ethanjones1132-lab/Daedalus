"""Unit checks for per-request delegate_request_id correlation in claude_cli_proxy.

Run: python scripts/test_claude_cli_proxy_correlation.py
"""
from __future__ import annotations

import logging
import os
import sys
import unittest
import urllib.error
import urllib.request
from io import StringIO
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import claude_cli_proxy as p  # noqa: E402


class DelegateRequestIdCorrelationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._prev = os.environ.get("JARVIS_DELEGATE_REQUEST_ID")
        os.environ.pop("JARVIS_DELEGATE_REQUEST_ID", None)

    def tearDown(self) -> None:
        if self._prev is None:
            os.environ.pop("JARVIS_DELEGATE_REQUEST_ID", None)
        else:
            os.environ["JARVIS_DELEGATE_REQUEST_ID"] = self._prev

    def test_missing_when_env_and_headers_unset(self) -> None:
        self.assertEqual(p.get_delegate_request_id(), "missing")
        self.assertEqual(p.delegate_correlation_field(), "delegate_request_id=missing")

    def test_header_wins_over_env_for_long_lived_proxy(self) -> None:
        # Production path: Claude CLI sets X-Jarvis-Delegate-Request-Id per request.
        # Process env must not freeze or override a different concurrent request.
        os.environ["JARVIS_DELEGATE_REQUEST_ID"] = "env-stale-id"
        headers_a = {p.DELEGATE_REQUEST_ID_HEADER: "req-from-header-aaa"}
        headers_b = {p.DELEGATE_REQUEST_ID_HEADER.lower(): "req-from-header-bbb"}
        self.assertEqual(p.get_delegate_request_id(headers_a), "req-from-header-aaa")
        self.assertEqual(p.get_delegate_request_id(headers_b), "req-from-header-bbb")
        self.assertEqual(
            p.delegate_correlation_field(headers_a),
            "delegate_request_id=req-from-header-aaa",
        )

    def test_env_is_fallback_and_re_read_each_call(self) -> None:
        # Env is a test/same-process fallback only — re-read, not process-cached.
        os.environ["JARVIS_DELEGATE_REQUEST_ID"] = "req-corr-abc"
        self.assertEqual(p.get_delegate_request_id(), "req-corr-abc")
        os.environ["JARVIS_DELEGATE_REQUEST_ID"] = "req-other"
        self.assertEqual(p.get_delegate_request_id(), "req-other")
        self.assertEqual(p.delegate_correlation_field(), "delegate_request_id=req-other")

    def test_rejects_auth_like_and_oversized_ids(self) -> None:
        self.assertEqual(
            p.get_delegate_request_id({"X-Jarvis-Delegate-Request-Id": "Bearer secret-token"}),
            "missing",
        )
        self.assertEqual(
            p.get_delegate_request_id({"X-Jarvis-Delegate-Request-Id": "x" * 200}),
            "missing",
        )
        self.assertEqual(p.sanitize_delegate_request_id("not spaces ok"), "")

    def test_request_start_log_includes_correlation_not_auth_header(self) -> None:
        stream = StringIO()
        handler = logging.StreamHandler(stream)
        handler.setLevel(logging.INFO)
        logger = logging.getLogger("jarvis.claude_cli_proxy")
        prev_level = logger.level
        logger.setLevel(logging.INFO)
        logger.addHandler(handler)
        try:
            # Simulate the start/result/error log shapes used by Handler.do_POST.
            correlation = p.delegate_correlation_field(
                {p.DELEGATE_REQUEST_ID_HEADER: "req-log-xyz"},
            )
            fake_auth = "Authorization: Bearer secret-value-must-not-appear"
            p.LOG.info("request start model=%s %s", "qwen3:8b", correlation)
            p.LOG.info("upstream result status=200 %s", correlation)
            p.LOG.error("Upstream API Error %s: %s", correlation, "connection refused")
            # Auth headers must never be logged via the correlation path.
            text = stream.getvalue()
            self.assertIn("delegate_request_id=req-log-xyz", text)
            self.assertIn("request start", text)
            self.assertIn("upstream result", text)
            self.assertIn("Upstream API Error", text)
            self.assertNotIn("secret-value-must-not-appear", text)
            self.assertNotIn(fake_auth, text)
            self.assertNotIn("Bearer secret", text)
        finally:
            logger.removeHandler(handler)
            logger.setLevel(prev_level)

    def test_correlation_field_does_not_echo_authorization_env(self) -> None:
        # Even if a caller pollutes the env with a bearer string, the field is
        # only the request id (or missing) — never a free-form secret blob.
        os.environ["JARVIS_DELEGATE_REQUEST_ID"] = "req-safe"
        field = p.delegate_correlation_field()
        self.assertEqual(field, "delegate_request_id=req-safe")
        self.assertNotIn("Bearer", field)
        self.assertNotIn("Authorization", field)
        os.environ["JARVIS_DELEGATE_REQUEST_ID"] = "Bearer secret-value"
        self.assertEqual(p.delegate_correlation_field(), "delegate_request_id=missing")


class TransportRetryTests(unittest.TestCase):
    """run_8e930248: TCP reset after upstream accept must not kill the delegate."""

    def test_is_transport_error_connection_reset(self) -> None:
        self.assertTrue(p.is_transport_error(ConnectionResetError(10054, "forcibly closed")))
        self.assertTrue(p.is_transport_error(TimeoutError("timed out")))
        self.assertTrue(p.is_transport_error(urllib.error.URLError(ConnectionResetError())))

    def test_is_transport_error_rejects_http_error(self) -> None:
        http_err = urllib.error.HTTPError(
            "http://example", 400, "Bad Request", hdrs={}, fp=StringIO(""),
        )
        self.assertFalse(p.is_transport_error(http_err))

    def test_open_retries_connection_reset_then_succeeds(self) -> None:
        sleeps: list[float] = []
        calls = {"n": 0}
        sentinel = object()

        def fake_urlopen(req, timeout=None):  # noqa: ANN001
            calls["n"] += 1
            if calls["n"] == 1:
                raise ConnectionResetError(10054, "connection forcibly closed by remote host")
            return sentinel

        result = p.open_upstream_with_retry(
            urllib.request.Request("http://127.0.0.1/unused"),
            attempts=3,
            backoff_s=0.01,
            sleep_fn=sleeps.append,
            urlopen_fn=fake_urlopen,
        )
        self.assertIs(result, sentinel)
        self.assertEqual(calls["n"], 2)
        self.assertEqual(len(sleeps), 1)

    def test_open_does_not_retry_http_400(self) -> None:
        calls = {"n": 0}

        def fake_urlopen(req, timeout=None):  # noqa: ANN001
            calls["n"] += 1
            raise urllib.error.HTTPError(
                "http://example", 400, "Bad Request", hdrs={}, fp=StringIO(""),
            )

        with self.assertRaises(urllib.error.HTTPError):
            p.open_upstream_with_retry(
                urllib.request.Request("http://127.0.0.1/unused"),
                attempts=3,
                backoff_s=0.01,
                sleep_fn=lambda _s: None,
                urlopen_fn=fake_urlopen,
            )
        self.assertEqual(calls["n"], 1)

    def test_open_does_not_retry_after_exhausted_attempts(self) -> None:
        calls = {"n": 0}

        def fake_urlopen(req, timeout=None):  # noqa: ANN001
            calls["n"] += 1
            raise ConnectionResetError("reset")

        with self.assertRaises(ConnectionResetError):
            p.open_upstream_with_retry(
                urllib.request.Request("http://127.0.0.1/unused"),
                attempts=2,
                backoff_s=0.01,
                sleep_fn=lambda _s: None,
                urlopen_fn=fake_urlopen,
            )
        self.assertEqual(calls["n"], 2)


if __name__ == "__main__":
    unittest.main()
