# Jarvis Remaining Feature and Function Gaps

**Date:** 2026-07-10
**Repository:** `C:\Projects\home-base-recovered`
**Purpose:** Secondary, additive gap audit covering the application surface end to end.
**Relationship to the direct diagnosis:** This document does not replace or remove [`2026-07-10-jarvis-direct-app-diagnosis.md`](./2026-07-10-jarvis-direct-app-diagnosis.md). It expands that diagnosis from observed runtime failures to the remaining implementation work across UI, Tauri, Bun, orchestration, tools, memory, integrations, deployment, and deferred roadmap items.

## Executive summary

Jarvis has a substantial working foundation: the Tauri shell boots, the Bun service exposes a healthy listener, direct model calls can answer, the canonical tool runtime and policy tests exist, sessions and many control views render, and the repository contains real orchestration, memory, cron, skills, and self-tuning scaffolding.

The remaining work is not one missing feature. It is a set of contract and integration gaps between those pieces. The most consequential gaps are:

1. **Requests do not always reach a terminal state.** Live tests showed a workspace request ending in generic `Failed to fetch`, a code-review run remaining in `rewriter` for more than 94 seconds, and the supplied Versutus screenshot showing a 30-second synthesizer first-token timeout while the UI still displayed a running stage.
2. **Several “implemented” surfaces are only partially connected.** Agent lifecycle handlers are present but not mounted by the Bun route table; model-profile activation updates SQLite without clearly updating the live Bun configuration; Bun session endpoints are placeholders while the UI uses native SQLite; and the Rust bridge cannot be cleanly restarted or stream responses.
3. **Multiple UI surfaces are metadata or placeholders rather than end-to-end capabilities.** Channels, devices, nodes, gateway controls, action registry execution, companion art, and several views do not yet have their advertised transport, dispatch, or runtime behavior.
4. **Learning and self-improvement are not yet measured as a live closed loop.** Candidate evaluation exists, but bulk promotion remains heuristic, scheduled promotion is not complete, and a live distill → promote → repeat → measure demonstration has not been captured.
5. **Release confidence is ahead of feature confidence.** Unit and policy tests are useful, but high-risk UI views lack dedicated component tests, live semantic evaluation is opt-in/manual, the frontend and backend advertise different versions, and the optimized release has not yet been delivered as a verified Desktop/installer artifact.

## Live re-validation addendum — deployed Desktop runtime

**Validation time:** 2026-07-10, after this report was first written.
**Deployed artifact identity:** the Desktop UI and deployment manifest identify commit `97517a6aaf3ddc0369382be1a93273cb4970175a`. The UI simultaneously labels it **stale** relative to source commit `0ca584bb6`; it must not be treated as proof of current source behavior.

The application shell launched and rendered normally, but it initially displayed **“DEGRADED — Bun server is not running — tools and skills unavailable.”** No listener existed on `127.0.0.1:19877`. The Health/Control Center confirmed the native shell and Ollama checks were healthy while `bun_server` was the sole error.

Using the in-app **Restart Bun server** control once eventually started `C:\Users\ethan\.bun\bin\bun.exe`; `/health` then returned `ok: true`, backend `openrouter`, model `cohere/north-mini-code:free`, and the deployed commit above. The recovered server's initial uptime was about 40 seconds when observed. A subsequent restart attempt did not make `/health` available within a 66-second observation window. The restart control can therefore recover the sidecar in at least one case, but bootstrap/restart availability is not deterministic or bounded by the UI's advertised 20-second restart contract.

The deployed server logs also add these facts:

- Requests that require full execution repeatedly route through `deepseek-v4-pro` for executor, reviewer, rewriter, and/or synthesizer stages, despite the health/default model identifying `cohere/north-mini-code:free`.
- The Versutus workspace-read session (`40decf7a-0825-4102-9707-32a3148c2772`) reached executor and then ended in a 30-second first-token synthesizer timeout on `deepseek-v4-pro`.
- Two home-base sessions ended with `code=<generic>: undefined`; the UI's `Failed to fetch` message is thus losing server-side error information.
- A deliberately malformed direct HTTP probe returned a prompt `Failed to parse JSON` response; that proves the route's parse-error path is reachable, but it is not evidence of a tool failure. A PowerShell SSE client then failed locally with `NullReferenceException`, so that client is not a valid completion harness. A stable direct SSE harness remains required.

### Implementation dependency — unmerged source state

At the time of this re-validation, the source checkout contains unresolved merge markers (`Updated upstream` / `Stashed changes`) in the exact P0 ownership files:

