# Track B-03 recommendation — 2026-07-10

## Recommendation: do not expand or “finish” B-03 now

Treat B-03 as partial scaffolding and correct its roadmap status before adding more recursive behavior. The present code does not meet the stated conductor-native end-to-end contract, and the measured latency/reliability data makes extra model calls a poor default investment today.

## Why

The roadmap marks B-03 done and says a recursive critic can select `planner`, `executor`, or `conductor_replan`. Planner and executor re-entry work. The `conductor_replan` branch does not re-invoke the conductor: `PipelineExecutor.reenterForRecursion` emits a typed recursion event and returns the current result. `index.ts` enters `runPipelineWithReplanning` only when the original Coordinator route already contains `conductor_replan`. A decision produced later by the recursive critic cannot reach that loop. The existing test explicitly proves that no further stage runs after this critic decision.

This is useful wire-format/UI scaffolding, but it is not “recursive topology migrated to conductor-native replan.” `recursion-critique.md` also remains the active critic prompt despite documentation saying that path is deprecated/replaced.

The live telemetry provides no evidence that completing the handoff would pay for itself:

- zero live `replan_events` were present in the audited corpus;
- planner p50/p95 was 31.2/63.2 seconds;
- synthesizer p50/p95 was 22.4/132.9 seconds;
- overall run p95 was 273.2 seconds;
- coordinator parse fallback still occurred in the final live workspace probe and consumed 13.4 seconds;
- the corpus has no user ratings and no eval replay map to prove that recursive replanning improves quality.

Adding an actual conductor call at the critic boundary today would introduce another high-variance inference hop into a path whose tail and quality benefit are not measured.

## What should happen first

1. Land and operate the new coordinator-inclusive latency and first-token telemetry long enough to obtain a representative sample.
2. Add an eval fixture comparing no replan, planner re-entry, executor re-entry, and true conductor replan on the same tasks.
3. Define one shared budget across recursive depth, per-turn conductor replans, and per-session replans; no branch may double-count or escape it.
4. Replace the current no-op with an explicit handoff contract into the bounded replan loop, including parse-fallback and empty-output behavior.
5. Require end-to-end tests that invoke the persistent conductor, apply revised worker instructions, preserve the least-authority execution profile, emit the existing SSE fields, and record a `replan_event`.
6. Gate activation on measured quality gain large enough to justify added p95 latency; keep the current path off by default until that gate passes.

## Decision rule

Resume B-03 only when a replay/eval cohort shows a statistically credible quality or recovery gain and a bounded latency cost. With today's data, the correct engineering decision is to stabilize routing, grounding, and telemetry first, not add another model-backed recursion hop.

