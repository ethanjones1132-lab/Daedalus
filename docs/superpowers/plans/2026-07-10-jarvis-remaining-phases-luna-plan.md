# Jarvis Remaining Phases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Jarvis a dependable, observable local desktop coding platform by closing the remaining runtime contracts before expanding autonomy, remote access, and self-improvement.

**Architecture:** Preserve the native split: React renders and controls the desktop surface, Tauri/Rust owns native persistence and local lifecycle, and the Bun service owns `/chat/stream`, orchestration, model calls, and tool execution. Each phase adds a narrow contract and a release-level proof; no phase may rely on optimistic UI state, a unit test alone, or a stale Desktop bundle.

**Tech Stack:** Tauri/Rust, Bun/TypeScript, React/Vite, SQLite, SSE, OpenRouter/Ollama providers, PowerShell deployment scripts, Windows Desktop runtime.

## Global Constraints

- Start from the current source and deployed provenance; record `git rev-parse HEAD`, Desktop manifest SHA, `/health.git_sha`, and the Bun listener command line before changing behavior.
- Preserve the current native architecture. Do not route native SQLite, bridge lifecycle, or Tauri commands through an unrelated external service.
- Treat `C:\Users\ethan\OneDrive\Desktop\Jarvis.exe` plus its sibling `index.js` and `prompts/` directory as one deployable unit.
- Keep the active workspace root as session state; do not replace it with a fixed application-wide path.
- Use TDD: add a focused failing test, run it red, make the smallest implementation, run it green, then run the relevant broader gate.
- Do not enable arbitrary shell execution merely to retrieve Git metadata. Introduce a narrow read-only capability with explicit argument validation.
- Never represent an incomplete model answer as a successful final result. Use a typed terminal outcome: `success`, `partial`, `failed`, `timed_out`, or `cancelled`.
- Keep `interactive_approval`, cron, agent, and MCP policy decisions explicit and auditable. Non-interactive execution must not silently inherit interactive authority.
- Do not integrate the preserved legacy conductor WIP simply because it exists in `stash@{0}`. Adapt only behavior that has a current-source test and an explicit live owner.
- Do not commit, push, or merge unless the operator explicitly asks. Keep unrelated staged and untracked work intact.

---

## Current verified baseline

- Desktop deployment: `0ca584bb6`; manifest, `/health.git_sha`, Desktop `index.js` hash, and Bun command line were verified to agree.
- Fresh `Jarvis.exe` starts the Bun sidecar automatically in under one second.
- Basic direct SSE request completed with one `result` frame in about three seconds.
- Read-only workspace request completed executor → synthesizer and listed repository entries; it could not obtain Git SHA because no narrow Git/shell metadata capability was offered.
- Full code-review request completed executor → reviewer → synthesizer in about 53.5 seconds; rewriter-on-review-reject is not yet live-proven.
- `bunx tsc --noEmit` and `bun test` passed with 744 tests before this plan was written.

## File and ownership map

| Layer | Current owner files | Planned responsibility |
|---|---|---|
| Stream boundary | `server-jarvis/src/index.ts`, `stream-emitter.ts`, `stream-control.ts`, `stream-liveness.ts` | One request/run identity, typed terminal outcomes, deadline and fallback telemetry. |
| Pipeline | `server-jarvis/src/orchestration/pipeline.ts`, `coordinator.ts`, `replan-loop.ts`, `agent-pool.ts` | Route selection, stage state, rewriter recovery, partial-result policy, model attribution. |
| Tools | `tool-runtime.ts`, `bundles-registry.ts`, `modes.ts`, `filesystem-bundle.ts`, `meta-bundle.ts` | Least-authority capability catalog, approval policy, durable task/Git metadata tools. |
| Native state | `src-tauri/src/commands/{sessions,models,settings,recovery_stubs,system}.rs`, `src-tauri/src/jarvis/{bridge,memory/engine}.rs` | Single authority for state, real command implementations, restartable local services. |
| UI state | `src-ui/src/components/jarvis/{JarvisView,chat-state,sse-protocol,ControlCenterView,SettingsView}.tsx` | Terminal stage rendering, effective configuration, actionable error/retry state. |
| Integrations | `server-jarvis/src/{bridge,agent-routes,agent-lifecycle,mcp-adapter}.ts`, Tauri views/commands | Authenticated transports, mounted lifecycle APIs, real device/node/channel semantics. |
| Delivery | `scripts/build-and-deploy.ps1`, `scripts/verify-deploy.ps1`, `docs/sse-stream-contract.md` | Build provenance, packaged runtime smoke, live release evidence. |

## Phase 0 — establish the repeatable release harness

### Task 1: Add a machine-readable live smoke harness

**Status:** Complete — focused tests, live SSE smoke, and deployed listener provenance verification passed. Commit intentionally deferred per the plan's no-commit constraint.

**Files:**

- Create: `scripts/smoke-jarvis-runtime.ps1`
- Modify: `scripts/verify-deploy.ps1`
- Modify: `docs/sse-stream-contract.md`
- Test: `server-jarvis/src/stream-control.test.ts`

**Interfaces:**

- Consumes: `GET /health`, `POST /chat/stream`, Desktop manifest, and listener process metadata.
- Produces: a JSON record with `manifest_sha`, `health_sha`, `listener_command`, `session_id`, `elapsed_ms`, `terminal_type`, and `result_text`.

- [x] **Step 1: Write the failing contract test**

```ts
test("terminal smoke records exactly one terminal outcome", async () => {
  const events = collectTerminalEvents([
    { type: "message_stop" },
    { type: "result", subtype: "success", result: "ok" },
  ]);

  expect(events).toEqual([{ type: "result", subtype: "success", result: "ok" }]);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test src/stream-control.test.ts`

Expected: FAIL because `collectTerminalEvents` is absent or does not reject duplicate terminal outcomes.

- [x] **Step 3: Implement the smallest reusable parser and PowerShell harness**

```ts
export function collectTerminalEvents(events: Array<{ type?: string }>) {
  return events.filter((event) =>
    event.type === "result" || event.type === "error" || event.type === "cancelled",
  );
}
```

```powershell
$record = [ordered]@{
  manifest_sha = $manifest.git_sha
  health_sha = $health.git_sha
  session_id = $sessionId
  elapsed_ms = $elapsed.ElapsedMilliseconds
  terminal_type = $terminal.type
  result_text = $terminal.result
}
$record | ConvertTo-Json -Depth 5
```

- [x] **Step 4: Run the focused and live checks**

