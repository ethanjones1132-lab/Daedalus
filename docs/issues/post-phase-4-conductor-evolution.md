# Post–Phase 4 Conductor Evolution — Issue Backlog

Tracer-bullet vertical slices for Tracks A–D. Publish in dependency order so "Blocked by" references resolve to real issue numbers.

**Labels (suggested):** `enhancement`, `ready-for-agent` (AFK) or `ready-for-human` (HITL)

**Parent context:** Persistent Conductor Phases 1–4 complete. These issues extend KV persistence, skill distillation, conductor self-selection, and GRPO training.

---

## Dependency graph

```
A-01 ──┬──► A-02 ──► A-04
       │
       ├──► C-01 ──► C-02 ──► C-03 ──► C-04 ──► C-05
       │
       └──► B-01 ──► B-02 ──► B-03 ──► B-04

C-01 + A-02 ──► D-01 ──► D-02 (HITL) ──► D-03 ──► D-04

A-03 (HITL spike, optional parallel)
D-05 (HITL spike, only if D-03 underwhelms)
```

---

## Track A — True KV Cache Serialization

### A-01: Conductor session state contract and cache observability

**Type:** AFK  
**Blocked by:** None  
**Status:** ✅ Done (2026-06-29 afternoon, Jarvis maintenance pass)

#### What to build

Extend the local persistent Conductor with an explicit session-state contract beyond message replay: a `kv_generation` counter, prefix token estimate, and per-turn cache metrics. Wire config flags (`kv_persist`, optional `kv_backend`) and emit `conductor_cache_hit` / `prefix_tokens_recomputed` through inference metrics so `/health/inference` can show whether turn 2+ is reusing prefix work.

End-to-end: a multi-turn orchestrator session logs measurable cache behavior; tests prove metrics increment correctly.

#### Acceptance criteria

- [x] `orchestrator.conductor` config includes `kv_persist` (default true) and documents storage layout under `sessions/conductor/`
- [x] Each conductor turn records prefix vs delta token estimates in inference metrics
- [x] Unit tests cover session state serialization round-trip (messages + metadata)
- [x] Existing coordinator tests pass unchanged

**Implementation summary:** the conductor cache observability ring (`recordConductorCache` + `conductorCacheSnapshot` in `server-jarvis/src/orchestration/conductor-metrics.ts`) was already capturing the right per-turn data (`conductor_cache_hit`, `prefix_tokens_estimated`, `delta_tokens_estimated`, `prefix_tokens_recomputed`, `kv_generation`). The actual gap was that the data was only exposed at the standalone `/health/conductor-cache` endpoint — the main `/health/inference` snapshot (used by `SystemHealthView`) didn't see it. Fix in commit `fix(track-a): wire conductor cache observability through /health/inference`:
1. New `ConductorCacheSummary` type in `server-jarvis/src/inference-metrics.ts`; new `conductor_cache: ConductorCacheSummary | null` field on `InferenceMetricsSnapshot`.
2. `inferenceMetricsSnapshot()` calls `conductorCacheSnapshot()` at runtime; surfaces `null` when `window_size === 0` so the UI can distinguish "no data" from a real bad measurement (avoids the "0% hit rate on a fresh process" trap).
3. Full JSDoc block on `ConductorConfig.kv_persist` in `server-jarvis/src/config.ts` documenting `<SESSIONS_DIR>/conductor/<sanitized-sessionId>.json` layout, sanitization rule (`[^a-zA-Z0-9._-] → _`), the complete `ConductorSessionState` schema, `session_ttl_ms` pruning, and `MAX_SESSIONS = 256` in-memory cap.
4. 3 new bun tests in `inference-metrics.test.ts` (now 374 total, was 371): null-when-empty, populated shape (window_size=2, cache_hit_rate=0.5, avg_prefix_recomputed=400, full records array), and that backend stats and conductor cache coexist without double counting. Both tsc jobs clean, 59 cargo tests pass.

**Follow-up not in this pass:** UI's `InferenceMetrics` interface in `src-ui/src/components/jarvis/SystemHealthView.tsx` doesn't yet declare `conductor_cache` — TypeScript structural typing makes this safe (extra server fields are ignored), so existing dashboard keeps working. Surfacing the field in a `ConductorView`/`SelfImprovementView` panel is a low-risk follow-up.

