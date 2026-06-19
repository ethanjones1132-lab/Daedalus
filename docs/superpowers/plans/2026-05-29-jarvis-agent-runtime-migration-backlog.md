
# Jarvis Agent Runtime Migration Backlog (Comprehensive)

## Goal
Build a Jarvis-native, file-canonical agent system where `soul.md` is canonical, runtime state is projected, tool execution is unified in server-side runtime, and donor capabilities are adapted through a strict transplant gate.

## Architectural Constraints (Locked)
- Canonical target: Jarvis runtime architecture.
- Canonical agent definition: `agents/<slug>/soul.md` (identity-only).
- Runtime state: lean projection with provenance, never a second source of truth.
- Single tool runtime: one server-side contract for chat, cron, internal agent runs, and external adapters.
- Surface variance: execution context, not tool variants.
- Permission enforcement: runtime policy, not `soul.md`.
- First slice: Agent lifecycle + Tool runtime + Search bundle.
- Phase boundaries:
  - Phase 1: core proof only.
  - Phase 2A: MCP exposure.
  - Phase 2B: cron integration.
- Adaptation rule: transplant only if transplant gate passes.

## Transplant Gate (Must Pass All)
1. Proven parity gain over current Jarvis behavior.
2. Clean fit into Jarvis Tool runtime and Execution context.
3. Lower long-term maintenance cost than fresh reimplementation.

If any criterion fails: default to behavior-first reimplementation.

## Done Gate for Phase 1 (Must Pass All)
1. Functional gate: file-backed agent runs end-to-end through search bundle.
2. Safety gate: permission policy correctly enforces deny/ask constraints including non-interactive contexts.
3. Stability gate: activation boundary prevents in-flight mutation; projection updates are deterministic.

---

---
## Current Position — 2026-05-29

**Phase 2B complete. Next: Tier A rollout (core coding loop).**

All Phase 1 tickets done and gate verified (139/139 tests green, CI wired):
- [x] P1-01 agent-schema.ts — `parseSoulFile`, SHA-256 provenance, 4 error codes
- [x] P1-02 config.ts — `agents_root`, default path, `validateAgentsRootPath`
- [x] P1-03 agent-lifecycle.ts — `createLifecycleService`, scan/activate, collision/stale/removal
- [x] P1-04 projection-store.ts — `createProjectionStore`, DDL in migrations.rs
- [x] P1-05 activation-boundary.ts — `establishBoundary`, `restoreBoundary`, `isStale`
- [x] P1-06 tool-runtime.ts — `createToolRuntime`, `ToolResult` envelope
- [x] P1-07 tool-runtime.ts — `ExecutionContext`, `makeExecutionContext` factory
- [x] P1-08 tool-runtime.ts — `evaluatePolicy`, enforced in `execute()`
- [x] P1-09 search-bundle.ts — `registerSearchBundle` (read_file, glob, grep)
- [x] P1-10 phase1-gate.test.ts — FUNCTIONAL/SAFETY/STABILITY gates green; CI enforced

Phase 2A complete (160/160 tests green):
- [x] P2A-01 mcp-adapter.ts — `createMcpAdapter(runtime, cfg)`, tools/list + tools/call via canonical runtime
- [x] P2A-02 mcp-adapter.ts — `MCP_SCHEMA_VERSION`, `_meta.schemaVersion`, additive-change parity tests
- [x] P2A-03 mcp-adapter.ts — MCP surface=non-interactive, policy parity vs agent surface confirmed
- [x] `/mcp` HTTP endpoint wired in index.ts (POST JSON-RPC, GET tool list)

Phase 2B complete (195/195 tests green):
- [x] P2B-01 cron-runtime.ts — `createCronRuntime`, `CronRunRequest`, `CronRunContext`; non-interactive ExecutionContext, projection snapshot binding via `restoreBoundary()`, tool dispatch through canonical ToolRuntime
- [x] P2B-01 cron_scheduler.rs — updated `dispatch_cron_job()` to POST `/cron/run` (JSON body + JSON response); `ProjectionSnapshot` struct; `query_projection_snapshot()` against `agent_projections`
- [x] P2B-01 index.ts — `/cron/run` POST endpoint + `runCronInference()` using canonical ToolRuntime dispatch (not legacy `executeTool`)
- [x] P2B-02 cron-runtime.ts — `CronFailureClass`, `CronRunResult`, `classifyFailure()`, `canRetry()`; transient/permanent/timeout/policy_denied/tool_not_found classification; retry budget enforcement
- [x] P2B-02 phase2b-gate.test.ts — Phase 2B done-gate harness (FUNCTIONAL/SAFETY/STABILITY, 20 tests); confirms P2B exit gate is green