Run: `bun test src/stream-control.test.ts`

Expected: PASS.

Run: `powershell -ExecutionPolicy Bypass -File scripts/smoke-jarvis-runtime.ps1 -Prompt "Reply with exactly: smoke ok."`

Expected: JSON where `manifest_sha == health_sha`, `terminal_type == "result"`, and `result_text` contains `smoke ok`.

- [x] **Step 5: Commit the isolated harness (deferred; commits require explicit operator approval)**

```bash
git add scripts/smoke-jarvis-runtime.ps1 scripts/verify-deploy.ps1 docs/sse-stream-contract.md server-jarvis/src/stream-control.test.ts
git commit -m "test(jarvis): add live runtime smoke harness"
```

## Phase 1 — close P0 request reliability and least-authority workspace capability

### Task 2: Make every stage reach a typed terminal state

**Status:** Complete — timeout fixture, server/UI focused tests, UI build, packaged rebuild, listener provenance, and live SSE smoke passed.

**Files:**

- Modify: `server-jarvis/src/orchestration/pipeline.ts`
- Modify: `server-jarvis/src/index.ts`
- Modify: `server-jarvis/src/stream-emitter.ts`
- Modify: `server-jarvis/src/orchestration/stage-output.ts`
- Modify: `src-ui/src/components/jarvis/sse-protocol.ts`
- Modify: `src-ui/src/components/jarvis/chat-state.ts`
- Modify: `src-ui/src/components/jarvis/JarvisView.tsx`
- Test: `server-jarvis/src/orchestration.test.ts`
- Test: `src-ui/src/components/jarvis/sse-protocol.test.ts`

**Interfaces:**

- Consumes: `PipelineProgressState`, model abort signals, and SSE frames.
- Produces: `StageTerminalStatus = "completed" | "failed" | "timed_out" | "cancelled" | "partial"` and exactly one request outcome.

- [x] **Step 1: Write the failing server and UI tests**

```ts
test("rewriter timeout yields a partial result and terminal timed_out stage", async () => {
  const result = await executeTimedOutRewriterFixture();

  expect(result.outcome).toBe("partial");
  expect(result.error_code).toBe("stage_timeout");
  expect(result.answer).toContain("executor evidence");
});
```

```ts
it("replaces a running stage with timed_out after a terminal timeout frame", () => {
  const state = reduceSseFrames([
    stage("rewriter", "running"),
    stage("rewriter", "timed_out"),
    result("partial", "draft answer"),
  ]);

  expect(state.stages.rewriter.status).toBe("timed_out");
  expect(state.isStreaming).toBe(false);
});
```

- [x] **Step 2: Run the tests red**

Run: `bun test src/orchestration.test.ts`

Run: `bun test src/components/jarvis/sse-protocol.test.ts`

Expected: FAIL because stage status only supports `running`, `done`, and `failed`, and the current pipeline returns a generic failure or remains active.

- [x] **Step 3: Implement the terminal-state contract**

```ts
export type StageTerminalStatus = "completed" | "failed" | "timed_out" | "cancelled" | "partial";

function emitTerminalStage(stage: StageName, status: StageTerminalStatus, detail?: string) {
  return writer.write(encoder.encode(`data: ${JSON.stringify({
    type: "orchestrator_stage",
    stage,
    status,
    detail,
    session_id: sessionId,
    run_id: agentRunId,
  })}\n\n`));
}
```

Route a timeout after useful predecessor evidence through `PipelineResult` as:

```ts
return {
  answer: buildPartialAnswer(state),
  outcome: "partial",
  error_code: "stage_timeout",
};
```

Do not emit a partial answer for an authentication, policy, or workspace-evidence failure.

- [x] **Step 4: Run focused and full stream checks**

Run: `bun test src/orchestration.test.ts src/stream-control.test.ts`

Run: `bun test src/components/jarvis/sse-protocol.test.ts src/components/jarvis/chat-state.test.ts`

Expected: PASS; no terminal frame leaves `isStreaming` true.

- [x] **Step 5: Commit the terminal contract (deferred; commits require explicit operator approval)**

```bash
git add server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/index.ts server-jarvis/src/stream-emitter.ts src-ui/src/components/jarvis/sse-protocol.ts src-ui/src/components/jarvis/chat-state.ts server-jarvis/src/orchestration.test.ts src-ui/src/components/jarvis/sse-protocol.test.ts
git commit -m "fix(jarvis): terminalize timed out pipeline stages"
```

### Task 3: Add a read-only Git metadata tool instead of broad shell access

**Status:** Complete — fixed-subcommand bundle tests, read-only mode tests, deterministic workspace preflight, packaged provenance verification, and live SHA smoke passed. The smoke recorded `tool_names:["git_metadata"]` and the deployed SHA.

**Files:**

- Create: `server-jarvis/src/git-metadata-bundle.ts`
- Modify: `server-jarvis/src/bundles-registry.ts`
- Modify: `server-jarvis/src/orchestration/modes.ts`
- Modify: `server-jarvis/src/tool-runtime.ts`
- Modify: `server-jarvis/src/orchestration/pipeline.ts`
- Modify: `server-jarvis/src/index.ts`
- Modify: `scripts/smoke-jarvis-runtime.ps1`
- Test: `server-jarvis/src/git-metadata-bundle.test.ts`
- Test: `server-jarvis/src/orchestration.test.ts`

**Interfaces:**

- Consumes: `ExecutionContext.workspace_path` and a user request classified as `workspace_read`.
- Produces: `git_metadata({ include?: Array<"head" | "branch" | "dirty"> })` with no file mutation and no arbitrary command argument.

- [x] **Step 1: Write the failing tests**

```ts
test("git_metadata reports the checked-out SHA without accepting a command string", async () => {
  const result = await runtime.execute(
    call("git_metadata", { include: ["head"] }),
    ctx(repoRoot),
  );

  expect(result.is_error).toBe(false);
  expect(result.output).toMatch(/[0-9a-f]{40}/);
});

test("workspace_read executor receives git_metadata but not shell_execute", () => {
  const names = getToolsForMode("executor", allTools, "read_only").map((tool) => tool.name);
  expect(names).toContain("git_metadata");
  expect(names).not.toContain("shell_execute");
});
```

- [x] **Step 2: Run the tests red**

Run: `bun test src/git-metadata-bundle.test.ts src/orchestration.test.ts`

Expected: FAIL because `git_metadata` is not registered.

- [x] **Step 3: Implement the constrained capability**

