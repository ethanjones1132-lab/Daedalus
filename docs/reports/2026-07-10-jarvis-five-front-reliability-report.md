# Jarvis five-front reliability report — 2026-07-10

## Outcome

Fronts 1–4 produced verified repairs. Front 5 required no merge because `codex/jarvis-live-p0a` is already fully contained by `master`; merging its stale tip would add nothing. No force-push or history rewrite was performed.

Detailed evidence:

- [Latency and event-loop report](./2026-07-10-jarvis-latency-and-event-loop.md)
- [Repo-grounding forensics](./2026-07-10-repo-grounding-forensics.md)
- [Track D health check](./2026-07-10-track-d-health.md)
- [Track B-03 recommendation](./2026-07-10-track-b03-recommendation.md)

## Front 1 — latency and feedback

The live evidence rejects event-loop blocking as the primary tail-latency cause. Inference/network stages account for essentially all canonical run time in the final probe, and seven-day synthesizer p95 is 132.9 seconds. An opt-in event-loop/CPU/RSS monitor, coordinator timing, and real first-token telemetry now close the previous observability gaps.

Simple conversational/direct-answer turns bypass model-backed routing through the existing deterministic turn classifier while retaining the canonical route/executor contracts. The offline metrics script is now an actual six-hour cron feedback loop into AgentPool routing/capabilities and per-model first-token budgets. Its policy is versioned, expiring, clamped, atomically written, and packaged/deployment-hashed.

## Front 2 — Windows boot and supervisor

Tauri `.setup()` no longer performs the blocking boot sequence on the application runtime. It initializes lightweight state, dispatches a named `jarvis-bootstrap` OS thread with its own current-thread Tokio runtime, and returns. The Bun supervisor is spawned on that dedicated runtime rather than Tauri's global runtime. `jarvis_check_status` clones configuration while holding the mutex, releases it, and performs synchronous probes through `spawn_blocking`.

The Bun supervisor now retains concrete failure state, emits durable structured diagnostics, limits automatic restart attempts to five, pauses instead of spinning silently, and lets an operator-initiated restart clear/re-arm the failure budget. Rust tests pin non-blocking startup dispatch, status-runtime responsiveness, diagnostic state, and restart behavior.

Remaining native risk: this pass did not reproduce the historical packaged-GUI AppHang/0xc0000005 in a cold launch. Database open/migrations/skill seeding still occur before Tauri setup; the supervisor's initial liveness predicate is TCP presence rather than `/health`; and five attempts are bounded in count, not a strict 100-second wall clock because each probe has its own timeout.

## Front 3 — grounding

The real hallucination was a synthesizer-only, zero-tool-call run that fabricated `jarvis/orchestrator.py`. The Expo answer cited in the old diagnosis belonged to an explicitly targeted and previously enumerated Versutus session. Workspace-read turns now require successful read evidence, retry once with a bounded tool nudge, and fail closed before synthesis when evidence is absent. Session evidence is workspace-provenanced and shared context is consistently injected.

## Front 4 — Track D

The exporter existed but could publish stale snapshot pipeline/outcome/attribution data. It now joins to canonical repairable run data without changing the JSONL contract. The repaired live export had zero mismatches and produced 89 valid rows from 90 snapshots at the default reward threshold. No downstream trainer consumes the JSONL; D-02 remains a human-gated future step.

## Front 5 — branch decision

History proof:

- `codex/jarvis-live-p0a` tip: `7e457e9`
- merge base with `master`: `7e457e9`
- `git merge-base --is-ancestor codex/jarvis-live-p0a master`: success
- `git rev-list --left-right --count master...codex/jarvis-live-p0a`: `15 0`
- P0A-only commits: 0
- master-only commits: 15
- D-01 commit `d6dda91` is already contained by both refs

The branch is an ancestor, not an unmerged feature line. A merge would be a no-op. `PRIORITIES.md` still contains historical text saying D-01/P0A awaits the operator's merge call; that text is stale relative to Git history.

## Verification summary

- Bun: 725 passed, 0 failed, 2,096 assertions across 71 files
- Bun typecheck: passed
- Bun production build: passed, 101 modules / 3.54 MB
- Python inference-metrics tests: 3 passed
- UI: 64 passed across 10 files
- UI production build: passed; existing >500 kB chunk warning remains
- Rust: 64 passed, 0 failed, 0 ignored
- `cargo check --workspace --all-targets`: passed
- `cargo build --workspace`: passed
- `cargo clippy --workspace --all-targets`: passed with two unrelated pre-existing warnings
- modified native-file `rustfmt --check`: passed
- `git diff --check`: passed (Windows LF→CRLF notices only)

The full-repository `cargo fmt --all -- --check` is still red on pre-existing formatting debt in unrelated modules and unchanged portions of `lib.rs`; no new native hunk is reported by that baseline failure.

