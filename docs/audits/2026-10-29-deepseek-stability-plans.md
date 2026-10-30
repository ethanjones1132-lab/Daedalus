I'll start by reading the research reports.

# Twelve implementation plans — Jarvis stability work

**Evidence basis and limits.** Everything below comes only from the five read-only research reports in `C:/Users/ethan/.agent-router/jarvis-stability-research/` (source + test reading; no runtime execution, no logs, no DB, no user data). Nothing here is a claim about the *current* binary: the observations came from an older build, and every plan starts with a read-only confirmation step rather than assuming the defect is still present. No plan authorises touching real Cron jobs, real approvals, real memory rows, real skills/candidate files, credentials, tokens, or privacy policy. Where a report does not cover an observation (items 1 and 2), the root cause is labelled **HYPOTHESIS** and the plan is diagnosis-first.

Commands are the standard runners implied by the referenced test files (`bunx vitest` in `src-ui`, `bun test` in `server-jarvis`, `cargo test` in `src-tauri`, `pytest` in `workspace/action-registry`). Confirm script names in each manifest before running; do not treat a command name as verified.

---

## 1. Local selection vs cloud stage routing, and honest live attribution

**Evidence.** `src-ui/src/features/sessions/useSessionTurn.ts:2967-2973` builds `displayedProvider`/`displayedModel` from `runMetrics.provider|model`, falling back to props from `backendLabels(config)`. `runMetrics` come from the terminal SSE frame (`useSessionTurn.ts:2147-2155`, reading `actual_provider`/`actual_model`). The server publishes one route per turn from the *last* stage: `server-jarvis/src/index.ts:4881-4888` (`actualInferenceRouteTelemetry({provider: orchLastProvider, model: orchLastModel})`), with `actualProviderUsed` initialised to `"llama_cpp"` (`index.ts:2929`) and published at `:3588-3591`. The label vocabulary is not closed: `src-ui/src/domain/chat-state.ts:457-474` (`INFERENCE_PROVIDER_LABELS`) has no `llama_cpp`, so a llama.cpp turn renders raw `llama_cpp`. Separately `server-jarvis/src/inference-metrics.ts:33,50-66` omits `llama_cpp` from the `Backend` union and the switch, so `backendForProvider(..., "llama_cpp")` returns `"openrouter"`; call sites `index.ts:4919,4948,4979,5019`.

**Root cause (verified in source).** A turn's *route* is represented as a single `(provider, model)` pair derived from the last published stage. There is no per-stage record, and the shared provider vocabulary is incomplete, so a turn that uses different backends across stages can only present one of them. Whether the older build actually mixed local selection with cloud execution for a given turn is **not proven** by these reports — that part is a **HYPOTHESIS** supported by the single-slot telemetry shape.

**Safe diagnosis (read-only).**
1. Grep the emitted fields: `rg "actual_provider|actual_model|actualProviderUsed|orchLastProvider" server-jarvis/src src-ui/src`.
2. With `active_backend = llama_cpp`, run one dev turn and compare: header before the turn, header after the turn, composer `via …`, inspector `Route`, and `GET /health/inference` bucket. Expect the raw-`llama_cpp` header, a labelled pre-turn header, and the metrics row mis-bucketed under OpenRouter. No config or data changes; use the disposable dev profile.
3. To test the multi-stage hypothesis, use a stub that emits two stage routes in one turn and observe which one the terminal frame carries. Do not point this at a live paid key.

**Change steps.**
- Add `llama_cpp` to `INFERENCE_PROVIDER_LABELS` and `Backend`/`backendForProvider` with a label `llama.cpp`. Missing provider must never silently become Ollama or OpenRouter.
- Make the terminal frame additive and stage-aware: keep `actual_provider`/`actual_model` for compatibility, add an optional ordered `routes: [{provider, model, stage, backend}]`. Do not remove the old fields.
- UI: when `routes` has more than one entry, render the route chain and explicitly label the single-value fallback as "final stage only". When `routes` is absent, say "reported route (single stage)" rather than implying full attribution.
- Attribution source must be explicit: `server-reported` vs `configured`. Never blend them into one unlabelled chip.

**Tests.**
- `cd src-ui && bunx vitest run src/domain/chat-state.test.ts -t "formatInferenceRoute"`
- new `src-ui/src/domain/route-attribution.test.ts` — single stage, multi-stage, absent field, unknown provider.
- `cd server-jarvis && bun test src/inference-metrics.test.ts -t "backendForProvider"` (add a `llama_cpp` case).
- `cd server-jarvis && bun test src/index.telemetry.test.ts` (or the nearest existing SSE-frame test) for the additive frame shape.

**Acceptance.** No hardcoded backend name can appear as the model identity; a `llama_cpp` turn is labelled `llama.cpp` everywhere and bucketed as `llama_cpp` in `/health/inference`; a multi-stage turn displays all stages or explicitly states "final stage only"; unknown provider never claims Ollama/OpenRouter. Runtime: derivation is pure and adds **0 ms** to turn latency; frame payload growth bounded to ≤ 8 route entries; UI re-render ≤ 16 ms.

**Depends on** 10 (shared vocabulary/formatter). **Must land before** 2 if the frame contract is extended.

---

## 2. Trivial response stays streaming, then shows partial

**Evidence.** No report covers this observation directly. Adjacent verified facts: the streaming path is direct-fetch SSE (`useSessionTurn.ts:1221-1223`, `streamFromJarvisApi` at `:1543+`); listener wiring at `:1088-1093` attaches **no `.catch()`** (report 4, gap B7.5); terminal-frame handling at `:2147-2155`; server terminal publish at `index.ts:4881-4888`.

**Root cause — HYPOTHESIS (explicitly unproven).** Two candidates, both consistent with "streaming persists then partial":
- **H1 — missing settle on close:** the message is only finalised when a terminal frame arrives. If the stream closes without one (abort, fence loss, unmount race, or a trivial response that emits no content deltas), the UI keeps the streaming state and the persisted text stays partial.
- **H2 — emptier response, no transition:** a trivial response may produce no content delta, so a state machine that transitions on delta observation never sees completion and relies on a timeout that either fires late or never.