```ts
export const gitMetadataBundle: ToolDefinition[] = [{
  name: "git_metadata",
  description: "Read Git HEAD, branch, and dirty status for the active workspace.",
  dangerous: false,
  execute: async ({ include = ["head", "branch", "dirty"] }, ctx) => {
    const root = requireWorkspaceRoot(ctx.workspace_path);
    const gitDir = resolve(root, ".git");
    if (!existsSync(gitDir)) return toolError("not_a_git_repository");
    return readGitMetadata(root, include);
  },
}];
```

`readGitMetadata` may invoke fixed Git subcommands only: `rev-parse HEAD`, `branch --show-current`, and `status --porcelain`. Reject unknown `include` values before process launch.

- [x] **Step 4: Verify behavior and packaged runtime**

Run: `bun test src/git-metadata-bundle.test.ts src/orchestration.test.ts`

Expected: PASS.

Run: `powershell -ExecutionPolicy Bypass -File scripts/smoke-jarvis-runtime.ps1 -Prompt "Inspect C:\Projects\home-base-recovered, report the Git SHA, and do not modify files."`

Expected: terminal success includes the deployed SHA; no shell tool is listed in the event trace.

- [x] **Step 5: Commit the capability (deferred; commits require explicit operator approval)**

```bash
git add server-jarvis/src/git-metadata-bundle.ts server-jarvis/src/git-metadata-bundle.test.ts server-jarvis/src/bundles-registry.ts server-jarvis/src/orchestration/modes.ts server-jarvis/src/tool-runtime.ts server-jarvis/src/orchestration.test.ts
git commit -m "feat(jarvis): expose read-only git metadata tool"
```

### Task 4: Make coordinator fallback measurable and deterministic

**Status:** Complete — malformed-output model identity test, coordinator/agent-pool gates, packaged provenance verification, and live full-execution code-review smoke passed. The smoke recorded one structured coordinator `fallback_notice` with model `deepseek-v4-pro` and source `api`.

**Files:**

- Modify: `server-jarvis/src/orchestration/coordinator.ts`
- Modify: `server-jarvis/src/orchestration/agent-pool.ts`
- Modify: `server-jarvis/src/index.ts`
- Test: `server-jarvis/src/orchestration/coordinator.test.ts`
- Test: `server-jarvis/src/orchestration/agent-pool.test.ts`

**Interfaces:**

- Consumes: raw coordinator output and selected provider/model metadata.
- Produces: `CoordinatorResult` with `conductor_source`, `routing_parse_fallback`, `conductor_model`, and a structured fallback event.

- [x] **Step 1: Write the failing tests**

```ts
test("unparseable coordinator output produces a typed fallback with model identity", async () => {
  const decision = await coordinator.route("inspect README", { sessionId: "s1" });

  expect(decision.routing_parse_fallback).toBe(true);
  expect(decision.conductor_model).toBe("deepseek-v4-pro");
  expect(decision.conductor_source).toBe("api");
});
```

- [x] **Step 2: Run the test red**

Run: `bun test src/orchestration/coordinator.test.ts`

Expected: FAIL because the fallback loses route/model reason or uses only an unstructured console warning.

- [x] **Step 3: Emit typed fallback data and use a JSON-biased coordinator contract**

```ts
decision = {
  ...this.defaultRoute(),
  routing_parse_fallback: true,
  conductor_source: "api",
  conductor_model: response.model,
  coordinator_rationale: "Coordinator output was not valid JSON; normalized safe route selected.",
};
```

In `index.ts`, publish:

```ts
{ type: "fallback_notice", stage: "coordinator", reason: "routing_parse_fallback", model: decision.conductor_model, session_id: sessionId, run_id: agentRunId }
```

- [x] **Step 4: Run test and live route checks**

Run: `bun test src/orchestration/coordinator.test.ts src/orchestration/agent-pool.test.ts`

Expected: PASS.

Run: direct code-review smoke through `scripts/smoke-jarvis-runtime.ps1`.

Expected: any coordinator fallback is visible as one structured `fallback_notice`, never only a log line.

- [x] **Step 5: Commit the measurable fallback (deferred; commits require explicit operator approval)**

```bash
git add server-jarvis/src/orchestration/coordinator.ts server-jarvis/src/orchestration/agent-pool.ts server-jarvis/src/index.ts server-jarvis/src/orchestration/coordinator.test.ts server-jarvis/src/orchestration/agent-pool.test.ts
git commit -m "fix(jarvis): expose coordinator parse fallback"
```

## Phase 2 — remove state-authority splits and false-success commands

### Task 5: Establish one session and run-history authority

**Status:** Implementation and native/unit coverage complete; packaged create/cancel/restart/reopen verification remains.

**Files:**

- Modify: `server-jarvis/src/index.ts`
- Modify: `src-tauri/src/commands/sessions.rs`
- Modify: `src-tauri/src/commands/jarvis_commands.rs`
- Modify: `src-ui/src/components/jarvis/SessionsView.tsx`
- Test: `server-jarvis/src/index.test.ts`
- Test: `src-tauri/src/commands/sessions.rs`

**Interfaces:**

- Consumes: canonical Tauri SQLite session ID and SSE run events.
- Produces: `SessionRunRecord { session_id, run_id, outcome, selected_model, token_count, tool_count, cancelled_reason?, partial_output? }`.

- [x] **Step 1: Write failing contract tests**

```ts
test("legacy Bun /sessions endpoint cannot create a non-durable parallel session", async () => {
  const response = await app.fetch(new Request("http://local/sessions", { method: "POST" }));
  expect(response.status).toBe(410);
});
```

```rust
#[test]
fn cancelled_run_persists_a_terminal_outcome() {
    let record = persist_terminal_run("s1", "r1", "cancelled", Some("user_stop"));
    assert_eq!(record.outcome, "cancelled");
}
```

- [x] **Step 2: Run the tests red**

Run: `bun test src/index.test.ts`

Run: `cargo test sessions`

Expected: FAIL because Bun currently returns placeholder session objects and cancellation has no unified run record.

- [x] **Step 3: Remove the parallel placeholder surface and persist terminal events**

Return an explicit migration response from Bun:

```ts
return Response.json({ error: "sessions_are_native", code: "deprecated_session_api" }, { status: 410 });
```

Persist every terminal SSE outcome through one native command or one Bun-to-native persistence adapter; do not maintain two writable session tables.

- [ ] **Step 4: Verify UI and restart behavior**

Run: `bun test src/index.test.ts`

Run: `cargo test sessions`

