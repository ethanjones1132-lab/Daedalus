# Jarvis live issues — priority / impact stack + comprehensive plans

**Date:** 2026-07-02  
**Repo:** `C:\Projects\home-base-recovered` (master, sanitizer fix `fb63137`)  
**Live runtime (stale):** `C:\Users\ethan\OneDrive\Desktop\Jarvis.exe` + `bun …\Desktop\index.js`  
**Status:** Plan only — no implementation in this pass.

---

## Executive ordering (impact × blast radius)

| Rank | Issue | Why first |
|------|--------|-----------|
| **P0-A** | Stale Desktop runtime bundle | Every other fix is invisible until `index.js` / `Jarvis.exe` / `prompts/` match repo HEAD. You are debugging production behavior that does not include `VisibleAnswerStreamSanitizer` or recent orchestrator fixes. |
| **P0-B** | Turn-wide `streamAbort` on slow first-token (false “cancelled”) | Hard user-visible failure: ~46s, zero tokens, no fallback, blank bubble, no persisted assistant row. Blocks trust in free-tier models (`deepseek-v4-flash-free`). |
| **P1-C** | Read-only turns over-orchestrated (classifier + routing + executor churn) | Same session: 10 executor passes, 3× HTTP 400, 3 fallback advances for a simple read probe — cost, latency, and wrong tool profile. |
| **P1-D** | Negation-blind `mutation_verb` (“Do not modify”) → `full_execution` | Safety regression: read-only ask escalates to full tool profile. |
| **P1-E** | Bun server failed to auto-start (manual `Desktop\index.js`) | App appears “up” but chat path dead until user intervenes; couples to supervisor / spawn / Desktop layout. |
| **P2-F** | Permissive sandbox + Windows path outside `jarvis_path` | Expected per `fs-scope.ts` design, but user expectation mismatch; config/docs + optional `jarvis_path` alignment. |
| **P2-G** | Companion sprite overlaps Send (`fixed bottom-6 right-6` vs composer Send) | UX friction, not data loss. |
| **P2-H** | Build provenance does not cover **Desktop deploy triplet** | Rust `build.rs` stamps exe; **no enforced hash** for copied `index.js` + `prompts/` beside `Jarvis.exe`. Stale server script can persist while exe looks “fresh.” |

---

## P0-A — Stale Desktop runtime

### Symptoms (observed)

- Active: `Jarvis.exe` + `Desktop\index.js` (OneDrive Desktop).
- Repo bundle hash ≠ deployed `index.js` hash.
- Deployed server still uses **`TextToolCallStreamSanitizer`** on synthesizer path; repo uses **`VisibleAnswerStreamSanitizer`** when `surfaceAsAnswer` (`server-jarvis/src/index.ts` ~1468–1471, `text-tools.ts`).

### Root cause

- **Two launch surfaces:** Tauri may run bundled `index.js` next to exe / resources, while day-to-day usage points Bun at **OneDrive Desktop** copy (documented in `NEXT_AGENT_JARVIS_LIVE_MODEL_DIAGNOSIS_2026-06-26.md`, `scripts/build-and-deploy.ps1`).
- Deploy is manual/scripted, not tied to app start; MD5/SHA can match when source unchanged (PRIORITIES notes deterministic `bun build`), so **hash equality is not sufficient** — must compare to **current git HEAD** build output.

### Plan

1. **Pre-flight (5 min)**  
   - `git rev-parse HEAD` → note SHA.  
   - Build fresh: `powershell -ExecutionPolicy Bypass -File scripts\build-and-deploy.ps1 -SkipDeploy` (or stages 1–3 only).  
   - Hash repo `server-jarvis/dist/index.js` vs `OneDrive\Desktop\index.js`.  
   - Grep deployed file for `VisibleAnswerStreamSanitizer` (string present in fresh bundle).

