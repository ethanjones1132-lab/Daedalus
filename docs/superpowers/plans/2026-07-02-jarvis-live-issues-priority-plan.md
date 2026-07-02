# Jarvis live issues — priority / impact stack + comprehensive plans

**Date:** 2026-07-02  
**Repo:** `C:\Projects\home-base-recovered` (master, sanitizer fix `fb63137`)  
**Live runtime (stale):** `C:\Users\ethan\OneDrive\Desktop\Jarvis.exe` + `bun …\Desktop\index.js`  
**Status:** Plan only — no implementation in this pass.

**Changelog (2026-07-02 verification pass):** Re-ranked stack after parallel sweeps of server streaming/abort, UI chat flow, and orchestration/classifier/spawn. Corrected P0-B (server *does* emit `cancelled`; UI drops it; Agent Loop duplicates first-token watchdog). Rewrote P2-F (permissive **allows** out-of-workspace paths). Added P0-I/J, P1-K/L/M/N, P2-O. Strengthened acceptance criteria, execution order, risks, and test matrix.

---

## Executive ordering (impact × blast radius)

| Rank | Issue | Why first |
|------|--------|-----------|
| **P0-A** | Stale Desktop runtime bundle | Every other fix is invisible until `index.js` / `Jarvis.exe` / `prompts/` match repo HEAD. You are debugging production behavior that does not include `VisibleAnswerStreamSanitizer` or recent orchestrator fixes. |
| **P0-B** | Turn-wide `streamAbort` on slow first-token (false “cancelled” + blank bubble) | Hard user-visible failure: slow/zero-token turns, blank bubble, no persisted assistant row. Blocks trust in free-tier models (`deepseek-v4-flash-free`). |
| **P0-I** | SSE protocol contract & terminal-frame guarantee | Server emits frame types the UI never handles; non-terminal or silent ends break “fluid chat” even when server logic is partially correct. |
| **P0-J** | Stream liveness: hangs, stalls, disconnects | No client inactivity timeout; limited server stall coverage; no keepalive during silent pipeline stages; upstream not aborted on client disconnect. |
| **P1-C** | Read-only turns over-orchestrated (classifier + routing + executor churn) | Same session: many executor passes, HTTP 400s, fallback advances for a simple read probe — cost, latency, wrong tool profile. |
| **P1-D** | Negation-blind `mutation_verb` (“Do not modify”) → `full_execution` | Safety regression: read-only ask escalates to full tool profile. |
| **P1-E** | Bun server failed to auto-start (manual `Desktop\index.js`) | App appears “up” but chat path dead until user intervenes; couples to supervisor / spawn / Desktop layout. |
| **P1-K** | UI chat state machine (send/stop/session/history/empty bubble) | Races and edge cases that corrupt messages, lose input, or leave broken UI state during normal chat. |
| **P1-L** | Server abort-domain races & resource hygiene | Extends P0-B: controller map races, duplicate `reader.cancel()`, shared `streamAbort`, markup leakage on non-answer stages. |
| **P1-M** | Persistence & history integrity | Assistant history is UI-driven (Tauri `append_message`); server `/sessions` stubs; cancel/error mid-stream loses rows. |
| **P1-N** | Config integrity | `saveConfig` writes without pre-validation; `deepMerge` blocks intentional empty-string clears; coordinator `<think>`-only output degrades routing. |
| **P2-F** | Permissive sandbox **allows** paths outside `jarvis_path` | Working-as-coded (not “bypass bug”); user/docs expectation mismatch; align `jarvis_path` or document behavior. |
| **P2-G** | Companion sprite overlaps Send | Global `z-50` companion vs composer Send (no z-index) — click-target friction, not data loss. |
| **P2-H** | Build provenance does not cover **Desktop deploy triplet** | Rust `build.rs` stamps exe; **no enforced hash** for copied `index.js` + `prompts/` beside `Jarvis.exe`. |
| **P2-O** | Ops hardening (spawn, restart TTL, deploy guards, tool truncation) | Restart fast-path stale health, supervisor boot grace, deploy `prompts/` guard, executor result elision. |

---

## P0-A — Stale Desktop runtime

### Symptoms (observed)