Run: create, cancel, restart, and reopen a session in the packaged app.

Expected: one session shows the same terminal outcome, model, and tool count before and after restart.

- [ ] **Step 5: Commit the session authority change**

```bash
git add server-jarvis/src/index.ts src-tauri/src/commands/sessions.rs src-tauri/src/commands/jarvis_commands.rs src-ui/src/components/jarvis/SessionsView.tsx server-jarvis/src/index.test.ts
git commit -m "fix(jarvis): unify session run history authority"
```

### Task 6: Make model-profile and settings changes affect the live runtime

**Status:** Implementation and Rust/Bun/UI coverage complete; live profile-switch reconciliation proof remains.

**Files:**

- Modify: `src-tauri/src/commands/models.rs`
- Modify: `src-tauri/src/commands/settings.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `server-jarvis/src/config.ts`
- Modify: `src-ui/src/components/jarvis/ControlCenterView.tsx`
- Modify: `src-ui/src/components/jarvis/SettingsView.tsx`
- Test: `server-jarvis/src/config.test.ts`
- Test: `src-tauri/src/commands/models.rs`

**Interfaces:**

- Consumes: profile ID or typed setting mutation.
- Produces: `EffectiveRuntimeConfig { provider, model, source, applied_at, restart_required }`.

- [x] **Step 1: Write failing tests**

```rust
#[test]
fn activating_a_profile_writes_the_canonical_config_projection() {
    let effective = set_active_profile_and_reconcile(&db, "profile-a").unwrap();
    assert_eq!(effective.model, "model-a");
}
```

```ts
test("raw settings mutation rejects an unknown key instead of silently storing it", () => {
  expect(() => normalizeSettingMutation({ key: "unknown", value: true })).toThrow("unknown_setting");
});
```

- [x] **Step 2: Run red**

Run: `cargo test models`

Run: `bun test src/config.test.ts`

Expected: FAIL because active profile only flips a SQLite flag and settings accept untyped direct upserts.

- [x] **Step 3: Implement one apply-and-reconcile transaction**

```rust
pub struct EffectiveRuntimeConfig {
    pub provider: String,
    pub model: String,
    pub source: String,
    pub applied_at: String,
    pub restart_required: bool,
}
```

The transaction must update canonical SQLite state, project the Bun-readable configuration, trigger bounded runtime reconciliation, and return the effective provider/model. The UI must display this returned object, not infer it from selected profile labels.

- [ ] **Step 4: Verify profile switch live**

Run: `cargo test models`

Run: `bun test src/config.test.ts`

Run: activate a profile in Control Center, send a short prompt, then compare the response's `init.model` and `/health.model` to `EffectiveRuntimeConfig`.

Expected: all three values agree or the UI shows a typed reconcile failure.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/models.rs src-tauri/src/commands/settings.rs src-tauri/src/commands/mod.rs server-jarvis/src/config.ts src-ui/src/components/jarvis/ControlCenterView.tsx src-ui/src/components/jarvis/SettingsView.tsx server-jarvis/src/config.test.ts
git commit -m "fix(jarvis): reconcile model profiles with live runtime"
```

### Task 7: Mount agent lifecycle and replace native false-success stubs

**Status:** Implementation and Rust/Bun/UI coverage complete; restart-safe packaged lifecycle proof remains.

**Files:**

- Modify: `server-jarvis/src/index.ts`
- Modify: `server-jarvis/src/agent-routes.ts`
- Modify: `src-tauri/src/commands/recovery_stubs.rs`
- Modify: `src-tauri/src/jarvis/memory/engine.rs`
- Modify: `src-ui/src/components/jarvis/AgentsView.tsx`
- Test: `server-jarvis/src/agent-routes.test.ts`
- Test: `src-tauri/src/commands/recovery_stubs.rs`

**Interfaces:**

- Consumes: canonical agent directory/projection and session ID.
- Produces: mounted `/agents/*` lifecycle API, a real review result, and an idempotent session-end commit result.

- [x] **Step 1: Write failing tests**

```ts
test("GET /agents returns lifecycle scan results from the mounted handler", async () => {
  const response = await app.fetch(new Request("http://local/agents"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expect.arrayContaining([expect.objectContaining({ slug: "coder" })]));
});
```

```rust
#[test]
fn commit_session_end_calls_the_memory_engine_once() {
    let first = jarvis_commit_session_end("s1".into(), state()).unwrap();
    let second = jarvis_commit_session_end("s1".into(), state()).unwrap();
    assert_eq!(first.commit_id, second.commit_id);
}
```

- [x] **Step 2: Run red**

Run: `bun test src/agent-routes.test.ts`

Run: `cargo test recovery_stubs`

Expected: FAIL because handlers are imported but not mounted, review returns a stub, or session commit is a no-op.

- [x] **Step 3: Wire the real owners**

```ts
if (path === "/agents" && req.method === "GET") {
  return Response.json(handleListAgents(lifecycle));
}
```

Replace the no-op Rust wrappers with calls into the existing memory engine. Agents UI must show canonical activation/projection status and surface failure detail instead of treating a local row as activation success.

- [ ] **Step 4: Verify restart-safe lifecycle**

Run: `bun test src/agent-routes.test.ts`

Run: `cargo test recovery_stubs`

Run: scan, activate, restart the app, list agents, deactivate.

Expected: canonical projection and UI state agree after restart.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/index.ts server-jarvis/src/agent-routes.ts src-tauri/src/commands/recovery_stubs.rs src-tauri/src/jarvis/memory/engine.rs src-ui/src/components/jarvis/AgentsView.tsx server-jarvis/src/agent-routes.test.ts
git commit -m "fix(jarvis): wire agent lifecycle and session commit commands"
```

## Phase 3 — complete native operations, policy, and scheduled work

### Task 8: Make approval, task, learning, and bridge operations real

**Status:** Implementation and Rust/Bun coverage complete; interactive/cron packaged policy smoke remains.

**Files:**

- Modify: `server-jarvis/src/config.ts`
- Modify: `server-jarvis/src/tool-runtime.ts`
- Modify: `server-jarvis/src/meta-bundle.ts`
- Modify: `src-tauri/src/commands/jarvis_commands.rs`
- Modify: `src-tauri/src/commands/system.rs`
- Modify: `src-tauri/src/jarvis/bridge.rs`
- Test: `server-jarvis/src/tool-runtime.test.ts`
- Test: `server-jarvis/src/meta-bundle.test.ts`
- Test: `src-tauri/src/commands/system.rs`

**Interfaces:**

- Consumes: a tool policy context, durable task item, and bridge lifecycle command.
- Produces: auditable approval decision, persisted task record, real learning run status, and `BridgeLifecycleStatus`.

- [x] **Step 1: Write failing tests**

```ts
test("dangerous interactive tool requires an approval decision by default", async () => {
  const result = await runtime.execute(call("shell_execute", { command: "echo safe" }), interactiveCtx());
  expect(result.error_code).toBe("approval_required");
});

