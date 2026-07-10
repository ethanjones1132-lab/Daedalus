# Jarvis Performance and Reliability Five-Front Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Diagnose and repair Jarvis turn latency, Windows startup/supervision, repository grounding, and Track D trajectory export with measured evidence, then conditionally resolve `codex/jarvis-live-p0a` and issue a data-backed Track B-03 recommendation.

**Architecture:** Keep the native UI -> Tauri command -> Bun server -> inference backend path intact. Add opt-in Bun runtime instrumentation and a deterministic metrics feedback policy at the Server-side runtime boundary; let the Native surface schedule that refresh through its existing cron scheduler. Keep startup/supervisor fixes in Rust, grounding enforcement in orchestration modules, and corpus verification in the existing training boundary.

**Tech Stack:** Bun 1.3, TypeScript 6, `bun:sqlite`, Node-compatible `perf_hooks`, Python 3 `sqlite3`, Rust/Tokio/Tauri 2, React/Vite, SQLite.

## Global Constraints

- Do not widen another timeout constant as the Front 1 fix.
- Preserve all four `PipelineExecutor` topologies: `linear`, `speculative_parallel`, `speculative_cascade`, and `recursive`.
- Preserve the Track D JSONL trajectory contract in `server-jarvis/src/training/corpus.ts`.
- Establish root cause and a failing regression test before each production behavior change.
- Treat current logs, live listeners, the live self-tuning database, and fresh builds/tests as authoritative when docs diverge.
- Do not merge, rebase, force-push, or rewrite `master` until Fronts 1-4 reconverge and the Front 5 gates have all passed.

---

### Task 1: Baseline and Runtime Latency Instrumentation

**Files:**
- Create: `server-jarvis/src/performance/runtime-monitor.ts`
- Create: `server-jarvis/src/performance/runtime-monitor.test.ts`
- Modify: `server-jarvis/src/index.ts`
- Create: `docs/reports/2026-07-10-jarvis-latency-and-event-loop.md`

**Interfaces:**
- Produces: `startRuntimeMonitor(options): RuntimeMonitor`, `RuntimeMonitor.snapshot(): RuntimePerformanceSnapshot`, and per-turn/stage measurement records.
- Consumes: `monitorEventLoopDelay`, `performance.eventLoopUtilization`, current process resource usage, and existing stage/run telemetry.

- [ ] **Step 1: Write failing monitor contract tests**

```ts
test("snapshot reports bounded millisecond percentiles and resets the interval", () => {
  const monitor = createRuntimeMonitorForTest(fakeHistogram, fakeClock);
  expect(monitor.snapshot()).toMatchObject({ event_loop_delay_ms: { p50: 2, p95: 8, p99: 12 } });
});
```

- [ ] **Step 2: Verify the focused test is red**

Run: `cd server-jarvis && bun test src/performance/runtime-monitor.test.ts`

Expected: FAIL because the runtime-monitor module/API does not exist.

- [ ] **Step 3: Implement the opt-in monitor and health snapshot**

```ts
export interface RuntimePerformanceSnapshot {
  window_started_at: string;
  event_loop_delay_ms: { min: number; mean: number; p50: number; p95: number; p99: number; max: number };
  event_loop_utilization: number;
  process_cpu_ms: { user: number; system: number };
  rss_bytes: number;
}
```

Wire it at Bun server startup behind `JARVIS_PERF_MONITOR=1`, log interval snapshots as structured `Jarvis_Perf` records, and expose a read-only `/performance/runtime` snapshot endpoint for live capture.

- [ ] **Step 4: Run monitor tests and typecheck green**

Run: `cd server-jarvis && bun test src/performance/runtime-monitor.test.ts && bun run typecheck`

Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 5: Execute the live playbook and CPU profile**

Run the loaded Bun server with the monitor enabled and a CPU profile, exercise `/chat/stream` with conversational, repository-read, and full-execution probes, capture p50/p95/p99 event-loop lag plus stage/run wall time, and inspect the hottest profile frames. Record exact commands, environment, runtime provenance, and numbers in the report.

### Task 2: Classifier-Driven Simple-Turn Short Circuit

**Files:**
- Modify: `server-jarvis/src/orchestration/turn-requirements.ts`
- Modify: `server-jarvis/src/orchestration/turn-requirements.test.ts`
- Modify: `server-jarvis/src/orchestration/route-normalization.ts`
- Modify: `server-jarvis/src/orchestration/route-normalization.test.ts`
- Modify: `server-jarvis/src/index.ts`