**Safe diagnosis (read-only).** Locate the stream state machine and the terminal/finalise transition; enumerate every path that ends a stream (done frame, error frame, transport close, abort, unmount) and check whether each clears the streaming flag and records an explicit completeness marker. Reproduce against a local stub that (a) sends a done frame with zero deltas, (b) closes without a done frame, (c) sends one delta then closes. Use a disposable Session; do not inspect or mutate any real transcript.

**Change steps (conditional).**
- Every terminal path must settle the stream state exactly once, within a bounded window, and must record `complete | incomplete | aborted` rather than leaving `streaming` true.
- A stream that closes without a terminal frame must be marked **incomplete** and rendered as such. Do **not** fabricate completion, and do **not** rewrite stored content.
- Add an idle watchdog (suggested 45 s to first token, 90 s between tokens) that marks the turn incomplete and stops the spinner — a watchdog must never mark a turn complete.
- Fix the un-caught `listen()` rejections so a refused subscription cannot masquerade as an in-flight stream.

**No-change option.** If diagnosis shows the state machine already settles on close and the observed symptom was an older build, close the item with the new regression tests only.

**Tests.**
- new `src-ui/src/features/sessions/stream-settle.test.ts`: zero-delta done frame; close-without-done; delta-then-close; abort mid-stream; each asserts spinner cleared and completeness label correct.
- `cd src-ui && bunx vitest run src/features/sessions/SessionsPage.state.test.tsx`
- `cd server-jarvis && bun test src/index.stream.test.ts` (zero-delta terminal frame).

**Acceptance.** No turn displays "streaming" more than **1 s** after transport close; every turn is labelled complete/incomplete/aborted; a partial answer is never presented as complete; stored content is never rewritten by the client. Runtime: watchdog cost is a single timer per turn; settle work ≤ 5 ms.

**Depends on** 1 only if the frame gains stage metadata.

---

## 3. Contradictory health verdict and bridge requirement

**Evidence.** Masthead verdict is computed from `jarvis_check_status` only, and never consults the bridge: `src-ui/src/features/health/health-derivation.ts:43-57` (and `:91-92` for `Ready`/`All systems ready`), called at `HealthPage.tsx:100-104`, which additionally hard-codes `fetchError = null` so a retained stale snapshot still reads "Ready". Footer verdict: `src-ui/src/domain/system-telemetry-state.ts:412-425` — `bridge === 'down'` ⇒ `stopped`, unconditionally. Requirement: `:253-258` `ALWAYS_REQUIRED = { bun: 'required', bridge: 'required', ollama: 'unknown', proxy: 'unknown' }`, projected at `:276-287`. Label: `SubsystemGauges.tsx:66-70` renders `Required by the active Inference backend` for the bridge row (`:36-37`). Probe mismatch: `src-tauri/src/commands/system.rs:408` hard-codes `is_port_listening(19876)` while `src-tauri/src/jarvis/runner.rs:1993-1994` uses `config.bridge_port`. `JarvisConfig.bridge_enabled` (`src-tauri/src/jarvis/types.rs:72-73`, default `true` at `:114-115`, edited at `ConfigPanels.tsx:369`) is read by **no** health path.

**Root cause (verified).** Three separate readiness computations with different inputs: the masthead ignores the bridge entirely; the footer treats the bridge as unconditionally mandatory; the gauge claims the requirement is backend-derived when it is a hard-coded constant. Secondary defects: two disagreeing bridge ports, and an operator-facing `bridge_enabled` switch that no health surface honours.

**Safe diagnosis.** Construct the contradictory input without touching the machine: render the Health page and footer against a fixture with `bun` up, `bridge.running = false`, memory/disk unmeasured. Confirm `All systems ready` and `SYS STOPPED` coexist. Then set `bridge_port` to a non-default value and compare `get_system_health` against `jarvis_check_status`.

**Change steps.**
- Make one readiness projection the authority for both masthead and footer (keep derivation in TS over native booleans — do not duplicate verdict logic in Rust).
- Thread `bridge_port` from config into `get_system_health`; both probes use the configured port. Their disagreement becomes impossible by construction.
- Make the bridge requirement explicit and truthful: `required` when `bridge_enabled` and the active backend needs it, `disabled` (not a fault) when `bridge_enabled = false`, with its own fixed copy. Rename the gauge label to match the actual predicate — if the requirement is unconditional, say "required for turn transport", not "required by the active Inference backend".
- Stop hard-coding `fetchError = null` in the masthead: a stale snapshot must read "Ready (last observed …, may be stale)".

**Tests.**
- `cd src-ui && bunx vitest run src/domain/system-telemetry-state.test.ts -t "always-required"`
- new `src-ui/src/features/health/HealthPage.verdict.test.tsx`: bridge down ⇒ masthead not "All systems ready"; stale snapshot ⇒ stale label.
- `cd src-tauri && cargo test restart_bridge_stops_then_rebinds_the_listener`
- new Rust test: non-default `bridge_port` gives agreeing probes.

**Acceptance.** Masthead and footer cannot disagree about the bridge for the same observation; requirement text matches the predicate; `bridge_port ≠ 19876` yields agreement; `bridge_enabled = false` renders "disabled", not "stopped"; a stale read is never labelled plain "Ready". Runtime: one health read per 30 s poll; probe timeout ≤ 2 s; no added polling.

**Depends on** 4 (shared reason vocabulary and the "unknown ≠ pressure" rule). Land 4's decoder first.

---

## 4. Resource/telemetry unknown reported as high or zero

**Evidence.** Correct decoder exists: `src-ui/src/lib/memory-reading.ts:25,72-94` — a zeroed record (`total_mb: 0`) is "unprobed", a genuine 0 % with a real total stays measured. It is bypassed in three places: (a) `system-telemetry-state.ts:406-407` — `if (memoryPercent === null || memoryPercent >= 80) reasons.push('memory_pressure')`, same for disk, with phrases `:478-479` (`'memory use is high'`, `'disk use is high'`) printed for every overall state including `stopped` (`:515-525`); (b) `src-ui/src/features/health/ResourceHero.tsx:50-63` — passes raw `used_percent` and `used_mb/total_mb` and `parsePercent('?')` → `0`, into `Dial`/`loadTone`, where `Meter.tsx:81` maps null to `v = 0` and `loadTone(0) === 'ok'` (green); (c) `OverviewPage.tsx:260` renders `? of ?`, and `DiagnosticsPanels.tsx:69-70` renders `0 MB used of 0 MB`. Native sentinels: `src-tauri/src/commands/system.rs:479-515` (zeroed memory on WSL `cat /proc/meminfo` failure), `:454-477` (`"?"` disk).