**Phase 2B exit gate: PASSED**
  1. ✅ Cron executes via canonical runtime and projection snapshots (GATE-P2B-F1 through F5)
  2. ✅ Non-interactive policy enforced for scheduler runs (GATE-P2B-S1 through S5)
  3. ✅ Retry/failure/observability hardening complete (GATE-P2B-ST1 through ST10)

**Up next: Tier A rollout** (core coding loop — safe file operations + patch workflows)

---

## Phase 1: Core Proof Slice

### P1-01: Define File-Canonical Agent Schema
- Outcome: stable schema for `soul.md` identity fields and validation errors.
- Touchpoints:
  - server-jarvis/src (new agent schema/validator module)
  - src-tauri/src/commands/agents.rs (projection integration points)
  - CONTEXT.md term alignment checks
- Acceptance:
  - Valid and invalid examples produce deterministic validator output.
  - No runtime state fields allowed in schema.

### P1-02: Implement Agents Root Configuration
- Outcome: app-owned default agents root with user-config override.
- Touchpoints:
  - server-jarvis/src/config.ts
  - src-tauri/src/commands/settings.rs
  - src-ui/src/components/jarvis/SettingsView.tsx
- Acceptance:
  - Fresh install works without repo checkout.
  - Agents root path editable in settings and persisted.

### P1-03: Build Agent Lifecycle Pipeline
- Outcome: discover -> validate -> project -> activate flow.
- Touchpoints:
  - server-jarvis/src (new lifecycle service)
  - src-tauri/src/commands/agents.rs
  - src-ui agent list and status views
- Acceptance:
  - Invalid `soul.md` marks agent invalid without crashing runtime.
  - Valid changes produce updated projection for future activations.

### P1-04: Add Runtime Projection Store with Provenance
- Outcome: lean projection model with source hash/version timestamps and validation status.
- Touchpoints:
  - src-tauri/src/db/migrations.rs
  - src-tauri/src/commands/agents.rs
  - shared type defs in types.ts and src-ui/src/types.ts
- Acceptance:
  - Projection does not duplicate canonical long-form identity text.
  - Every projection row links to source file and hash.

### P1-05: Implement Activation Boundary
- Outcome: active runs remain stable while new projections apply to future work.
- Touchpoints:
  - server-jarvis/src/agent-tools.ts
  - session execution path in server-jarvis/src/index.ts
  - cron run handoff boundary in src-tauri/src/commands/cron.rs (read-only guard in phase 1)
- Acceptance:
  - Editing `soul.md` does not mutate in-flight run behavior.
  - New sessions pick up newly activated projection.

### P1-06: Introduce Jarvis Tool Runtime Contract
- Outcome: one canonical runtime interface for registration, validation, execution, and result formatting.
- Touchpoints:
  - server-jarvis/src/tools.ts (refactor to registry + runtime)
  - server-jarvis/src/types.ts
  - server-jarvis/src/agent-tools.ts
- Acceptance:
  - Chat and agent-run entry points call same runtime execution path.
  - Tool result envelope is normalized across surfaces.

### P1-07: Add Execution Context Model
- Outcome: invocation context object carries surface/interactivity/scope/policy/timeouts.
- Touchpoints:
  - server-jarvis/src/tools.ts
  - server-jarvis/src/index.ts
  - server-jarvis/src/agent-tools.ts
- Acceptance:
  - Context indicates chat vs non-interactive correctly.
  - Tools receive context without requiring per-surface implementations.

### P1-08: Implement Runtime Permission Policy Layer
- Outcome: central allow/deny/ask checks and dangerous-operation controls.
- Touchpoints:
  - server-jarvis/src/tools.ts
  - server-jarvis/src/config.ts
  - approval UX touchpoints in src-ui if required
- Acceptance:
  - Non-interactive contexts cannot bypass ask-required policies.
  - Policy behavior covered by automated tests.

