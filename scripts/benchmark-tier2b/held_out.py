"""Canonical held-out task names for Phase D. Frozen at design time — not
randomized per run, so results are comparable across the whole CMA-ES
campaign. Every name here must exist in tasks.py's TASKS (tasks.py asserts
this on import and fails loud on drift/typo)."""

HELD_OUT_NAMES: frozenset[str] = frozenset({
    "clamp_with_lib",      # E (mandatory, existing)
    "pkg_auth",            # B (mandatory, existing)
    "run_checked",         # D (mandatory, existing)
    "find_rotation_point", # A (new)
    "nested_lookup",       # C (new)
    "slugify_with_lib",    # E (new)
})
