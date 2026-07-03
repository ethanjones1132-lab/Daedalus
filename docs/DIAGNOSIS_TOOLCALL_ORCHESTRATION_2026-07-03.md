# Deep Diagnosis: Toolcall Spillage & Orchestration Failure in Jarvis

**Date:** 2026-07-03  
**Scope:** `server-jarvis/` (Bun orchestration + streaming), `src-ui/` (React chat surface), Daimon runtime bridge  
**Method:** Code-path tracing, session forensics, regression analysis, live-issue document cross-reference  
**Status:** Research & diagnosis complete — implementation explicitly out of scope for this document

---

## 1. Executive Summary

Tool calls are spilling into chat bubbles and orchestration logic is failing due to **a stack of interacting defects across four layers**: (1) stale deployed runtime that lacks the sanitizer fix, (2) a fundamentally broken visible-answer sanitizer that destroys formatting and over-strips, (3) a UI state machine that suppresses the server's final answer in favor of garbled streamed text, and (4) abort-domain misclassification that turns slow model stalls into silent blank bubbles. These layers are **not independent** — fixing any one in isolation leaves the others producing the same user-visible symptom.

The most critical finding is **P0-A (stale Desktop runtime)**: the production `Desktop\index.js` does not contain the `VisibleAnswerStreamSanitizer` wiring (commit `fb63137` is in the repo but not deployed). Every subsequent fix — no matter how correct — is invisible until the deploy triplet (`Jarvis.exe`, `index.js`, `prompts/`) is atomically rebuilt and verified.

---

## 2. Evidence Base: What the Latest Sessions Show

### 2.1 Latest Session — Current Daimon Conversation (conv-2312393e994e2a7a6924c51e)

This is the Daimon/Kimi Code agent session (the conversation you and I are in). It is **not** a Jarvis chat session, but it is stored in the same Daimon session layer. The wire format shows:

- `type: "tools.set_active_tools"` followed by `type: "permission.set_mode"` (`yolo`)  
- `type: "turn.prompt"` with the user's request about diagnosing toolcall spillage  
- `type: "context.append_loop_event"` with `content.part.think` reasoning blocks  
- `type: "tool.call"` events (e.g., `TodoList`, `Bash`, `Read`, `PythonRun`)  
- `type: "tool.result"` events with raw outputs  
- `type: "usage.record"` after each step  
- No toolcall spillage is visible **because this is a Daimon agent loop, not the Jarvis orchestrator** — the Daimon runtime handles tools natively and does not stream raw `<tool_call>` tags to the chat surface

**Why this matters:** The user is asking about the Jarvis application, but the "latest two chat sessions" stored in the Daimon runtime are actually Daimon agent turns (my own reasoning and tool calls). The Jarvis chat sessions are stored separately — either in the Jarvis SQLite database (`jarvis.db`) or in the Tauri-side SQLite store. However, the **codebase and live-issue docs** provide sufficient forensic evidence to diagnose the Jarvis path without the raw Jarvis chat logs.

### 2.2 Second-Latest Session — Title Generation (ctitle-019f2637...)

This is a `daimon` profile conversation whose sole purpose is title generation. It shows a clean, single-turn completion with no tools. It is diagnostically uninteresting for toolcall spillage.

### 2.3 Jarvis Session Traces (turn-traces.v1.json)

The trace file shows the most recent Jarvis turns:
- `conversation:e23ab39f-4d36-4c4e-87b3-59b5402767b9` — 8 turns between 2026-06-30 and 2026-07-01  
- `conversation:74d44d2f-5e70-428c-8406-6d3a96dedc50` — 1 turn on 2026-07-03 (the current request)

These traces confirm Jarvis turns are active but do not contain the message payloads. The payload analysis must be done from the code and the documented live incidents.

---

## 3. Layer-by-Layer Root Cause Analysis

### 3.1 Layer 0: Deployed Runtime Stale (P0-A) — The Invisible Fix