---

### A-02: Ollama prefix reuse — delta-only turn appends

**Type:** AFK  
**Blocked by:** A-01
**Status:** ✅ Done (2026-06-29 evening, Jarvis maintenance pass)

#### What to build

Optimize `PersistentConductor` so multi-turn routing minimizes redundant prefix computation: track cached prefix length, append only new user/assistant pairs, and measure reuse rate. On Bun restart, reload warm session JSON and avoid rebuilding system prompt when unchanged.

End-to-end: turn 2+ conductor latency improves measurably vs cold replay; metrics show >80% prefix reuse on 3-turn sessions in tests.

#### Acceptance criteria

- [x] Turn 2+ does not re-push system prompt if unchanged
- [x] `conductor_cache_hit` true on subsequent turns in same session (test)
- [x] Session reload after simulated restart preserves turn history and continues appending
- [x] Fallback to API coordinator still works when Ollama unavailable

**Implementation summary:** the prefix-reuse machinery (`session.systemPromptHash`, `kvGeneration`, `apiFallbackUsed`, `prefixTokensRecomputed`, delta-only push of new user/assistant pairs, `markApiFallback()` rebuild trigger) was already in place from the Phase 4 Persistent Conductor commit. This pass verified the four A-02 acceptance criteria with three new focused bun tests in `server-jarvis/src/orchestration/persistent-conductor.test.ts`:

1. `achieves >80% prefix reuse across a 3-turn session (Track A-02 acceptance)` — pins that turn 1 is a cold prefix (`prefixTokensRecomputed > 0`), turns 2 + 3 are warm cache hits (`prefixTokensRecomputed === 0`), the 4-turn cache hit rate clears the >80% target, and the total recompute budget across the session is bounded by one cold turn's prefix.
2. `turn 2 conductor chat request does not re-push system prompt if unchanged (Track A-02 acceptance)` — captures the wire body of each Ollama call, asserts each body has exactly one system message, that the system content is byte-identical across all three turns, and that the body length grows by exactly two messages per turn (one user + one assistant) instead of duplicating the system.
3. `recovers warm prefix after a mid-session API fallback (Track A-02 acceptance)` — pins the A-02 + A-04 interaction in one flow: cold local turn → markApiFallback → next local turn rebuilds (`cacheHit=false`, `prefixTokensRecomputed>0`) → following local turn is warm again (`cacheHit=true`, `prefixTokensRecomputed===0`).

The 4th acceptance criterion (API fallback when Ollama unavailable) is already covered by `coordinator.test.ts > falls back to API coordinator when local conductor is unavailable`. 377 bun tests pass (+3), 59 cargo tests pass, both tsc jobs clean.

---

### A-03: llama.cpp conductor sidecar spike (HITL)

**Type:** HITL  
**Blocked by:** A-02

#### What to build

Spike whether a dedicated `llama-server` sidecar for the conductor can beat Ollama on prefix reuse and latency via true KV state save/restore. Produce a short ADR: adopt sidecar, stay on Ollama, or defer.

Not a production integration — decision artifact only.

#### Acceptance criteria

- [ ] Runnable spike script or doc with measured p50/p95 for turn 1 vs turn 2+
- [ ] ADR in `docs/adr/` with recommendation and VRAM/latency tradeoffs
- [ ] Clear go/no-go for A-04 implementation path

---

### A-04: KV lifecycle — reset, TTL, and fallback safety

**Type:** AFK
**Blocked by:** A-02
**Status:** ✅ Done (2026-06-30 morning, Jarvis maintenance pass)

#### What to build

Wire conductor KV/session cleanup into existing session reset and TTL paths. Ensure API fallback never corrupts in-flight session state. Prune cold session files for inactive sessions per `session_ttl_ms`.

End-to-end: session reset clears conductor state; expired sessions prune disk; no stale routing after reset.

#### Acceptance criteria

- [x] Session reset (existing path in `index.ts`) clears conductor memory + disk state
- [x] TTL pruning removes inactive `sessions/conductor/` entries
- [x] Test: fallback to API mid-session → next local turn recovers cleanly
- [x] No writes to shared Windows `jarvis.db` for conductor KV blobs

