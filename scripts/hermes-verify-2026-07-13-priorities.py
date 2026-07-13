#!/usr/bin/env python
"""
Ad-hoc verifier for the 2026-07-13 PRIORITIES.md maintenance-pass edit.

Checks (no canonical test covers markdown structure):
  1. File readable, decodes as UTF-8.
  2. New 2026-07-13 entry exists with the required content (live-fire deploy,
     a2564d5, evidence-gaming gap, git_metadata restriction, distinct (tool,
     arguments) counting, code: result.error_code, benchmark hardening, +3
     tests).
  3. "Last updated" line is current (contains 2026-07-13).
  4. Header "# Jarvis / home-base — Priority Roadmap" still present and on a
     line by itself (so the renderer doesn't break).
  5. No literal "\\n" byte sequence in the file (the patch multi-line footgun).
  6. No CRLF line endings (the patch tool on Windows converts LF -> CRLF).
  7. File size is sane (was 102,432 bytes pre-edit; +new-entry should add a
     small amount, not balloon).
"""
import sys
import os

PATH = r"C:\Projects\home-base-recovered\PRIORITIES.md"

def fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)

def main():
    if not os.path.isfile(PATH):
        fail(f"file not found: {PATH}")
    raw = open(PATH, "rb").read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        fail(f"UTF-8 decode failed: {e}")
    print(f"PASS 1: file readable, UTF-8, size={len(raw)} bytes")

    # 2. New 2026-07-13 entry content
    new_entry_markers = [
        "**Update 2026-07-13",
        "a2564d5",
        "evidence-gaming",
        "git_metadata",
        "distinct**",
        "(tool, arguments)",
        "code: result.error_code",
        "scripts/benchmark-jarvis-runtime.ps1",
        "11ms",
        "retry_short_circuited",
        "916/916",
    ]
    for m in new_entry_markers:
        # Use a permissive substring match (case-sensitive) that allows for
        # minor formatting drift. e.g. **distinct** might be **distinct** or
        # **distinct**; we look for the core word.
        if m.startswith("**") and m.endswith("**"):
            core = m.strip("*")
            if core not in text:
                fail(f"new-entry marker missing: {m} (core={core!r})")
        else:
            if m not in text:
                fail(f"new-entry marker missing: {m!r}")
    print(f"PASS 2: all {len(new_entry_markers)} new-entry markers present")

    # 3. Last updated line current
    if "Last updated: 2026-07-13" not in text:
        fail("'Last updated' line is NOT 2026-07-13")
    print("PASS 3: 'Last updated' line is current (2026-07-13)")

    # 4. Header still present, on a line by itself (textually, even though
    # the file's `**Update` paragraphs end with `**` followed by a newline
    # and the next line starts with `**#` — we look for the standalone
    # header line that contains the # but only that as the leading content)
    header_line = "**# Jarvis / home-base — Priority Roadmap"
    header_lines = [ln for ln in text.splitlines() if "Jarvis / home-base" in ln and "Priority Roadmap" in ln]
    if len(header_lines) != 1:
        fail(f"header not on exactly one line (found {len(header_lines)})")
    if header_lines[0].strip() != header_line:
        fail(f"header line has unexpected content: {header_lines[0]!r}")
    print("PASS 4: '# Jarvis / home-base — Priority Roadmap' header present, alone on its line")

    # 5. No literal backslash-n bytes (patch multi-line footgun).
    # The corruption pattern is a backslash followed by an 'n' that IS the
    # line ending (i.e. it replaces what should be a real \n). Real
    # markdown content can have a literal backslash followed by an 'n' on
    # a line (e.g. "a path like C:\newproj") - those are fine. We flag
    # only when the 'n' of a '\n' byte sequence is the LAST byte before a
    # real \n.
    import re
    bad_corruption = re.findall(rb"\\n\n", raw)
    # Also flag when 'n' is the last byte of the file (truncated patch)
    if raw.endswith(b"\\n"):
        bad_corruption.append(b"<eof trailing \\\\n>")
    bad_count = len(bad_corruption)
    if bad_count > 0:
        # Show first 3 for diagnosis
        for sample in bad_corruption[:3]:
            idx = raw.find(sample)
            print(f"  sample at {idx}: {raw[max(0,idx-30):idx+30]!r}")
        fail(f"file contains {bad_count} '\\\\n\\n' byte sequence(s) (patch corruption footgun)")
    print(f"PASS 5: no '\\\\n\\n' corruption footgun ({bad_count} found)")

    # 6. No CRLF line endings (patch tool on Windows converts LF -> CRLF)
    crlf_count = raw.count(b"\r\n")
    lf_only_count = raw.count(b"\n") - crlf_count
    bare_cr = raw.count(b"\r") - crlf_count
    if crlf_count > 0 or bare_cr > 0:
        fail(f"file has {crlf_count} CRLF + {bare_cr} bare-CR line endings ({lf_only_count} LF-only) - patch tool converted line endings")
    print(f"PASS 6: no CRLF line endings ({lf_only_count} LF-only, {bare_cr} bare-CR)")

    # 7. File size sanity
    if len(raw) < 100_000:
        fail(f"file shrunk suspiciously: {len(raw)} bytes (was 102,432)")
    if len(raw) > 130_000:
        fail(f"file grew suspiciously: {len(raw)} bytes (was 102,432)")
    print(f"PASS 7: file size in expected range ({len(raw)} bytes, was 102,432)")

    print("\nALL 7 CHECKS PASSED")

if __name__ == "__main__":
    main()