2. **Atomic deploy** (`build-and-deploy.ps1` stage 4 — already documents triplet):  
   - `home-base.exe` → `Jarvis.exe` (+ `home-base.exe` alias if used).  
   - `dist/index.js` → `Desktop\index.js`.  
   - `server-jarvis/src/prompts/` → `Desktop\prompts\` (required — prompts are **not** inlined in bundle).

3. **Restart contract**  
   - Kill old Bun on port **19877** (or configured port).  
   - Option: `-RestartServer` on script, or relaunch `Jarvis.exe` and verify supervisor spawns Bun (see P1-E).  
   - Smoke: one chat turn + confirm log line shows post-`fb63137` sanitizer behavior.

4. **Hardening (follow-up task)**  
   - Write `Desktop\.jarvis-deploy-manifest.json` on each deploy: `{ git_sha, index_js_sha256, exe_mtime, prompts_tree_sha256, deployed_at }`.  
   - Health UI / Control Center: “runtime drift” when manifest ≠ current build artifacts.  
   - On app start: prefer **single canonical server entry** (exe-adjacent `index.js` **or** documented Desktop path — not both silently).

### Acceptance

- `Desktop\index.js` contains `VisibleAnswerStreamSanitizer` wiring for synthesizer.  
- Chat bubble shows newline-faithful answers; no regression to empty bubble from sanitizer-only bugs fixed in `fb63137`.  
- `coordinator.md` loads from `Desktop\prompts\`.

### Verify

- `bun -e` against **deployed** `index.js` is awkward (bundled); instead: strings/grep + live SSE frame inspection.  
- `server-jarvis` tests: `bun test text-tools.test.ts` on repo before deploy.

---

## P0-B — Independent cancellation bug (slow model → blank bubble)

### Symptoms (observed)

- Model: `deepseek-v4-flash-free`, ~45.967s, zero tokens, zero fallbacks, error: **`stream cancelled`**.
- Stale bundle: first-token watchdog calls **turn-wide** `streamAbort.abort()` (~line 14955 in Desktop `index.js`; repo equivalent ~1461–1465 in `server-jarvis/src/index.ts`).
- UI: `JarvisView.tsx` `finalizeAssistantMessage` (~404–425) clears streaming flag; **does not persist** assistant if `content.trim()` empty; stream ends without `error` frame when `StreamCancelledError` short-circuits server catch (~2755–2756).

### Root cause (layered)

1. **`chatCompletionWithFallback`** (`openrouter.ts` ~812–848): attempt-local `attemptCtrl.abort(STALL_REASON)` on first-byte timeout → **should** advance cascade (correct layer).

2. **Orchestrator defense-in-depth** (`index.ts` ~1445–1466): after `fetchRes.ok`, if no **content** token before `firstTokenMs`, calls **`streamAbort.abort("First-token timeout")`** — this is the **session/turn** controller, shared with user cancel (`activeStreamControllers`, `emitCancelled`).

3. **Misclassification:** Slow-but-valid model is treated like **user cancellation** → `StreamCancelledError` → catch returns with **no** `type: "error"` SSE → UI runs normal end-of-stream `finalizeAssistantMessage` → empty optimistic bubble.

4. **Fallback gap:** Abort poisons the whole turn before `callModel` can retry/next model; metrics show `stream cancelled` not first-token timeout message.

### Plan

#### Server (`server-jarvis/src/index.ts` + `openrouter.ts`)

1. **Separate abort domains**  
   - `userAbort` / `streamAbort` — only user Stop, session supersede, app shutdown.  
   - `attemptAbort` — first-token stall, per-HTTP-attempt only; **must not** call `streamAbort.abort()`.

2. **Orchestrator first-token watchdog behavior**  
   - On timeout: `reader.cancel()`, throw **`FirstTokenTimeoutError`** (or structured error with `retryable: true`, `reason: "first_token"`).  
   - **`callModel` loop** catches attempt-level timeout → exclude model → invoke `chatCompletionWithFallback` again / next pool model (same as empty-completion cascade).  
   - Bound attempts (e.g. max 2–3 per stage) to avoid infinite spin.

3. **Never map attempt timeout → `emitCancelled()`** unless `streamAbort` reason is explicitly user-initiated (`AbortSignal` from `/chat/cancel` or client disconnect).

4. **Terminal frames for non-user failures**  
   - Emit `type: "error"` with `code: "first_token_timeout"` **or** `type: "fallback_notice"` + continue pipeline; if all models exhausted, `type: "result", is_error: true` with user-facing retry text.  
   - Do **not** use `type: "cancelled"` for watchdog.

5. **Align timeouts**  
   - Per-model `firstTokenTimeoutFor` (agent pool) for orchestrator read loop.  
   - Ensure `deepseek-v4-flash-free` (and similar) either has pool override **or** inherits config `openrouter.first_token_timeout_ms` — today orchestrator may fire at 30s while user saw ~46s (stale bundle or different code path — re-verify on fresh deploy).

#### UI (`JarvisView.tsx`)

1. Handle `type: "cancelled"` explicitly: only then finalize as “stopped by user”; optional persist “(cancelled)” or drop empty bubble.

2. On `type: "error"` or `result.is_error`: set `error` state, remove empty assistant stub (already partial in `handleSend` catch ~906–911).

3. **`finalizeAssistantMessage`:** if streaming assistant is empty and no explicit success, **remove** bubble and show error strip (don’t leave blank assistant row).

4. **`type: "cancelled"`** during non-user watchdog: treat as error (server fix should prevent this).

#### Tests

- Extend `stream-cancel.test.ts`: user cancel still single `cancelled` frame.  
- New test: simulated first-token timeout → `error` or fallback frames, **not** `cancelled`.  
- Optional integration: mock slow SSE, assert cascade `excludeModels` advances.

### Acceptance

- Slow `deepseek-v4-flash-free` turn: either tokens arrive, or fallback runs, or explicit error message — **never** silent blank bubble.  
- User Stop still emits one `cancelled` and clears streaming promptly.  
- Inference metrics: `fallbacks_used` / `retry_count` non-zero when appropriate.

---

## P1-C — Read-only work over-orchestrated (quoted JSON / read probe)

### Symptoms (observed)

- Quoted `{"name":"read_file",…}` JSON misclassified as executable workspace intent.  
- **10 Executor** model passes for a read probe.  
- **3× HTTP 400** + **3 fallback advances** on provider chain.  
- First `read_file` omitted `path`; auto-correction recovered (tool-loop churn).

### Root cause hypotheses (verify on fresh logs)

1. **`classifyTurnRequirements`** (`turn-requirements.ts`):  
   - `quoted_path` regex matches JSON strings containing `/` or `\\`.  
   - Bare tool JSON in user message → **`workspace_read`** or worse **`full_execution`** (see P1-D).  
   - Coordinator may still route heavy pipeline (`planner` → `executor` × N tool turns).

2. **Executor tool loop** (`MAX_TOOL_EXECUTION_TURNS` = 10): text-tool protocol on OpenCode models → multi-pass parse/execute.

3. **OpenCode / tool-message 400s** (orchestrator-tuning skill): providers reject tool-shaped history → fallback churn before successful read.

4. **Fast path missing:** Trivial “read path X” should be `workspace_read` + `["executor","synthesizer"]` + read-only profile, **not** full planner/reviewer stack when conductor agrees.

### Plan

1. **Log forensics template** (one failing session id):  
   - Grep: `Jarvis_Orchestrator:`, `normalized=`, `requirement=`, `Pool resolved`, `Fallback:`, `API 400`.  
   - Correlate with `classifyTurnRequirements` signals in log (add log line if missing).

2. **Classifier hardening** (`turn-requirements.ts`):  
   - **JSON / tool-call shaped messages:** if message matches `^\s*\{.*"name"\s*:\s*"(read_file|…)"` and lacks mutation intent → `workspace_read` or `answer_only` (if user says “paste/analyze this JSON” without workspace noun).  
   - **Quoted JSON block:** do not treat as `quoted_path` if entire message is tool-call exemplar (negative lookahead / `isToolCallPayload()` helper).  
   - Tests in `turn-requirements.test.ts` for pasted tool JSON + “do not execute”.

3. **Route normalization** (`route-normalization.ts`):  
   - `workspace_read` + read-only profile: cap pipeline to `executor → synthesizer` (already partially enforced — verify not expanded by coordinator).

4. **Executor efficiency:**  
   - Single-tool read turns: coordinator fast-route (existing turn-triage / trivial paths — compare with `isTrivialConversationalTurn`).  
   - Reduce redundant LLM passes: deterministic parse of `read_file` from user text when path is explicit (optional Tier-2).

5. **Provider 400:** strip or compress tool messages for OpenCode providers before retry (orchestrator-tuning §7); count 400s in metrics.

### Acceptance

- “Read `C:\…\file`” (or quoted path): ≤2 executor LLM rounds typical, read-only tools only.  
- Pasted tool JSON with “analyze only / do not run”: no executor loop.  
- HTTP 400 count logged; fallbacks bounded.

---

## P1-D — Negation ignored (`mutation_verb` → `full_execution`)

### Symptoms

- “Do not modify any files” triggers **`mutation_verb`** → **`full_execution`** profile.

### Root cause

- `MUTATION_VERB` in `turn-requirements.ts` (~70–71) matches **`modify`** as substring of “**modify**” in “Do **not modify**” — no negation window.  
- Precedence: mutation wins over `workspace_read` (~121–124).

### Plan

1. **Negation pass** before verb signals:  
   - Patterns: `\b(do not|don't|never|without)\s+(\w+)` within ~3 words of mutation lemma; `\bno\s+(modifications|edits|changes)\b`.  
   - If negated → do not set `mutation_verb` for that lemma.

2. **Conservative default:** negated mutation + read verbs → `workspace_read` or `answer_only`.

3. **Tests:**  
   - `"Do not modify any files"` → `workspace_read` or `answer_only`, signals include `negated_mutation`, **not** `full_execution`.  
   - `"Do not delete"` vs `"delete temp"` still `full_execution`.

4. **Eval cases** (`eval/cases.ts`): add regression case for negation.

### Acceptance

- Read-only probes with explicit negation never get `full_execution` tool profile.

---

## P1-E — Bun failed to auto-start

### Symptoms

- Jarvis did not start Bun; user ran `bun Desktop\index.js` manually.

### Root cause candidates

- **Entry resolution** (`lib.rs` ~286–330): exe dir vs `resources/index.js` vs repo path — Desktop layout may not match what Tauri spawn expects.  
- **Bun discovery** (`find_bun_executable`): WSL vs native `.exe` branch — wrong branch → spawn fails silently (`spawn_jarvis_server` returns `None`).  
- **Supervisor give-up** after 5 failures (PRIORITIES) — UI shows “down” without obvious recovery.  
- **User habit:** launching `Jarvis.exe` from Desktop while server expected beside exe but only `index.js` on Desktop without matching exe resources.

### Plan

1. **Diagnose:**  
   - `%LOCALAPPDATA%\com.jarvis.desktop\logs\server-jarvis.log` + `.err.log` at failed start.  
   - Control Center: Bun row, `*_give_up` flags.  
   - Confirm which `index.js` path Tauri selected (`[Jarvis] Bun server spawned` log with entry path).

2. **Fix spawn contract:**  
   - When `Jarvis.exe` lives on OneDrive Desktop, resolve `index.js` + `prompts/` **same directory** first (document in `jarvis-runtime-ops`).  
   - Failed spawn → **actionable toast** (“Bun server failed: …” + Restart), not silent chat failure.

3. **Supervisor:**  
   - Manual restart clears give-up (`system.rs` reset) — verify UI wires Restart.  
   - Optional: `-RestartServer` in deploy script as standard ops step.

4. **Deploy alignment (P0-A):** exe + index.js + prompts from **one** `build-and-deploy` run.

### Acceptance

- Cold start: within 30s, `/health` OK without manual `bun`.  
- Failed start surfaces in Health banner with retry.

---

## P2-F — Permissive sandbox + path outside workspace

### Symptoms

- `sandbox_mode: permissive` still allowed read of Windows path outside configured `jarvis_path`.

### Root cause (documented, not bug)

- `fs-scope.ts` / `jarvis-runtime-ops`: **`permissive` ≠ path bypass**; only `sandbox_mode: "off"` disables `safePath`.  
- Default `jarvis_path` may be Linux-shaped; Windows native paths resolve relative to wrong workspace.

### Plan

1. **Config:** set `jarvis_path` to `C:\Projects\home-base-recovered` (or intended repo) if reads should work there; or `off` only with user consent.

2. **UX:** when sandbox blocks, SSE/tool_result should surface exact `Path "…" is outside the workspace` (not generic 400).

3. **Optional product:** `permissive` could mean “allow any path on host” — **separate ADR**; today code intentionally differs.

### Acceptance

- User understands mode table; read probe succeeds with `off` or in-workspace path.

---

## P2-G — Companion overlaps Send

### Symptoms

- `App.tsx` companion: `fixed bottom-6 right-6 z-50`.  
- `JarvisView` Send: `absolute right-2 bottom-2` in composer (bottom of chat column).  
- Global companion sits atop chat chrome on Jarvis view.

### Plan

1. **Layout:** hide companion on `jarvis` / chat view, or offset companion when `currentView === 'jarvis'` (e.g. `bottom-24`).  
2. **Or:** move companion to left side / reduce `z-index` below composer `z-10` only if click-target remains accessible.  
3. **Test:** manual + narrow viewport.

### Acceptance

- Send button fully clickable on Jarvis chat without dismissing companion.

---

## P2-H — Deploy provenance gap

### Plan

- Extend deploy script to write manifest (P0-A).  
- `BuildBadge` / System Health: show `index.js` drift vs embedded exe build SHA.  
- CI gate: `scripts/verify.sh` optional check that `dist/index.js` rebuilt when `server-jarvis/src/**` changes.

---

## Recommended execution sequence (implementation phase)

```text
1. P0-A  Deploy triplet (script + verify sanitizer string + prompts)
2. P0-B  Abort-domain split + UI error/empty-bubble handling + tests
3. P1-D  Negation in turn-requirements (quick, high safety value)
4. P1-C  Classifier JSON/tool-payload + provider 400 / executor churn
5. P1-E  Spawn path + supervisor surfacing (with P0-A layout)
6. P2-G  Companion offset
7. P2-F  Config/docs (jarvis_path / sandbox expectations)
8. P2-H  Manifest + drift UI
```

---

## Dependencies & risks

| Risk | Mitigation |
|------|------------|
| Fixing P0-B on stale bundle only | **P0-A first** |
| Over-tight classifier breaks real edit requests | Keep mutation precedence tests; negation only strips signal when negation phrase present |
| OpenCode 400 fix touches shared normalizeMessages | Stage behind config flag; bun tests for each provider shape |
| OneDrive sync delays deploy | Deploy with exe closed; verify manifest mtime |

---

## References (repo)

- `scripts/build-and-deploy.ps1` — canonical deploy stages  
- `server-jarvis/src/index.ts` — `streamAbort`, `callModel`, first-token timer  
- `server-jarvis/src/openrouter.ts` — `chatCompletionWithFallback` attempt abort  
- `server-jarvis/src/orchestration/turn-requirements.ts` — classifier  
- `src-ui/src/components/jarvis/JarvisView.tsx` — SSE `finalizeAssistantMessage`  
- `docs/superpowers/plans/2026-07-02-synthesizer-sanitizer-chat-regression-fable-handoff.md` — sanitizer context  
- Hermes skill: `jarvis-runtime-ops` — sandbox + deploy + orchestrator diagnosis  

---

*End of plan — implementation explicitly out of scope for this document.*