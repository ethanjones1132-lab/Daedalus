# Orchestration runtime performance evidence

Date: 2026-07-12  
Repository: `C:\Projects\home-base-recovered`

## Incident baseline

The latest live session evidence showed a systemic orchestration amplification pattern:

- `/health/inference` recorded OpenCode Go p50 latency of 52,731 ms and p95 latency of 110,348 ms, with 3 errors in 10 requests and zero token totals.
- Self-tuning runs included failed durations of 72,629 ms, 110,348 ms, and 183,296 ms.
- The live pipeline performed repeated reviewer/rewriter cycles and invoked an extra `stage=coordinator` pool resolution after stage completion.
- `LiveConductor.setContext` was not called in production, `afterConductorStage` passed a fake `[stage]` queue, and cumulative token accounting added prior totals on every loop.
- Interactive work overlapped with self-improvement/cron activity, so provider contention was not isolated.

## Implemented controls

| Area | Control | Evidence |
|---|---|---|
| Provenance | `/health` reports Git SHA, dirty state, and source-tree digest; deploy verification checks them | `dcd10a2` |
| Telemetry | Linear turn totals, 200-entry attempt ring, runtime pressure snapshot, System Health rendering | `842a9b4` |
| Supervision | Healthy successful stages skip live conductor inference; real remaining queue is passed | `d3300c3` |
| Repair loops | Full-profile repair defaults to one round, clamps to 0–2, and exits on no new write effect | `8a899dd`, `023c292` |
| Turn safety | Requirement-aware 30–180 second budgets, finalization reserve, two-candidate cap, stage cooldowns | `4478757` |
| Admission | Interactive leases preempt background work; cron can return `background_deferred` | `8c623fd` |
| Context | Raw-request history budgets and 6,000-token synthesis cap preserving terminal effects | `73ce56f` |

## Verification record

The release gate is intentionally evidence-driven. Populate the table with the exact command output from the current checkout and deployed process.

| Check | Result | Evidence |
|---|---|---|
| Bun focused tests | pending live run | `bun test ...` |
| Bun typecheck | pending live run | `bunx tsc --noEmit` |
| UI tests/build | pending live run | `bun run test && bun run build` |
| Rust tests | pending live run | `cargo test --manifest-path src-tauri/Cargo.toml` |
| Deploy provenance | pending live run | `verify-deploy.ps1` |
| Write/read smoke | pending live run | `smoke-jarvis-runtime.ps1 -WriteReadSmoke` |
| Five-sample benchmark | pending live run | `benchmark-jarvis-runtime.ps1 -Iterations 5` |

### Live benchmark run (2026-07-12)

The deployed Desktop process passed all 15 samples and structural gates:

| Scenario | p50 | p95 | SLO result |
|---|---:|---:|---|
| Direct answer | 2.16 s | 2.83 s | pass (<=10 s / <=30 s) |
| Workspace read | 9.87 s | 16.76 s | pass (<=30 s / <=60 s) |
| Full execution write/read | 48.29 s | 78.56 s | pass (<=75 s / <=120 s) |

Every scenario had five structural passes. The full-execution samples verified the
temporary artifact contents, and per-stage candidate counts remained at or below
two. The write/read smoke also passed in 38.6 s with matching Desktop listener
provenance.

## Acceptance gates

- Every successful healthy stage makes zero live-conductor provider calls.
- No stage uses more than two provider candidates.
- Full execution requires an authoritative successful write and read before claiming success.
- Interactive queue wait is observable and background work is deferred rather than counted as model failure.
- `/health/inference` includes non-zero truthful token totals, per-attempt outcomes, recent attempts, and runtime pressure.
- Deployed process provenance matches the Desktop bundle hash, Git SHA, dirty state, and source-tree digest.