**Root cause (verified).** The unmeasured sentinel is decoded correctly on the footer and Overview but the *reason construction* treats null as pressure, and the Health resource hero feeds raw sentinel values into a dial that cannot distinguish "0" from "unknown". Two decoders for one record.

**Safe diagnosis.** Render the Health page, Overview, footer and Diagnostics against a fixture with the zeroed memory record and `"?"` disk. Expect green `0%`, `0 / 0 MB`, `? of ?`, and a `Stopped: … memory use is high and disk use is high.` sentence. No real probe needed; use existing fixtures.

**Change steps.**
- `unknown` is not pressure: emit `memory_unmeasured`/`disk_unmeasured` (or nothing) instead of `*_pressure` for null. Reserve `*_pressure` for measured ≥ 80.
- Route `ResourceHero` through the shared memory decoder and a matching disk decoder; `Dial`/`loadTone` must render a distinct "not measured" state, never green-ok and never a numeric zero.
- Replace `? of ?` and `0 MB used of 0 MB` with the one shared sentinel label.
- Keep genuine 0 % as a measured 0 %, including its tone.

**Tests.**
- `cd src-ui && bunx vitest run src/lib/memory-reading.test.ts`
- new cases in `src/domain/system-telemetry-state.test.ts`: `stopped` + zeroed memory/`"?"` disk ⇒ no "high" reason.
- new `HealthPage.gauges.test.tsx` case: zeroed record renders "not measured", not `0%`/green.
- `SystemStatusBar.state.test.tsx` — add the missing `DSK —` assertion.
- unit test for `health-format.parsePercent('?')`.

**Acceptance.** A zeroed record never renders `0%`, `0 / 0 MB`, or green; unknown never appears as "high use"; Overview/Health/footer/Diagnostics agree for the same record; a real 0 % still reads measured. Runtime: pure functions, no extra native reads, one decode per render.

**Depends on** nothing. **Blocks** 3.

---

## 5. Agent discovery unavailable

**Evidence.** Root resolution is raw and one-shot: `server-jarvis/src/index.ts:892-895` returns `cfg.agents_root` unvalidated; the lifecycle service is constructed once at module load (`:899-903`). The safe helpers exist but are dead in production — `config.ts:1355-1361` (`resolveAgentsRoot`), `:1367-1390` (`validateAgentsRootPath`), referenced only by `server-jarvis/src/config-regression.test.ts:39-45`. Rust default is the empty string (`src-tauri/src/jarvis/types.rs:79,121`); `set_setting` writes SQLite only (`src-tauri/src/commands/settings.rs:77-94`) while the `config.json` projection happens only in `persist_jarvis_config_conn` (`:391-392`), and the Advanced panel saves `agents_root` via `set_setting` (`AdvancedPanel.tsx:24-30,77-103`). Failure surface: missing dir ⇒ HTTP 200 `[]` (`agent-lifecycle.ts:191-194`); unreadable dir/`soul.md` ⇒ exception ⇒ 500 with the raw Node message (`:196-201`, `index.ts:6781-6785`). The UI flattens all of it to fixed copy (`useAgentLifecycle.ts:33-49`, `lifecycle-stations.ts:92-101`, `AgentsPage.tsx:171-175`), deliberately: `AgentsPage.lifecycle.test.tsx:65-87` asserts no cause leakage. `/agents` never returns the resolved root (`agent-routes.ts:22-26`, `:99-108`), though `LifecycleRunResult.agents_root` exists (`agent-lifecycle.ts:40-53`).

**Root cause (verified, multi-part).** (a) Root is used raw, so an empty `agents_root` silently scans `""` and looks like an empty root; (b) the settings write path never reaches the Bun-readable config and the Bun service never re-reads after construction; (c) a missing root and an empty root look identical, and every non-2xx/network failure looks identical to the user. Per the report, the observed "DISCOVER failed" requires a non-2xx/network failure — most parsimoniously a Bun outage during the audited run (**inference**, not proven).

**Safe diagnosis.** Compare, read-only: the value returned by `get_config`/settings read, the effective `config.json` field, and whether `GET /agents` answers at all. A missing directory alone would show the empty-state copy, not the failure banner — that distinction alone separates "misconfiguration" from "Bun down". Do not display or log the path outside the local UI.

**Change steps.**
- Call `resolveAgentsRoot` in `index.ts` and return a typed `root_state: ok | missing | unreadable | unconfigured | empty_string`.
- Extend `/agents` with `root_state` and a **sanitized** reason code. Do not leak raw exception text; the existing no-leak test stays green. Expose the resolved path only on explicit operator action ("Show resolved path"), never in the failure copy.
- Make `agents_root` either project to `config.json` on save or report "restart required" — silently saving to SQLite is the defect.
- Re-resolve the root per request (or expose an explicit reload) instead of freezing it at module load.
- UI: map the four states to four fixed messages, each with its own next step and Retry. Keep previously discovered agents visible and marked stale on failure (`agent-discovery-state.ts:27-35` already retains the snapshot).
- Optional: expose a native `validate_agents_root` so the Advanced field can pre-validate. Read-only.

**Tests.**
- `cd server-jarvis && bun test src/agent-lifecycle.test.ts` (add: unreadable root ⇒ typed `unreadable`; empty-string root ⇒ `unconfigured`, never a silent scan of `""`).
- `cd server-jarvis && bun test src/config-regression.test.ts` (dead helper becomes live — assert it is called).
- add a `agent-routes.test.ts` case for `root_state` and no cause leakage.
- `cd src-ui && bunx vitest run src/features/agents/AgentsPage.lifecycle.test.tsx` plus new per-state message cases.
- new test: `set_setting('agents_root')` either projects or signals restart.

