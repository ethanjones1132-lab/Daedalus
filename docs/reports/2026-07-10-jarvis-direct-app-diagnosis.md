# Jarvis Direct Application Diagnosis

**Date:** 2026-07-10  
**Scope:** Live interaction with the optimized release desktop application, plus read-only runtime and workspace verification.  
**Artifact exercised:** `C:\Projects\home-base-recovered\src-tauri\target\release\home-base.exe`  
**Build provenance shown by the UI:** commit `9013158ba6bc6600a2546e309fd066d6e53a5223`, built `2026-07-10T15:19:43+00:00`.

## Executive diagnosis

Jarvis is booting correctly and the native desktop shell is responsive. Direct chat, code reasoning, and structured-output requests can produce correct answers. The application is not yet reliable as a general-purpose coding agent because the tool/workspace path fails with a generic `Failed to fetch`, and multi-stage requests can remain indefinitely in `reviewer` or `rewriter` while the UI continues to show `Streaming…`.

The current diagnosis is therefore:

- **Shell/runtime health:** healthy.
- **Direct inference path:** functional but slow (roughly 16–19 seconds for short answers in this live sample).
- **Agent orchestration:** partially functional; executor/reviewer can produce useful intermediate work, but finalization can hang.
- **Workspace/tool execution:** not proven live; the direct workspace probe failed before returning evidence.
- **Observability:** present in the UI, but session token telemetry showed `0 / 0` for completed work and frontend/backend version strings differ.

## Evidence and feedback loop

The application was found through Windows app discovery, activated, and exercised through its real Jarvis window. Each prompt was sent through the visible chat composer and verified by a fresh accessibility snapshot. The backend was then checked read-only through its live health endpoint.

The worktree remained clean. The built-in capability smoke prompt was cancelled before any write; `workspace\\jarvis-capability-smoke-test.md` does not exist.

## Prompt matrix

| Test | Prompt / action | Observed result | Wall-clock evidence | Diagnosis |
|---|---|---|---:|---|
| Basic capability | “In one concise sentence, what can you do for me?” | Correct concise answer: coding, planning, research, and workspace execution. | ~16.6s | Direct chat path works. |
| Code reasoning | Review `function add(a,b){ return a-b }` and give the smallest safe fix. | Executor correctly proposed `return a+b`; reviewer marked it **ACCEPT** with high confidence. | Executor visible ~16.4s; reviewer accepted by ~37.6s. | Reasoning and review stages work, but this run never finalized. |
| Finalization stress | Same code-review run. | `REWRITER` stayed `running…`; UI stayed `Streaming…`; no final assistant answer appeared after ~94s. | >94s | Missing/broken stage deadline or completion handoff. |
| Workspace grounding | Inspect `C:\Projects\home-base-recovered`, list three entries, and report the current SHA. | Visible `ERROR`; message `Failed to fetch`; code `unknown`; `STREAM RELAY` remained `running…`. | ~22.4s | Tool/stream relay path is failing before usable workspace evidence is returned. |
| Minimal arithmetic | A follow-up after the workspace failure returned `4`, but the typed prompt was malformed by an active prior composer/session. | The answer was correct, but the input was not a clean test case. | Not used as a quality benchmark. | Excluded from capability conclusions; highlights the need to reset/clear the composer before retries. |
| Structured output | “Respond as a JSON object with status ok and capabilities chat and code. No markdown.” | Exact valid JSON: `{"status":"ok","capabilities":["chat","code"]}`. | ~19.0s | Direct generation and format following work. |
| Built-in capability smoke | Clicked the prebuilt smoke-test action. | The UI queued a prompt asking Jarvis to read `CONTEXT.md` and `README.md`, then overwrite `workspace/jarvis-capability-smoke-test.md`. It was cancelled before execution. | Cancelled | The UI advertises read/write tool capability, but this test does not prove that the tool path currently succeeds. |

## What the live UI exposes

### Chat surface

- `LIVE` status is visible.
- Provider label is `OPENROUTER`; model label is `OPENROUTER/FREE`.
- Quick actions include **Refactor a function**, **Debug a stack trace**, and **Explain a piece of code**.
- Chat shows stage labels such as `EXECUTOR`, `REVIEWER`, `REWRITER`, and `STREAM RELAY`.
- The UI exposes `Stop streaming`, but cancellation behavior was inconsistent across stuck stages.
- New chat works when the correct control is targeted; stale/active composer state must be cleared before retrying a failed prompt.

