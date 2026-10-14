"""Read-only sector copy with a map of unreadable 4K blocks (D: rescue, 2026-10-04).

Reads SOURCE (a file, or a raw device such as \\\\.\\PhysicalDrive1 when elevated) from
START_LBA for COUNT 512-byte sectors into OUT, 1 MiB at a time. A chunk that fails is
re-read in 4K blocks; blocks that still fail are zero-filled and listed. Never writes
to SOURCE. Exit 0 if at most --max-bad blocks failed, 3 if more, 2 on open errors.

usage: d_copy.py SOURCE OUT START_LBA COUNT [--max-bad N]
"""
import sys

SECT, CHUNK, BLK = 512, 2048, 8


def main():
    src, out, start, count = sys.argv[1], sys.argv[2], int(sys.argv[3], 0), int(sys.argv[4], 0)
    max_bad = int(sys.argv[sys.argv.index("--max-bad") + 1]) if "--max-bad" in sys.argv else 64
    bad, first_err = [], None
    try:
        f = open(src, "rb", buffering=0)
    except OSError as e:
        print(f"{out}: cannot open {src}: {e!r}")
        return 2
    with f, open(out, "wb") as o:
        lba, end = start, start + count
        while lba < end:
            n = min(CHUNK, end - lba)
            try:
                f.seek(lba * SECT)
                data = f.read(n * SECT)
                if len(data) != n * SECT:
                    raise OSError(f"short read: {len(data)} of {n * SECT} bytes")
                o.write(data)
            except OSError as e:
                first_err = first_err or repr(e)
                for s in range(lba, lba + n, BLK):
                    try:
                        f.seek(s * SECT)
                        d = f.read(BLK * SECT)
                        if len(d) != BLK * SECT:
                            raise OSError(f"short read: {len(d)} bytes")
                        o.write(d)
                    except OSError as e2:
                        first_err = first_err or repr(e2)
                        o.write(b"\0" * (BLK * SECT))
                        bad.append(s)
            lba += n
    shown = " ".join(hex(b) for b in bad[:64]) + (" ..." if len(bad) > 64 else "")
    print(f"{out}: {count} sectors from LBA {start:#x}; unreadable 4K blocks: {len(bad)} {shown}"
          + (f"; first error: {first_err}" if first_err else ""))
    return 0 if len(bad) <= max_bad else 3


if __name__ == "__main__":
    sys.exit(main())