**Acceptance.** Four distinct states with distinct copy; no raw exception text and no path in failure copy; empty `agents_root` never scans `""`; changing the root either takes effect or says a restart is required; a discovery failure never clears previously discovered agents. Runtime: root resolution ≤ 50 ms; scan bounded (≤ 5 s for ≤ 500 directories); UI fetch timeout 5 s; no new polling.

**Depends on** 6's shared Bun-origin helper (both are Bun-availability failures).

---

## 6. Alert delivery and Discord telemetry unavailable

**Evidence.** Banner: `src-ui/src/domain/registry-alert-channel.ts:28-35` (headline + three fixed reasons `boot-read`, `registry-events`, `missed-cron-events`), projection `:87-109` (unavailable if any channel failed), reducer `:69-85`. Sources: `useAppSignals.ts:40-48` (`track` maps rejection to failed), `:60-67` (boot read), `:69-78` (registry subscription), `:80-92` (missed-cron subscription). Crucially `:45` marks a channel `live` when `listen()` **resolves**, not when an event arrives. Banner component `ActionRegistryAlertBanner.tsx:19-45`, mounted at `Shell.tsx:126`. Discord telemetry: `ChannelsPage.tsx:227-240` (Bun fetch, fixed `Delivery telemetry unavailable`), copy `:603-609`, state `channel-receipt-state.ts:26-72`, route `index.ts:6457-6459`, store `channels/discord.ts:33-105`; native channel rows load by `invoke('list_channels')` (`ChannelsPage.tsx:242-277`), which is why rows survive a Bun outage. ACL facts: no `src-tauri/capabilities` directory; `src-tauri/gen/schemas/capabilities.json` is `{}`; `build.rs:44` is a plain `tauri_build::build()`; no `app.security.capabilities` in `tauri.conf.json`; `listen()` is `invoke('plugin:event|listen', …)`. **HYPOTHESIS:** with no capability declared, `core:event:default` is not granted, so `plugin:event|listen` rejects while app commands succeed — matching "lists load, banner says two channels failed". This must be confirmed against the packaged build, not assumed. Also verified: `read_alerts` never errors (`action_registry.rs:175-186`), so the `boot-read` reason is nearly unreachable.

**Root cause (split).** Two independent causes: (i) delivery is *event-only* with no fallback, so a refused/blocked subscription produces a "cannot reach you" banner even though the same data is readable by app command — plus a false `live` signal from subscription success; (ii) Discord telemetry is a Bun-HTTP read with no reason discrimination, but is correctly isolated from native rows.

**Safe diagnosis.** In a dev build, capture the rejection from `plugin:event|listen` (message only, no payload). Inspect the *packaged* build's effective ACL manifest read-only. If app-command reads return data while subscriptions reject, the ACL hypothesis holds.

**Change steps.**
- **Recommended (no ACL expansion):** make delivery not depend on events. Poll the existing read commands — `get_action_registry_alerts` on an interval, `list_pending_missed_jobs` once at mount and on Cron navigation — and treat events as an accelerator when available. This fixes delivery without widening capability surface and without inventing a new IPC path.
- If the ACL route is chosen instead, grant only `core:event:default` and nothing else, document it, and add a test that the packaged manifest contains exactly that grant. This is a security change and needs explicit sign-off.
- Rename the channel state: `subscribed` is not `live`. `live` requires a successful read or a received event, with a last-success timestamp.
- Banner copy must distinguish "no delivery path" (true failure) from "events unavailable, periodic reads working" (degraded, quiet).
- Discord telemetry: add a reason code (`bun_unreachable | http_<status> | malformed`) with fixed copy; never imply delivery failed and never mark the channel disconnected. Tokens stay server-side (`index.ts:130-134`); no UI change touches them.

**Tests.**
- new `src-ui/src/shell/useAppSignals.fallback.test.tsx`: rejecting `listen` + working reads ⇒ no "cannot reach you" banner, delivery still occurs.
- `cd src-ui && bunx vitest run src/domain/registry-alert-channel.test.ts`
- `cd src-ui && bunx vitest run src/features/channels/ChannelsPage.receipts.test.tsx`
- `cd server-jarvis && bun test src/channels/discord.test.ts`
- if ACL chosen: a packaging test asserting the manifest grant set.

**Acceptance.** Banner appears only when no delivery path exists; a refused subscription with a working poll never claims alerts cannot reach the user; `live` is never asserted from subscription alone; Discord telemetry failure never marks a channel disconnected and never claims undelivered; no token reaches the UI. Runtime: poll ≥ 30 s; one read per poll; payload bounded to the current alerts.

**Depends on** 7 (what counts as an active alert) and 8 (truth of the missed-pending list). **Shares** 5's Bun-origin helper.

---

## 7. Stale approval alert versus an approved action

