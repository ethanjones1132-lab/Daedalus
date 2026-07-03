#!/usr/bin/env python3
"""Ad-hoc verifier for the 2026-07-03 afternoon PRIORITIES.md edit.

Cron mode safety: writes to scripts/ rather than the OS temp dir so the
cron-flaky `os.remove` cleanup step isn't required.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

PRIORITIES = Path(__file__).resolve().parents[1] / "PRIORITIES.md"


def main() -> int:
    if not PRIORITIES.exists():
        print(f"FAIL: {PRIORITIES} missing")
        return 1
    raw = PRIORITIES.read_text(encoding="utf-8")
    # Normalize CRLF → LF for the checks (the file is mostly LF with
    # some Windows-era CRLF lines; we don't care about line endings here).
    text = raw.replace("\r\n", "\n")

    checks: list[tuple[str, bool]] = []

    # Header line should now start with "Last updated: 2026-07-03 afternoon"
    checks.append((
        "Last-updated line is 2026-07-03 afternoon",
        bool(re.search(r"^Last updated: 2026-07-03 afternoon", text, re.MULTILINE)),
    ))

    # Should reference the new commit cae32c9
    checks.append((
        "References commit cae32c9",
        "cae32c9" in text,
    ))

    # Should reference both files modified: stream-emitter (ts + test.ts) and text-tools
    checks.append((
        "Mentions stream-emitter (ts or test.ts)",
        "stream-emitter.ts" in text or "stream-emitter.test.ts" in text,
    ))
    checks.append((
        "Mentions text-tools (ts or test.ts)",
        "text-tools.ts" in text or "text-tools.test.ts" in text,
    ))

    # Should mention 523 bun tests
    checks.append((
        "Mentions 523 bun tests",
        "523 bun tests pass" in text,
    ))

    # Should mention Phase 2 closure
    checks.append((
        "Mentions Phase 2 closure of implementation plan",
        "Phase 2" in text and "IMPLEMENTATION_PLAN_TOOLCALL_ORCHESTRATION" in text,
    ))

    # Should preserve the previous P0-B line (regression guard)
    checks.append((
        "Preserves previous P0-B reference",
        "P0-B" in text and "2026-07-02 evening" in text,
    ))

    # Should mention the new 6 tests
    checks.append((
        "Mentions 6 new bun tests",
        "6 new bun tests" in text,
    ))

    # No literal \n corruption (the file uses real newlines; \n in source should
    # only appear inside backticks for code/JSON examples)
    # We just confirm the file is readable and non-empty.
    checks.append((
        "File is non-empty and > 30 KB",
        len(text) > 30_000,
    ))

    # Section headers should be plain text (no markdown corruption)
    h2_count = len(re.findall(r"^## ", text, re.MULTILINE))
    checks.append((
        f"Has section headers (found {h2_count})",
        h2_count >= 5,
    ))

    passed = sum(1 for _, ok in checks if ok)
    failed = [name for name, ok in checks if not ok]
    total = len(checks)
    for name, ok in checks:
        mark = "PASS" if ok else "FAIL"
        print(f"  [{mark}] {name}")
    print(f"\n{passed}/{total} checks passed")
    if failed:
        print(f"FAILED: {failed}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