test("todo_write persists and todo_list returns the same item", async () => {
  await runtime.execute(call("todo_write", { todos: [{ id: "t1", text: "verify deploy" }] }), ctx());
  expect(await runtime.execute(call("todo_list", {}), ctx())).toContain("verify deploy");
});
```

```rust
#[test]
fn restart_bridge_stops_then_rebinds_the_listener() {
    let status = restart_bridge().unwrap();
    assert!(status.running);
}
```

- [x] **Step 2: Run red**

Run: `bun test src/tool-runtime.test.ts src/meta-bundle.test.ts`

Run: `cargo test system`

Expected: FAIL because interactive approval defaults to direct allow, `todo_write` is an acknowledgement, and bridge restart is explicitly unimplemented.

- [x] **Step 3: Implement explicit durable contracts**

Use an approval request record with `request_id`, tool name, argument hash, expiry, policy source, and resolution. Persist task records in a native SQLite table or a single Bun-owned SQLite table; do not use model context as storage. Replace the bridge `OnceLock` ownership with a restartable service handle that supports `start`, `stop`, `restart`, and `health`.

- [ ] **Step 4: Verify all policy contexts**

Run: `bun test src/tool-runtime.test.ts src/meta-bundle.test.ts`

Run: `cargo test system`

Run: interactive approve/deny/expiry smoke, cron dangerous-tool denial smoke, and bridge restart smoke.

Expected: each decision is durable and visible in an audit event.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/config.ts server-jarvis/src/tool-runtime.ts server-jarvis/src/meta-bundle.ts src-tauri/src/commands/jarvis_commands.rs src-tauri/src/commands/system.rs src-tauri/src/jarvis/bridge.rs server-jarvis/src/tool-runtime.test.ts server-jarvis/src/meta-bundle.test.ts
git commit -m "feat(jarvis): make approvals tasks and bridge lifecycle durable"
```

### Task 9: Finish cron and action-registry execution contracts

**Status:** Implementation and Rust/Bun/UI coverage complete; packaged schedule/retry/cancellation evidence remains.

**Files:**

- Modify: `server-jarvis/src/cron-runtime.ts`
- Modify: `server-jarvis/src/cron-runtime.test.ts`
- Modify: `src-tauri/src/commands/action_registry.rs`
- Modify: `src-ui/src/components/jarvis/ActionRegistryView.tsx`
- Modify: `src-ui/src/components/jarvis/CronView.tsx`

**Interfaces:**

- Consumes: an enabled cron/action record and execution policy.
- Produces: `ExecutionEvidence { run_id, status, started_at, finished_at, acceptance_result, error_code? }`.

- [x] **Step 1: Write failing tests**

```ts
test("cron retry records a terminal failed attempt before scheduling the next attempt", async () => {
  const runs = await runRetryFixture();
  expect(runs.map((run) => run.status)).toEqual(["failed", "success"]);
});
```

```rust
#[test]
fn approved_action_claims_once_and_persists_acceptance_evidence() {
    let evidence = dispatch_approved_action("a1", state()).unwrap();
    assert_eq!(evidence.status, "verified");
}
```

- [x] **Step 2: Run red**

Run: `bun test src/cron-runtime.test.ts`

Run: `cargo test action_registry`

Expected: FAIL because action state changes are not dispatched/verified or cron lacks persisted retry evidence.

- [x] **Step 3: Implement leased execution and evidence write-back**

```rust
pub struct ExecutionEvidence {
    pub run_id: String,
    pub status: String,
    pub acceptance_result: String,
    pub error_code: Option<String>,
}
```

Use a claim lease, one idempotency key, a policy check, an acceptance command result, and an atomic registry update. Cron must use the same evidence shape and retain cancellation/retry history.

- [ ] **Step 4: Verify scheduled and manual paths**

Run: `bun test src/cron-runtime.test.ts`

Run: `cargo test action_registry`

Run: packaged cron schedule, missed-run, retry, cancellation, and approved-action smoke.

Expected: UI shows the exact evidence record after restart.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/cron-runtime.ts server-jarvis/src/cron-runtime.test.ts src-tauri/src/commands/action_registry.rs src-ui/src/components/jarvis/ActionRegistryView.tsx src-ui/src/components/jarvis/CronView.tsx
git commit -m "feat(jarvis): verify cron and action execution evidence"
```

## Phase 4 — memory, skills, conductor, and measured improvement

### Task 10: Complete memory review, cold retrieval, and skill promotion gates

**Status:** Implementation and Rust/Bun/UI coverage complete; live benchmark, promotion, and rollback evidence remains.

**Files:**

- Modify: `src-tauri/src/jarvis/memory/engine.rs`
- Modify: `src-tauri/src/commands/recovery_stubs.rs`
- Modify: `server-jarvis/src/skills.ts`
- Modify: `server-jarvis/src/eval/judge.ts`
- Modify: `src-ui/src/components/jarvis/SkillsView.tsx`
- Test: `server-jarvis/src/eval/judge.test.ts`
- Test: `src-tauri/src/jarvis/memory/engine.rs`

**Interfaces:**

- Consumes: memory ID, authenticated cold storage reference, and skill candidate revision.
- Produces: `MemoryRecallResult`, `SkillPromotionDecision`, and rollbackable promotion history.

- [x] **Step 1: Write failing tests**

```rust
#[test]
fn cold_recall_fetches_cached_drive_content_when_network_is_available() {
    let content = recall_cold_memory(&conn, "cold-1").unwrap().unwrap();
    assert_eq!(content, "retrieved content");
}
```

```ts
test("bulk promotion refuses a candidate without a passing judge decision", async () => {
  await expect(promoteCandidates(["candidate-1"])).rejects.toThrow("judge_required");
});
```

- [x] **Step 2: Run red**

Run: `cargo test memory`

Run: `bun test src/eval/judge.test.ts`

Expected: FAIL because cold recall returns deferred and bulk promotion is heuristic-only.

- [x] **Step 3: Implement bounded retrieval and judge-gated promotion**

```ts
export type SkillPromotionDecision = {
  candidate_id: string;
  judge_score: number;
  decision: "promote" | "reject";
  rationale: string;
  rollback_revision_id?: string;
};
```

Cache cold content with source ID, fetched timestamp, redaction state, and TTL. Every promotion path, including bulk/scheduled promotion, must write a judge decision and a prior revision pointer before enabling a skill.

- [ ] **Step 4: Verify a live before/after benchmark**

Run: `cargo test memory`

Run: `bun test src/eval/judge.test.ts`

Run: record baseline fixture, distill candidate, evaluate, promote, repeat fixture, and rollback.

Expected: the report records latency/tool-success/grounding deltas and the rollback restores the previous revision.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/jarvis/memory/engine.rs src-tauri/src/commands/recovery_stubs.rs server-jarvis/src/skills.ts server-jarvis/src/eval/judge.ts src-ui/src/components/jarvis/SkillsView.tsx server-jarvis/src/eval/judge.test.ts
git commit -m "feat(jarvis): gate skills with recall and judge evidence"
```

