#!/usr/bin/env python3
"""Simulate Rust SseRelay on captured SSE lines — regression gate for streaming."""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Relay:
    streamed_any: bool = False
    tokens: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    done: bool = False

    def handle_line(self, raw_line: str) -> str:
        line = raw_line.strip()
        if not line.startswith("data:"):
            return "continue"
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            return "done" if payload == "[DONE]" else "continue"
        try:
            evt = json.loads(payload)
        except json.JSONDecodeError:
            return "continue"

        typ = evt.get("type")
        if typ == "stream_event":
            text = (evt.get("delta") or {}).get("text")
            if text:
                self.streamed_any = True
                self.tokens.append(text)
                return "token"
        elif typ == "error":
            self.errors.append(evt.get("error") or "unknown")
            return "error"
        elif typ == "result":
            token = None
            error = None
            if not self.streamed_any:
                result = evt.get("result")
                if isinstance(result, str) and result:
                    if evt.get("is_error"):
                        error = result
                    else:
                        token = result
                elif evt.get("is_error"):
                    error = evt.get("subtype") or "error"
            if token:
                self.tokens.append(token)
            if error:
                self.errors.append(error)
            self.done = True
            return "result_done"
        elif typ == "message_stop":
            return "message_stop"
        elif typ == "cancelled":
            self.errors.append("cancelled")
            self.done = True
            return "cancelled"
        return "continue"

    def eof(self) -> None:
        if not self.done:
            self.done = True


def replay(lines: list[str]) -> Relay:
    relay = Relay()
    for line in lines:
        outcome = relay.handle_line(line)
        if outcome == "error":
            relay.done = True
            break
        if outcome == "cancelled":
            break
        if outcome == "result_done":
            break
        if outcome == "done":
            relay.done = True
            break
        # message_stop must NOT break — keep reading for trailing result
    if not relay.done:
        relay.eof()
    return relay


def main() -> int:
    sample_orchestrator = [
        'data: {"type":"init","session_id":"s1","model":"test"}',
        'data: {"type":"orchestrator_stage","stage":"synthesizer","status":"running","session_id":"s1"}',
        'data: {"type":"message_stop","session_id":"s1"}',
        'data: {"type":"result","subtype":"success","is_error":false,"result":"Hello from orchestrator","session_id":"s1"}',
    ]
    r1 = replay(sample_orchestrator)
    assert r1.tokens == ["Hello from orchestrator"], f"orchestrator replay failed: {r1.tokens}"
    assert r1.done

    sample_streaming = [
        'data: {"type":"stream_event","delta":{"text":"Hi"}}',
        'data: {"type":"stream_event","delta":{"text":" there"}}',
        'data: {"type":"message_stop","session_id":"s2"}',
        'data: {"type":"result","subtype":"success","is_error":false,"result":"Hi there","session_id":"s2"}',
    ]
    r2 = replay(sample_streaming)
    assert r2.tokens == ["Hi", " there"], f"streaming replay failed: {r2.tokens}"

    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as f:
            r3 = replay(f.read().splitlines())
        print(f"tokens={len(r3.tokens)} chars={sum(len(t) for t in r3.tokens)} done={r3.done} errors={r3.errors}")
        if not r3.tokens and not r3.errors:
            print("FAIL: no visible output captured")
            return 1
        print("PASS: relay captured output from file")
        return 0

    print("PASS: built-in SSE relay regression cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())