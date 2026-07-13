# Orchestration Repetition & Performance — Outcome Report

**Date:** 2026-07-12 (evening)
**Branch:** `worktree-orchestration-perf` (all phases of `2026-07-12-comprehensive-performance-improvement.md`)
**Verification:** 913/913 bun tests (95 files), 84/84 cargo lib tests, 68/68 UI vitest, both `tsc` jobs clean.

---

## Root cause (evidence-grounded, from the plan's Part A + new findings this session)

The 2026-07-12 force-stopped session `e21d0533` was a **cross-turn behavioral loop**, not token
degeneration. Chain: `workspace_read` classification → executor capped at 2 turns / 25s against a
52.7s-p50 provider pool (structural starvation) → one `list_directory` satisfied the boolean
evidence fence → the synthesizer dressed the shortfall as "ask me again" (its own prompt, line 21,
literally scripted the re-ask) → the user complied → identical loop, ~43–53s and ~1.3–3k chars of
non-answer per cycle → force-stop left zero trace (`session_runs` empty, incident window absent
from the server log).

**New confirmation this session:** the self-tuning DB (`C:\Users\ethan\.openclaw\jarvis\self-tuning.db`
— alive, 3,885 stage runs, NOT dark; the original audit had queried jarvis.db's vestigial June
tables) contains the incident turns as `agent_runs` rows `run_5ed78a81` / `run_931c0741`, both
recorded **outcome=success** — the self-tuner was actively rewarding the repetition loop, the same
failure-reinforcement mode as the 2026-07-04 tool-call leak.

## What landed (16 commits on the branch, by phase)

**Phase 1 — the loop can no longer run** (landed on master earlier today, `423c8a7`–`0f8851f`, plus
fixes `c2e33c2`/`a5b33e5` this session): cross-turn no-progress detector (trigram Jaccard 0.25,
calibrated on the real incident text, `newEvidence` gate primary), intra-stream degeneration
detector (KMP smallest-period, O(1) per check), both wired into `streamJarvis` + both stream read
loops + stage-health failover, repair-loop cap pinned by mutation-tested regression tests.

**Phase 2 — the executor can now actually do the work** (`a861a89`, `7341f30`, `93f773d`,
`f5cef5a`, `b599ed3`): depth-scaled evidence sufficiency (a lone `list_directory` never grounds a
"comprehensively diagnose" turn; 3+ content reads required), deterministic listing+anchor-file
preflight seeds weak models with real evidence before their first token, `read_file`-on-directory
auto-substitutes `list_directory` in one hop instead of a ~50s model round-trip,
evidence-progress-scaled budgets (+20s per new evidence item, stage-capped 90s, turn-capped 180s;
a stalled executor still exits on the original tight deadline; `read_only` turn limit 2→4), typed
`insufficient_workspace_evidence` failures with actionable guidance, and the synthesizer prompt
rule that manufactured the loop ("ask me to read specific files") replaced with an explicit
never-coach-a-re-ask rule.

**Phase 3 — throughput** (`77edc92`, `1edd685`, `7cb1eb8`, `19c6c88`): parallel dispatch for
read-only tool batches (N reads in one turn = 1 wait, proven by a maxInFlight≥2 test; writes stay
serial barriers in model order), read-only route slimming (verified already landed via
`ALLOWED_STAGES`), fail-fast memo (a near-identical retry after a no-progress/evidence failure
answers in <1s instead of ~50s; bypasses: `force deep read`, naming a concrete file; transient
provider failures never short-circuit), pool-collapse diagnosis (07-11 monoculture = zen agents
disabled in live config + OpenRouter 401 window; key verified VALID today; `provider_diversity`
now exposed in `/health/inference`), config-warning churn killed (~5,700 identical lines/day →
once per process per path).

**Phase 4 — the next incident will be observable** (`851b846`, `d2eb536`, `99405ab`):
`session_runs` now written on every stream exit path — the webview's direct `/chat/stream` fetch
was bypassing the Rust relay that owned persistence; the UI now mirrors the relay's accumulator
and reports via a new `record_terminal_run` Tauri command, including force-stops that race ahead
of the server's cancelled frame. No-progress repeats are recorded `degraded` so the tuner stops
rewarding them (and they stay out of success-gated skill distillation). A self-log tee
(`server-jarvis.self.log`) guarantees log coverage regardless of spawn path. The self-tuning store
logs its resolved sink path at startup.

**Phase 5 — proof harness** (`d0319c0`): benchmark gained the `repeated_no_progress` scenario —
same un-answerable deep-read request twice in one session; attempt 2 must resolve <5s with
`retry_short_circuited`.

