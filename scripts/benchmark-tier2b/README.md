# Tier-2B benchmark

This is the checked-in successor to the temporary Tier-2 harness. It contains
the eight original tasks with the two reported fixture defects corrected, plus
two execution-required tasks (`load_or_create_json` and `run_checked`) that
exercise the run gate against filesystem and subprocess behavior.

The runner is deliberately dry-run by default. Use `scripts/run-tier2b-benchmark.ps1`
without `-Live` to validate task enumeration, and add `-Live` only for an
explicit baseline/architecture measurement against the deployed listener.