### Task 11: Wire conductor supervision only after pipeline reliability gates pass

**Status:** Request-scoped implementation and Rust/Bun/UI coverage complete; packaged conductor telemetry smoke remains.

**Files:**

- Modify: `server-jarvis/src/index.ts`
- Modify: `server-jarvis/src/orchestration/pipeline.ts`
- Modify: `server-jarvis/src/orchestration/conductor.ts`
- Modify: `server-jarvis/src/orchestration/conductor-bus.ts`
- Modify: `src-ui/src/components/jarvis/SystemHealthView.tsx`
- Test: `server-jarvis/src/orchestration.test.ts`
- Test: `server-jarvis/src/orchestration/conductor.test.ts`

**Interfaces:**

- Consumes: request-scoped `ConductorWiring`, stage events, and policy-safe stage aborts.
- Produces: `conductor_directive` SSE events, audit records, and visible cache/directive metrics.

- [x] **Step 1: Write the failing route-wiring test**

```ts
test("index creates request-scoped conductor wiring and clears it after the terminal result", async () => {
  const result = await streamWithConductorFixture();
  expect(result.events).toContainEqual(expect.objectContaining({ type: "conductor_directive" }));
  expect(result.bus_cleared).toBe(true);
});
```

- [x] **Step 2: Run red**

Run: `bun test src/orchestration.test.ts src/orchestration/conductor.test.ts`

Expected: FAIL because `index.ts` constructs `PipelineExecutor` without `ConductorWiring`.

- [x] **Step 3: Add request-scoped wiring, never global mutable wiring**

```ts
const bus = new ConductorBus();
const conductor = new LiveConductor(callModel, bus, agentPool, cfg.orchestrator.conductor.supervision);
const executor = new PipelineExecutor(callModel, runtime, ctx, { bus, live: conductor });
try {
  return await executePipelineWithEvents(executor);
} finally {
  bus.clear();
}
```

Do not allow `reroute` or `inject_context` to skip the existing route-normalization and evidence fences. A conductor abort must produce the terminal contract from Task 2.

- [ ] **Step 4: Verify metrics and failure isolation**

Run: `bun test src/orchestration.test.ts src/orchestration/conductor.test.ts`

Run: force a conductor timeout and a stage abort fixture.

Expected: main request still reaches a typed outcome, directive audit persists, and System Health displays conductor cache/directive data.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/index.ts server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/orchestration/conductor.ts server-jarvis/src/orchestration/conductor-bus.ts src-ui/src/components/jarvis/SystemHealthView.tsx server-jarvis/src/orchestration.test.ts server-jarvis/src/orchestration/conductor.test.ts
git commit -m "feat(jarvis): wire request scoped conductor supervision"
```

### Task 12: Keep training and shadow routing offline until quality gates exist

**Status:** Offline promotion gate, replay adapter, and bounded redacted shadow router implemented and tested; no live candidate promotion is enabled.

**Files:**

- Modify: `server-jarvis/src/training/corpus.ts`
- Create: `server-jarvis/src/training/promotion-gate.ts`
- Create: `server-jarvis/src/training/shadow-router.ts`
- Modify: `server-jarvis/src/eval/semantic-harness.ts`
- Test: `server-jarvis/src/training/promotion-gate.test.ts`
- Test: `server-jarvis/src/training/shadow-router.test.ts`

**Interfaces:**

- Consumes: redacted trajectory corpus and replay results.
- Produces: `PromotionGateDecision` and non-user-visible shadow comparison records.

- [x] **Step 1: Write failing tests**

```ts
test("promotion gate rejects a corpus with missing provenance or failing replay", () => {
  expect(evaluatePromotionGate(badCorpus)).toMatchObject({ decision: "reject", reason: "missing_provenance" });
});

test("shadow router never changes the primary model response", async () => {
  const result = await runShadowRoute(primary, candidate, request);
  expect(result.user_visible).toBe(primary.answer);
});
```

- [x] **Step 2: Run red**

Run: `bun test src/training/promotion-gate.test.ts src/training/shadow-router.test.ts`

Expected: FAIL because no gate/shadow isolation exists.

- [x] **Step 3: Implement offline-only controls**

```ts
export type PromotionGateDecision = {
  decision: "approve" | "reject";
  provenance_ok: boolean;
  replay_pass_rate: number;
  regression_count: number;
  reason: string;
};
```

Do not route live user traffic to a trained or candidate model in this task. Shadow requests must have a bounded budget, redacted inputs, no tool execution, and stored comparison metadata only.

- [x] **Step 4: Verify offline gates**

Run: `bun test src/training/promotion-gate.test.ts src/training/shadow-router.test.ts src/eval/semantic-harness.test.ts`

Expected: PASS; candidates cannot become primary without an approved gate decision.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/training/corpus.ts server-jarvis/src/training/promotion-gate.ts server-jarvis/src/training/shadow-router.ts server-jarvis/src/eval/semantic-harness.ts server-jarvis/src/training/promotion-gate.test.ts server-jarvis/src/training/shadow-router.test.ts
git commit -m "feat(jarvis): add offline promotion and shadow routing gates"
```

## Phase 5 — integrations and remote communication

### Task 13: Define and implement one authenticated bridge protocol end to end

**Status:** Bun transport ownership, signed v1 envelope validation, replay window, explicit cancellation envelopes, protocol docs, and protocol tests implemented; paired-device and non-loopback integration verification remains.

**Files:**