### P1-09: Migrate Search Bundle Through Runtime
- Outcome: canonical runtime-backed file search + text search + file read.
- Touchpoints:
  - server-jarvis/src/tools.ts
  - existing search helpers and file IO paths
- Acceptance:
  - One file-backed agent can complete “find and inspect implementation” flow end-to-end.
  - Same runtime behavior from chat and internal agent invocation.

### P1-10: Build First-Slice Test Harness
- Outcome: enforce phase done gate in CI.
- Touchpoints:
  - server-jarvis/src/*.test.ts
  - .github/workflows/ci.yml
- Acceptance:
  - Functional/safety/stability suites are mandatory for phase completion.

---

## Phase 2A: External MCP Exposure

### P2A-01: MCP Adapter Over Canonical Runtime
- Outcome: MCP list/call routes map to same internal runtime, no duplicate logic.
- Touchpoints:
  - server-jarvis/src/mcp-tools.ts
  - server-jarvis/src/tools.ts
- Acceptance:
  - MCP calls execute through same runtime contract as internal calls.

### P2A-02: MCP Schema Versioning and Compatibility Tests
- Outcome: stable external contract with explicit versioning policy.
- Touchpoints:
  - server-jarvis/src/mcp-tools.ts
  - tests for tool list and call payload compatibility
- Acceptance:
  - Backward compatibility policy documented and tested.

### P2A-03: Security/Policy Parity Checks for MCP
- Outcome: external path obeys exact same permission policy.
- Touchpoints:
  - runtime policy enforcement path
  - MCP adapter call path
- Acceptance:
  - Deny/ask behavior parity between internal and MCP surfaces.

---

## Phase 2B: Cron Integration (After MCP Stabilizes)

### P2B-01: Bind Cron Execution to Runtime Projection + Execution Context
- Outcome: cron jobs execute file-backed agents through canonical runtime in non-interactive mode.
- Touchpoints:
  - src-tauri/src/commands/cron.rs
  - server-jarvis runtime entrypoints
- Acceptance:
  - Cron runs pick activated projection snapshot.
  - Non-interactive policy enforcement verified.

### P2B-02: Cron Failure/Retry/Observability Hardening
- Outcome: robust scheduler behavior with explicit failure modes.
- Touchpoints:
  - cron command handlers and run history
  - UI cron status panels
- Acceptance:
  - Retry policy and terminal failure states are deterministic and visible in app.

---

## Rollout Tiers (Post-Phase 2)

### Tier A: Core Coding Loop
- Search bundle plus safe file operations and patch workflows.

### Tier B: Intelligence Layer
- LSP-style definition/reference/rename and structured edits.

### Tier C: Orchestration Surfaces
- MCP expansion, cron depth, multi-agent collaboration primitives.

### Tier D: Optional Interaction Layers
- Notebook/media/browser enhancements as needed.

Each capability in tiers A-D must include:
1. Transplant gate decision record.
2. Runtime and policy conformance tests.
3. Execution context behavior checks.

---

## Execution Order and Parallelization

### Sequence
1. ~~P1-01 to P1-04~~ ✓ done
2. ~~P1-05 to P1-08~~ ✓ done
3. ~~P1-09~~ ✓ done
4. ~~P1-10~~ ✓ done
5. ~~Done gate review~~ ✓ green 2026-05-29
6. ~~P2A-01 to P2A-03~~ ✓ done 2026-05-29 (160/160 green)
7. ~~P2B-01 to P2B-02~~ ✓ done 2026-05-30 (195/195 green)
8. Tiered expansion  ← **current**

### Parallel-safe groups
- Group A: P1-01, P1-02
- Group B: P1-03, P1-04
- Group C: P1-06, P1-07
- Group D: P2A-02, P2A-03

Do not parallelize across phase boundaries.

---

## Tracking Template Per Ticket
- Ticket ID:
- Decision log reference:
- Transplant gate result:
- Files touched:
- Tests added/updated:
- Acceptance criteria status:
- Risks discovered:
- Follow-on tickets:

---

## Immediate Start Recommendation
Start with P1-01, P1-02, and P1-06 in parallel, then converge into P1-03 and P1-04.
This gives schema, root configuration, and runtime contract early, which are prerequisites for every later ticket.