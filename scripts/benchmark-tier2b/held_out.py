"""Canonical held-out task names for Phase D. Frozen at design time — not
randomized per run, so results are comparable across the whole CMA-ES
campaign. Every name here must exist in tasks.py's TASKS (tasks.py asserts
this on import and fails loud on drift/typo).

Target ~20% of the suite, stratified across A–E so neither split is missing
a category (especially E — symbol grounding).
"""

HELD_OUT_NAMES: frozenset[str] = frozenset({
    "find_rotation_point",  # A
    "pkg_auth",             # B
    "pkg_inventory",        # B
    "nested_lookup",        # C
    "run_checked",          # D
    "atomic_write",         # D
    "clamp_with_lib",       # E (mandatory, existing)
    "slugify_with_lib",     # E
})
