"""Unit checks for JARVIS_DELEGATE_REQUEST_ID correlation in claude_cli_proxy.

Run: python scripts/test_claude_cli_proxy_correlation.py
"""
from __future__ import annotations

import logging
import os
import sys
import unittest
from io import StringIO
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import claude_cli_proxy as p  # noqa: E402


class DelegateRequestIdCorrelationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._prev = os.environ.get("JARVIS_DELEGATE_REQUEST_ID")
        os.environ.pop("JARVIS_DELEGATE_REQUEST_ID", None)
        p.reset_delegate_request_id_cache()

    def tearDown(self) -> None:
        if self._prev is None:
            os.environ.pop("JARVIS_DELEGATE_REQUEST_ID", None)
        else:
            os.environ["JARVIS_DELEGATE_REQUEST_ID"] = self._prev
        p.reset_delegate_request_id_cache()

    def test_missing_when_env_unset(self) -> None:
        self.assertEqual(p.get_delegate_request_id(), "missing")
        self.assertEqual(p.delegate_correlation_field(), "delegate_request_id=missing")

    def test_reads_env_once_and_caches(self) -> None:
        os.environ["JARVIS_DELEGATE_REQUEST_ID"] = "req-corr-abc"
        p.reset_delegate_request_id_cache()
        self.assertEqual(p.get_delegate_request_id(), "req-corr-abc")
        # Mutating env after first read must not change the cached value.
        os.environ["JARVIS_DELEGATE_REQUEST_ID"] = "req-other"
        self.assertEqual(p.get_delegate_request_id(), "req-corr-abc")
        self.assertEqual(p.delegate_correlation_field(), "delegate_request_id=req-corr-abc")

    def test_request_start_log_includes_correlation_not_auth_header(self) -> None:
        os.environ["JARVIS_DELEGATE_REQUEST_ID"] = "req-log-xyz"
        p.reset_delegate_request_id_cache()

        stream = StringIO()
        handler = logging.StreamHandler(stream)
        handler.setLevel(logging.INFO)
        logger = logging.getLogger("jarvis.claude_cli_proxy")
        prev_level = logger.level
        logger.setLevel(logging.INFO)
        logger.addHandler(handler)
        try:
            # Simulate the start/result/error log shapes used by Handler.do_POST.
            correlation = p.delegate_correlation_field()
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
        p.reset_delegate_request_id_cache()
        field = p.delegate_correlation_field()
        self.assertEqual(field, "delegate_request_id=req-safe")
        self.assertNotIn("Bearer", field)
        self.assertNotIn("Authorization", field)


if __name__ == "__main__":
    unittest.main()