**Evidence.** The alert is generated only at sync time by `workspace/action-registry/src/action_registry/notifications.py:31-62` (emitted when `approval_required` and status not `approved`/`waived`; `created_at` is generation time, line 32), regenerated wholesale by `refresh_notifications` (`:117-128`) from `sync.py:84-86`. Read side: `src-tauri/src/commands/action_registry.rs:74-91` (schema; Python's `bucket` field is dropped), `:175-186` (`read_alerts` returns `vec![]` for missing/unreadable — never an error), `:349-354`. Refresh after approval: `:440-441` `let _ = sync_action_registry(app, db);` — result discarded. Toast: `useAppSignals.ts:50-58`, persistent because `Toast.tsx:18,56` makes warn/error/action toasts persistent, and it carries no age. Ledger: `AlertLedger.tsx:92` prints raw `created_at`; `formatIsoAge` exists (`design/Misc.tsx:147-152`) but is unused here; the `stale` badge means "read loading/error", not age. Authoritative state: `ActionCard.tsx:73-90` and summary `action_registry.rs:308-318`. Data-level confirmation in the report: the notifications file predates the approval by ~15 h and was never regenerated.

**Root cause (verified).** Alerts are a persisted projection regenerated only by a full sync, read independently from the authoritative buckets, with no reconciliation, no age, and a best-effort refresh whose failure is discarded. `python3` availability is a silent dependency (`action_registry.rs:360-364`).

**Safe diagnosis.** Read `notifications.json` and `active.json` side by side (read-only) and confirm an alert whose `action_id` is already `approved`. Confirm `update_action_approval` succeeded while the file did not change. Do not re-approve or waive anything to test.

**Change steps.**
- Reconcile at read time in Rust: `get_action_registry_alerts` loads the buckets and annotates each alert with `superseded: true` when its `action_id` is no longer pending (approved, waived, absent from active/blocked, or done). Do not delete rows and do not rewrite `notifications.json`.
- The toast considers only non-superseded alerts. The ledger still shows the historical row, labelled `superseded` with a relative age.
- Surface refresh failure: return `refresh_error` from the summary/approval path instead of discarding the sync result, and show it as an alert in the ledger.
- Fail **open** on a bucket read failure: if the bucket cannot be read, do **not** mark alerts superseded — an unreadable bucket must never hide a genuinely pending approval.
- Show age (`formatIsoAge`) in the ledger and a `historical` marker for anything older than a threshold (e.g. 24 h).

**Tests.**
- new Rust test in `action_registry.rs` over a temp fixture dir: approved action ⇒ alert superseded; unreadable bucket ⇒ alert still active; missing file ⇒ empty with an explicit state, not silence.
- `cd workspace/action-registry && pytest tests/test_adapters.py`
- `cd src-ui && bunx vitest run src/features/actions/ActionsPage.state.test.tsx`
- `cd src-ui && bunx vitest run src/shell/useAppSignals.test.tsx` (add: superseded alert is not toasted).

**Acceptance.** An approved action never yields an active alert or toast; the ledger keeps the history and labels it; `pending_approvals` and the active alert set agree for the same read; a failed refresh is visible; a failed bucket read never suppresses an alert. No user data is modified. Runtime: one extra JSON read per call, bounded by bucket size; no Python invocation on the read path; refresh failure ≤ 1 log line.

**Blocks** 6.

---

## 8. Overdue enabled Cron jobs and an empty timeline

**Evidence.** `src-tauri/src/cron_scheduler.rs:2046-2097` — `detect_missed_jobs` selects enabled jobs with `next_run < now`, records them in an in-process `OnceLock<Mutex<HashSet>>` (`:35-39`, getter `:84-89`), emits `cron://missed-jobs`, and **does not advance `next_run`**; it runs once at startup (`:2119`) and the polling loop never re-emits. Pending jobs are skipped by the loop (`:2154-2166`). Overdue is derived in the UI: `CronJobRow.tsx:78,185-186`; `formatWhen` yields `"111d 0h ago"` (`cron-model.ts:198-211`) — that is what "101–111 days overdue" is, not a separate field. Timeline: `CronTimeline.tsx:6,20-35` filters `enabled && next_run && at > now && at <= now + 24h`; empty message `:89-97`; `CronPage.tsx:166` passes `jobs` only, never `pendingMissed`. The existing test encodes the exclusion: `CronTimeline.test.tsx:21,26,30`. Ordering defects: `trigger_missed_job` removes the pending id before proving dispatch and maps an already-claimed occurrence to `Ok(true)` (`cron_scheduler.rs:2231-2250`, `:1750-1755`); `dismiss_missed_job` removes the id before the DB write (`:2198-2224`); `run_cron_job` never clears pending (`commands/cron.rs:587-604`); `disable_cron_job` only sets `enabled = 0` (`:501-521`). Duplicated UI logic in `GoalCronPage.tsx:1607-1634`.

**Root cause (verified).** Two projections of "what happens next": the scheduler knows missed occurrences in memory, the timeline only knows `next_run > now`. A missed job's `next_run` is in the past, so it is filtered out and the empty message is technically true but misleading. Missed state is volatile (memory-only, startup-only).

**Safe diagnosis.** Read-only: compare `list_cron_jobs` (persisted `next_run`) against `list_pending_missed_jobs` for the same moment. The overlap of "N missed pending" and "nothing in 24 h" is the defect signature. **Do not trigger, dismiss, or edit any real job.** All reproduction uses a temp DB fixture.

**Change steps.**
- Pass `pendingMissed` into `CronTimeline` and render a distinct "waiting on a missed run" marker; change the empty copy so it explains enabled jobs blocked on missed occurrences. A silent empty timeline alongside pending missed items is not acceptable.
- Prefer a single native read-only projection — `cron_timeline_projection` returning `{job_id, next_run, state: upcoming | missed_pending | disabled}` — so the UI no longer re-derives occurrences and scheduler/UI share one authority. Keep the persisted column as the sole input; no new table.
- Ordering fixes, one at a time with tests: dismiss removes from pending only after the DB write succeeds (re-insert on failure); trigger reports success only when the run actually appears in the run history; `run_cron_job` clears the pending id for that job on success (it will then show a future `next_run`); `disable_cron_job` clears or annotates pending.
- Do **not** auto-trigger missed jobs. Manual trigger/dismiss stays the product behaviour; the fix is honesty and ordering.
- De-duplicate `GoalCronPage`'s independent missed implementation onto the shared projection.

**Tests.**
- new Rust tests over a temp DB: `detect_missed_jobs` selects only enabled past-due rows; `dismiss` failure keeps pending; `trigger` false when the occurrence was already claimed; `run_cron_job` then pending is cleared.
- `cd src-ui && bunx vitest run src/features/cron/CronTimeline.test.tsx` (add: missed job appears as blocked, not absent).
- `cd src-ui && bunx vitest run src/features/cron/CronPage.operations.test.tsx`
- `cd src-ui && bunx vitest run src/features/cron/CronMissedJobs` (nearest existing file).

**Acceptance.** No screen shows "N missed pending" together with an unexplained "nothing in the next 24 hours"; every enabled job occupies exactly one timeline state; trigger reports success only after a run is recorded; a dismiss failure leaves the job pending; no test triggers a real job; no job row is modified outside explicit operator action. Runtime: startup detection ≤ 1 s for ≤ 500 jobs; projection ≤ 100 ms; no extra polling.

**Blocks** 6. Do not batch with 7 — different writers.

---

## 9. Distilled skill lifecycle unavailable

**Evidence.** Three render sites: `SkillCard.tsx:159-170`, `SkillLearningPage.tsx:1840-1844`, `SkillDetail.tsx:214-218`. The message is also shown **while the read is pending**, because the ternary tests `candidate?.status`, and `SkillsPage.observations.test.tsx:62-78` pins exactly that. The toggle absence is separate: `SkillCard.tsx:139-151` renders `CandidateActions` only when `distilled && candidateId`, and those render nothing unless the status is `candidate`/`staged`; a distilled row with no candidate renders neither actions nor toggle. The observation is a Bun HTTP read with a **hard-coded origin**: `skill-model.ts:8,248-266` (`http://127.0.0.1:19877`) against route `index.ts:6463-6466` and store `skill-store.ts:48-56,154-177`; the server port itself is env-overridable (`index.ts:718`) and native WSL resolution exists (`wsl.rs:180-199`). Native is only a mirror: `skills.rs:621-626,724-731`, with no lifecycle read command (`lib.rs:1931-1938`) and no candidate table. A missing candidates directory returns early and preserves stale rows (`skills.rs:655-657`, pinned by `missing_directory_preserves_existing_distilled_rows`, `:866-874`); corrupt files are skipped silently (`skill-store.ts:165-172`); sync failures are swallowed (`useSkillsController.ts:67-71`).

**Root cause (verified).** Four separable causes: pending conflated with failed; a single hardcoded Bun origin; per-row absence after a successful read rendering as "unavailable"; stale native mirror rows whose candidate files no longer exist, preserved indefinitely by the missing-directory early return.

**Safe diagnosis.** Read-only: check whether `GET /skills/candidates` answers at all; compare the returned candidate ids with the `candidate_id` values in the native `skills` metadata. All-rows-unavailable ⇒ transport/origin; one-row-unavailable ⇒ missing/corrupt file; native rows with no matching candidate ⇒ orphaned mirror.

**Change steps.**
- Split the observation into `pending | failed | absent | known`. Render "checking lifecycle…" for pending; "unavailable" only for a real failure.
- Resolve the Bun origin from the same configuration the rest of the app uses, not a module constant.
- Use the native `metadata.status` mirror as an explicitly labelled fallback when the HTTP read fails: `mirrored; may be stale`. Never use it to authorise Promote/Reject.
- Surface a swallowed sync failure as "mirror may be stale", non-fatal.
- For a distilled row whose `candidate_id` is missing from a **successful** read, show "candidate record not found" with a re-sync action. Do not delete the row, the candidate file, or the skill.

**No-change note.** The absence of the native enable/disable toggle on distilled rows is **correct by design** (`skill-model.ts:156-161`; the resolver reads only the Bun store, `skill-resolver.ts:121`) and must not be "fixed".

**Tests.**
- `cd src-ui && bunx vitest run src/features/skills/SkillsPage.observations.test.tsx` (update the pending case: expect "checking", not "unavailable").
- new cases: absent candidate after a successful read; fallback label on HTTP failure; orphan mirror row.
- `cd src-tauri && cargo test missing_directory_preserves_existing_distilled_rows` and `sync_removes_only_stale_distilled_rows`.
- `cd server-jarvis && bun test src/skill-candidate-routes.test.ts`

**Acceptance.** Pending never reads as unavailable; the four states are distinguishable; a failed read never removes the distilled-row semantics; a stale mirror row explains itself; nothing under the candidates directory is deleted. Runtime: one candidates read per page load plus one retry; timeout 3 s; no per-row requests.

**Depends on** 6's Bun-origin helper if both adopt one resolver.

---

## 10. Gemma/Qwen and active-profile versus actual route identity

**Evidence.** `src-ui/src/features/sessions/outcome.ts:40-60`: `llama_cpp` ⇒ the **literal** `'Gemma 4 · llama.cpp'`; the unknown-backend default is `'Ollama'` (`:49`). Call site `SessionsPage.tsx:299`, passed at `:340-341`. The same surface is correct elsewhere: `Transcript.tsx:16-29` renders `Powered by llama.cpp · <config model>`. The configured default model is a Qwen GGUF (`src-tauri/src/jarvis/types.rs:217-236`, `server-jarvis/src/config.ts:700-702`), `active_backend` default `LlamaCpp` (`types.rs:87`, `config.ts:665`), and the Settings placeholder still says "Gemma" (`ConfigPanels.tsx:258-271,291`). Other hardcoded product labels: `SystemStatusBar.tsx:85`, `SubsystemGauges.tsx:51`, `DiagnosticsPanels.tsx:76`. "ACTIVE PROFILE" is a SQLite lookup, not config: `ModelsPage.tsx:57-62`, hero `ProfileViews.tsx:43-44,69-80`, uppercased by CSS (`app.css:200-207`); the page never reads `active_backend`. Nothing reconciles the two: `save_jarvis_config` writes settings keys only (`settings.rs:293-320`), `model_profiles` is touched only by `commands/models.rs`, and `set_active_profile_and_reconcile` (`models.rs:203-209`) is only reachable from the Inference Activate action. Profile activation coerces llama.cpp to Ollama: `models.rs:140-158` has no `llama_cpp` arm (`_ => JarvisBackend::Ollama`), and `create_profile` gives llama.cpp profiles an empty `api_base` (`:352-356`). Finally `AgentEditorDialog.tsx:104` hints "The Inference backend model this Agent runs on", contradicting `AGENT_RECORD_SCOPE` (`agent-routing-scope.ts:32-38`).

**Root cause (verified).** Three independent identity authorities (hardcoded UI strings, `config.active_backend`, `model_profiles.is_active`) with no reconciliation, plus a coercion bug that destroys the local backend identity when a profile is activated, plus one contradiction between the Agent editor hint and the documented routing scope.

**Safe diagnosis.** Under the default config, compare the header, the empty-Session `Powered by …` line, the Inference hero, and Settings. The header naming a model that is neither the configured alias nor the running engine is the signature. Do not activate a profile on a live install to test; use a temp DB.

**Change steps.**
- One formatter for backend/model identity, derived from config. Delete every hardcoded "Gemma" string above; name the *engine* (`llama.cpp`), never a model, in service labels.
- Unknown backend must render "unknown backend" — never Ollama.
- Add the `llama_cpp` arm in `models.rs`: set `active_backend = LlamaCpp`, `llama_cpp.model = profile.model`, preserve `api_base`. Never coerce.
- Reconcile explicitly: `is_active` is set only by Activate; the Inference hero shows "Active profile (not used for routing)" plus a separate "Routing backend" chip from config, with a visible disagreement notice. Do not silently rewrite either store.
- Fix `AgentEditorDialog.tsx:104` to agree with `AGENT_RECORD_SCOPE`, and add it to the scope test.

**Tests.**
- new `src-ui/src/features/sessions/outcome.test.ts` (llama.cpp, blank model, unknown backend, null config).
- `cd src-ui && bunx vitest run src/domain/chat-state.test.ts` and `src/domain/agent-routing-scope.test.ts`
- `cd src-tauri && cargo test activating_` (add: llama.cpp profile activation writes `llama_cpp`, not `ollama`).
- `cd server-jarvis && bun test src/inference-metrics.test.ts` (llama.cpp bucket).
- `cd src-ui && bunx vitest run src/features/models/ModelsPage.test.tsx` (hero vs config disagreement).

**Acceptance.** No hardcoded model product name in any UI string; default config names the configured alias and the `llama.cpp` engine consistently in header, transcript, footer, and health; llama.cpp profile activation never produces `active_backend = ollama`; disagreement between active profile and routing backend is visible, not hidden; the Agent hint matches the scope constant. Runtime: no added calls; formatting is pure.

**Blocks** 1. Shares its formatter with 1.

---

## 11. Project Steward prerequisites

**Evidence.** Gating is UI-only: `ProjectStewardView.tsx:262-282` (`sessionEligible`: non-archived, non-empty `project_root`, enabled Agent, plus a usable projection for custom Agents via `:252-260`), `:703-711` (`selectedSession` requires an explicit click; `:620` starts `null`), copy at `:960-977` and `:1133-1142`, disabled inputs at `:1190-1236`, validation at `:892-895`. There is **no native Session precondition**: `goals.rs:1021-1094` takes only objective/criteria/agent/project root; the `goals` table has no `session_id` (`migrations.rs:1366-1377`); binding happens at run time (`:1443-1462`, `goals.rs:1460-1520`, `jarvis_commands.rs:821-856`). The only writer of `sessions.project_root` is `memory_bind_session_workspace` → `scope::bind_session_workspace` (`memory.rs:607-631`, `scope.rs:63-104,108-133`). The legitimate Chat path is behind a **collapsed** `<details>` labelled "Memory and Goal controls" (`MemoryTurnControls.tsx:8-12`); for an existing Session binding is immediate (`useSessionTurn.ts:2435-2456`), but for a New Session it is deferred until the first Send creates the Session (`:2640-2672`). An existing Session's Agent is immutable (`MemoryScopeControls.tsx:186`). There are no tests for any of this.

**Root cause (verified).** The blocker is a UI selector contract, not a native rule. The copy also overclaims ("validated project workspace") when the UI only checks a non-empty persisted string, hides the custom-Agent projection prerequisite, and gives a next step ("bind a workspace, then return") that cannot work for an unsent New Session.

**Safe diagnosis.** Reproduce each of the six predicates against fixtures: no Sessions; all archived; Agent disabled; custom Agent with invalid/stale projection; empty root; eligible-but-unselected. Then verify the Chat round-trip: bind on an existing Session and confirm `list_sessions` reflects the canonical root. Use a scratch Session, not a real one.

**Change steps (UI only).**
- Report the **exact** failing predicate instead of one blob: no Sessions / none non-archived / no enabled Agent / projection not usable / no recorded workspace / none selected.
- Copy: say the workspace is *recorded by the native binder, not revalidated here*; disclose the projection requirement for custom Agents; state that a New Session's binding is saved on first Send.
- Deep-link to Chat with the controls panel **expanded**, and pre-select the single eligible Session when there is exactly one.
- Keep `Create Goal` disabled when criteria are empty (currently a click is needed to see the validation error).
- **No native change:** do not add `session_id` to `goal_create`; do not weaken `normalize_project_root`; do not create Sessions from Steward.

**Tests.** new `src-ui/src/features/workflows/ProjectStewardView.test.tsx` with one case per predicate plus the eligible-but-unselected case, and a `goalMatchesSubmission` unit test. `cd src-ui && bunx vitest run src/features/workflows/ProjectStewardView.test.tsx`.

**Acceptance.** Six distinct states with distinct next steps; no claim that a recorded-but-deleted directory is "validated"; a user following the copy reaches an eligible Session in ≤ 2 actions from Chat; the Steward screen performs zero writes. Runtime: no new invokes; reads once per mount; render ≤ 50 ms.

**Depends on** nothing. Shares the Session-scope chooser with 12.

---

## 12. Low-quality historical memories

**Evidence.** Overview = Memory route's "Overview" tab (`routes.ts:114-122`, `FeatureModes.tsx:13`, `MemoryPage.tsx:243-244`). It lists via `list_recent_memories` (`memory.rs:311-331`) → `engine.rs:131-142` `SELECT … FROM memory ORDER BY status ASC, updated_at DESC` with **no WHERE**; query search uses `memory_recall_preview` → `engine.rs:337-400` filtering only `status='active'` and score > 0.05, with confidence contributing only to scoring (`:1666`). Rows show tier/confidence/content (`MemoryRow.tsx:21,49,51,73`), but `MemoryEntry` carries no `scope_kind`/`project_root`/`authority_kind` (`memory-recall-state.ts:3-29`). Live turn recall is much stricter: `scoped.rs:555-557` (`status='active' AND tier IN ('hot','warm') AND authority_kind IN ('manual','user_statement','verified_observation')`) plus scope (`:559-593`) and expiry/review admission (`:614-643`); **no confidence floor**. Legacy rows default to `legacy_unscoped`/`legacy_unknown` and are excluded (`migrations.rs:824-837`; adoption preserves `legacy_unknown` unless `source == 'manual'`, `scoped.rs:803-809`). Tier aging exists (`engine.rs:2285-2286,2291-2399`) but its only caller `run_post_turn_housekeeping` (`:519`) has **no call site**, and `commit_session_end` states it deliberately runs no old housekeeping (`:2262-2265`). "Memory: no matches" is turn-level `recall_status=empty` (`memory-turn-state.ts:455-516`, `turn.rs:983-989`), not the Overview. Forgetting is Advanced-only and requires Session/scope/id/revision/reason (`ScopedMemoryPage.tsx:367-438,929-945`; `capture.rs:898-938`; `scoped.rs:975-1029`).

**Root cause (verified in part, hypothesis in part).** Verified: the Overview is an unfiltered inspection list that cannot express injectability, and the UI cannot distinguish "no candidates" from "candidates filtered out". Verified: aging is unwired, so old rows stay `hot` indefinitely. Verified: recall has no confidence floor. **HYPOTHESIS:** whether the specific historical low-quality rows are injected depends on their scope/authority/tier, which cannot be determined without reading the DB — so no claim is made either way.

**Safe diagnosis.** Read-only: for each visible row, determine scope/authority/tier via the Advanced scoped view or a read-only native query added as part of the change. Do not adopt, forget, restore, or delete anything during diagnosis. Reproduce "Memory: no matches" with a query that has no candidates versus one whose only candidates are legacy/out-of-scope/cold.

**Change steps.**
- Label the Overview honestly: "All stored memories — not necessarily what will be recalled", with a per-row injectability indicator derived from a **new, read-only** native command returning scope/authority/tier/expiry/review state. Do not add these columns to the turn path; the projection is for display and must call the same predicate as recall.
- Split the turn label: `no candidates matched` versus `filtered out (legacy / out-of-scope / cold / expired)`.
- Confidence: expose `confidence` in the recall result and add an **opt-in** `min_confidence` (default preserves today's behaviour, i.e. no floor). Do not change default recall semantics silently.
- Tier aging: **no change is justified without an explicit product decision.** `commit_session_end` deliberately runs no housekeeping, and re-enabling aging changes recall quality and invalidates historical evidence. If later approved, run it as a bounded, idempotent, tier-only maintenance pass (≤ 2000 rows or 2 s) with an observable audit line, and never as an unguarded call from turn preparation.
- Forgetting stays exactly as-is: Advanced → Scoped controls, explicit Session/scope/id/revision/reason, tombstone + source suppression.

**Protect.** No deletion, no bulk tombstone, no adoption, no mutation of existing memory rows, no privacy-policy change, no change to the confidence or scoring weights by default.

**Tests.**
- new Rust tests in `scoped.rs`: legacy rows excluded; out-of-scope excluded; cold excluded; active in-scope low-confidence **included** at default; included/excluded as configured when a floor is set.
- `cd src-tauri && cargo test` for `engine` tier and recall helpers.
- `cd src-ui && bunx vitest run src/features/memory/MemoryPage.navigation.test.tsx` plus a new label test.
- new test for the injectability projection agreeing with `recall_scoped_memories` for the same fixture.

**Acceptance.** The Overview never implies "this will be recalled"; each row's injectability matches the recall predicate for a chosen Session scope; the turn label distinguishes no-match from filtered-out; default recall output is byte-identical to today without an operator-set floor; nothing is modified or deleted. Runtime: recall latency unchanged (±5 %); the new projection bounded to the visible page (≤ 100 rows, ≤ 100 ms); any future maintenance bounded to 2 s and non-blocking.

**Depends on** 11 for the Session-scope chooser UX only.

---

## Dependencies

| Item | Blocked by | Blocks | Shared surface |
|---|---|---|---|
| 1 | 10 | 2 (if frame extended) | provider vocabulary, label formatter |
| 2 | 1 (conditional) | — | SSE terminal frame |
| 3 | 4 | — | footer verdict reasons |
| 4 | — | 3 | memory/disk decoders |
| 5 | 6 (Bun-origin helper) | — | Bun availability |
| 6 | 7, 8 | 5 (helper) | event vs command transport |
| 7 | — | 6 | alert reconciliation semantics |
| 8 | — | 6 | missed-pending truth |
| 9 | 6 (origin helper) | — | Bun availability |
| 10 | — | 1 | identity formatter, `models.rs` |
| 11 | — | 12 (UX only) | Session scope chooser |
| 12 | 11 (UX only) | — | scoped recall predicate |

**Suggested sequence:** (P0, honesty only, no behaviour change) 4 → 3, 7, 8, 9, 11, 12-labels. (P1) 10 → 1 → 2. (P2, behaviour/security, needs sign-off) 6 fallback-or-ACL, 8 ordering fixes, 12 optional confidence floor. Doing P0 first means the audit's misleading states stop lying before anything risky changes.

## Compact risk section

- **Health (3, 4).** Making the masthead consult the bridge could turn a currently "ready" system into "not ready" on every launch. Mitigation: land 4 first, keep the startup grace, and never let "unknown" become "failed".
- **ACL / events (6).** Granting `core:event:default` widens the IPC surface; the polling fallback is preferred precisely to avoid it. Any ACL change needs explicit approval and a test on the packaged manifest.
- **Alert reconciliation (7).** Marking alerts superseded on an unreadable bucket would hide a genuine approval. The plan requires fail-open; that must be tested.
- **Cron (8).** Reordering trigger/dismiss touches job execution state. A mistake can double-run or silently skip a scheduled prompt. Tests must use a temp DB only; no test may call a real trigger; no auto-trigger on startup is introduced.
- **Identity (1, 10).** The `models.rs` arm change alters persisted config on activation. A wrong mapping flips an operator's backend. Guard with readback and a test that asserts the exact written keys.
- **Skills (9).** Using the native mirror as a fallback risks showing a stale status as current. It must always be labelled mirrored/stale and must never authorise Promote/Reject.
- **Memory (12).** Any default confidence floor or re-enabled aging changes recall quality and destroys historical comparability. Both are opt-in and explicitly out of scope without a product decision; this plan only adds display truth by default.
- **Cross-cutting.** Hardcoded-string removal (10) touches several existing tests that assert "Gemma" copy (`SystemStatusBar.state.test.tsx`, `HealthPage.gauges.test.tsx`, `health-banner-subsystems.test.ts`); expect churn and update assertions to the config-derived value rather than loosening them.
- **Evidence risk.** None of this was runtime-verified. Items 1 and 2 are hypothesis-led; every plan's first step is read-only confirmation against the *current* build, and any item that no longer reproduces should be closed with regression tests rather than "fixed".