- `server-jarvis/src/config.ts`
- `server-jarvis/src/index.ts`
- `server-jarvis/src/orchestration/coordinator.ts` and its test
- `server-jarvis/src/orchestration/pipeline.ts`
- `server-jarvis/src/self-tuning/collector.ts`
- `server-jarvis/src/self-tuning/store.ts`

The worktree also contains uncommitted conductor/self-tuning additions and changes in `tool-runtime.ts`, orchestration tests, and Tauri migrations. Until those conflicts are resolved without discarding either side, it is not safe to implement or validate the stream/finalization fixes in this checkout. This is an immediate P0 engineering dependency, because the files cannot parse or be tested as a coherent runtime.

## Status key and evidence rules

| Label | Meaning |
|---|---|
| **Open / verified** | The source or live app directly demonstrates the gap. |
| **Partial** | A meaningful implementation exists, but the end-to-end contract is incomplete. |
| **Deferred** | The repository intentionally leaves the item for a later phase; it is still a roadmap gap if the capability is required. |
| **Needs live proof** | Source and tests exist, but a real packaged/runtime smoke has not proved the complete path. |
| **Scope limitation** | The surface works within a narrower contract than the product language may imply. |
| **Retired / out of scope** | Do not implement in Jarvis; ownership belongs elsewhere or the item was superseded. |

The source of truth for this audit is the current code and live evidence, not an unchecked historical completion claim. Where a plan says an item is complete but current source still shows a partial path, the discrepancy is called out explicitly.

## Priority matrix

| Priority | Remaining gap | Why it matters |
|---|---|---|
| **P0** | Request-wide deadlines, abort propagation, terminal stage states, and structured stream/tool errors | A correct intermediate result can be lost and the user can be left in `Streaming…` indefinitely. |
| **P0** | Repair the workspace/tool relay and prove a read-only workspace request live | Workspace grounding is the core coding-agent promise; `Failed to fetch` gives no usable evidence. |
| **P0** | Complete reviewer → rewriter/synthesizer finalization | Executor/reviewer work can succeed while no final answer is emitted. |
| **P0** | Resolve the unmerged runtime source before making more P0 changes | The source files that own streaming, routing, and config contain conflict markers, so builds and regression tests are not trustworthy. |
| **P0** | Make Bun bootstrap/restart deterministic and observable | The Desktop shell can remain degraded with no sidecar; one manual restart recovered after roughly 40 seconds while another did not recover within 66 seconds. |
| **P1** | Unify runtime authorities for sessions, agents, model profiles, and settings | UI state can look configured while the live Bun process uses a different source of truth. |
| **P1** | Finish bridge, channel, device, node, gateway, and remote-communication contracts | Current surfaces mostly expose rows/status rather than authenticated, observable transports. |
| **P1** | Replace native no-op/stub commands and wire lifecycle routes | User-visible commands can report success without performing the promised operation. |
| **P1** | Make learning/skills promotion a measured, judge-gated, repeatable loop | Self-improvement cannot be called effective without live before/after evidence. |
| **P2** | Autonomous action dispatch, MCP server exposure, conductor sidecar, GRPO/shadow stages | Important extensibility and autonomy work, but should follow runtime reliability. |
| **P2** | UI fidelity, high-risk view coverage, bundle splitting, and release delivery | Improves confidence and usability after contracts are reliable. |

## 1. Chat, streaming, and orchestration

**Status: Open / verified (P0).**

The live application can answer short direct prompts, but multi-stage requests do not share a proven request contract:

- `docs/reports/2026-07-10-jarvis-direct-app-diagnosis.md` records direct answers taking roughly 16–19 seconds, a workspace prompt failing with `Failed to fetch`, and a code-review run stuck in `rewriter` for more than 94 seconds.
- The supplied screenshot shows session `40DECF7A`, `model=deepseek-v4-pro`, `stage=synthesizer`, and `first-token timeout (30000ms)`. The error card says the model was aborted, while the stage still reads `running…` and both error locations expose `code: unknown`.
- The UI shows stage labels and a stop control, but cancellation and stage finalization are not deterministic across runs.
- `server-jarvis/src/orchestration/pipeline.ts` contains a `conductor_replan` re-entry path that surfaces the event and returns the current result; the comment says actual re-invocation is handled by the normal route. This is a safe degradation, not proof of a true critic → conductor → resumed-stage handoff. Historical docs describe B-03 as done, so this requires an explicit source/runtime reconciliation.

Remaining implementation:

- Enforce one request deadline, plus bounded per-stage first-token and completion deadlines, across executor, reviewer, rewriter/synthesizer, tool calls, and stream relay.
- Propagate abort signals to every child model/tool task and persist a terminal state (`completed`, `timed_out`, `cancelled`, `failed`, or `partial`).
- Validate the reviewer-to-rewriter payload contract and add an end-to-end regression that proves a final assistant answer is emitted.
- Return a clearly marked partial result when useful executor evidence exists and synthesis fails.
- Emit a structured error containing session ID, run ID, stage, selected model, timeout, provider response code, retry number, and fallback decision.
- Make the model router’s retry/fallback choice visible rather than showing only “try again.”
- Add a clean new-chat/composer reset that prevents stale prompt concatenation and duplicate sends.

## 2. Workspace grounding and tool execution

**Status: Open / verified (P0), with partial implementation.**

The canonical `ToolRuntime` and bundle registry exist, including filesystem, shell, web, meta, task, and MCP-client bundles. Policy tests cover important allow/deny behavior. The live workspace probe nevertheless failed at the relay boundary with a generic fetch error, so the principal capability is not proven.

Remaining implementation:

- Trace and test the complete UI → Tauri → Bun → `/chat/stream` → tool-runtime → result stream path with correlation IDs at each boundary.
- Replace generic browser/network fetch failures with typed tool errors that identify whether the failure was authorization, path validation, process launch, stream closure, timeout, or provider failure.
- Add a read-only workspace smoke to the release gate and a separate explicit-confirmation write smoke; do not use an overwrite prompt as the only capability check.
- Confirm that workspace identity is carried into every stage and cannot drift between projects or sessions.
- Add live smoke coverage for filesystem read, shell command, web search, task/meta tools, and MCP-client invocation, including cancellation and malformed-input cases.
- `server-jarvis/src/meta-bundle.ts` currently acknowledges `todo_write` without durable task persistence. Either implement durable task state or label the command as non-persistent.
- `server-jarvis/src/tools.ts` remains in the tree even though current documentation describes the legacy dispatcher as deleted. Remove it or mark it unambiguously as compatibility-only to prevent two tool implementations from diverging.
- The web bundle is a deliberately narrow search/HTML extraction surface (DuckDuckGo plus simple stripping). Authenticated browser sessions, JavaScript rendering, and citation provenance remain scope limitations, not completed capabilities.

### Approval and permission contract

**Status: Partial (P1).** The policy engine and non-interactive restrictions are tested, but `server-jarvis/src/config.ts` defaults `tools.interactive_approval` to `false`. Approval-required dangerous tools can therefore be allowed directly in interactive chat unless deployment configuration changes the default. The UI contains a `ToolApprovalModal`, but the product contract does not make the safe default explicit.

Remaining implementation:

- Decide and document the default approval policy for interactive chat, cron, agent, and MCP contexts.
- Make approval decisions auditable with tool name, arguments hash, requester, policy rule, expiry, and result.
- Add a live approval/deny/expiry smoke, including a dangerous command that is denied without a prompt in non-interactive contexts.

## 3. Sessions, persistence, and run history

**Status: Partial / authority split (P1).** The UI can list and manage sessions through native Tauri SQLite and the live app showed 105 sessions. The Bun server’s `/sessions` surface in `server-jarvis/src/index.ts` returns an empty list for GET, creates a random ID/name for POST, and reports `{ok:true}` for delete. That is a parallel placeholder API, not a durable server-side session contract.

Remaining implementation:

- Choose one authoritative session API and make Tauri, Bun, and UI use it consistently.
- Persist request status, stage events, selected model, token counts, tool calls, cancellation reason, partial output, and final output in one durable schema.
- Define what is retained for cancelled, timed-out, failed, and partially completed runs.
- Repair token accounting; the live Sessions view displayed `0 / 0` for completed work.
- Add retention, export, deletion, and recovery behavior with tests for interrupted writes.

## 4. Agents and lifecycle management

**Status: Partial / integration gap (P1).** `server-jarvis/src/agent-lifecycle.ts` implements scan, validation, collision detection, activation, and deactivation logic. `agent-routes.ts` exposes handlers, and unit tests cover pieces of the service. However, the route handlers are imported by `server-jarvis/src/index.ts` without a verified mounted route path or `createLifecycleService` wiring. The implementation is therefore not proven reachable through the live server.

The UI has another authority: `src-ui/src/components/jarvis/AgentsView.tsx` performs native SQLite CRUD (`list_agents`, `add_agent`, identity/enabled updates, deletion, and channel bindings), while the lifecycle service treats canonical agent directories and `soul.md` projections as authoritative. The result is a risk that an agent appears enabled in the UI but has no activated canonical projection.

Remaining implementation:

- Mount and live-probe the lifecycle routes, or remove the dead imports and formally make native commands authoritative.
- Define canonical ownership of identity, enabled state, tools, channels, and workspace scope.
- Synchronize `agent_projections` in the Tauri schema with the activation-boundary projection database, including provenance and rollback.
- Add collision, activation, deactivation, and restart smoke tests against the packaged runtime.
- Surface lifecycle failures and stale projections in the Agents UI instead of silently showing local row state.

## 5. Models, profiles, and configuration authority

**Status: Partial (P1).** Configuration unification has landed in parts of the system, but profile and settings commands still have bypass paths:

- `src-tauri/src/commands/models.rs::set_active_profile` updates `model_profiles.is_active` in SQLite. It does not clearly call `persist_jarvis_config`, switch the Bun provider, or reconcile the running process.
- `src-ui/src/components/jarvis/SettingsView.tsx` is a raw key/value editor. `src-tauri/src/commands/settings.rs::set_setting` performs a direct SQLite upsert without schema validation, normalization, or a guaranteed runtime reload.
- The UI provenance badge reports `0.1.0`, while `/health` reports backend version `3.0.0`; the relationship is ambiguous.
- The UI advertises `OPENROUTER/FREE`, the health sample resolves `cohere/north-mini-code:free`, and the screenshot selected `deepseek-v4-pro`. Per-request model identity is not consistently visible.

Remaining implementation:

- Make profile activation a transaction that updates canonical settings, projects file configuration, reloads/restarts the runtime when required, and returns the resolved provider/model.
- Replace raw settings writes with typed schemas, validation, migration, normalization, and an explicit apply/reconcile result.
- Add a “currently effective configuration” view showing source, provider, model, fallback chain, and last reload time.
- Unify frontend/backend release identity or label them explicitly as shell/server versions.
- Add a profile-switch live smoke proving the next chat uses the selected profile and that a failed switch leaves the previous profile intact.

## 6. Native Tauri commands and bridge lifecycle

**Status: Open / partial (P1).** Several commands are real, but the remaining stubs create false confidence:

- `src-tauri/src/commands/jarvis_commands.rs::run_learning_session` emits deterministic placeholder findings. The comment says full web fetch, summary, and LLM extraction belongs to a Python sidecar, and no UI caller was found.
- `src-tauri/src/commands/recovery_stubs.rs::jarvis_review_session` returns `{"reviewed":false,"note":"stub"}` and `jarvis_commit_session_end` is a no-op, even though a real `commit_session_end` engine implementation exists.
- `src-tauri/src/commands/system.rs::restart_bridge` explicitly returns “not implemented”; `src-tauri/src/jarvis/bridge.rs::stop_bridge` is a no-op because the listener is tied to a thread/`OnceLock`.
- `src-ui/src/components/ui/Mythos.tsx` is a no-op recovery wrapper. `CompanionSprite.tsx` and `MythosCompanionSprite.tsx` are functional visual placeholders with recovery notes that the original sprite/procedural art was lost.

Remaining implementation:

- Replace or formally retire the placeholder learning command and route learning through one observable sidecar/cron contract.
- Wire review and session-end commit commands to the real memory engine, with idempotency and failure persistence.
- Give the bridge an owned lifecycle: start, health, stop, restart, port conflict handling, and shutdown acknowledgement.
- Decide whether Rust or Bun owns the bridge transport; remove the other implementation’s divergent contract or make the boundary explicit.
- Replace placeholder Mythos/companion surfaces when visual fidelity is a product requirement, or label them as recovery-mode UI.

## 7. Memory, recall, and learning

**Status: Partial / deferred (P1–P2).** Warm memory and retrieval scaffolding exist, but the cold path and review loop are incomplete:

- `src-tauri/src/jarvis/memory/engine.rs::recall_cold_memory` explicitly defers records containing a Drive file ID instead of fetching them. Drive authentication, retrieval, caching, and failure recovery remain open.
- The no-op `jarvis_review_session` means the intended LLM-assisted review/commit flow is not user-reachable through that command.
- Skills candidate evaluation and per-candidate judge paths exist, but the bulk `POST /skills/promote` path remains heuristic-only. A scheduled/batch promotion pass is not complete.
- The organism-loop notes say a live distill → promote → repeat → measure demonstration has not been captured. There are no trustworthy before/after effectiveness numbers.
- The original implementation notes identify `tool_sequence_digest` and degraded-rescue policy as pending/conditional work; current code should be rechecked before declaring those contracts closed.
- `SkillsView` carries candidate cockpit behavior, but there is no complete longitudinal self-improvement command center with trend, rollback, and promotion history.

