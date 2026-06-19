from __future__ import annotations

import os
import time
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def registry_lock(root: Path, *, timeout_s: float = 10.0):
    path = root / "data" / ".registry.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + timeout_s
    handle = None
    while time.time() < deadline:
        try:
            handle = path.open("x", encoding="utf-8")
            handle.write(str(os.getpid()))
            handle.flush()
            break
        except FileExistsError:
            time.sleep(0.05)
    if handle is None:
        raise TimeoutError(f"could not acquire registry lock at {path}")
    try:
        yield
    finally:
        handle.close()
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass