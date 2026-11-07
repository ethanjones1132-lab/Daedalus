# Orchestration Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Settings select the actual orchestration mode, stage models, fallback order, and cloud boundary, with a real bounded route test and honest save/readback status.

**Architecture:** Keep SQLite as the canonical configuration authority and project its existing configuration into Bun. Introduce one explicit stage-route policy above automatic ranking and a shared single-target transport; reuse those in production stages and a capability-authenticated diagnostic. Expand the existing Settings section rather than introducing a parallel configuration surface.

**Tech Stack:** Existing Bun/TypeScript, Rust/Tauri/SQLite, React/Vitest; no new runtime or dependency is required unless existing SHA-256 support proves unavailable.

**Spec:** `docs/superpowers/specs/2026-11-07-orchestration-controls-design.md`, approved 2026-11-07.

## Global Constraints

- Work in `C:/astra-wt/daedalus-routing`, initially `ba6dab5`; preserve `2f611db`, `ba6dab5`, and the Phase 0 route map.
- Preserve the Rust/Tauri Native surface, Bun server, React UI, Tool runtime, Permission policy, and existing per-attempt attribution.
- SQLite remains the canonical configuration authority. A probe never saves configuration or runs a Session, tool, delegate, learning update, or memory capture.
- Keep `orchestrator.enabled`'s existing default. `allow_cloud_helpers` remains false when absent; explicit model selections cannot override the cloud boundary.
- Coordinator, planner, executor, reviewer, rewriter, and synthesizer are the six editable routing stages. General `config.mode` is unrelated.
- Absent settings preserve existing automatic behavior. Custom fallback lists are closed and ordered; an empty custom list disables fallback.
- Apply saved settings to newly started turns; do not mutate an in-flight turn's snapshot.
- Do not push, merge to `master`, deploy over the installed application, or enable cloud helpers in Ethan's live configuration as part of this plan.
- Source/build checks do not close roadmap #1–#4 runtime/empirical acceptance or prove packaged behavior. Return to active priority #3 after the reliability interruption.

## Review Focus

- Deep merges can resurrect removed stage pins: use an explicit nonempty `"automatic"` reset sentinel and verify Native-to-Bun round trips (Tasks 1 and 4).
- An excluded/unavailable primary, duplicate fallback, or a model ID containing colons/slashes must not change the intended sequence or re-enter an automatic tail (Tasks 1–2).
- Resident conductor and executor delegation can bypass a stage selection; cover both routing and supervision call sites, and suppress delegate replacement of explicit executor policy (Task 2).
- Diagnostic cancellation, duplicate clicks, navigation, and stale responses must stop the correct operation and never mark a newer draft tested (Tasks 3 and 5).
- Persistence may succeed while Bun reload/readback fails; display the split outcome without inventing success or discarding edits (Tasks 4–5).

## File and contract map

- New `server-jarvis/src/orchestration/stage-route-policy.ts`: six-stage schema, validation, explicit/automatic route resolution, ordered runner.
- New `server-jarvis/src/orchestration/stage-target-request.ts`: extract the existing single-target HTTP send/endpoint/header logic; do not create a second network implementation for probes.
- `server-jarvis/src/config.ts`: typed optional routing maps, validation, stable non-secret routing descriptor/fingerprint.
- `server-jarvis/src/index.ts`, `openrouter.ts`, `orchestration/coordinator.ts`, `orchestration/claude-delegate.ts`: production integration and bypass prevention.
- New `server-jarvis/src/orchestration/route-diagnostics.ts`: private probe/cancel/reload/readback handlers and bounded operation ownership.
- `server-jarvis/src/native-memory.ts`: reuse the existing owned-native capability check through a small exported authorization adapter; preserve memory/Goal authority semantics.
- New `src-tauri/src/commands/orchestration.rs`: typed commands, input checks, readback/diagnostic forwarding; register in `commands/mod.rs` and `lib.rs`.
- `src-tauri/src/jarvis/memory/transport.rs`: encapsulated authenticated diagnostic transport using the existing owned-child capability; never expose it to React.
- `src-tauri/src/commands/jarvis_commands.rs`: save result with persistence/readback/runtime acknowledgement.
- New `src-ui/src/features/settings/OrchestrationPanel.tsx`, `orchestration-draft.ts`: focused editor and validation; integrate in `ConfigPanels.tsx`.
- `SettingsPage.tsx`, `SaveBar.tsx`, `domain/types.ts`: typed fields and honest save/probe states.

## Task 1: Define and validate explicit stage routes

**Files:** `stage-route-policy.ts` and `.test.ts`; `config.ts`; existing `config.test.ts`.

**Interfaces:**

```ts
type RoutingStage = 'coordinator' | 'planner' | 'executor' | 'reviewer' | 'rewriter' | 'synthesizer';
type StageTarget = { provider: 'llama_cpp' | 'ollama' | 'openrouter' | 'opencode_zen' | 'opencode_go' | 'vllm'; model: string };
type StageModels = Partial<Record<RoutingStage, StageTarget | 'automatic'>>;
type StageFallbacks = Partial<Record<RoutingStage, StageTarget[] | 'automatic'>>;
// Add optional stage_models: StageModels and fallback_chains: StageFallbacks to OrchestratorConfig.
function hasStageRouteOverride(cfg: JarvisConfig, stage: RoutingStage): boolean;
function resolveStageRoute(cfg: JarvisConfig, stage: RoutingStage,
  automatic: { primary?: StageTarget; fallbacks: StageTarget[] },
  excluded: ReadonlySet<string>): StageTarget[];
```

Missing or `"automatic"` entries use automatic policy. Custom fallback arrays contain targets after the selected primary; deduplicate by provider and full model string without splitting the model ID. Reject unknown stages/providers, blank IDs, more than 8 custom fallback entries, or model IDs over 512 characters. A llama.cpp target must match the configured serving alias; this feature cannot load a different GGUF.

- [x] Write tests asserting an explicit primary precedes trial/tier/ranking choices; ordered `[B, C]` stays ordered; `[]` produces no tail; absent and `"automatic"` preserve legacy selection; duplicates and exclusions cannot reintroduce the primary; `model: 'org/model:tag'` round-trips unchanged.
- [x] Add a config test that resets an old pin and old fallback array to `"automatic"`, projects/loads the result, and observes no explicit override. Add rejection tests for all schema limits above. Run these tests and observe failure before implementation.
- [x] Implement validation and resolution. Keep malformed settings observable at request/save validation; do not normalize invalid explicit routes into Automatic. Do not change the generic deep-merge behavior for unrelated keys.
- [x] Run `bun test src/orchestration/stage-route-policy.test.ts src/config.test.ts` and `bun run typecheck` in `server-jarvis`; require zero failures. Commit this independently testable contract.

## Task 2: Enforce the route through the production attempt path

**Files:** `stage-route-policy.ts`, `stage-target-request.ts` and tests; `index.ts`; `openrouter.ts`; `coordinator.ts` and tests; `claude-delegate.ts` and tests; new `stage-route-integration.test.ts`.

**Consumes:** Task 1 types/resolver and current `CallModelFn` in `orchestration/coordinator.ts`.

**Produces:**

```ts
type StageAttemptResult<T> = { usable: true; value: T } | { usable: false; reason: string };
async function runStageRoute<T>(targets: readonly StageTarget[], context: {
  cfg: JarvisConfig; signal: AbortSignal; deadline: number;
  onRejected(target: StageTarget, reason: string): void;
}, attempt: (target: StageTarget, signal: AbortSignal) => Promise<StageAttemptResult<T>>): Promise<T>;
async function requestStageTarget(cfg: JarvisConfig, target: StageTarget,
  body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
```

Keep production body assembly, message/tool-call normalization, sampler controls, token/context fit, streaming, stage budgets, and attempt accounting. Extract the existing single-target request dispatch behind `requestStageTarget`; return its original streaming Response. Extend the internal `callModelAttempt` with a forced-target argument, rather than duplicating its response parser. In explicit-policy mode the shared runner chooses candidates; the forced attempt bypasses pool re-selection and disables `chatCompletionWithFallback`'s generic tail. Automatic-only mode follows the current path.

- [x] Write loopback/fake-transport integration tests: explicit A fails, B answers, C is never called; explicit A with `[]` fails without catalog/pool/paid fallback; cloud-blocked A makes zero cloud requests and can advance to permitted B; exhausted chains fail; caller/stage abort prevents subsequent attempts. Run and observe failure.
- [x] Extract shared target dispatch and implement ordered execution, checking availability/cloud policy immediately before every candidate. Record preflight rejections separately from dispatched `RouteAttempt`s; a blocked cloud candidate must not set `left_machine=true`. A real dispatched cloud failure remains disclosed.
- [x] Route an explicit Ollama model exactly, rather than silently allowing `selectInstalledOllamaModel` to substitute. If unavailable, advance by the selected fallback policy. Keep llama.cpp endpoint/model identity exact.
- [x] Make explicit coordinator policy govern resident routing and model-based supervision/replanning, using the shared stage caller where needed; deterministic routing may still avoid inference. Disable Claude executor delegation when executor primary or fallback policy is explicit. Test these bypasses and that no override preserves current behavior.
- [x] Complete attribution in the Direct path as well: current `RoutePlan.add` is inside the orchestrated callback, while the Direct request loop begins after that branch. Record every real `agent_loop` attempt, including errors/fallbacks/cancellation, and attach its summary to terminal results without changing Direct selection. Add tests for Direct success, failed request, and fallback attribution. This is a prerequisite for the comparison plan's observed-route gate; configured `init` labels are insufficient evidence.
- [x] Run new integration tests plus `provider-availability`, `route-plan`, `tool-call-wire`, `coordinator`, `claude-delegate`, and existing HTTP fallback tests; run server typecheck. Assert ordered traces, correct final answer attribution, and unchanged automatic-mode results. Commit.

## Task 3: Add a bounded real route test on the owned-native channel

**Files:** `route-diagnostics.ts` and `.test.ts`; `native-memory.ts` and tests; `index.ts`; new Native `commands/orchestration.rs`; `memory/transport.rs`; command registration.

**Consumes:** Task 2 route resolver/runner, `requestStageTarget`, and existing `streamOpenRouterSSE` parser. Use configured candidate metadata for Automatic; local-only probes must not fetch cloud catalogs.

**Produces:** private routes `POST /internal/orchestration/test`, `POST /internal/orchestration/test/cancel`; Native commands `jarvis_test_orchestration_route({ operationId, stage, config })`, `jarvis_cancel_orchestration_route_test({ operationId })`. Results are `{ operation_id, stage, status, attempts, rejected_candidates, answered_by?, left_machine, duration_ms }`; reuse route-plan types for dispatched attempts. `status` is `success | failed | cancelled | timeout`.

- [x] Add failing tests for missing/invalid capability (zero requests), invalid stage/config, oversized body (256 KiB cap), duplicate operation, timeout, cancellation before/during inference, and cleanup after settlement. One active probe per owned Native app; a second distinct probe receives a busy result. Scope cancellation to its operation ID.
- [x] Implement through the existing owned-child capability channel, before general CORS handling. Reuse authorization without exposing the secret to React or weakening existing private routes. Do not offer this as an unauthenticated cloud-spending endpoint.
- [x] Use fixed prompt `Reply with exactly OK.`, tools absent, `temperature: 0`, maximum 64 completion tokens, total deadline 90,000 ms shared by the entire fallback chain, and request/cancel signal propagation. Success requires a usable nonempty completion; arbitrary HTTP 200/health availability is insufficient.
- [x] Reuse the production route runner and target transport; parse streaming with the existing parser. Do not call `streamJarvis`, create a Session/TaskRun, or run finalizers/proposers. Probe traces stay ephemeral and are returned to the initiating UI only. Redact errors and bound response/error sizes.
- [x] Run `bun test src/orchestration/route-diagnostics.test.ts src/native-memory.test.ts` and Native tests filtered to `orchestration`; require denied requests make zero inference calls and cancellation settles promptly. Commit.

## Task 4: Prove persisted configuration reached the serving Bun process

**Files:** `config.ts` and tests; `route-diagnostics.ts`; `commands/orchestration.rs`; `jarvis_commands.rs`; `memory/transport.rs`; Native settings/config projection tests.

**Produces:** `POST /internal/orchestration/reload` (invalidate/reload from disk; no config write) and typed Native `ConfigSaveResult { persisted, readback_ok, runtime_synced, warning_code? }`.

The private reload returns the Bun instance ID and SHA-256 of a canonical **routing descriptor**, not full config. Define a shared JSON fixture for both languages: backend ID; configured local/cloud model and endpoint fields; `enabled`; cloud toggle; six stage primary/fallback entries; conductor route configuration; and provider readiness booleans. Apply the same explicit defaults, fixed field names, recursively sorted object keys, and preserved array order. Credentials/capability are excluded. Native computes expected state from the submitted/read-back configuration and reports a mismatch honestly; no background success assumption after the five-second cache TTL.

- [x] Write failing tests for unknown-field preservation, pin -> `"automatic"` persistence through SQLite/file projection/reload, fingerprint stability, changed fallback order changing fingerprint, omitted false/defaults equivalence, and secret exclusion. Use temp SQLite/files only.
- [x] Write Native save tests for persistence failure, Native readback failure, unavailable Bun, wrong instance/fingerprint, and successful acknowledgement. Persisted configuration stays saved when runtime sync fails; failed persistence must not reconcile a new backend or report saved.
- [x] Implement save -> Native authoritative readback -> bounded authenticated Bun reload/readback. Keep existing service reconciliation, but cap the acknowledgement separately at 5 seconds. Return safe warning codes, never raw config/keys/errors.
- [x] Run config/projection/save tests, shared descriptor fixture tests in both languages, server typecheck, and `cargo check` in `src-tauri`. Commit.

## Task 5: Build the existing Settings section against those contracts

