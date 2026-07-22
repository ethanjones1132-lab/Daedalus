# Reasoning-Lift Implementation Handoff

## Completed and deployed

- P1 ground-truth gates: content fingerprints, no-op write errors, syntax/run
  verification, and repair-loop feedback.
- P2 routing intelligence: high-complexity model bias, cross-family reviewer,
  bounded alternate executor, and SHA-256 delegate file identity.
- P3 learning loops: conductor outcome read-back, judge-gated skill promotion,
  and opt-in nightly semantic evaluation.
- P4.1: `mcp_list_tools`, `mcp_call_tool`, and `mcp_read_resource` are in the
  executor filter. Reviewer and read-only fences remain unchanged.
- P4.2 fixtures: corrected Tier-2 task hygiene plus two execution-required
  tasks, with a dry-by-default runner under `scripts/benchmark-tier2b/`.

## Release proof

- Master commit: `51660ad1edbc2115572f18e3cb78e7d3e5d91d1c`
- `scripts/verify-deploy.ps1 -ExpectSha 51660ad1edbc2115572f18e3cb78e7d3e5d91d1c`: passed.
- Running listener `/health.git_sha`: exact match; listener provenance matched
  the deployed Desktop `index.js`.
- `scripts/smoke-jarvis-runtime.ps1 -WriteReadSmoke -TimeoutSeconds 120`:
  passed; `JARVIS_SMOKE` was written and read back.
- P4 focused regression: 73 pass, 0 fail; server typecheck passed.
- MCP bundle/mode regression: 34 pass, 0 fail; deployed bundle contains all
  three executor MCP tool names.
- Tier-2B fixture validation: 10 tasks, 10 test programs compile; corrected
  topological seed and non-leaking discount spec are pinned.

## Intentionally not run

The new Tier-2B live measurement is 10 tasks × K=3 × 2 arms = 60 inference
calls. It remains opt-in to honor the weekly usage ceiling. No live K=3 score
is claimed in `docs/BENCHMARK_2026-07-21_TIER2B.md`.

When the usage budget permits, run from the canonical checkout after confirming
the listener is serving the expected SHA:

```powershell
scripts/run-tier2b-benchmark.ps1 -Arm both -K 3 -Live
```

The runner writes `scripts/benchmark-tier2b/results-tier2b.json` and reports
per-task pass counts and latency. Review the result for the run-gate-specific
tasks (`load_or_create_json`, `run_checked`) before treating the benchmark as a
release-quality measurement.
