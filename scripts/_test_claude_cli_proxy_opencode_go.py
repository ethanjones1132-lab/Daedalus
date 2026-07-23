"""Unit checks for OpenCode Go upstream routing in claude_cli_proxy.

Run: python scripts/_test_claude_cli_proxy_opencode_go.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import claude_cli_proxy as p  # noqa: E402


class OpenCodeGoProxyRoutingTests(unittest.TestCase):
    def setUp(self) -> None:
        # Isolate from the user's live config/keys.
        self._env_backup = {
            k: os.environ.get(k)
            for k in (
                "JARVIS_OPENROUTER_API_KEY",
                "JARVIS_OPENCODE_GO_API_KEY",
                "OPENCODE_GO_API_KEY",
                "OPENCODE_GO_KEY",
                "JARVIS_OPENCODE_GO_URL",
                "JARVIS_OPENCODE_GO_OPENAI_MODELS",
                "JARVIS_OPENCODE_GO_MODELS_PATH",
                "JARVIS_CONFIG_PATH",
            )
        }
        for k in self._env_backup:
            os.environ.pop(k, None)

        p._OR_KEY_CACHE.update({"key": "", "ts": 0.0})
        p._GO_KEY_CACHE.update({"key": "", "ts": 0.0})
        p._GO_URL_CACHE.update({"url": "", "ts": 0.0})
        p._GO_MODELS_CACHE.update({"models": frozenset(), "ts": 0.0})

        # Point config at an empty temp file so live ~/.openclaw keys can't leak in.
        self._tmpdir = tempfile.TemporaryDirectory()
        self._cfg_path = Path(self._tmpdir.name) / "config.json"
        self._cfg_path.write_text("{}", encoding="utf-8")
        os.environ["JARVIS_CONFIG_PATH"] = str(self._cfg_path)
        # Use the repo-synced model list explicitly.
        os.environ["JARVIS_OPENCODE_GO_MODELS_PATH"] = str(
            SCRIPTS / "opencode_go_openai_models.json"
        )

    def tearDown(self) -> None:
        for k, v in self._env_backup.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmpdir.cleanup()

    def _write_cfg(self, payload: dict) -> None:
        self._cfg_path.write_text(json.dumps(payload), encoding="utf-8")
        p._OR_KEY_CACHE.update({"key": "", "ts": 0.0})
        p._GO_KEY_CACHE.update({"key": "", "ts": 0.0})
        p._GO_URL_CACHE.update({"url": "", "ts": 0.0})
        p._GO_MODELS_CACHE.update({"models": frozenset(), "ts": 0.0})

    def test_synced_json_lists_deepseek_not_minimax(self) -> None:
        models = p.get_opencode_go_openai_models()
        self.assertIn("deepseek-v4-flash", models)
        self.assertIn("deepseek-v4-pro", models)
        self.assertIn("mimo-v2.5", models)
        self.assertNotIn("minimax-m3", models)

    def test_resolve_upstream_routes_deepseek_to_opencode_go(self) -> None:
        os.environ["JARVIS_OPENCODE_GO_API_KEY"] = "go-test-key"
        u = p.resolve_upstream("deepseek-v4-pro")
        self.assertEqual(u["provider"], "opencode_go")
        self.assertEqual(u["model"], "deepseek-v4-pro")
        self.assertTrue(u["completions_url"].endswith("/chat/completions"))
        self.assertIn("opencode.ai", u["base_url"])
        self.assertEqual(u["auth"], "Bearer go-test-key")
        self.assertFalse(u["local"])

    def test_resolve_upstream_accepts_opencode_go_prefix(self) -> None:
        os.environ["JARVIS_OPENCODE_GO_API_KEY"] = "go-test-key"
        u = p.resolve_upstream("opencode_go/deepseek-v4-flash")
        self.assertEqual(u["provider"], "opencode_go")
        self.assertEqual(u["model"], "deepseek-v4-flash")

    def test_anthropic_native_minimax_does_not_route_to_opencode_go(self) -> None:
        # minimax-m3 is Anthropic-native and stays out of the proxy openai list.
        os.environ["JARVIS_OPENCODE_GO_API_KEY"] = "go-test-key"
        u = p.resolve_upstream("minimax-m3")
        self.assertNotEqual(u["provider"], "opencode_go")

    def test_openrouter_still_wins_for_namespaced_ids(self) -> None:
        os.environ["JARVIS_OPENCODE_GO_API_KEY"] = "go-test-key"
        os.environ["JARVIS_OPENROUTER_API_KEY"] = "or-test-key"
        u = p.resolve_upstream("deepseek/deepseek-v4-flash")
        self.assertEqual(u["provider"], "openrouter")
        self.assertEqual(u["model"], "deepseek/deepseek-v4-flash")

    def test_config_key_and_base_url(self) -> None:
        self._write_cfg(
            {
                "opencode_go": {
                    "api_key": "cfg-go-key",
                    "base_url": "https://opencode.ai/zen/go/v1/",
                }
            }
        )
        self.assertEqual(p.get_opencode_go_key(), "cfg-go-key")
        self.assertEqual(p.get_opencode_go_base_url(), "https://opencode.ai/zen/go/v1")
        u = p.resolve_upstream("deepseek-v4-flash")
        self.assertEqual(u["provider"], "opencode_go")
        self.assertEqual(u["completions_url"], "https://opencode.ai/zen/go/v1/chat/completions")

    def test_config_openai_format_models_override(self) -> None:
        self._write_cfg(
            {
                "opencode_go": {
                    "api_key": "cfg-go-key",
                    "openai_format_models": ["custom-go-model"],
                }
            }
        )
        # Config list takes precedence over the JSON sidecar.
        os.environ.pop("JARVIS_OPENCODE_GO_MODELS_PATH", None)
        models = p.get_opencode_go_openai_models()
        self.assertEqual(models, frozenset({"custom-go-model"}))
        u = p.resolve_upstream("custom-go-model")
        self.assertEqual(u["provider"], "opencode_go")

    def test_allowlist_includes_opencode_host(self) -> None:
        self.assertIn("opencode.ai", p.ALLOWED_REMOTE_HOSTS)
        self.assertIn("openrouter.ai", p.ALLOWED_REMOTE_HOSTS)
        # Back-compat alias
        self.assertIs(p.OPENROUTER_HOSTS, p.ALLOWED_REMOTE_HOSTS)

    def test_missing_go_key_does_not_claim_opencode_go(self) -> None:
        u = p.resolve_upstream("deepseek-v4-pro")
        self.assertNotEqual(u["provider"], "opencode_go")


if __name__ == "__main__":
    unittest.main()