**Implementation summary:** the three behavioral guarantees (session reset → state cleared, disk TTL pruning, mid-session API fallback recovery) were already wired from earlier passes — `persistent-conductor.clearSession` is called from `index.ts` line 3099 (the `POST /sessions/:sid/interaction` reset path), `pruneExpiredDiskSessions` is called from `index.ts` line 1186 at orchestrator session start, and the mid-session API fallback recovery is the existing A-02 test `recovers warm prefix after a mid-session API fallback`. The work for this pass was **pinning the contract with 4 new focused bun tests** in `server-jarvis/src/orchestration/persistent-conductor.test.ts` so any future regression that re-routes KV blobs through `jarvis.db`, drops TTL pruning, or breaks the reset path is caught immediately:

1. `A-04: clearSession removes both in-memory state and disk file (Track A-04 acceptance)` — confirms a routed turn leaves a JSON file under `<sessions_root>/conductor/<sid>.json`, that `clearSession` removes both the in-memory entry and the on-disk file, and that the next `routeTurn` after reset is a cold start (`cacheHit=false`, `kvGeneration=1`, `prefixTokensRecomputed > 0`).
2. `A-04: pruneExpiredDiskSessions removes only files older than session_ttl_ms (Track A-04 acceptance)` — seeds two session JSON files in an isolated `tempRoot` with `utimes`-forced mtimes (one 2 hours stale, one just-now), runs the prune, and asserts exactly the stale one is removed and the fresh one is kept.
3. `A-04: pruneExpiredDiskSessions is a no-op when both persist_sessions and kv_persist are disabled (Track A-04 acceptance)` — pins the `kv_persist || persist_sessions` short-circuit so a fully-off config never touches the disk.
4. `A-04: conductor never references the shared jarvis.db SQLite store (Track A-04 acceptance)` — guards the layout invariant: every file under the conductor directory is `.json`, no `.db`/`.sqlite`/`.sqlite3` files appear, and the filename sanitization rule is unchanged.

381 bun tests pass (+4), 59 cargo tests pass, both tsc jobs clean.

---

## Track C — Skill Distillation from Trajectories

### C-01: Trajectory-to-skill candidate extractor

**Type:** AFK  
**Blocked by:** None (Phase 4 `trajectory_snapshots` exists)

#### What to build

New distillation module that reads successful `trajectory_snapshots` from `self-tuning.db` and emits `SkillCandidate` records: trigger patterns (task_type + turn-requirement signals), distilled worker-instruction templates, successful tool sequences, and failure avoidances. Hook post-`conductorLearning.completeRun()` when `run_outcome === "success"`.

End-to-end: successful orchestrator run produces a logged/stored skill candidate (status `candidate`, not enabled).

#### Acceptance criteria

- [ ] Extractor runs only on `success` outcomes with non-empty trajectories
- [ ] Candidate includes `trigger`, `body` (markdown), `source_run_ids`, `confidence`
- [ ] Unit tests with fixture trajectory JSON
- [ ] No auto-enable — candidates stay inert until C-04

---

### C-02: Persist skill candidates via native skills surface

**Type:** AFK  
**Blocked by:** C-01

#### What to build

Bridge Bun distillation output to the Tauri native skills store (SQLite). Add `POST /skills/synthesize` (or Tauri command) that writes a skill revision with `source_session_id`, `change_reason: trajectory_distillation`, and `enabled: false`. Unify Bun `loadSkills()` stub with native skill list for orchestrator reads.

End-to-end: distillation creates a row visible in `SkillsView` as a disabled candidate.

#### Acceptance criteria

- [ ] Candidate skill appears in `list_skills()` / `SkillsView` with correct metadata
- [ ] `skill_revisions_list` shows distillation provenance
- [ ] Bun and native stores do not diverge on skill identity
- [ ] Existing bundled skills unchanged

---

### C-03: SkillResolver — inject promoted skills into orchestration

**Type:** AFK  
**Blocked by:** C-02

#### What to build

`SkillResolver` matches enabled skills to incoming turns (task_type + `classifyTurnRequirements` signals). Matched skill bodies merge into conductor turn context and worker stage prompts (below conductor custom instructions, above static `.md` baselines). Executor and planner stages first.

End-to-end: manually enable a test skill → next matching turn's executor prompt includes skill body.

#### Acceptance criteria