**Finding:** The production `Desktop\index.js` (OneDrive Desktop) does **not** contain `VisibleAnswerStreamSanitizer`. The repo at `fb63137` added it to `server-jarvis/src/index.ts` (~1468) and `text-tools.ts` (~269). The deployed bundle still uses the old `TextToolCallStreamSanitizer` on the synthesizer path.

**Impact:** The sanitizer that was supposed to stop free-tier models from echoing tool JSON into chat bubbles is **not running**. Any fix to `text-tools.ts` or `index.ts` is invisible until the deploy triplet is rebuilt and copied.

**Verification:** `grep VisibleAnswerStreamSanitizer ~/Desktop/index.js` → expected negative on stale bundle; `grep` on repo `server-jarvis/dist/index.js` after `bun build` → positive.

**Fix pattern (professional):** Atomic deploy manifest with SHA256 verification. Do not treat "build succeeded" as "deployed."

---

### 3.2 Layer 1: VisibleAnswerStreamSanitizer Is Broken (text-tools.ts)

**Finding:** Even in the repo, the `VisibleAnswerStreamSanitizer` class has fatal defects that destroy user-visible formatting and over-strip legitimate content. This was empirically confirmed by the `bun -e` probe documented in the Layer A plan (`docs/superpowers/plans/2026-07-02-synthesizer-sanitizer-chat-regression-fable-handoff.md`).

**Specific defects:**

| Defect | Code Location | Symptom |
|--------|---------------|---------|
| Blank-line eater | `emitCompleteLines` (~283): `if (!trimmed) continue;` | Paragraph breaks (`\n\n`) are collapsed to single newlines; markdown formatting breaks |
| Newline loss at chunk boundaries | `drainLines` (~287): `lineAlreadyEmitted` logic | `["Hello","\nWorld"]` → `"HelloWorld"` (lines glue together) |
| Mixed prose+JSON line mishandling | `decideLine` (~331): `isCosmeticToolEchoLine` | `Here: {"name":"read_file","arguments":{"path":"."}}` is either dropped or stripped, losing the prose prefix |
| Fence-blind stripping | `isCosmeticToolEchoLine` (~419): no fence awareness | Legitimate code examples inside `\`\`\`json` fences are destroyed |
| Over-aggressive `TOOL_ALIASES` | `TOOL_ALIASES` (~23): `read`, `write`, `search`, `find`, `ps`, `agent`, `task` | Generic `{"name":"search","query":"x"}` in prose is stripped as "hallucinated tool payload" |
| `{`-prefix hold-until-flush | `drainLines` (~318): `pendingLine` held if `trimStart().startsWith("{")` | A single-line answer starting with `{` is invisible until the entire turn finishes |

**Why this causes toolcall spillage:** The sanitizer is so broken that it either (a) strips too much, leaving an empty bubble, or (b) the model's raw text (including tool-call JSON) bypasses the broken sanitizer because the chunk boundaries fall in a way that the JSON is not on its own line. The `extractTextToolCalls` post-turn path and the streaming sanitizer use **different** logic, so the bubble text and the server-side `cleanContent` diverge.

**Fix pattern (professional):** Rewrite the sanitizer with two invariants:
1. **Chunking invariance**: concatenated output is identical for any chunk split of the same input.
2. **Identity on clean text**: if no line is dropped, output === input byte-for-byte.

Only drop a line if it is **entirely** hallucinated tool JSON (every JSON object on the line is a cosmetic tool echo, and removing them leaves only whitespace). Keep mixed lines whole. Be fence-aware. Use a shared `isCosmeticToolEchoPayload` predicate for both streaming and post-turn extraction.

---

### 3.3 Layer 2: UI State Machine Suppresses the Final Answer (JarvisView.tsx)

**Finding:** The React UI (`src-ui/src/components/jarvis/JarvisView.tsx`) has a critical logic flaw that makes the streamed text the **sole source of truth**, even when it is garbled or empty.

**Specific defects:**