**Files:** `OrchestrationPanel.tsx`, `orchestration-draft.ts` and tests; `ConfigPanels.tsx`; `SettingsPage.tsx`; `SaveBar.tsx`; `domain/types.ts`; settings tests.

**Consumes:** Task 1 config schema, Task 3 Native probe/cancel commands, Task 4 save result/readback. UI uses typed routing targets; credentials remain in existing provider settings.

- [ ] Write failing UI tests for Direct/Orchestrated, cloud off when absent, six stage primary editors, custom fallback add/remove/reorder, empty-chain disablement, Automatic reset sentinel, and model IDs containing colons/slashes. Preserve unknown config fields and IDs not present in a current catalog; do not silently clear saved unavailable models.
- [ ] Implement the panel with existing design components and Save/Discard. Show configured llama.cpp identity as one serving target; offer only HTTP-supported stage providers. Explain Automatic versus explicit selection. Cloud-blocked targets remain understandable without silently enabling helpers.
- [ ] State that stage policies apply to Orchestrated turns; retain them when Direct is selected. A stage probe in a Direct draft is an isolated stage diagnostic and must not imply the Direct Session path now uses that stage.
- [ ] Write and implement save-state tests for persisted-but-unsynced, readback failure, and success. Keep edits on failure. Display `Saved locally; Bun sync unconfirmed` for the split outcome; only runtime acknowledgement earns the synced state. After the save result, call `jarvis_get_config` and apply that authoritative Native readback, not an optimistic copy of the submitted draft. A failed follow-up read keeps the submitted draft and an unconfirmed status.
- [ ] Write and implement probe tests for draft labeling, a fixed selected stage, failed/cancelled/timeout outcomes, busy duplicate clicks, stale completion after edits/navigation, and component unmount cancellation. Associate results with an immutable draft signature; prior results cannot certify a changed draft. Show actual attempts, preflight rejections, latency, and destination status, with no claims about deployment or answer quality.
- [ ] Run `bun run test -- src/features/settings` and `bun run build` in `src-ui`. Render the settings at desktop and narrow widths in a Tauri-capable harness, inspect focus/labels/overflow, then exercise a real local probe through Native forwarding; browser mocks alone do not prove the forwarding path. Commit.

## Task 6: Integrate and record acceptance

**Files:** new `docs/reports/2026-11-07-orchestration-settings.md`; `docs/CURRENT_ROADMAP.md` interruption note; `docs/orchestration/route-map.md` current checkpoint, preserving its historical Phase 0 evidence.

- [ ] Run server typecheck/build/full tests, UI build/full tests, and `cargo check` plus the Native tests for changed contracts. Preserve exact exit codes and suite totals. Investigate failures without weakening assertions or silently treating an isolated rerun as a green full suite.
- [ ] From an isolated Native-capable instance, save Direct/cloud-off, reload/read back, run a local probe, change a stage model/fallback order, verify its real dispatch trace, reset to Automatic, and verify round-trip persistence. Confirm failure and cancellation states. Keep production configuration untouched.
- [ ] Request one independent final review of the diff and validation evidence; fix actionable findings and rerun affected checks. Do not claim packaged acceptance unless a built package was installed/launched/tested explicitly.
- [ ] Record source SHA, tests/builds, actual isolated runtime evidence, all remaining limitations, and the roadmap interruption. Commit feature/evidence on this branch; landing/pushing remains outside this plan.

## Execution order and current status

Tasks 1 -> 2 -> 3. Task 4 can follow Task 1 and share Task 3's private transport. Task 5 consumes Tasks 1, 3, and 4; Task 6 closes source/runtime checks. Do not parallelize mutations to `index.ts`, Native transport, or shared settings files without disjoint ownership.

Tasks 1–4 are complete on this branch. Ethan approved the design and implementation; his latest instruction requests concrete implementation plans for substantial pieces. The separate comparison plan owns experimental fixtures, collection, and the empirical report.

### 2026-11-07 reviewed landing checkpoint

Ethan subsequently authorized review and landing of this implementation while excluding live testing and verification. Tasks 1–4 were imported onto the comparison landing at `e35a3d3`; Task 5's UI source and test source were snapshotted from the author worktree without modifying it. Independent source review found and repaired concrete backend/Native/UI defects. Server typecheck/build, UI build, and `cargo check --tests --offline` passed; test execution, rendered inspection, real diagnostic forwarding, model runs, and packaged checks were deliberately omitted. The compound checkboxes above remain unchecked where they require that missing evidence. The resident conductor's existing global configuration getter also leaves the in-flight snapshot requirement unproven and open. See the [source review record](../../reports/2026-11-07-orchestration-settings.md) for provenance, findings, and acceptance limits. Landing/pushing is authorized by this later instruction; roadmap acceptance is unchanged.
