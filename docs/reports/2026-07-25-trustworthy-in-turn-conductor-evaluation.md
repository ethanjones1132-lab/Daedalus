# Trustworthy In-Turn Conductor Evaluation

Date: 2026-07-25

## Verdict

Do not promote a new resident conductor model yet.

The Rung 1 and Rung 2 implementation is operational and auditable, but the
model comparison did not show a quality improvement over the current
`qwen3.5:4b` baseline. The live configuration remains on `qwen3.5:4b`, with
the in-turn driver disabled by default and Claude delegation restored to
`delegate_first`.

The highest-value next step is to put the conductor on the production
`delegate_first` path. After coverage exists, the signal and trigger need a
quality dimension: the current `MidLoopSignal` contains counters and budget
state, and `checkMidLoop` stops escalating after any successful write. That
cannot detect a mutation that landed but is behaviorally wrong.

## Implementation verification

- Full Bun suite: 1,982 passed, 0 failed, 143 files.
- TypeScript typecheck: passed.
- Mid-loop decisions are persisted in `conductor_directives`.
- Resident model calls are attributed as `stage_id='conductor_supervision'`.
- Each in-turn row now records whether it came from a deterministic reflex,
  resident-model decision, no-signal fast path, exhausted cap, or fail-open
  model error. Resident attempts share an escalation ID with their model
  attribution.
- Model attributions now retain the actual Ollama model and whether the
  configured fallback served the request.
- `force_write` is present in the production structured-output schema, not
  merely the prompt and parser.
- Deterministic reflexes remain available when the model is disabled,
  unavailable, timed out, or capped.
- Mid-loop and post-stage judgment share the existing four-inference run cap;
  mid-loop judgment may consume at most three of those calls.
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
| Run outcome | Partial | Degraded |
| Total task time | 78.7 s | 211.7 s |
| Route latency | 6,116 ms | 3,008 ms |
| Runtime mid-loop results | 11/11 continue | 15/15 continue |
| Model mid-loop calls | 3 | 3 |
| Median model mid-loop latency | 2,187 ms | 1,365 ms |
| Model intervention decisions | 3/3 continue | 3/3 continue |
| Failed `edit_file` attempts | 2 | 1 |
| Successful writes | 0 | 0 |
| Verification provenance | heuristic / none | heuristic / none |
| Corrective quality lift | None observed | None observed |

Both models exhausted their three model escalations on early read-heavy
progress and chose `mid_loop_continue` every time. The executors later proposed
the fixture's correct logical boundary edit (`>` to `>=`), but every
`edit_file` call was rejected with `old_string not found`. The persisted stage
rows record those edit turns as `was_successful=0, had_error=1`; no mutation
landed. The deterministic zero-write reroute therefore fired correctly, but
the replacement executor's edit attempt failed the same way.

The 26 total `mid_loop_continue` rows are not 26 model judgments. Six were
resident-model calls; the remaining 20 were deterministic returns after the
model cap or another fast path. These runs predate decision-source provenance,
so the historical rows cannot be split more precisely.

There is still a real structural quality gap, but these two runs did not
exercise it. `decideMidLoopIntervention` immediately continues when
`successfulWrites > 0`, and `checkMidLoop` only escalates while
`successfulWrites === 0`. A successfully applied but incorrect write would
therefore end in-turn supervision. That prospective failure mode needs a
quality-aware post-write checkpoint; it should not be misreported as the cause
of these particular A/B failures.

Both agent rows record `verified_via='heuristic'` and `check_tier='none'`.
This proves no authoritative `CheckResult` reached either run; it does not
prove the verification feature flag was disabled. The live config currently
has verification enabled, and historical config state was not persisted with
the run. With zero successful writes, the more defensible conclusion is simply
that verification supplied no usable ground-truth signal.

Historical note: these canary rows were produced before model/fallback metadata
was threaded through the supervision adapter, so their stored model ID was the
generic `supervision` label. Candidate identity in this table was cross-checked
against the active config and server logs. Future comparisons will record the
actual Ollama model and fallback flag directly.

The current conductor telemetry records wall-clock call latency but not
generated-token counts, so reliable tokens-per-second cannot be calculated
from these runs. Wall-clock route and supervision latency is reported instead.

## Promotion decision

No candidate is promoted:

- Qwythos demonstrated clean JSON parsing in the routing benchmark and remained
  stable under live use, but was slower than qwen for both routing and
  supervision.
- Neither native run produced enough corrective-supervision evidence to support
  a model-quality verdict: each candidate was observed on one fixture, both
  exhausted early escalations, and neither successfully applied its proposed
  edit.
- Nanbeige could not be loaded by the installed runtime.

Qwythos remains registered for later experiments. The live default remains
`qwen3.5:4b`. This is a no-promotion decision under insufficient evidence, not
a conclusion that either model is incapable of supervision.

## Follow-up architecture work

1. Supervise the production `delegate_first` executor stream, or unify delegate
   and native execution behind one event loop, so the conductor is live for the
   entire implementation path.
2. Add a quality-aware post-write checkpoint and enrich `MidLoopSignal` with
   bounded semantic evidence: task objective, active plan item, recent read and
   write targets, tool-result summaries, verification state, and progress since
   the previous checkpoint. A successful write must not automatically mean the
   implementation is correct.
3. Let the conductor request a bounded mid-loop check-runner invocation after a
   meaningful write or before accepting completion. Feed the authoritative
   `CheckResult` back into supervision so correction is grounded in executable
   evidence rather than model confidence.
4. Run a cheap prompt/schema control before the larger context build: require a
   `continue` directive to cite concrete progress evidence, or invert the
   default so continuing is affirmative rather than automatic. This separates
   prompt-default bias from context starvation.
5. Revisit escalation timing and cap accounting. Early reads can consume all
   three model escalations before the point where corrective judgment is most
   valuable. Reserve at least one escalation for after a deterministic reroute,
   after a successful write, or near the endgame.
6. Repeat the quality comparison at K>=3 across multiple fixtures only after
   production-path coverage and quality-aware checkpoints exist. The current
   one-fixture-per-model native replay is diagnostic, not a model verdict.
7. Add token-count telemetry to conductor attributions if throughput remains a
   model-selection criterion.
8. Resolve Nanbeige runtime compatibility or replace it with a loadable compact
   candidate before repeating the model comparison.