Remaining implementation:

- Complete cold Drive recall with bounded fetch, auth, cache, redaction, and offline behavior.
- Make every promotion judge-gated, explainable, reversible, and recorded with evidence.
- Build scheduled promotion/evaluation jobs with a dry-run mode and explicit human approval policy.
- Capture a repeatable live benchmark with baseline, promoted result, regression guard, and rollback evidence.
- Add memory write provenance, source references, conflict resolution, and user-visible deletion/retention controls.

## 8. Conductor, self-tuning, and evaluation

**Status: Deferred / needs live proof (P1–P2).** Deterministic orchestration and evaluation harnesses are useful, but semantic quality and optimization stages remain incomplete:

- The eval harness is primarily deterministic/mocked. Live semantic evaluation is opt-in/manual/nightly rather than a blocking release gate.
- The post-phase-4 evolution issue leaves the llama-server/KV-cache sidecar spike (A-03) open. Conductor cache metrics are exposed through `/health/inference`, but the UI interface does not declare or present a dedicated `conductor_cache` panel.
- Offline GRPO sandbox, promotion gate, shadow A/B, and evolutionary routing head items (D-02 through D-05) remain unbuilt or human-gated.
- The reliability report found no downstream JSONL trainer/consumer and no live D3 numbers.

Remaining implementation:

- Define a live semantic eval lane with model, prompt, workspace, tool, and latency fixtures.
- Add quality, grounding, tool-success, first-token, completion, and cancellation metrics to release criteria.
- Finish the conductor cache sidecar decision and expose hit/miss/eviction/latency telemetry in the UI.
- Build offline training only after data provenance, redaction, rollback, and promotion gates are explicit.
- Add shadow routing and A/B analysis before changing the production router.

## 9. Remote communication, channels, devices, nodes, and gateway

**Status: Open / partial (P1).** The screenshot’s Versutus request was about Android remote communication, but the request timed out before any architecture evidence was returned. The current home-base bridge also does not constitute remote access:

- `server-jarvis/src/bridge.ts` binds TCP to `127.0.0.1` and forwards `/chat/stream`; it has no Android pairing, authentication, encryption, relay, or mobile protocol.
- `src-tauri/src/jarvis/bridge.rs` binds loopback, queues messages, and returns “Message queued” rather than streaming a response. Rust and Bun bridges therefore have divergent contracts.
- `ChannelsView` channel login/logout changes a `config.connected` flag, but no Discord, Slack, Telegram, Signal, email, or WebSocket transport workers/webhooks were verified.
- `DevicesView` stores paired-device rows without pairing proof, key exchange, heartbeat, or command transport.
- `NodesView` stores node rows without discovery, ping/connect, credential lifecycle, or execution.
- `GatewayView` reports port/connections/uptime/version and refreshes status, but does not provide start/stop, exposure, auth, or relay controls.
- Hermes is an optional bridge surface; `hermes_interrupt` has no per-request cancel RPC, with child shutdown described as the closest behavior.
- `restart_bridge` is not implemented, so even the local bridge lifecycle is incomplete.

Remaining implementation:

- First define the remote protocol: pairing, identity, encryption, authorization scopes, reconnect, replay protection, delivery acknowledgement, and audit events.
- Select one bridge owner and expose a versioned transport with health and cancellation semantics.
- Implement channel-specific adapters with secret storage, retries, rate limits, inbound/outbound delivery status, and webhook verification.
- Implement device/node enrollment, heartbeat, capability discovery, command authorization, and revocation.
- Keep remote Android work behind core runtime/tool reliability gates, as the master plan intends, but track it explicitly as a current product gap.

## 10. Action registry and autonomous operator loop

**Status: Partial / deferred (P1–P2).** The Action Registry UI can sync, summarize, bucket, approve, waive, and show active/blocked actions. Native commands cover registry summaries and approval state. The remaining autonomous loop is not complete:

- Approved actions are not proven to dispatch to an Agent lifecycle.
- Acceptance commands are not automatically executed and verified.
- Registry status, evidence, result summary, and memory write-back are not automatically updated after execution.
- Concurrency, activation-boundary, and approval policy integration need one end-to-end contract.

Remaining implementation:

- Build a dispatcher that claims an approved action, selects an agent/tool policy, runs the acceptance command, captures evidence, and updates the registry atomically.
- Add retry, lease expiry, deduplication, cancellation, and rollback behavior.
- Make every action execution visible in sessions, audit logs, and memory provenance.