| Defect | Code Location | Symptom |
|--------|---------------|---------|
| `streamedVisibleText` suppresses `result` | ~753–757, ~828 | Any `stream_event` delta (even whitespace-only) sets `streamedVisibleText = true`; the final `result` frame is ignored |
| Whitespace-only deltas count as "visible" | ~753 | A delta containing only `\n` or ` ` permanently suppresses the fallback notice |
| No `cancelled` handler | ~751–838 | `cancelled` SSE frames are silently dropped; empty bubble remains |
| No `default` case for unknown frames | ~751–838 | New frame types (e.g., `fallback_notice`, `heartbeat`) are silently swallowed; drift is invisible |
| `finalizeAssistantMessage` persists streamed text | ~404–425 | The garbled streamed text is saved to the Tauri SQLite DB via `append_message`; the server's `cleanContent` is never persisted |
| `JSON.parse` on SSE is unguarded | ~852 | A malformed `data:` line crashes the read loop; `isStreaming` stays true forever |

**Why this causes toolcall spillage:** If the sanitizer fails to strip a bare tool JSON line, that line is emitted as a `stream_event` delta, the UI appends it to the bubble, and `streamedVisibleText` becomes true. Even if the server's final `result` frame contains the correctly sanitized answer, the UI ignores it. The user sees the raw tool JSON in the bubble. Worse, if the sanitizer over-strips and the bubble is empty, `streamedVisibleText` may still be true (from a whitespace delta), so the "produced no output" fallback is suppressed — the user sees a truly blank bubble.

**Fix pattern (professional):**
1. Set `streamedVisibleText = true` only when the delta contains **non-whitespace** (`/\S/.test(text)`).
2. Handle `cancelled`: finalize with "(stopped)" or remove the empty stub.
3. Add a `default` case to the frame handler: log unknown types once per session.
4. Wrap `JSON.parse` in try/catch: on failure, abort the stream cleanly and surface an error.
5. Optionally: align the persisted message with the server's `result` text rather than the streamed accumulation. (This is a larger UX change; the short-term fix is to make the stream identical to the result.)

---

### 3.4 Layer 3: Orchestration Abort Misclassification (P0-B)

**Finding:** The first-token watchdog in both the orchestrator read loop (`index.ts` ~1456–1465) and the Agent Loop (`index.ts` ~2346–2357) calls `streamAbort.abort()` — the **same** abort controller used for user Stop. This conflates a **hung model** with a **user cancellation**.

**Flow:**
1. Model `deepseek-v4-flash-free` stalls for ~46s.
2. First-token watchdog fires.
3. `streamAbort.abort("First-token timeout")` is called.
4. `emitCancelled()` runs → `type: "cancelled"` SSE frame.
5. UI has no `cancelled` handler → frame dropped.
6. `finalizeAssistantMessage` leaves an empty bubble.
7. No `append_message` because `content.trim()` is empty.

**Impact:** The user sees a blank bubble with no error message. The metrics log says "stream cancelled" rather than "first-token timeout." The fallback cascade is poisoned because the turn-wide abort kills the session before `chatCompletionWithFallback` can advance to the next model.

**Fix pattern (professional):** Separate abort domains:
- `streamAbort` — user Stop, session supersede, app shutdown only.
- `attemptAbort` / per-read-loop abort — first-token stall, inter-token stall. On timeout: call `reader.cancel()`, throw `FirstTokenTimeoutError`. The outer catch block emits `type: "error"` with `code: "first_token_timeout"`, not `cancelled`. Reserve `cancelled` for **explicit** user/client cancel only.

---

### 3.5 Layer 4: SSE Protocol Contract Gaps (P0-I)

**Finding:** The server emits ~15 frame types; the UI handles ~8. There is no shared contract document, no runtime assertion of "exactly one terminal frame per turn," and no version negotiation.

**Unhandled server frames:** `cancelled`, `fallback_notice`, `message_stop`, `init`, `agent_run_id`, `heartbeat`.