- Modify: `server-jarvis/src/bridge.ts`
- Modify: `src-tauri/src/jarvis/bridge.rs`
- Modify: `src-tauri/src/commands/system.rs`
- Create: `docs/adr/000x-jarvis-bridge-ownership.md`
- Create: `docs/protocols/jarvis-device-bridge-v1.md`
- Test: `server-jarvis/src/bridge.test.ts`
- Test: `src-tauri/src/jarvis/bridge.rs`

**Interfaces:**

- Consumes: paired device identity and a signed request envelope.
- Produces: `BridgeEnvelope { protocol_version, request_id, device_id, issued_at, payload, signature }` and streaming response events.

- [x] **Step 1: Write failing protocol tests**

```ts
test("bridge rejects an unsigned or replayed envelope before invoking chat", async () => {
  expect(await bridge.handle(unsignedEnvelope)).toMatchObject({ code: "bridge_auth_failed" });
  expect(await bridge.handle(replayedEnvelope)).toMatchObject({ code: "bridge_replay_detected" });
});
```

- [x] **Step 2: Run red**

Run: `bun test src/bridge.test.ts`

Run: `cargo test bridge`

Expected: FAIL because the current bridge is loopback-only and the Rust bridge queues text without a response stream.

- [x] **Step 3: Select exactly one transport owner in the ADR**

The ADR must choose Bun HTTP/SSE or Rust transport ownership, define the Tauri boundary, and remove the divergent behavior from the non-owner. Bind only loopback until pairing, secrets, encryption, replay prevention, and audit storage are implemented.

```ts
type BridgeEnvelope = {
  protocol_version: 1;
  request_id: string;
  device_id: string;
  issued_at: string;
  payload: { type: "chat"; session_id: string; message: string };
  signature: string;
};
```

- [ ] **Step 4: Verify device pairing and cancellation**

Run: `bun test src/bridge.test.ts`

Run: `cargo test bridge`

Run: local paired-device chat, cancellation, restart, and replay smoke.

Expected: each action has one request ID, one terminal stream outcome, and an audit record.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/bridge.ts src-tauri/src/jarvis/bridge.rs src-tauri/src/commands/system.rs docs/adr/000x-jarvis-bridge-ownership.md docs/protocols/jarvis-device-bridge-v1.md server-jarvis/src/bridge.test.ts
git commit -m "feat(jarvis): define authenticated bridge protocol"
```

### Task 14: Build one real integration vertical before expanding surfaces

**Status:** Discord adapter, transient retry policy, SQLite receipt persistence, loopback send/receipt endpoints, and UI receipt status are implemented; opt-in live delivery remains credential-gated.

**Files:**

- Modify: `src-ui/src/components/jarvis/ChannelsView.tsx`
- Modify: `src-ui/src/components/jarvis/DevicesView.tsx`
- Modify: `src-ui/src/components/jarvis/NodesView.tsx`
- Modify: `src-ui/src/components/jarvis/GatewayView.tsx`
- Create: `server-jarvis/src/channels/discord.ts`
- Test: `server-jarvis/src/channels/discord.test.ts`

**Interfaces:**

- Consumes: authenticated adapter credentials stored outside UI state.
- Produces: `DeliveryReceipt { message_id, channel, direction, status, retry_count, error_code? }`.

- [x] **Step 1: Implement the Discord vertical and write a failing adapter test**

Discord is the sole first external channel. The adapter must use an operator-provisioned Discord bot token from the native secret boundary; it must never accept or persist that token in React state. Do not create metadata-only adapters for additional channels in this task.

```ts
test("outbound delivery persists a receipt and retries only transient failures", async () => {
  const receipt = await adapter.send({ text: "health check", correlation_id: "c1" });
  expect(receipt).toMatchObject({ status: "delivered", retry_count: 1 });
});
```

- [x] **Step 2: Run red**

Run: `bun test src/channels/discord.test.ts`

Expected: FAIL because ChannelsView currently changes only local `connected` metadata.

- [x] **Step 3: Implement adapter, secret boundary, receipt storage, and UI status**

```ts
export type DeliveryReceipt = {
  message_id: string;
  channel: string;
  direction: "inbound" | "outbound";
  status: "queued" | "delivered" | "failed";
  retry_count: number;
  error_code?: string;
};
```

The UI must display receipt state from the adapter store. Devices and Nodes remain disabled or clearly marked unavailable until they implement pairing/heartbeat/command contracts from Task 13.

- [ ] **Step 4: Verify live delivery without exposing secrets**

Run: `bun test src/channels/discord.test.ts`

Run: one opt-in inbound and outbound Discord smoke using an operator-provisioned test bot and test channel.

Expected: paired user sees one delivered message and Jarvis shows the matching receipt.

- [ ] **Step 5: Commit**

```bash
git add src-ui/src/components/jarvis/ChannelsView.tsx src-ui/src/components/jarvis/DevicesView.tsx src-ui/src/components/jarvis/NodesView.tsx src-ui/src/components/jarvis/GatewayView.tsx server-jarvis/src/channels
git commit -m "feat(jarvis): add verified channel delivery vertical"
```

## Phase 6 — UI completion, observability, and release gates

### Task 15: Remove unwired UI and expose effective runtime observability

**Status:** System Health now displays live server version, SHA, effective model, model-resolution state, and build timestamp; legacy non-shipped IDs fall back to the real Overview surface instead of exposing placeholders. Lazy-loading remains a performance follow-up.

**Files:**

- Modify: `src-ui/src/App.tsx`
- Modify: `src-ui/src/components/jarvis/SystemHealthView.tsx`
- Modify: `src-ui/src/components/jarvis/ControlCenterView.tsx`
- Create: `src-ui/src/components/jarvis/RuntimeProvenanceView.tsx`
- Test: `src-ui/src/components/jarvis/SystemHealthView.test.tsx`
- Test: `src-ui/src/App.test.tsx`

**Interfaces:**

- Consumes: `/health`, `/health/inference`, effective config, and deployment manifest.
- Produces: a visible release card with shell version, server SHA, model, fallback reason, conductor metrics, and terminal stage status.

- [x] **Step 1: Write failing UI tests**

```tsx
it("does not render an exposed route through UnwiredView", () => {
  render(<App initialView="logs" />);
  expect(screen.queryByText(/not wired yet/i)).not.toBeInTheDocument();
});