## 11. Cron and scheduled execution

**Status: Partial / needs live proof (P1–P2).** Cron CRUD, enable/disable, manual run, missed-run handling, and non-interactive execution context exist with tests. Remaining operational behavior needs proof and hardening:

- Release smoke has not proven scheduled execution after packaged startup and restart.
- Missed-run persistence, notification/delivery, retention, log export, retry semantics, and per-job cancellation need a stable contract.
- Provider/model fallback and tool-policy decisions for cron runs need to be visible in run history.
- The native learning command emits placeholders while learning cron jobs are textual prompts; these should be unified or clearly separated.

## 12. UI coverage and feature fidelity

**Status: Open / partial (P2).** `src-ui/src/App.tsx` contains an `UnwiredView` (“not wired yet”). The `instances`, `usage`, `logs`, and `doctor` render paths currently route to it; `chat-feeds` is routed but not present in the primary sidebar. This is concrete dead/hidden feature surface.

High-risk views without dedicated component tests include Agents, Channels, Cron, Devices, Nodes, Hooks, Commitments, Approvals, Plugins, Gateway, Hermes, Model Profiles, Settings, and Action Registry. The existing UI suite is valuable, but it does not cover those workflows end to end.

Remaining implementation:

- Either wire each view to a real contract or remove/hide it until the contract exists.
- Add component and live E2E coverage for every mutation-heavy control surface.
- Add accessible terminal-state, error, retry, loading, and empty-state behavior to each view.
- Split the large frontend bundle (the existing build reports a main JavaScript chunk around 898 kB, gzip around 267 kB) with route-level lazy loading.
- Replace recovery-mode companion placeholders if the application is expected to retain its intended visual identity.

## 13. Release, deployment, and observability

**Status: Needs live proof (P1–P2).** The optimized release has build provenance, and prior work improved the Tauri/Bun bootstrap, but release confidence still has gaps:

- A cold packaged GUI AppHang has not been reproduced and ruled out.
- Migration/skill seeding order and supervisor startup predicates need a release smoke; the supervisor currently checks a TCP predicate rather than proving `/health` semantics.
- Restart attempts are count-bounded, not proven against a strict wall-clock budget.
- The optimized release was tested locally but not yet copied to the user’s actual Desktop/installer target and verified there.
- `cargo fmt --all -- --check` still reports pre-existing formatting debt and clippy has unrelated warnings; these need triage so real regressions are distinguishable.
- Runtime logs need consistent run IDs, stage terminal events, token accounting, provider/model/timeout details, and redacted tool arguments.

Remaining implementation:

- Establish a reproducible build → package → install/copy → hash → launch → health → chat/tool smoke pipeline.
- Make frontend, backend, sidecar, and installer provenance one inspectable release record.
- Add cold-start, restart, network-loss, provider-timeout, migration, and stale-binary tests.
- Define telemetry retention and redaction rules before enabling broader remote or autonomous operation.

## 14. Documentation and ownership drift

**Status: Open (P1).** The repository contains historical plan language that no longer matches the current source. Examples include the B-03 “done” statement versus the current conductor re-entry return, old references to deleted stubs while `server-jarvis/src/tools.ts` remains, and broad “all tracked done” wording beside live route and UI gaps.

Remaining implementation:

- Add an owner, status, evidence link, and last-verified date to every roadmap item.
- Separate “source exists,” “unit tested,” “live endpoint wired,” “packaged smoke passed,” and “production-ready.”
- Run a documentation drift check as part of release preparation.
- Mark external or retired work explicitly: PrizePicks belongs to the separate `prizepicks-monster` application; OpenClaw/Hermes may be optional donors rather than core Jarvis dependencies.

## Feature-by-feature acceptance checklist

The following is the minimum evidence required before calling each surface complete:

| Surface | Completion evidence still required |
|---|---|
| Chat/SSE | Clean prompt returns a final answer; timeout/cancel/error all terminate and persist. |
| Orchestrator | Executor → reviewer → rewriter/synthesizer completes, retries, and produces a final answer. |
| Workspace grounding | Read-only file/list/SHA smoke succeeds in the packaged app with structured errors on failure. |
| Tools | Filesystem, shell, web, meta/task, and MCP-client success/deny/timeout paths are live-tested. |
| Approvals | Dangerous interactive tool requires approval; cron/agent/MCP policy is auditable and deterministic. |
| Sessions | One authoritative durable API records status, stages, tokens, tools, cancellation, and output. |
| Agents | Lifecycle routes are mounted; UI state and canonical projections agree after restart. |
| Models/config | Profile switch changes the effective runtime model and is visible in the next run. |
| Memory | Warm and cold recall, review, commit, deletion, and provenance work across restart. |
| Skills | Judge-gated promotion, rollback, scheduled evaluation, and measured improvement exist. |
| Cron | Packaged restart, schedule, missed run, retry, cancel, and notification behavior pass. |
| Actions | Approved action dispatches, acceptance command verifies, registry and memory update atomically. |
| Channels | At least one real adapter proves authenticated inbound/outbound delivery and retry. |
| Devices/nodes | Pairing, heartbeat, capability discovery, authorization, command, and revocation pass. |
| Gateway/bridge | Start/stop/restart, auth, health, cancellation, and transport ownership are explicit. |
| Remote Android | Versioned protocol, pairing, encryption, relay, reconnect, and audit smoke pass. |
| UI views | No unwired placeholder remains exposed; mutation-heavy views have tests and terminal states. |
| Release | Actual shipped artifact hash, provenance, launch, health, chat, tool, and restart evidence recorded. |

## Recommended implementation sequence

### First: close P0 reliability contracts

1. Instrument the live stream/tool relay and replace `Failed to fetch`/`code: unknown` with structured boundary errors.
2. Add request and stage deadlines with abort propagation and terminal UI state.
3. Repair reviewer-to-rewriter/synthesizer finalization and prove a final answer after intermediate work.
4. Add the clean composer/session reset and a read-only workspace smoke.

### Second: remove authority splits and false-success commands

1. Unify sessions, model profiles, settings, agent lifecycle, and projection ownership.
2. Wire or retire the imported agent routes.
3. Replace `jarvis_review_session`, `jarvis_commit_session_end`, and learning placeholders with real contracts.
4. Give the bridge a real lifecycle and choose Rust or Bun as transport owner.

### Third: build durable intelligence and operator loops

1. Complete cold memory and judge-gated skills promotion with a measured live benchmark.
2. Finish action dispatch and acceptance verification.
3. Add live semantic evaluation, conductor cache telemetry, and only then pursue training/shadow routing.

### Fourth: expand integrations and polish the shipped surface

1. Implement one authenticated channel adapter and one device/node protocol end to end.
2. Define remote Android protocol and bridge it only after local reliability gates pass.
3. Wire or hide unwired views, add high-risk UI tests, split the bundle, and deliver a verified Desktop/installer artifact.

## Explicitly retired or outside this application

- **PrizePicks functionality:** belongs to the separate `prizepicks-monster` application; do not add it to Jarvis merely because older planning text mentions it.
- **External OpenClaw/Hermes ownership:** may be used as an optional integration or donor path, but it is not a substitute for a defined Jarvis bridge contract.
- **Remote Android exposure before core reliability:** remains a deferred product phase, not evidence that the current local bridge is complete.

## Verification plan for the next implementation pass

Use the real runtime and packaged artifact for these checks:

```text
GET  http://127.0.0.1:19877/health
POST http://127.0.0.1:19877/chat/stream  (direct and workspace-grounded prompts)
GET  /skills/candidates
GET  /skills/candidates/:id/eval
GET  /agents/pool                 (after lifecycle route wiring)
bun test
cargo test --workspace
```

Then launch the actual release binary, run the read-only workspace smoke, a tool approval smoke, a cancellation/timeout smoke, a model-profile switch smoke, a scheduled cron smoke, and a restart/health smoke. Record artifact hash, runtime PID/provenance, model identity, elapsed times, terminal states, and all correlation IDs in the release report.

## Bottom line

Jarvis is a real platform with meaningful working infrastructure, not an empty shell. It is also not feature-complete: the highest-risk work is closing the contracts between existing components. Until P0 streaming/tool/finalization behavior is terminal and observable, and the authority splits and no-op commands are resolved, additional integrations or self-tuning features will compound uncertainty rather than increase dependable capability.

## Implementation follow-up — 2026-07-10

This report is now also the status record for the first remediation pass. The following items moved from diagnosis to verified implementation:

| Item | Status | Verification |
|---|---|---|
| Unmerged P0 source state | **Resolved** | The seven conflicted runtime files were restored to the current `master` architecture and marked resolved. The older June conductor WIP remains preserved in `stash@{0}` rather than being discarded. |
| Conductor compatibility seam | **Implemented, not yet live-wired** | `PipelineExecutor` now accepts optional conductor wiring without treating it as a stage collector; it forwards stage-token observation and stage-local abort signals, and directive rows are durable in the self-tuning store. The Bun suite passes with this adapter. The Bun route has not yet made conductor supervision a required live-path dependency. |
| Bun sidecar bootstrap | **Resolved and deployed** | Rebuilt and deployed source commit `0ca584bb6`. A fresh `Jarvis.exe` launch created the Desktop `index.js` Bun listener automatically; `/health` reported the same SHA with initial uptime under one second. |
| Stale-artifact ambiguity | **Resolved for this deployment** | Desktop manifest SHA, `/health.git_sha`, Desktop `index.js` SHA, and the live Bun command line all agreed on `0ca584bb6`. |
| Direct SSE terminal contract | **Verified** | A clean `POST /chat/stream` returned `init`, synthesizer progress, visible deltas, `message_stop`, and one successful terminal `result` in about 3 seconds. |

### Current feature/function lineup after this pass

| Rank | Remaining gap | Current status | Next proof or implementation |
|---|---|---|---|
| **P0** | Multi-stage executor → reviewer → rewriter/synthesizer completion under provider latency | Still open | Run a bounded full-execution regression against the newly deployed app and ensure every stage emits a terminal state or usable partial result. |
| **P0** | Workspace/tool request error attribution | Still open | Re-run a read-only workspace probe through the fresh UI and direct SSE path; retain correlation IDs and distinguish tool, relay, provider, and cancellation failures. |
| **P0** | Request-wide deadline/partial-result policy | Still open | Add a release fixture where synthesis stalls after executor evidence and assert a terminal partial or structured timeout result. |
| **P1** | Sessions, model profiles, settings, and agent lifecycle authority splits | Still open | Select a canonical runtime contract for each surface and add packaged end-to-end activation/persistence tests. |
| **P1** | Bridge, channel, device, node, and remote Android transports | Still open | Define authenticated transport ownership and prove one adapter/protocol vertically before adding more metadata-only UI. |
| **P1** | Native no-op commands, cold-memory retrieval, and measured skills promotion | Still open | Replace placeholders with observable, reversible runtime contracts and capture a live benchmark. |
| **P2** | Action dispatch, MCP server transport, conductor production wiring, training/shadow routing, and UI fidelity | Deferred | Build after the P0 stream/tool contracts are stable; no autonomous or remote path should bypass those controls. |

The earlier evidence remains historically valid for the old deployed builds. The verified status above applies only to the current Desktop deployment of `0ca584bb6`; it does not yet prove the remaining workspace and full-pipeline scenarios.

### Workspace acceptance follow-up — current deployment

A clean read-only stream request against the deployed `0ca584bb6` sidecar asked Jarvis to inspect `C:\Projects\home-base-recovered`, list three top-level entries, and report the current Git SHA without modifying files. It reached an SSE `result` success in about 37 seconds after executor and synthesizer activity.

- **Verified:** workspace directory inspection succeeded; the answer correctly returned `README.md`, `src-ui/`, and `package.json`, and identified 36 top-level items.
- **Verified:** the earlier generic `Failed to fetch` outcome did not recur on this deployed direct-SSE path.
- **Still open:** the executor was not offered a shell/Git tool, so it could not run `git rev-parse HEAD`; it returned a clear capability limitation instead of inventing a SHA.
- **Status change:** “workspace/tool request error attribution” is now **partial, with a concrete routing gap** rather than an unclassified fetch failure. The remaining design choice is whether a read-only Git metadata capability should be added to the workspace profile, not whether arbitrary shell execution should be enabled.
- **Still open:** this probe used executor → synthesizer and does not prove the reviewer/rewriter path, write approval path, or request-wide partial-result behavior.

### Multi-stage finalization follow-up — current deployment

A direct code-review request against the same deployment completed executor → reviewer → synthesizer in about 53.5 seconds and emitted one successful terminal result. It correctly diagnosed `function add(a,b){ return a-b }` and returned `return a + b` as the smallest safe fix. This is a meaningful improvement over the earlier run that remained in `rewriter` without a final answer.

- **Verified:** executor, reviewer, synthesizer, `message_stop`, and terminal `result` all completed in a single turn.
- **Still open:** this route did not invoke rewriter because the reviewer accepted the executor output. A reviewer-reject/rewriter regression remains required.
- **New concrete observation:** the coordinator selected `deepseek-v4-pro`, failed to parse its routing output, and fell back to the deterministic normalized full-execution route. The fallback is safe and completed, but repeated coordinator parse failure remains a latency, routing-quality, and observability gap.
- **Status change:** multi-stage finalization is **partial / verified for executor → reviewer → synthesizer**, rather than a blanket P0 hang. Rewriter stress, shared deadlines, partial results, and model-routing quality remain open.