**Impact:**
- `heartbeat` (intended to keep connections alive during silent pipeline stages) is dropped by the UI. If the UI later adds a client-side inactivity timeout, heartbeats would reset it — but today they are silently ignored, making the timeout feature impossible to add safely.
- `fallback_notice` (tells the user that a fallback model was used) is invisible.
- `message_stop` and `init` are redundant for the direct chat path but are consumed by the Claude CLI path; contract drift is invisible.

**Fix pattern (professional):** Document the SSE contract in `docs/sse-stream-contract.md` (already started) and add a runtime assertion in `StreamSession` that every turn emits exactly one of `result`, `error`, or `cancelled`. The UI `switch` statement must have a `default` that logs unknown types once per session.

---

### 3.6 Layer 5: Orchestration Logic Failures (Beyond Streaming)

#### 3.6.1 Read-Only Turns Over-Orchestrated (P1-C)

**Finding:** A simple read request (e.g., "read `C:\…\file`") is classified as `workspace_read` with `read_only` tool profile, but it still runs through the **full executor loop** with `max_turns: 10` (`modes.ts` ~47). The executor may loop multiple times, and if the model emits tool-shaped JSON in its reasoning, the provider returns HTTP 400, triggering fallback advances.

**Fix pattern:** Add a trivial-read fast path: if the turn requirement is `workspace_read` and the message contains an explicit file path, skip the planner and run a single executor pass with `read_only` tools. Log the pipeline choice so the operator can audit.

#### 3.6.2 Negation-Blind Mutation Detection (P1-D)

**Finding:** `turn-requirements.ts` ~112–124 matches `MUTATION_VERB` keywords (`modify`, `write`, `edit`) without checking for negation (`do not`, `don't`, `never`). "Do not modify any files" triggers `full_execution` profile.

**Fix pattern:** Add a negation pass: strip or invert signals when negation words precede mutation verbs within a window.

#### 3.6.3 Conductor Replan Incomplete (B-02 / B-03)

**Finding:** The `conductor_replan` routing decision is parsed and validated (`conductor-routing.ts`, `route-normalization.ts`), but the migration from the old `recursion_critique` hardcoded topology to conductor-native replan is **not complete** (`post-phase-4-conductor-evolution.md`: B-03 status is unchecked). The conductor can decide to replan, but the depth cap, telemetry, and safety bounds (B-04) are not fully wired.

**Impact:** Replan loops may run indefinitely or fail silently. The `max_recursion_depth` config exists but is not enforced across all re-enter types.

**Fix pattern:** Implement B-04 (configurable caps, telemetry, graceful degradation) before enabling B-03 in production. Add a kill switch config flag.

#### 3.6.4 Empty Completion Cascade Poisoning

**Finding:** When the synthesizer returns empty (or sanitizes to empty), the bounded empty-completion cascade (`index.ts` ~1826–1841) advances up to 2 more models. Each streams into the **same** bubble. If all models echo tool JSON and the sanitizer over-strips, the final `trimmedAnswer` is empty, triggering the "produced no output" fallback.

**Fix pattern:** After the first empty completion, inject a system prompt that explicitly forbids tool calls and demands a visible answer. If the second attempt is also empty, surface the executor summary (if available) rather than a generic "try again" notice.

---

### 3.7 Layer 6: Tool-Call Parsing Edge Cases (Both Paths)

**Finding:** The native tool-call streaming path (`index.ts` ~2546–2558) and the text-tool fallback path (`index.ts` ~2596–2598) have different normalization logic.

**Native path defects:**
- `activeToolCalls` slots are assembled from `choice.delta.tool_calls`. If the model streams `arguments` chunks but never sends `function.name`, the slot has an undefined name. The old code coerced it to `call_<random>` and leaked it into the tool runtime. The `normalizeStreamedToolCalls` fix (2026-06-26) now drops name-less slots and logs a warning, but the **orchestrator path** and **Agent Loop path** had divergent behavior before that fix. The stale bundle may still have the old behavior.