**Post-merge live-fire fix** (`a2564d5`, 2026-07-13): merged to `master`, pushed, rebuilt
(`build-and-deploy.ps1 -RestartServer`), and deployed to the OneDrive Desktop; `/health` confirmed
`git_sha` matched local `HEAD` at each step (Two-Desktops trap avoided). The **first** live
benchmark run against the deployed instance caught a real gap the plan's own design review missed:
`repeated_no_progress` attempt 2 did not short-circuit (19.9s instead of <5s). Traced via
self-tuning.db `stage_runs` to the exact tool calls — the executor satisfied the deep-read
3-content-reads floor by calling `read_file` once plus `git_metadata` **twice** against a
single-real-file fixture, never genuinely inspecting more than one file. `git_metadata` (repo
HEAD/branch/dirty state) counted toward "content reads" alongside `read_file`/`grep`, which let a
model "diagnose an architecture" by checking git status twice — exactly the kind of gap this whole
plan exists to close. Fixed: only `read_file`/`grep` count toward the deep-read floor now
(`git_metadata` still satisfies a *shallow* request alone, preserving the git/SHA preflight's use
case); the floor also now counts **distinct** `(tool, arguments)` targets, closing the adjacent gap
where re-reading the same file repeatedly could fake it the same way. Also closed a related
observability gap: the fatal-error `session.finish()` call never included `code`, so no client
(including this repo's own benchmark script) could see *why* a turn failed. 4 new tests; one
existing test corrected (it had pinned `git_metadata` as valid deep-read evidence — that was the
bug). Re-deployed and re-ran the full benchmark: **all four scenarios pass structurally**, with the
repeated-request gate resolving attempt 2 in **11ms** (real, this time — `memo_armed: true`,
`outcome_code: retry_short_circuited`, confirmed via the redeployed instance, not a mock).

## Before / after

| Metric | Before | After |
|---|---|---|
| Identical no-progress retry | full pipeline re-run, 42.9–53.5s each (incident data) | <1s memo short-circuit; gate: <5s in benchmark scenario |
| Third identical non-answer | emitted verbatim (incident turn 5) | refused with typed `no_progress_repetition` + actionable guidance |
| Deep-read grounding | 1 `list_directory` = "grounded" | 3+ content reads or typed failure; preflight seeds listing + up to 5 anchor files |
| Executor ceiling (workspace_read) | 2 turns / 25s fixed | 4 turns / 25s base, +20s per evidence item to 90s stage / 180s turn |
| N read tools in one turn | N sequential waits | 1 concurrent batch wait |
| No-progress turn in tuner | recorded `success` (rewarded) | recorded `degraded` (never rewarded, never distilled) |
| Force-stop trace | none (`session_runs` empty forever) | durable `cancelled` row from every exit path |
| Incident-window logs | zero lines possible | guaranteed self-log independent of spawn path |
| Pool monoculture | discoverable only by log forensics | `provider_diversity` in `/health/inference` |
| Config-warning spam | ~5,700 lines/day | once per process per stale path |
| Deep-read evidence floor gaming | N/A (didn't exist) | closed same-day by live-fire benchmark (see below) |
| Benchmark, deployed 2026-07-12 baseline | Direct 2.16s / Read 9.87s / Full 48.29s p50 | — |
| Benchmark, deployed 2026-07-13 (`12b13b7`, pre-fix) | — | Direct 5.68s / Read 11.2s / Full 20.35s p50; repeated-request gate **failed** (19.9s, no short-circuit) |
| Benchmark, deployed 2026-07-13 (`a2564d5`, post-fix) | — | Direct 2.78s / Read 9.37s / Full 19.97s p50, all structural; repeated-request **11ms**, `retry_short_circuited` confirmed |

Full-execution p50 improved ~2.4x over the 2026-07-12 baseline (48.29s → ~20s), consistent with the
parallel read-only tool dispatch (Task 3.1) and progress-scaled budgets (Task 2.4). Direct/Read
p50s show normal live free-tier model variance run-to-run (2.16–5.68s / 9.37–11.2s) — within SLO
throughout, not a regression signal.

## Remaining operator steps

1. ~~Merge + deploy~~ — done: `master` fast-forwarded through `a2564d5`, pushed to `origin/master`,
   rebuilt via `build-and-deploy.ps1 -RestartServer`, `/health.git_sha` verified against local
   `HEAD` at each step (Two-Desktops trap avoided).
2. ~~Live benchmark re-run~~ — done, see the table above. The first run caught and the second run
   confirmed the fix for the `git_metadata` evidence-gaming gap.
3. **Incident replay smoke** (plan Task 5.3, still open): re-send the Versutus diagnosis request;
   expect either a grounded diagnosis (≥3 real file reads) or a typed evidence failure — never a
   re-ask coaching loop; force-stop a turn and verify the `cancelled` row in `session_runs`.
4. **Config decision** (still open, operator's call): the 4 disabled `opencode_zen` agents in live
   config are the standing monoculture risk — re-enable or remove them.
