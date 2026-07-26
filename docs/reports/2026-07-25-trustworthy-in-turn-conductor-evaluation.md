# Trustworthy In-Turn Conductor Evaluation

Date: 2026-07-25

## Verdict

Do not promote a new resident conductor model yet.

The Rung 1 and Rung 2 implementation is operational and auditable, but the
model comparison did not show a quality improvement over the current
`qwen3.5:4b` baseline. The live configuration remains on `qwen3.5:4b`, with
the in-turn driver disabled by default and Claude delegation restored to
`delegate_first`.

The highest-value next step is to give the resident conductor richer execution
context and ensure it supervises the delegate-first path. The current
`MidLoopSignal` contains counters and budget state, but not enough semantic
evidence to judge implementation completeness or quality.

## Implementation verification

- Full Bun suite: 1,980 passed, 0 failed, 143 files.
- TypeScript typecheck: passed.
- Mid-loop decisions are persisted in `conductor_directives`.
- Resident model calls are attributed as `stage_id='conductor_supervision'`.
- Deterministic reflexes remain available when the model is disabled,
  unavailable, timed out, or capped.
- Resident warm-up and route deadlines are now independently configurable and
  default to 90 seconds and 20 seconds respectively.

## Model registration

| Candidate | Registration result | Notes |
| --- | --- | --- |
| `qwythos9b-conductor:latest` | Registered | Ollama ID `b4078b49e643`; GGUF architecture `qwen35` |
| `nanbeige42-3b-conductor` | Blocked | Ollama 0.32.1 rejects GGUF architecture `nanbeige` as unknown |
| `qwen3.5:4b` | Existing baseline | Retained as the live default |

The Nanbeige failure is a runtime compatibility block, not an evaluation loss.
A compatible Ollama build, conversion, or replacement candidate is required
before a fair three-way comparison is possible.

## Routing benchmark

Claude's 30-run tier-2B routing benchmark was audited against the recorded
`conductor_runs` rows.

- Canonical task result: 30/30 passed.
- Qwythos actually participated in 16/30 routes; 14/30 used deterministic
  cold-start fallback.
- Qwythos routing JSON parse failures: 0/16.
- Qwythos task classifications: 13 `debug`, 1 `general`, 1 `refactor`,
  1 `code_review`.
- Invariant overrides: 3/30.
- Accepted topologies: 30/30 `linear`.
- Qwythos route latency: minimum 3,017 ms; median 3,771 ms; p95/max 5,037 ms;
  mean 3,920 ms.

One later native canary produced a JSON pipeline containing a `null` entry.
The deterministic invariant layer normalized it safely. This was not a JSON
parse failure, but it is evidence that semantic route validation must remain
authoritative.

## Live-fire findings

### Delegate-first run

A 10-task tier-2B run with production-style `delegate_first` behavior passed
10/10 canonical checks. Only 2/10 routes used the resident Qwythos model; the
rest fell back during cold load, timeout, or abort handling. No
`conductor_supervision` rows were produced because the delegate executor stream
bypasses the native executor loop where `checkMidLoop` is currently wired.

This run exposed two operational deadline defects:

- Qwythos cold load took about 54.4 seconds, exceeding the former 30-second
  warm-up deadline and triggering quarantine.
- Resident Qwythos routes took roughly 7-9 seconds, leaving too little margin
  under the former hard 10-second route timeout.

The implementation now uses a 90-second warm-up deadline and a 20-second
routing deadline. A behavioral test proves a 54.4-second warm-up can complete,
and another proves a route longer than 10 seconds but shorter than 20 seconds
is accepted.

### Native executor A/B

The same read-heavy `pkg_discount` fixture was replayed through the native
executor loop with delegation disabled so that mid-loop supervision was
actually exercised.

| Metric | Qwythos 9B | qwen3.5:4b |
| --- | ---: | ---: |
| Session | `tier2b-pkg_discount-1-d896f87e` | `tier2b-pkg_discount-2-d29e89f2` |
| Canonical result | Failed | Failed |
| Run outcome | Degraded | Degraded |
| Total task time | 79.5 s | 212.4 s |
| Route latency | 6,116 ms | 3,008 ms |
| Model mid-loop calls | 3 | 3 |
| Median model mid-loop latency | 2,187 ms | 1,365 ms |
| Model intervention decisions | 3/3 continue | 3/3 continue |
| Corrective quality lift | None observed | None observed |

Both models exhausted their three model escalations on early read-heavy
progress, chose `mid_loop_continue` every time, and ultimately failed the
fixture's required write. The deterministic zero-write reroute fired, but the
replacement executor also failed to produce a correct write.

The current conductor telemetry records wall-clock call latency but not
generated-token counts, so reliable tokens-per-second cannot be calculated
from these runs. Wall-clock route and supervision latency is reported instead.

## Promotion decision

No candidate is promoted:

- Qwythos demonstrated clean JSON parsing in the routing benchmark and remained
  stable under live use, but did not improve the native fixture's outcome and
  was slower than qwen for both routing and supervision.
- qwen remained faster but also failed to convert supervision into a corrective
  intervention.
- Nanbeige could not be loaded by the installed runtime.

Qwythos remains registered for later experiments. The live default remains
`qwen3.5:4b`.

## Follow-up architecture work

1. Enrich `MidLoopSignal` with bounded semantic evidence: task objective,
   current plan item, recent read targets, recent tool-result summaries,
   write-intent progress, and progress since the previous checkpoint.
2. Supervise the production `delegate_first` executor stream, or unify delegate
   and native execution behind one event loop, so the conductor is live for the
   entire implementation path.
3. Revisit escalation timing and cap accounting. Early reads can consume all
   three model escalations before the point where corrective judgment is most
   valuable, including after a deterministic reroute.
4. Add token-count telemetry to conductor attributions if throughput remains a
   model-selection criterion.
5. Resolve Nanbeige runtime compatibility or replace it with a loadable compact
   candidate before repeating the model comparison.