**Text-tool path defects:**
- `extractTextToolCalls` uses regex + JSON parsing. It can match JSON inside markdown fences, inside prose, or in malformed tags. The cosmetic strip path (`tools=[]`) is fence-blind and uses a looser `isCosmeticToolEchoPayload` predicate than the genuine tool path.

**Fix pattern:** Unify the normalization. Use `normalizeStreamedToolCalls` for both paths. For text tools, run `extractTextToolCalls` first, then validate each extracted call against the `TOOL_ALIASES` map and the available tool list. Reject unmatched names with a log warning.

---

## 4. Professional Implementation Roadmap

The following is the **execution order** recommended by the live issues priority plan, validated by the code analysis above. Each step includes the acceptance criteria and verification method.

### Phase 1: Foundation (Deploy + Contract + Abort Safety)

| Step | Task | Files | Acceptance | Verification |
|------|------|-------|------------|--------------|
| 1.1 | **Atomic deploy triplet** | `scripts/build-and-deploy.ps1` | `Desktop\index.js` contains `VisibleAnswerStreamSanitizer`; `Desktop\prompts\` exists; manifest has SHA256 | `grep` + `Test-Path` + hash compare |
| 1.2 | **SSE contract + UI handlers** | `docs/sse-stream-contract.md`, `JarvisView.tsx` | UI handles `cancelled`, `fallback_notice`, `heartbeat`; `default` case logs unknown types; `JSON.parse` wrapped | Mock SSE injection; manual Stop |
| 1.3 | **Abort-domain split** | `index.ts`, `openrouter.ts` | `streamAbort` = user only; timeout uses `reader.cancel()` + `FirstTokenTimeoutError`; emits `error` not `cancelled` | `stream-cancel.test.ts` + slow model |
| 1.4 | **Stream liveness** | `JarvisView.tsx`, `index.ts` | UI inactivity timer resets on any frame; server heartbeat every 15s (behind flag) | Network drop simulation |

### Phase 2: Sanitizer Fix (The Core Toolcall Spillage)

| Step | Task | Files | Acceptance | Verification |
|------|------|-------|------------|--------------|
| 2.1 | **Rewrite `VisibleAnswerStreamSanitizer`** | `text-tools.ts` | Chunking invariance; identity on clean text; bare JSON lines dropped; mixed lines kept; fence-aware | `text-tools.test.ts` probes #1–#10 |
| 2.2 | **Align cosmetic strip in `extractTextToolCalls`** | `text-tools.ts` | Post-turn `cleanContent` matches streamed output; fence-aware; tightened payload test | `text-tools.test.ts` probe #10 |
| 2.3 | **UI whitespace suppression fix** | `JarvisView.tsx` | `streamedVisibleText` set only on non-whitespace delta; fallback notice appears when bubble empty | Live smoke with empty synthesizer |
| 2.4 | **Tighten `TOOL_ALIASES`** | `text-tools.ts` | Generic `{"name":"search"...}` in prose is kept; legacy flat blocks keyed by `tool`/`tool_name` still stripped | `text-tools.test.ts` regression |

### Phase 3: Orchestration Hardening

| Step | Task | Files | Acceptance | Verification |
|------|------|-------|------------|--------------|
| 3.1 | **Negation-aware classifier** | `turn-requirements.ts` | "Do not modify" → `workspace_read` or `answer_only`; no `full_execution` | `turn-requirements.test.ts` |
| 3.2 | **Trivial read fast path** | `route-normalization.ts`, `pipeline.ts` | "Read `C:\…\file`" → ≤2 executor passes, `read_only` tools | Session log grep |
| 3.3 | **Conductor replan safety bounds** | `replan-loop.ts`, `persistent-conductor.ts` | `max_replans_per_turn` and `max_conductor_replans_per_session` enforced; loop terminates at cap | `replan-loop.test.ts` |
| 3.4 | **Empty completion fallback** | `index.ts` | After 2 empty attempts, surface executor summary or error, not blank bubble | Mock empty model |
| 3.5 | **Tool normalization unification** | `streaming-tool-calls.ts`, `text-tools.ts` | Same validation rules for native and text-tool paths; unmatched names rejected with log | `streaming-tool-calls.test.ts` |

### Phase 4: UI State Machine & Persistence

| Step | Task | Files | Acceptance | Verification |
|------|------|-------|------------|--------------|
| 4.1 | **Send lock + input recovery** | `JarvisView.tsx` | Double-click Send → one stream; connection refused → input restored | Manual double-click |
| 4.2 | **Session switch atomicity** | `JarvisView.tsx` | Switch session mid-stream → no ghost bubble on wrong session | Manual switch |
| 4.3 | **Tool-result matching by `call_id`** | `JarvisView.tsx` | `tool_use` and `tool_result` pair by `id`; name fallback warns | Mock SSE with tool events |
| 4.4 | **Persistence contract** | `JarvisView.tsx`, Tauri side | Document what happens on stop/error/empty; no vanished assistant rows | Reload after stop |

### Phase 5: Ops & Build Integrity

| Step | Task | Files | Acceptance | Verification |
|------|------|-------|------------|--------------|
| 5.1 | **Deploy manifest** | `scripts/build-and-deploy.ps1` | JSON manifest with `git_sha`, `index_js_sha256`, `prompts_tree_sha256` | Read manifest post-deploy |
| 5.2 | **Restart TTL fix** | `src-tauri/src/lib.rs` | `force_restart_jarvis_server` clears `LAST_HEALTHY_MS` | Restart button always spawns |
| 5.3 | **Prompt copy guard** | `scripts/build-and-deploy.ps1` | Script fails fast if `server-jarvis/src/prompts` missing | Delete prompts dir, run script |
| 5.4 | **Sandbox mode docs** | `docs/jarvis-runtime-ops.md` | Table: `strict`/`permissive`/`off` behavior documented | User test with out-of-workspace path |

---

## 5. Risk Matrix & Mitigations

| Risk | Blast Radius | Mitigation |
|------|--------------|------------|
| Fixing P0-B on stale bundle only | User sees no improvement | **P0-A first** — verify deploy before any streaming fix |
| Keepalive / new SSE types dropped silently | UI regression, invisible heartbeats | **P0-I before P0-J** — add UI handlers first, then enable server heartbeats |
| Over-tight classifier breaks real edit requests | False negatives on edit tasks | Negation-only rule; mutation precedence stays intact for non-negated requests |
| OpenCode 400 fix touches shared `normalizeMessages` | Provider compatibility regression | Config flag; bun tests per provider shape |
| Shared `streamAbort` refactor breaks user Stop | Stop button no longer works | `stream-cancel.test.ts` + manual Stop checklist |
| UI persistence ADR delays shipping | Empty-bubble bug persists | Ship minimal placeholder/delete behavior first; ADR in parallel |
| OneDrive sync delays deploy | App runs mismatched files | Deploy with exe closed; verify manifest mtime |

---

## 6. Conclusion

The toolcall spillage and orchestration failure are **not a single bug** — they are the emergent behavior of a stale runtime, a broken sanitizer, a UI state machine that trusts the stream over the server, and an abort architecture that misclassifies hung models as user cancellations. 

The correct fix sequence is:

1. **Deploy the existing fix** (`VisibleAnswerStreamSanitizer` + `fb63137`) so the production runtime matches the repo.
2. **Fix the sanitizer itself** so it is newline-faithful, fence-aware, and uses a single shared predicate for both streaming and post-turn extraction.
3. **Fix the UI** so it handles `cancelled`, ignores whitespace-only deltas for `streamedVisibleText`, and wraps `JSON.parse`.
4. **Split the abort domains** so slow models emit `error` with `first_token_timeout`, not `cancelled`.
5. **Harden the orchestration** with negation-aware classification, trivial-read fast paths, and conductor replan caps.

Every step above is backed by concrete code locations, documented live incidents, and professional patterns (atomic deploy, contract-first SSE, separate abort domains, invariant-driven sanitizers). The implementation is ready to proceed when you give the go-ahead.