- [ ] Trigger matching unit tests (task_type + signal overlap)
- [ ] `resolveStagePrompt` receives skill appendix when matched
- [ ] Conductor turn receives skill summary in memory hints block
- [ ] Unmatched turns behave identically to pre-C-03

---

### C-04: Eval-gated skill promotion harness

**Type:** AFK  
**Blocked by:** C-03

#### What to build

Extend `eval/harness.ts` with skill cases: trigger firing, regression (baseline score with skill OFF vs ON), grounding (no invented paths in skill body). Promotion flow: candidate → eval delta ≥ threshold → `enabled: true`; else stays candidate.

End-to-end: one fixture skill promotes through eval; one bad skill fails and stays disabled.

#### Acceptance criteria

- [ ] New eval case kinds: `skill_trigger`, `skill_regression`, `skill_grounding`
- [ ] `baseline.json` updated with skill cases
- [ ] Promotion API/command toggles `enabled` only on pass
- [ ] CI fails on skill regression

---

### C-05: SelfImprovementView cockpit for skill candidates

**Type:** AFK  
**Blocked by:** C-04

#### What to build

Wire `SelfImprovementView` (or extend `SkillsView` candidate panel) to show: recent distillations, eval pass/fail per skill, eval delta, one-click enable/disable/revert via `skill_restore_revision`.

End-to-end: user sees distilled candidate, eval result, and can approve or revert without CLI.

#### Acceptance criteria

- [ ] UI lists candidates with `source_session_id` and eval status
- [ ] Enable/disable calls native commands
- [ ] Revert restores prior revision
- [ ] Empty state when no candidates

---

## Track B — Conductor Recursive Self-Selection

### B-01: Routing schema — `conductor_replan` decision type

**Type:** AFK  
**Blocked by:** A-02  
**Status:** ✅ Done (2026-06-30 evening, Jarvis maintenance pass)

#### What to build

Extend coordinator routing schema (`conductor-routing.ts`, `CoordinatorResult`, `route-normalization.ts`) with `conductor_replan` as a first-class routing decision. Update `coordinator.md` with when to self-replan vs delegate. Parse, validate, and normalize without stripping on `workspace_read` turns.

End-to-end: fixture routing JSON with `conductor_replan` validates and survives normalization.

#### Acceptance criteria

- [x] Gemma `route_pipeline` tool schema includes replan field/stage
- [x] `Coordinator.validate()` accepts replan decisions
- [x] `normalizeRoute` preserves replan where appropriate
- [x] New coordinator unit tests

---

### B-02: Pipeline `conductor_replan` stage (vertical slice)

**Type:** AFK  
**Blocked by:** B-01

#### What to build

Implement `conductor_replan` as a non-user-visible pipeline stage: feed conductor original request + summarized stage outputs; receive revised `worker_instructions`, `pipeline`, `shared_context`; re-materialize remaining stages. Enforce intra-workflow isolation (summaries, not raw tool trajectories).

End-to-end: forced replan in test fixture re-runs executor with updated instructions and completes.

#### Acceptance criteria

- [x] Replan stage calls local persistent conductor
- [x] Revised worker instructions flow to subsequent stages
- [x] `read_only` execution profile cannot escalate to `full`
- [x] SSE `orchestrator_stage` events include replan (internal status)

---

### B-03: Migrate recursive topology to conductor-native replan

**Type:** AFK  
**Blocked by:** B-02

#### What to build

Replace hardcoded `recursion_critique` → executor re-enter with conductor-decided re-enter targets (`planner`, `executor`, `conductor_replan`). Shared `max_recursion_depth` budget across re-enter types. Deprecate `recursion-critique.md` path for new recursive runs.

End-to-end: recursive topology test completes via conductor replan; existing recursion SSE frames still emit.

#### Acceptance criteria

- [ ] Conductor chooses re-enter target from critique context
- [ ] Depth cap applies to all re-enter types
- [ ] `orchestrator_recursion` SSE unchanged for UI consumers
- [ ] Eval/regression tests for recursive topology pass

---

### B-04: Replan telemetry and safety bounds

**Type:** AFK  
**Blocked by:** B-03

#### What to build

Record replan events in `conductor_runs` and `trajectory_snapshots`. Configurable caps: max replans per turn, max `conductor_replan` per session. Feed replan outcomes into `conductor-learning` aggregates.

End-to-end: telemetry row exists per replan; cap prevents infinite loop in test.