- Active: `Jarvis.exe` + `Desktop\index.js` (OneDrive Desktop).
- Repo bundle hash ≠ deployed `index.js` hash.
- Deployed server still uses **`TextToolCallStreamSanitizer`** on synthesizer path; repo uses **`VisibleAnswerStreamSanitizer`** when `surfaceAsAnswer` (`server-jarvis/src/index.ts` ~1468–1471, `text-tools.ts`).

### Root cause

- **Two launch surfaces:** Tauri may run bundled `index.js` next to exe / resources, while day-to-day usage points Bun at **OneDrive Desktop** copy (`scripts/build-and-deploy.ps1`, live diagnosis docs).
- Deploy is manual/scripted, not tied to app start; deterministic `bun build` can yield identical hashes when source unchanged — **hash equality is not sufficient**; compare to **current git HEAD** build output.
- **Prompts are disk-loaded:** `loadPrompt()` resolution order (`server-jarvis/src/orchestration/prompt-loader.ts` ~30–82): `JARVIS_PROMPTS_DIR` → `__dirname/prompts/` → dev walk-ups → cwd/repo walk. Missing `Desktop\prompts\` degrades stages with narrative errors (`pipeline.ts` loads prompts per stage), not a silent single-point kill.
- **Deploy script gap:** `build-and-deploy.ps1` copies `server-jarvis\src\prompts` via `$promptsSrc` (~55, ~138–144) but does **not** `Test-Path` the source before `Copy-Item` — a bad path fails late or copies nothing useful.

### Plan

1. **Pre-flight (5 min)**  
   - `git rev-parse HEAD` → note SHA.  
   - Build fresh: `powershell -ExecutionPolicy Bypass -File scripts\build-and-deploy.ps1 -SkipDeploy`.  
   - Hash repo `server-jarvis/dist/index.js` vs `OneDrive\Desktop\index.js`.  
   - Grep deployed file for `VisibleAnswerStreamSanitizer`.

2. **Atomic deploy** (`build-and-deploy.ps1` stage 4):  
   - `home-base.exe` → `Jarvis.exe` (+ alias if used).  
   - `dist/index.js` → `Desktop\index.js`.  
   - `server-jarvis/src/prompts/` → `Desktop\prompts\` (required — not inlined in bundle).

3. **Restart contract**  
   - Kill old Bun on port **19877** (or configured port).  
   - `-RestartServer` on script or relaunch `Jarvis.exe`; verify supervisor spawns Bun (P1-E).  
   - Smoke: one chat turn + log/sanitizer behavior post-`fb63137`.

4. **Hardening (follow-up)**  
   - `Desktop\.jarvis-deploy-manifest.json`: `{ git_sha, index_js_sha256, exe_mtime, prompts_tree_sha256, deployed_at }`.  
   - Health UI: runtime drift when manifest ≠ current artifacts.  
   - Single canonical server entry documented (exe-adjacent vs Desktop — not both silently).

### Acceptance

- `Desktop\index.js` contains `VisibleAnswerStreamSanitizer` wiring for synthesizer.  
- Chat bubble shows newline-faithful answers; no empty bubble from sanitizer regressions fixed in `fb63137`.  
- `coordinator.md` loads from `Desktop\prompts\`.

### Verify

- Strings/grep on deployed `index.js` + live SSE inspection (bundled file is awkward for `bun -e`).  
- Repo: `bun test text-tools.test.ts` before deploy.

---

## P0-B — Independent cancellation bug (slow model → blank bubble)

### Symptoms (observed)

- Model: `deepseek-v4-flash-free`, ~45.967s, zero tokens, zero fallbacks, error: **`stream cancelled`**.
- First-token watchdog calls **turn-wide** `streamAbort.abort("First-token timeout")` in **two** code paths:
  - Orchestrator stage read loop: `server-jarvis/src/index.ts` ~1456–1465.
  - **Agent Loop** (missed in prior plan): same pattern ~2346–2357 (`[Jarvis Agent Loop] First-token timeout`).
- Server **does** emit `type: "cancelled"` via `emitCancelled()` (~1033–1038) before throwing `StreamCancelledError`.
- Catch block (~2755–2756): `StreamCancelledError` → **silent `return`** (no `error` frame — `cancelled` already sent).
- UI (`JarvisView.tsx` ~751–838): **no handler for `cancelled`** and **no `default` case** → frame dropped; stream ends → `finalizeAssistantMessage` (~404–425) leaves **empty** assistant bubble; **no** `append_message` when `content.trim()` empty (~415).

### Root cause (layered)

1. **`chatCompletionWithFallback`** (`openrouter.ts` ~792–796): `first_token_timeout_ms` defaults **30_000** ms on attempt-local watchdog; should advance cascade on stall (correct layer).

2. **Orchestrator + Agent Loop defense-in-depth** (`index.ts`): after `fetchRes.ok`, if no content token before `firstTokenTimeoutFor()` (clamped **[1_000, 60_000]** ms, ~1454–1456, ~2342–2350), calls **`streamAbort.abort()`** — session/turn controller shared with user Stop (`activeStreamControllers`, `/chat/cancel` ~3125–3127).

3. **Misclassification:** Slow/hung model is treated like **user cancellation** → `cancelled` SSE → UI ignores it → empty bubble + no persistence.

4. **Fallback gap:** Turn-wide abort can poison the session before `callModel` / cascade completes; metrics may read `stream cancelled` rather than structured first-token failure.

### Plan

#### Server (`server-jarvis/src/index.ts` + `openrouter.ts`)

1. **Separate abort domains**  
   - `streamAbort` — user Stop, session supersede, app shutdown only.  
   - `attemptAbort` / per-read-loop abort — first-token stall, per-HTTP-attempt; **must not** call `streamAbort.abort()`.

2. **First-token watchdog (both orchestrator read loop and Agent Loop)**  
   - On timeout: `reader.cancel()`, throw **`FirstTokenTimeoutError`** (or `retryable: true`, `reason: "first_token"`).  
   - `callModel` / fallback catches attempt-level timeout → exclude model → advance cascade.  
   - Bound attempts per stage.

3. **Terminal frames for non-user failures**  
   - Emit `type: "error"` with `code: "first_token_timeout"` **or** `fallback_notice` + continue; exhausted pool → `result` with `is_error: true` and retry text.  
   - Reserve `type: "cancelled"` for **explicit** user/client cancel only.

4. **Align timeouts**  
   - Orchestrator uses `firstTokenTimeoutFor(agentPool, model, MODEL_FIRST_TOKEN_TIMEOUT_MS)`; reconcile with `openrouter.first_token_timeout_ms` and observed ~46s on stale bundle (re-verify post P0-A).

#### UI (`src-ui/src/components/jarvis/JarvisView.tsx`)

1. **Handle `type: "cancelled"`** in `handleFrame`: user Stop → finalize with “(stopped)” or remove empty stub; **do not** treat as success.

2. **`type: "error"` / `result.is_error`:** set error strip; remove empty assistant stub (`handleSend` catch ~902+).

3. **`finalizeAssistantMessage`:** if assistant empty and stream ended without visible success, **remove** bubble and show error (no blank row).

4. **Terminal-frame invariant (see P0-I):** every turn must end in UI handling `result` | `error` | `cancelled`.

#### Tests

- `stream-cancel.test.ts`: user cancel → single `cancelled`.  
- New: first-token timeout → `error` or fallback, **not** `cancelled`.  
- Both code paths: orchestrator read loop + Agent Loop watchdog.

### Acceptance

- Slow `deepseek-v4-flash-free`: tokens, fallback, or explicit error — **never** silent blank bubble.  
- User Stop: one `cancelled`, UI shows stopped state, streaming clears promptly.  
- **Invariant:** watchdog timeout never emits `cancelled`; UI handles `cancelled` when user Stop does emit it.  
- Metrics: `fallbacks_used` / `retry_count` non-zero when appropriate.

### Verify

- Spot-check: `index.ts:1033–1039`, `1461–1465`, `2351–2357`, `2755–2757`; `JarvisView.tsx:751–838`, `404–425`.

---

## P0-I — SSE protocol contract & terminal-frame guarantee

### Symptoms

- Server emits frame types including: `init`, `stream_event`, `agent_activity`, `orchestrator_stage`, `orchestrator_recursion`, `reasoning_*`, `tool_use`, `tool_result`, `cost_info`, `result`, `error`, **`cancelled`**, **`fallback_notice`**, **`message_stop`**, **`agent_run_id`** (`stream-emitter.ts`, `index.ts`, `claude-cli.ts`).
- UI `handleFrame` (`JarvisView.tsx` ~751–838) handles ~11 kinds; **unhandled:** `cancelled`, `fallback_notice`, `message_stop`, `init`, `agent_run_id`; **no `default`** logging for unknown types.
- `JSON.parse(data)` at ~852 is **uncaught** → malformed SSE line can freeze/hang the read loop mid-stream.
- Server `JSON.stringify` in hot paths is not uniformly wrapped — writer failures should not leave ambiguous half-states.
- **Agent Loop** empty-completion path: orchestrator tool loop has empty fallback text + `session.finish` (~2653–2665); verify Agent Loop parity — any path that ends without `session.finish` / terminal frame leaves UI waiting.

### Root cause

- No shared **SSE contract** document or runtime assertion: “exactly one terminal frame per turn.”
- UI and server evolved separately; Claude CLI path emits `init` / `message_stop` that direct `fetch` UI path never consumed.

### Plan

1. **Document contract** in `docs/` or `stream-emitter.ts` header: required terminal trio; optional progress frames; versioning rule for new types.

2. **UI:** `switch`/`if-else` with **`default`**: log `unknown SSE type` + optional dev banner; handle `cancelled`, `fallback_notice` (toast or inline), ignore-noop `init`/`message_stop` if redundant.

3. **UI:** wrap `JSON.parse` in try/catch → surface parse error, abort stream cleanly.

4. **Server:** `ensureTerminal()` in `finally` (~2785–2789) must guarantee terminal frame unless already sent; audit Agent Loop exits for parity with orchestrator empty handling.

5. **Tests:** terminal-frame invariant test (mock writer records exactly one of `result`|`error`|`cancelled` per session).

### Acceptance

- Every completed turn: UI receives and processes exactly one terminal outcome (visible answer, error strip, or cancelled/stopped state).  
- Unknown frame types logged once per type per session (dev).  
- Malformed `data:` line does not wedge `isStreaming` true forever.

### Verify

- `JarvisView.tsx:751–838`, `852`; `index.ts:1033–1039`, `2785–2789`; `stream-emitter.ts` finish paths.

---

## P0-J — Stream liveness: hangs, stalls, disconnects

### Symptoms

- UI: `reader.read()` loop (~840–855) has **no inactivity timeout** — TCP half-close or hung proxy → wait forever, `isStreaming` stuck.
- Server: first-token watchdog + **chunk stall** check (`MODEL_STREAM_STALL_*`, ~1485–1493) — no **inter-token** guarantee if bytes trickle (e.g. one byte every 55s).
- Long silent orchestrator stages (~1833–1850 region): no SSE **keepalive** / heartbeat → reverse-proxy idle timeout risk.
- No **client disconnect** propagation: failed `writer.write` does not abort upstream model fetch for that session.

### Plan

1. **UI:** `AbortController` + wall-clock inactivity timer (reset on any valid frame); on fire → abort fetch, finalize with error.

2. **Server:** optional `: ping` or `type: "heartbeat"` every N seconds during pipeline gaps (behind flag); **deploy UI default handler first** (P0-I) so heartbeats are not silently dropped.

3. **Server:** inter-token idle timeout on read loops (distinct from first-token).

4. **Server:** on write failure, abort `streamAbort` or upstream `fetch` signal for that session.

### Acceptance

- Simulated network drop: UI recovers within configured timeout (error + `isStreaming` false).  
- 5+ minute silent pipeline (mock): connection stays open or fails with explicit error, not infinite spinner.

### Verify

- Manual: disable network mid-stream; throttle SSE to 1 byte/min in dev mock.

---

## P1-C — Read-only work over-orchestrated (quoted JSON / read probe)

### Symptoms (observed)

- Quoted `{"name":"read_file",…}` JSON misclassified as executable workspace intent.
- **10 Executor** model passes for a read probe (`modes.ts` `max_turns: 10` ~47).
- **3× HTTP 400** + **3 fallback advances** on provider chain.
- First `read_file` omitted `path`; recovery via **model-driven retry after tool-error result** (`pipeline.ts` tool loop ~199–233), not deterministic “auto-correction.”

### Root cause (verified on repo)

1. **`classifyTurnRequirements`** (`turn-requirements.ts`):  
   - `quoted_path` regex ~42: `/["'][^"']*[\\/][^"']*["']/`.  
   - Bare tool JSON → `workspace_read` or **`full_execution`** (P1-D).

2. **Route normalization** (`route-normalization.ts`):  
   - `ALLOWED_STAGES.workspace_read` = planner, executor, reviewer, synthesizer (~62) — **not** capped to executor→synthesizer only at allowed-set level.  
   - `REQUIRED_STAGES.workspace_read` = **`["executor", "synthesizer"]`** (~70).  
   - `PROFILE_FOR.workspace_read` = **`read_only`** (~74–78) — tools capped; coordinator cannot expand to full profile via normalization (~98–164).

3. **Executor tool loop** + OpenCode 400s: tool-shaped history rejected → fallback churn.

4. **Fast path missing** for trivial read-with-explicit-path.

### Plan

1. **Log forensics** per failing `session_id`: `normalized=`, `requirement=`, `Pool resolved`, `Fallback:`, `API 400`.

2. **Classifier** (`turn-requirements.ts`): tool-call-shaped / quoted JSON exemplar → `answer_only` or `workspace_read` without `quoted_path`; tests in `turn-requirements.test.ts`.

3. **Route normalization:** optionally tighten `ALLOWED_STAGES.workspace_read` to `{executor, synthesizer}` if product wants minimal pipeline (ADR); today **required** stages already force executor presence.

4. **Executor efficiency:** trivial read fast-route; optional deterministic path extract (Tier-2).

5. **Provider 400:** normalize/strip tool messages for OpenCode providers (config flag).

### Acceptance

- “Read `C:\…\file`”: ≤2 executor LLM rounds typical, **read_only** tools only.  
- Pasted tool JSON “analyze only / do not run”: no executor loop.  
- HTTP 400 count logged; fallbacks bounded.

### Verify

- `turn-requirements.ts:42`; `route-normalization.ts:62–71, 74–79`; `modes.ts:47`.

---

## P1-D — Negation ignored (`mutation_verb` → `full_execution`)

### Symptoms

- “Do not modify any files” triggers **`mutation_verb`** → **`full_execution`** profile.

### Root cause

- `MUTATION_VERB` matches **`modify`** inside “Do **not modify**” — no negation window (`turn-requirements.ts` ~112–124).  
- Precedence: mutation wins over `workspace_read` (~121–124).

### Plan

1. Negation pass before mutation signals (`do not|don't|never|without` + lemma; `no modifications|edits|changes`).  
2. Negated mutation + read cues → `workspace_read` or `answer_only`.  
3. Tests + `eval/cases.ts` regression.

### Acceptance

- Read-only probes with explicit negation never get `full_execution` tool profile.

---

## P1-E — Bun failed to auto-start

### Symptoms

- Jarvis did not start Bun; user ran `bun Desktop\index.js` manually.

### Root cause candidates

- **Entry resolution** (`lib.rs` `find_jarvis_server` ~271–389): exe dir, `resources/index.js`, repo walk — Desktop layout may not match spawn expectation.  
- **Bun discovery** (`find_bun_executable` ~417–463): WSL vs native `.exe`.  
- **`spawn_jarvis_server`** returns `None` silently (~522–527).  
- **Supervisor** `MAX_CONSECUTIVE_RESTARTS=5` (`supervisor.rs` ~27); first tick after **20s** `TICK` (~77–85) → red health on cold boot until first heartbeat.  
- Logs: `%LOCALAPPDATA%\com.jarvis.desktop\logs\server-jarvis.log` / `.err.log` (`lib.rs` ~465–486).  
- No spawn-failure toast; `jarvis://supervisor` heartbeat only.

### Plan

1. Diagnose logs + Control Center Bun row + spawn log line with entry path.  
2. **Desktop contract:** `Jarvis.exe` on OneDrive Desktop → `index.js` + `prompts/` same directory first (document in `jarvis-runtime-ops`).  
3. Failed spawn → actionable toast + Restart.  
4. Align with P0-A single deploy triplet.

### Acceptance

- Cold start: `/health` OK within 30s without manual `bun`.  
- Failed start visible in Health banner with retry.

### Verify

- `lib.rs:271–389`, `539–579`; `supervisor.rs:77–85`.

---

## P1-K — UI chat state machine

### Symptoms / findings (code review)

- **Double-send race:** `handleSend` (~862) gates on `isStreaming` only — stale closure can double-send.  
- **Input cleared early** (~867) before stream confirmed — connection refused → message lost from input.  
- **Session switch mid-stream** (~478–541): cancels prior stream but history reload can **bleed** streaming bubble until load completes.  
- **Empty bubble render:** `MarkdownView` + empty streaming assistant (~1439 region).  
- **`</think>` not filtered client-side** on streamed text.  
- **Tool-result matching** falls back to tool name (~806–819) — wrong pairing risk.  
- **Autoscroll vs user scroll** (~456–460).  
- **Stop** (~921–941): does not clear reasoning panel state.  
- **Autofocus / IME** (~705–709).  
- **Error banner a11y** (~1214–1223).

### Plan

1. Send lock (ref + `isStreaming`); clear input only after POST accepted or restore on failure.  
2. On session switch: reset messages/streaming state atomically before history fetch.  
3. Empty assistant: don’t render markdown shell; strip or collapse `think` tags for display.  
4. Tool match: prefer `call_id` only; warn on name fallback.  
5. Stop: clear `reasoningText` / `showReasoning`.  
6. Manual checklist (see Test matrix).

### Acceptance

- Double-click Send / rapid Enter: one in-flight stream.  
- Connection refused: user message still in composer or error with recoverable text.  
- Switch session during stream: no ghost streaming bubble on wrong session.

---

## P1-L — Server abort-domain races & resource hygiene

### Symptoms / findings

- `activeStreamControllers` get/abort/delete race: `/chat/cancel` (~3125–3127) vs stream `finally` (~2786).  
- Abort listener add/remove scattered (~1386–1691, Agent Loop ~2223–2322).  
- First-token timer + stall watchdog can both call `reader.cancel()` (~1465, 1491, 2355).  
- **Single shared `streamAbort`** across all stages (document as design constraint in fix).  
- Markup leakage when `useTextTools=false` on non-answer stages (~1635–1651).  
- `MAX_TOOL_RESULT_CHARS=2000` middle-elision (~155, 208–211) — large reads truncated in history.

### Plan

1. Serialize cancel + finally on per-session mutex or “cancel generation” token.  
2. Centralize abort listener registration (try/finally helper).  
3. Dedupe `reader.cancel()` — idempotent guard.  
4. Document `streamAbort` scope; stage-local attempt abort for timeouts.  
5. Surface truncation in tool_result metadata for UI.

### Acceptance

- Fuzz: cancel during first-token timeout → one terminal frame, no double-free controller map entry.  
- No duplicate cancel side effects in logs.

---

## P1-M — Persistence & history integrity

### Symptoms

- **Server** `/sessions` GET/POST/delete are **stubs** (`index.ts` ~3133–3135) — no server-side chat history API.  
- **Persistence is client-driven:** `finalizeAssistantMessage` → Tauri `append_message` only when `content.trim()` non-empty (`JarvisView.tsx` ~415–420).  
- Cancel/error/crash mid-stream: assistant row **not** saved; blank bubble visible until refresh then may vanish.

### Plan

1. **Product contract (ADR):** persist partials? persist “(stopped)” rows? server-side backup?  
2. Short term: on `error`/`cancelled`, optionally persist placeholder or delete optimistic row consistently.  
3. Long term: align Tauri SQLite as source of truth with server stubs or implement real `/sessions` if needed.

### Acceptance

- Documented behavior for stop/error/empty: user sees consistent history after reload.  
- No “vanished” assistant that existed only in ephemeral UI state without explanation.

---

## P1-N — Config integrity

### Symptoms

- `saveConfig` merge + normalize, **no validate-before-write** (`config.ts` ~608–616).  
- `deepMerge` skips empty-string overwrite when target has non-empty default (~644–645) — cannot intentionally clear some fields via partial save.  
- Coordinator reasoning model `<think>`-only → `extractJson` fails → `defaultRoute()` (~135–147) — silent degradation, not user-visible misconfig.

### Plan

1. Call validation helper before `writeFileSync`; reject or strip invalid partials.  
2. Explicit “clear field” sentinel or separate API for empty overrides.  
3. Health warning when coordinator model never returns routable JSON in smoke test.

### Acceptance

- Invalid config cannot be persisted without error surfaced to Control Center.  
- User can clear optional string fields without deepMerge blocking.

---

## P2-F — Permissive sandbox allows paths outside workspace

### Symptoms

- `sandbox_mode: permissive` **allowed** read of Windows path outside configured `jarvis_path`.

### Root cause (**rewrite — prior plan was wrong**)

- `fs-scope.ts` ~59–63: **`permissive` logs and returns `resolved`** for paths outside workspace (`escapes` true).  
- **Strict** (~65–66) throws `Path "…" is outside the workspace. Sandbox mode: …`.  
- **`off`** disables containment (see `jarvis-runtime-ops` / agent-tools `safePath`).  
- User observation is **working-as-coded**, not “permissive ≠ bypass.”

### Plan

1. **Docs / Control Center:** mode table — `strict` (enforce workspace), `permissive` (allow outside with log), `off` (no sandbox).  
2. **Config:** set `jarvis_path` to intended Windows repo root if strict reads matter.  
3. Optional ADR if product should change permissive semantics (separate from this bug class).

### Acceptance

- User understands three modes; read probe behaves predictably per chosen mode.  
- No doc claim that permissive blocks out-of-workspace paths.

### Verify

- `fs-scope.ts:59–66`.

---

## P2-G — Companion overlaps Send

### Symptoms

- `App.tsx` companion: `fixed bottom-6 right-6 z-50` (~774–775).  
- `JarvisView` Send: `absolute right-2 bottom-2` — **no z-index** (~1283–1288).  
- Companion wins stacking; Send click-target partially blocked.

### Plan

1. Hide companion on `jarvis` view or offset `bottom-24` when chat active.  
2. Or raise composer Send `z-index` above companion when focused (careful with petdex hit target).

### Acceptance

- Send fully clickable on Jarvis chat without dismissing companion.

---

## P2-H — Deploy provenance gap

### Plan

- Manifest (P0-A).  
- `BuildBadge` / System Health: `index.js` drift vs exe build SHA.  
- CI optional: `verify.sh` when `server-jarvis/src/**` changes.

---

## P2-O — Ops hardening

### Findings

- **Restart fast-path:** `force_restart_jarvis_server` (`lib.rs` ~539–579) does not clear `LAST_HEALTHY_MS` (~586–595) — Restart may no-op 10s TTL “healthy” skip.  
- **Supervisor boot:** first heartbeat only after initial `TICK` sleep (~77–85).  
- **Deploy:** add `Test-Path $promptsSrc` before copy (`build-and-deploy.ps1` ~138–144).  
- **Bun spawn with spaces:** verify `Command` arg quoting (`lib.rs` ~504–512) before treating as bug — Rust normally passes args without shell split.  
- **Tool result truncation:** `MAX_TOOL_RESULT_CHARS=2000` — document for quality-sensitive reads.

### Plan

1. Clear `LAST_HEALTHY_MS` on force restart.  
2. Optional earlier supervisor ping on boot.  
3. Deploy guard + fail-fast message for missing `prompts/`.  
4. Executor truncation: raise limit or attach “truncated” flag in SSE.

### Acceptance

- UI Restart always probes/spawns when user requests, regardless of TTL cache.  
- Deploy fails clearly if `server-jarvis/src/prompts` missing.

---

## Recommended execution sequence (implementation phase)

```text
1. P0-A     Deploy triplet + verify sanitizer + prompts (Test-Path hardening in script)
2. P0-I     SSE contract + UI handlers (incl. cancelled, default case, JSON.parse guard)
3. P0-B     Abort-domain split (orchestrator + Agent Loop) + terminal-frame semantics
4. P0-J     Liveness (UI inactivity timeout; server keepalive behind flag)
5. P1-L     Abort races + hygiene (same files as P0-B — one branch)
6. P1-D     Negation in turn-requirements (quick safety win)
7. P1-C     Classifier JSON/tool-payload + provider 400 / executor churn
8. P1-K     UI state machine fixes
9. P1-M     Persistence contract + short-term stop/error behavior
10. P1-E    Spawn path + supervisor surfacing (with P0-A layout)
11. P1-N    Config validate-on-save
12. P2-G    Companion offset
13. P2-F    Sandbox docs + jarvis_path guidance
14. P2-H    Manifest + drift UI
15. P2-O    Restart TTL, deploy guards, truncation UX
```

---

## Dependencies & risks

| Risk | Mitigation |
|------|------------|
| Fixing P0-B on stale bundle only | **P0-A first** |
| Keepalive / new SSE types dropped silently | **P0-I before P0-J** server heartbeats |
| Over-tight classifier breaks real edit requests | Mutation precedence tests; negation only strips when phrase present |
| OpenCode 400 fix touches shared normalizeMessages | Config flag; bun tests per provider shape |
| OneDrive sync delays deploy | Deploy with exe closed; verify manifest mtime |
| Shared `streamAbort` refactor breaks user Stop | `stream-cancel.test.ts` + manual Stop checklist |
| UI persistence ADR delays P1-M | Ship minimal placeholder/delete behavior first |

---

## Test matrix (implementation phase)

| Area | Automated | Manual |
|------|-----------|--------|
| P0-B / cancel | Extend `stream-cancel.test.ts`; first-token timeout → not `cancelled` | Slow free model; Stop mid-stream |
| P0-I | Terminal-frame invariant (one of result/error/cancelled) | Inject unknown `type` in mock SSE |
| P0-J | — | Network drop; proxy idle timeout sim |
| P1-D | `turn-requirements.test.ts` negation + tool JSON | “Do not modify …” |
| P1-C | Classifier pasted JSON cases | Read probe session log grep |
| P1-K | — | Double-send, session switch mid-stream, connection refused |
| P1-M | — | Stop with empty bubble → reload history |
| P2-F | `fs-scope` unit tests if present | permissive vs strict path read |
| Deploy | — | Missing prompts folder → script error |

---

## References (repo)

- `scripts/build-and-deploy.ps1` — deploy stages; add `Test-Path` on `$promptsSrc`  
- `server-jarvis/src/index.ts` — `streamAbort`, `emitCancelled`, `callModel`, first-token timers (orchestrator + Agent Loop), `/sessions` stubs  
- `server-jarvis/src/openrouter.ts` — `chatCompletionWithFallback`, `first_token_timeout_ms` (~796)  
- `server-jarvis/src/stream-emitter.ts` — `init`, `message_stop`, `finish`  
- `server-jarvis/src/fs-scope.ts` — permissive vs strict (~59–66)  
- `server-jarvis/src/orchestration/turn-requirements.ts` — classifier  
- `server-jarvis/src/orchestration/route-normalization.ts` — `ALLOWED_STAGES` / `REQUIRED_STAGES`  
- `server-jarvis/src/orchestration/prompt-loader.ts` — prompt resolution  
- `server-jarvis/src/config.ts` — `saveConfig`, `deepMerge`  
- `src-ui/src/components/jarvis/JarvisView.tsx` — SSE `handleFrame`, `finalizeAssistantMessage`, `handleSend`, `handleStop`  
- `src-ui/src/App.tsx` — companion layout  
- `src-tauri/src/lib.rs` — spawn, `force_restart_jarvis_server`, `LAST_HEALTHY_MS`  
- `src-tauri/src/supervisor.rs` — tick interval, give-up  
- `docs/superpowers/plans/2026-07-02-synthesizer-sanitizer-chat-regression-fable-handoff.md`  
- Hermes skill: `jarvis-runtime-ops`

---

*End of plan — implementation explicitly out of scope for this document.*