### Navigation and control surface

The shell exposes navigation for Chat, Overview, Sessions, Cron, Actions, Channels, Skills, Agents, Control, Models, Memory, Approvals, Commitments, Hooks, Devices, Nodes, Plugins, Gateway, Hermes Bridge, Config, and Health.

The Sessions view rendered successfully and reported **105 sessions**, with refresh, new-session, and delete-session controls. A selected session showed message counts and timestamps, but completed work displayed token usage as `0 / 0`.

### Provenance and versioning

The frontend provenance badge reports:

- version `0.1.0`
- commit `9013158ba`
- build timestamp `2026-07-10T15:19:43+00:00`

The backend health endpoint reports version `3.0.0`. This may be an intentional frontend/backend version split, but it is ambiguous and should be made explicit or unified.

## Runtime health evidence

Read-only probe of `http://127.0.0.1:19877/health` after the UI tests:

```json
{
  "ok": true,
  "uptime": 210.6073799,
  "version": "3.0.0",
  "backend": "openrouter",
  "model": "cohere/north-mini-code:free",
  "model_resolved": true,
  "git_sha": "9013158ba6bc6600a2546e309fd066d6e53a5223",
  "built_at": "2026-07-10T11:19:34.6594451-04:00"
}
```

The listener was active on port `19877` and owned by `C:\Users\ethan\.bun\bin\bun.exe`. This separates the UI/tool failures from a total Bun-process or listener outage: the runtime remained healthy while the failing prompts were being exercised.

## Ranked hypotheses for the failures

These are falsifiable follow-up hypotheses, ranked by the live evidence:

1. **Stream relay/tool bridge failure.** If the relay or fetch boundary is the cause, a direct `/chat/stream` request using the same session/payload should reproduce `Failed to fetch` while `/health` remains `ok`; adding boundary error capture should identify the missing response or rejected connection.
2. **Missing stage deadline or abort propagation.** If orchestration lacks a shared deadline, a request that has already produced executor/reviewer output will remain in `reviewer`/`rewriter` until manual cancellation. A bounded stage timeout should convert the hang into a terminal error and release the composer.
3. **Finalization handoff contract failure.** If the rewriter is receiving an incomplete or invalid reviewer payload, executor/reviewer output will be correct but the rewriter will never emit a final assistant message. Logging the stage input/output contract at one boundary should distinguish this from model latency.
4. **Model/provider tail latency.** If the free OpenRouter model is the dominant factor, bypassing the multi-stage route with a direct short prompt should remain successful but slow, as observed (~16–19s), while the multi-stage tail should correlate with provider latency rather than local CPU or Bun health.
5. **Composer/session reset state.** If stale client state is involved, a failed request followed by an explicit new-chat plus composer clear should prevent prompt concatenation. The malformed arithmetic follow-up was not retained as a functional failure because the input was not cleanly isolated.

## Severity assessment

### P0 — Agent request can hang indefinitely

Correct intermediate work can be trapped behind `reviewer` or `rewriter`, leaving the user with `Streaming…` and no terminal result. This is the highest-impact defect because it consumes time and prevents reliable completion even when the model work is already good.

### P0 — Workspace/tool path returns a generic fetch error

The application could not complete a read-only workspace inspection prompt and provided no actionable error detail. This blocks the core “coding assistant in my workspace” capability and prevents grounding claims from being trusted.

### P1 — Cancellation and recovery are inconsistent

Escape recovered one stuck run, while another stuck reviewer remained visible until a new chat was created. Stop/abort state should be centralized and deterministic.

### P1 — Observability does not fully agree with behavior

Sessions are recorded and stage labels are shown, but token telemetry displayed `0 / 0` for completed work. This makes cost/usage analysis unreliable.

### P2 — Version identity is ambiguous

The frontend shows `0.1.0`; `/health` shows `3.0.0`. Operators need one clear release identity or an explicit shell/server version pair.

### P2 — Mutation smoke action needs a confirmation boundary

The built-in capability smoke prompt asks Jarvis to overwrite a workspace file. It should be clearly labeled as a write test and require explicit confirmation before dispatch.

## Image-derived diagnosis: Versutus remote-communication request