#### Acceptance criteria

- [ ] `conductor_runs` or new table captures replan count and outcome
- [ ] Config: `max_replans_per_turn`, `max_conductor_replans_per_session`
- [ ] Test proves loop terminates at cap
- [ ] Replan failures degrade gracefully (surface synthesizer answer)

---

## Track D — GRPO Conductor Training

### D-01: Trajectory corpus export and composite reward

**Type:** AFK  
**Blocked by:** C-01, A-02

#### What to build

Export `trajectory_snapshots` → GRPO JSONL with composite reward: run outcome, eval replay pass, user rating, token efficiency, stage error absence. CLI command `bun run src/training/export-corpus.ts`. Filter low-quality rows.

End-to-end: export produces valid JSONL; reward in [0,1]; documents field schema.

#### Acceptance criteria

- [ ] JSONL schema documented in module header
- [ ] Reward weights configurable
- [ ] Export skips `failed`/`degraded` below quality threshold
- [ ] Unit test on fixture trajectories

---

### D-02: Offline GRPO training sandbox (HITL)

**Type:** HITL  
**Blocked by:** D-01

#### What to build

Isolated training pipeline (not production Bun): ingest JSONL, fine-tune LoRA on `gemma4:e2b` for routing + `worker_instructions` jointly, output `gemma4:e2b-jarvis-r1` importable to Ollama. Document GPU requirements, training command, rollback.

End-to-end: one training run completes on exported corpus; model loads in Ollama.

#### Acceptance criteria

- [ ] Training scripts live under `server-jarvis/training/` (or `tools/training/`)
- [ ] README with hardware requirements and steps
- [ ] Never writes to production `self-tuning.db`
- [ ] Checkpoint tagged and importable

---

### D-03: Checkpoint promotion gate vs baseline conductor

**Type:** AFK  
**Blocked by:** D-02

#### What to build

Promotion workflow: import checkpoint → run full eval harness + coordinator smoke cases → compare JSON parse rate, routing accuracy, answer quality vs baseline `gemma4:e2b` → update `orchestrator.conductor.model` only on positive delta.

End-to-end: promotion script outputs pass/fail report; config unchanged on fail.

#### Acceptance criteria

- [ ] Promotion script runs eval + records comparison table
- [ ] Requires explicit flag to write config (`--promote`)
- [ ] Rollback documented (revert model tag)
- [ ] No auto-promote on training complete

---

### D-04: Shadow-deploy conductor A/B

**Type:** AFK  
**Blocked by:** D-03

#### What to build

Route configurable % of sessions to candidate conductor model; compare rolling 7-day rewards via `conductor-learning`. Integrate with inference metrics for shadow latency/error.

End-to-end: 10% shadow mode runs without user-visible regression; metrics dashboard shows A vs B.

#### Acceptance criteria

- [ ] Config: `conductor.candidate_model`, `shadow_fraction`
- [ ] Shadow runs tagged in `conductor_runs.conductor_source`
- [ ] Auto-promote only via D-03 gate, not shadow alone
- [ ] Tests for shadow routing selection

---

### D-05: TRINITY-style evolutionary routing head spike (HITL)

**Type:** HITL  
**Blocked by:** D-03

#### What to build

If GRPO improvement <5% after two cycles, spike frozen-embedding + CMA-ES routing head (~10K params) optimized on eval reward. ADR: pursue, defer, or reject.

#### Acceptance criteria

- [ ] Spike code or notebook with eval reward curve
- [ ] ADR comparing GRPO vs evolutionary approach
- [ ] Recommendation for D-04 follow-up or close

---

## Publish commands

After `gh auth login`, run from repo root (adjust labels to match your tracker):

```bash
# Track A
gh issue create --title "A-01: Conductor session state contract and cache observability" --label "enhancement,ready-for-agent" --body-file docs/issues/bodies/a-01.md
# ... etc
```

Or batch-create from this doc manually. Suggested milestone: **Conductor Evolution v2**.

## Suggested pick-up order for AFK agents

1. A-01 → A-02 → A-04 (foundation)
2. C-01 → C-02 → C-03 → C-04 → C-05 (highest compound return)
3. B-01 → B-02 → B-03 → B-04 (after A-02)
4. D-01 → (human: D-02) → D-03 → D-04