**Interfaces:**
- Produces: `shortCircuitRouteFor(requirement): CoordinatorResult | undefined` for `conversational` and simple `answer_only` turns.
- Consumes: the raw-message `classifyTurnRequirements` result before any Coordinator inference call.

- [ ] **Step 1: Add failing route tests**

```ts
test("conversation bypasses coordinator and executes synthesizer only", () => {
  expect(shortCircuitRouteFor("conversational")?.pipeline).toEqual(["synthesizer"]);
});
```

- [ ] **Step 2: Verify red**

Run: `cd server-jarvis && bun test src/orchestration/turn-requirements.test.ts src/orchestration/route-normalization.test.ts`

Expected: FAIL because no pre-Coordinator short-circuit exists.

- [ ] **Step 3: Implement the minimum route bypass**

Classify the raw message before `coordinator.route()`. For `conversational`, construct the canonical synthesizer-only route without calling the Coordinator. For `answer_only`, bypass only when no continuation inheritance or explicit orchestration signal requires a richer route. Continue using `normalizeRoute` and existing run telemetry so the shortcut remains observable.

- [ ] **Step 4: Verify focused and orchestration suites**

Run: `cd server-jarvis && bun test src/orchestration/turn-requirements.test.ts src/orchestration/route-normalization.test.ts src/orchestration.test.ts`

Expected: all pass, with existing workspace-read/full-execution contracts unchanged.

### Task 3: Metrics Report to Routing/Timeout Feedback Loop

**Files:**
- Modify: `automate_inference_metrics.py`
- Create: `tests/test_automate_inference_metrics.py`
- Create: `server-jarvis/src/self-tuning/inference-feedback.ts`
- Create: `server-jarvis/src/self-tuning/inference-feedback.test.ts`
- Modify: `server-jarvis/src/self-tuning/learned-pool-state.ts`
- Modify: `server-jarvis/src/orchestration/agent-pool.ts`
- Modify: `server-jarvis/src/orchestration/agent-pool.test.ts`
- Modify: `server-jarvis/src/index.ts`
- Modify: `src-tauri/src/db/migrations.rs`
- Modify: `src-tauri/src/cron_scheduler.rs`
- Modify: `scripts/build-and-deploy.ps1`

**Interfaces:**
- Produces: a versioned JSON policy containing per-stage/model sample count, success rate, p50/p95 duration, routing penalty/boost, and a bounded empirical first-token budget.
- Consumes: `%USERPROFILE%/.openclaw/jarvis/self-tuning.db` tables `agent_runs`, `stage_runs`, `model_attributions`, and `tuning_proposals`.

- [ ] **Step 1: Add a failing Python fixture test for the real schema**

```py
def test_collect_metrics_uses_duration_ms_and_model_attributions(tmp_path):
    db = seed_real_schema(tmp_path / "self-tuning.db")
    report = collect_metrics(db, days=7)
    assert report["stages"]["synthesizer"]["p95_duration_ms"] == 30000
    assert report["models"]["openrouter:test"]["sample_count"] == 2
```

- [ ] **Step 2: Verify Python red**

Run: `python -m unittest tests.test_automate_inference_metrics -v`

Expected: FAIL because the current script points at `jarvis.db` and queries nonexistent `model`/`duration` columns.

- [ ] **Step 3: Correct collection and emit a stable policy**

Use the real self-tuning DB by default, compute explicit percentile interpolation, avoid keys/secrets in output, write JSON atomically, and include a `schema_version` plus `generated_at`/window metadata.

- [ ] **Step 4: Add failing Bun tests for policy ingestion**

```ts
test("empirical feedback demotes a slow failing model and supplies its bounded timeout", () => {
  applyInferenceFeedback(fixturePolicy);
  expect(pool.pickFor("synthesizer", "general")?.id).toBe("fast-model");
  expect(firstTokenTimeoutFor(pool, "slow-model", 30_000)).toBe(42_000);
});
```

- [ ] **Step 5: Verify Bun red, then implement policy ingestion**

Run: `cd server-jarvis && bun test src/self-tuning/inference-feedback.test.ts src/orchestration/agent-pool.test.ts`

Expected before implementation: FAIL. After implementation: PASS, with minimum-sample gates, expiry, and clamps preventing noisy data from destabilizing routing.

- [ ] **Step 6: Seed and dispatch the actual cron refresh**

Add an idempotent disabled-safe system cron job with a stable ID and schedule. Its `/cron/run` dispatch must execute the deterministic metrics refresh path (not ask an inference backend to decide whether to do it), load the newly written policy into the Bun runtime, and log/record success or a concrete error.