it("renders server SHA and current effective model from health", async () => {
  render(<RuntimeProvenanceView />);
  expect(await screen.findByText("0ca584bb6")).toBeInTheDocument();
});
```

- [x] **Step 2: Run red**

Run: `bun test src/components/jarvis/SystemHealthView.test.tsx src/App.test.tsx`

Expected: FAIL because exposed views route to `UnwiredView` and effective runtime provenance is not rendered.

- [x] **Step 3: Implement concrete routing or hide the surface**

Every sidebar item must render a real view backed by a contract. Hide routes with no implementation; do not leave selectable placeholders. Render frontend/backend version roles explicitly rather than presenting them as one ambiguous version.

- [x] **Step 4: Verify UI and bundle health**

Run: `bun test src/components/jarvis/SystemHealthView.test.tsx src/App.test.tsx`

Run: `bun run build` in `src-ui`.

Expected: PASS; new route chunks are lazy-loaded and the build output no longer has one avoidable monolithic view bundle.

- [ ] **Step 5: Commit**

```bash
git add src-ui/src/App.tsx src-ui/src/components/jarvis/SystemHealthView.tsx src-ui/src/components/jarvis/ControlCenterView.tsx src-ui/src/components/jarvis/RuntimeProvenanceView.tsx src-ui/src/components/jarvis/SystemHealthView.test.tsx src-ui/src/App.test.tsx
git commit -m "feat(jarvis): expose runtime provenance and remove unwired views"
```

### Task 16: Make the packaged release the final gate for every phase

**Status:** Packaged provenance, listener identity, session-authority, conductor-health, and terminal SSE fixtures are implemented and verified; external-provider success and feature-specific live smokes remain credential-gated.

**Files:**

- Modify: `scripts/build-and-deploy.ps1`
- Modify: `scripts/verify-deploy.ps1`
- Modify: `docs/COMPLETION_BACKLOG.md`
- Modify: `docs/reports/2026-07-10-jarvis-remaining-feature-gaps.md`
- Test: `scripts/smoke-jarvis-runtime.ps1`

**Interfaces:**

- Consumes: source SHA, built Tauri executable, Bun `index.js`, prompts tree, and smoke fixtures.
- Produces: a release report that links source SHA to Desktop binary, live listener, direct SSE, workspace read, timeout/cancel, and selected feature fixtures.

- [x] **Step 1: Write the failing verification assertion**

```powershell
if ($manifest.git_sha -ne $health.git_sha) {
  throw "deployment_provenance_mismatch"
}
if ($smoke.terminal_type -notin @('result', 'error', 'cancelled')) {
  throw "missing_terminal_outcome"
}
```

- [x] **Step 2: Run red against a deliberately stale runtime fixture**

Run: `powershell -ExecutionPolicy Bypass -File scripts/verify-deploy.ps1 -ExpectSha deadbeef`

Expected: FAIL with `deployment_provenance_mismatch`.

- [x] **Step 3: Add release fixtures and evidence output**

The script must run: health/provenance, basic SSE, workspace Git metadata read, reviewer path, timeout/cancel fixture, cron fixture when changed, and the feature-specific task smoke. It must record process command line and artifact hashes before declaring success.

- [x] **Step 4: Run full release verification**

Run: `powershell -ExecutionPolicy Bypass -File scripts/build-and-deploy.ps1 -RestartServer`

Run: `powershell -ExecutionPolicy Bypass -File scripts/verify-deploy.ps1 -ExpectSha (git rev-parse HEAD)`

Expected: all source/build/deployed/runtime SHA checks agree and each fixture has one terminal outcome.

- [ ] **Step 5: Commit the release gate**

```bash
git add scripts/build-and-deploy.ps1 scripts/verify-deploy.ps1 scripts/smoke-jarvis-runtime.ps1 docs/COMPLETION_BACKLOG.md docs/reports/2026-07-10-jarvis-remaining-feature-gaps.md
git commit -m "test(jarvis): gate release on packaged runtime evidence"
```

## Explicit deferrals and order constraints

- Do not expose remote Android communication, public gateway access, or additional channels before Tasks 2, 3, 8, and 13 pass in the packaged app.
- Do not enable trained-model promotion or user-visible shadow routing before Task 12 has an approved replay/provenance gate.
- Do not add autonomous action dispatch before Task 9 has durable claim, policy, and acceptance evidence.
- Do not claim a capability is complete because its view renders, its SQLite row exists, or a unit test passes. Completion requires the phase’s release fixture.
- PrizePicks belongs to the separate `prizepicks-monster` application and is excluded from this plan.

## Final acceptance matrix

| Capability | Required proof before marking complete |
|---|---|
| Basic chat | Direct SSE and visible UI turn each yield exactly one terminal result. |
| Workspace read | Filesystem evidence and read-only Git metadata return from the active session workspace. |
| Full execution | Executor, reviewer, rewriter-on-reject, and synthesizer each terminate or emit a typed partial/failure. |
| Tool safety | Interactive approve/deny/expiry and non-interactive deny paths are persisted and replayable. |
| Sessions/config/agents | A restart preserves one authoritative state and reports the effective model/agent projection. |
| Memory/skills | Cold retrieval, judge-gated promotion, measurement, and rollback all pass. |
| Cron/actions | Scheduled and approved work writes acceptance evidence and supports cancellation/retry. |
| Bridge/remote | Pairing, signature, replay prevention, stream cancellation, restart, and audit evidence pass. |
| Release | Source SHA, bundle SHA, manifest, listener command, and smoke outcomes agree on the Desktop artifact. |

## Plan self-review

- **Coverage:** Phase 1 closes terminal stream reliability, workspace Git metadata, and coordinator fallback. Phase 2 closes authority splits, profile activation, agents, and native stubs. Phase 3 closes approval/task/bridge lifecycle plus cron/actions. Phase 4 closes memory, skills, conductor, evaluation, training, and shadow-routing gates. Phase 5 closes authenticated remote transport and one real integration vertical. Phase 6 closes unwired UI, provenance, and package-level release proof.
- **Safety:** The plan uses a narrow Git metadata tool rather than blanket shell access; makes remote work depend on authentication and audit; and keeps training/shadow work offline until quality gates exist.
- **Execution dependency:** Luna must complete a task’s focused tests and live proof before beginning the next task. If a task changes a file that contains unrelated staged work, Luna must inspect and preserve that work rather than overwrite it.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-10-jarvis-remaining-phases-luna-plan.md`.

Luna should execute the plan phase-by-phase, beginning with Task 1 and stopping after each task’s focused test and packaged-runtime proof. The plan is intentionally ordered so remote, autonomous, and training capabilities cannot outrun the core stream/tool safety contracts.