The supplied screenshot adds a second, concrete failure trace from the live Jarvis UI. It is a separate session and workspace target from the home-base probes above, so it should not be conflated with the home-base grounding test.

### What the screenshot proves

- Session badge: `40DECF7A`.
- The user prompt explicitly targets `C:\Projects\Versutus` and asks what remains for the application to communicate remotely through an Android phone.
- The shell is visually alive: Chat is selected, the header says `SYNCED 0S AGO`, the footer says `LIVE`, and the composer remains interactive.
- The request created one agent stage. The executor began with: “I’ll start by exploring the project structure…”
- The synthesizer then failed before producing a user-facing answer.
- The visible error is: “The answering model stalled before responding, so I aborted it. Try again — the router will pick a different model.”
- The error gives a concrete timeout: `first-token timeout (30000ms)`.
- The failing route is identified as `model=deepseek-v4-pro`, `stage=synthesizer`.
- Both the top-level error card and the synthesizer stage show `code: unknown`; no actionable provider error, request ID, or retry correlation is exposed.

### Capability implications

The screenshot does **not** prove that Android/remote communication is implemented or missing. The request failed during synthesis after the executor started, before Jarvis returned a grounded architecture assessment. No remote gateway, mobile bridge, authentication path, websocket, or device capability was actually inspected in the visible result.

It does prove that a workspace-scoped architecture question can be routed into an agent pipeline, but the pipeline can fail before the user receives the result. The “router will pick a different model” message also indicates per-request model fallback behavior: the UI advertises `OPENROUTER/FREE`, while this request selected `deepseek-v4-pro`. That is distinct from the later `/health` sample, which reported `cohere/north-mini-code:free` as the resolved backend model.

### Reliability implications

This is a cleaner example of the same general reliability class observed in the direct tests:

1. The local shell and transport remain healthy enough to render the request, stage state, and error.
2. The selected model fails to emit its first token within the configured 30-second budget.
3. The synthesizer aborts, but the UI retains a `SYNTHESIZER running…` stage and leaves the user with a retry-oriented error rather than a grounded partial answer.
4. `code: unknown` prevents distinguishing provider timeout, router rejection, model capacity failure, or stream transport failure.

The screenshot also clarifies the timeout inconsistency in the broader diagnosis: this request shows an explicit 30-second first-token limit, while the earlier code-review test remained in `rewriter` for more than 94 seconds. Timeout enforcement is therefore either stage-specific, missing from some stages, or not propagated through the full orchestration graph.

### Additional remediation from the image

- Persist the selected model, stage, timeout value, session ID, run ID, and provider response code in the error event.
- Make model fallback observable: show which model was tried, why it was rejected, and which model will be attempted next.
- On synthesizer timeout, terminate the stage in the UI (`timed out`/`aborted`) instead of leaving `running…` visible.
- Return a useful partial result when executor evidence exists, clearly marked as incomplete, rather than silently losing the architecture exploration.
- Add a Versutus-specific regression fixture for a remote-communication request and assert that a 30-second first-token timeout produces a terminal, retryable state.
- Keep workspace identity explicit in every stage so the Versutus request cannot be confused with home-base or another project session.

## Recommended remediation order

1. Add a deterministic request-level deadline covering executor, reviewer, rewriter, and stream relay; propagate aborts to every child stage.
2. Replace generic `Failed to fetch` with structured errors at the UI → Tauri → Bun → stream-relay → provider/tool boundaries, including correlation/session/run IDs.
3. Capture and validate the reviewer-to-rewriter handoff contract; add an end-to-end regression test that proves a completed final answer is emitted.
4. Add a clean “new chat/reset composer” path that clears stale text and disables duplicate sends during an in-flight request.
5. Repair token accounting and expose terminal stage status in Sessions and Health.
6. Unify or explicitly label frontend/backend version provenance.
7. Gate built-in write-capability smoke actions behind an explicit confirmation and retain a read-only capability probe for routine health checks.

## Conclusion

The release is genuinely bootable and the direct model path is capable of correct answers. It is not yet reliable enough to call the full Jarvis agent path production-complete: workspace/tool execution fails generically, and multi-stage finalization can hang after correct work has already been produced. The next engineering pass should focus on stream/tool error propagation and stage cancellation before adding more orchestration features.