- [ ] **Step 7: Verify cron and packaging paths**

Run: `cd src-tauri && cargo test cron_scheduler -- --nocapture`

Run: `cd server-jarvis && bun test src/cron-runtime.test.ts src/self-tuning/inference-feedback.test.ts`

Expected: seeded job is idempotent, deterministic refresh is dispatched, report is loaded, and deploy packaging includes the metrics script.

### Task 4: Windows Boot and Supervisor Reliability

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/supervisor.rs`
- Modify: `src-tauri/src/commands/system.rs`
- Modify tests colocated in those Rust modules
- Modify diagnostics UI only if required by the structured status contract

**Interfaces:**
- Produces: non-blocking startup dispatch plus durable structured supervisor exhaustion/recovery state and a bounded restart policy.

- [ ] **Step 1: Pin current blocking and exhaustion behavior with failing Rust tests.**
- [ ] **Step 2: Run the focused tests red.**
- [ ] **Step 3: Move blocking probes/spawns off async/WebView worker paths and add bounded backoff/restart diagnostics.**
- [ ] **Step 4: Run focused Rust tests, `cargo test --workspace`, and a launch-time smoke.**

### Task 5: Evidence-Enforced Repository Grounding

**Files:**
- Modify: `server-jarvis/src/orchestration/pipeline.ts`
- Modify: `server-jarvis/src/orchestration/worker-prompt.ts`
- Modify: `server-jarvis/src/orchestration/coordinator.ts` if required by traced context loss
- Modify: `server-jarvis/src/index.ts` only for the minimum turn-requirement option wiring
- Add/modify focused tests beside each module

**Interfaces:**
- Produces: workspace-read execution that cannot be marked successful without at least one successful repository evidence tool result; shared context remains present even without custom worker instructions.

- [ ] **Step 1: Reproduce the zero-tool workspace-read hallucination and context-loss paths in tests.**
- [ ] **Step 2: Run focused tests red.**
- [ ] **Step 3: Add a bounded evidence requirement/retry or explicit failure path and retain shared context through prompt resolution.**
- [ ] **Step 4: Run grounding, pipeline, route, and live repo-read probes green.**

### Task 6: Track D Export Health

**Files:**
- Inspect/modify: `server-jarvis/src/training/corpus.ts`
- Inspect/modify: `server-jarvis/src/training/export-corpus.ts`
- Modify: `server-jarvis/src/training/corpus.test.ts` only through failing-first coverage
- Create: `docs/reports/2026-07-10-track-d-health.md`

**Interfaces:**
- Produces: a verified JSONL export from real trajectory snapshots and a precise downstream-consumer trace without changing the schema.

- [ ] **Step 1: Export a dry-run sample from the live self-tuning DB and validate join/count/reward invariants.**
- [ ] **Step 2: Trace every repository consumer of the JSONL output.**
- [ ] **Step 3: If broken, write a focused red test, implement only the root fix, and run green.**
- [ ] **Step 4: Record real sample counts, rejected rows, serialization checks, and consumption status.**

### Task 7: Reconvergence, Full Verification, and Track B-03

**Files:**
- Modify: `docs/reports/2026-07-10-jarvis-latency-and-event-loop.md`
- Create: `docs/reports/2026-07-10-track-b03-recommendation.md`

- [ ] **Step 1: Review all workstream diffs for collisions and architecture drift.**
- [ ] **Step 2: Run `server-jarvis` full tests/typecheck/build, UI tests/build, Rust workspace tests/build, and the existing eval gate with no skips.**
- [ ] **Step 3: Re-run live instrumented turns and compare stage wall time to event-loop delay/CPU samples.**
- [ ] **Step 4: Audit current B-03 code/docs against measured recursive/replan cost and write a one-page recommendation.**

### Task 8: Conditional `codex/jarvis-live-p0a` Resolution

**Files:**
- Inspect: `git diff master...codex/jarvis-live-p0a`
- Inspect: `PRIORITIES.md`
- No source edits unless required to resolve a verified non-conflicting merge

- [ ] **Step 1: Prove ancestry/divergence and enumerate exact branch-only commits/files.**
- [ ] **Step 2: Cross-check branch content against Fronts 1-4 and `PRIORITIES.md`.**
- [ ] **Step 3: Test the exact merged candidate with the complete existing test surface.**
- [ ] **Step 4: Merge normally only if all three operator gates pass; otherwise write the exact blocking report and leave history untouched.**
