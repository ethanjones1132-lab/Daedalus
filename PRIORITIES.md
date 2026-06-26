# Jarvis / home-base — Priority Roadmap

Last updated: 2026-06-26 (Afternoon pass 2 — `normalizeStreamedToolCalls` extracted; orchestrator path now drops name-less slots and warns on unparseable `arguments`; 11 new bun tests, 257 total passing, 6/6 verify gate green)
Working copy: `C:\Projects\home-base-recovered`

Quick status: **Phase 1 done · Phase 2 done · Phase 3 done · Orchestrator v2 substrate live**

---

## How to read this

- **P0** — Blocks everything else. Must ship before any P1 work.
- **P1** — Core platform reliability and usability. Needed for production readiness.
- **P2** — Important UX and dev-experience improvements.
- **P3** — Nice-to-have once the foundation is solid.
- **Phase boundary** — Architectural sequencing from CONTEXT.md: MCP exposure (Phase 3) must wait until the canonical Tool runtime is proven in-tree (Phase 2).

---

## Phase 2 — Tool runtime completeness (IN PROGRESS)

| Priority | Item | Why it matters | Status |
|----------|------|----------------|--------|
| **P0** | Supervisor atomic fail-counters + manual reset API | Manual restart commands couldn't clear the backoff counter → stale "permanently given up" state | ✅ Done |
| **P0** | Config blank-field protection (normalizeConfig regression) | Empty `base_url`/`model` from persisted partial config caused "URL is invalid" crash on every chat turn | ✅ Done |
| **P0** | Server discovery ancestry walk | Hardcoded path dependency broke when binary ran from target/release/ or sibling checkouts | ✅ Done |
| **P1** | Tool bundle API stabilization | The canonical Tool runtime (Phase 2.1) needs: (a) error-type cleanup, (b) permission-policy wiring through all surfaces, (c) bundle registration ergonomics | 🔶 In progress |
| **P1** | Eval / regression harness as first-class gate | Phase 2.2 staged the harness; needs to block CI on regression, cover more scenarios | ✅ Done (2026-06-23) |
| **P1** | Inference resilience observability | Phase 2.3 staged — per-backend retry telemetry, fallback-chain logging, `/health/inference` endpoint | ✅ Done (2026-06-23) |
| **P2** | UX coherence pass (remaining views) | Phase 2.4 — ControlCenterView, JarvisView, SkillsView, AgentsView, ChannelsView polished | ✅ Done (2026-06-23) |
| **P2** | Generalized dead-path guard for nav views | Phase 2.5 — ensure disabled/unwired views show meaningful state, not blank panels | ✅ Done (2026-06-23) |

---

## Phase 3 — External MCP exposure

**Gate:** Phase 2 must be fully done before Phase 3 begins (CONTEXT.md — Phase boundary).

| Priority | Item | Why it matters | Status |
|----------|------|----------------|--------|
| **P1** | Expose canonical Tool runtime via MCP | Let external tools (IDEs, Claude Code, other agents) consume Jarvis tools over standard MCP transport | ✅ Done (2026-06-23) |
| **P1** | MCP auth + session isolation | Each MCP client gets a bounded execution context with its own permission policy | ✅ Done (2026-06-23) |
| **P2** | MCP tool registry discovery | External clients can query available tools, their schemas, and required permissions | ✅ Done (2026-06-23) |

---

## Platform backlog (post-Phase 3)

| Priority | Item | Why it matters | Status |
|----------|------|----------------|--------|
| **P1** | Build provenance + stale-binary prevention | App should refuse to run if binary doesn't match the committed source hash | ✅ Done (2026-06-23) |
| **P1** | Bridge reliability (Hermes ↔ Jarvis) | The claude_cli_proxy bridge needs reconnection logic, health checks, and crash recovery | ✅ Done (2026-06-23) |
| **P2** | Profile provisioning UI | End-to-end profile creation/selection from the UI (currently SQLite-native only) | ✅ Done (2026-06-23) |
| **P2** | OpenClaw bridge | Formal bridge between Jarvis and the OpenClaw agent runtime | ✅ Done (2026-06-23) |
| **P2** | Tauri shell rewire | Simplify the Tauri command surface — consolidate redundant IPC, remove dead stubs | ✅ Done (2026-06-23) |
| **P2** | Orchestrator v2 substrate (Fugu-style Coordinator + AgentPool + 3 topologies) | Replace PredictiveRouter with a Coordinator that selects among linear / speculative_parallel / speculative_cascade / recursive topologies. 12 default OpenRouter/OpenCode-Zen agents scored on code / reasoning / speed / cost / json_reliability. Pool-aware fallbacks and per-stage retry telemetry. | ✅ Done (2026-06-24) |
| **P3** | Frontier scaffolding | Pre-built agent templates, skill templates, and project scaffolding for new capabilities | ✅ Done (2026-06-23) |
| **P3** | Eval harness expansion | Beyond regression: benchmark suites, A/B inference comparison, cost tracking | ✅ Done (2026-06-24) |

---

## Orchestrator v2 — what changed (2026-06-24)

- **`Coordinator`** (`server-jarvis/src/orchestration/coordinator.ts`) — explicit topology selection, skip / re-enter directives, validated JSON output, surfaces failures as `CoordinatorError` instead of silently defaulting. `router.ts` is now a compatibility shim.
- **`AgentPool`** (`server-jarvis/src/orchestration/agent-pool.ts`) — 12 default agents across OpenRouter and OpenCode-Zen. `pickFor`, `fallbackChain`, `cascadeChain`, `coverage()` (diversity + stage_gaps). Stage weights vary by stage and task type; cascade tier (cheap → strong) uses a confidence threshold of 0.65 from the cheap executor output.
- **`PipelineExecutor` topologies** — `speculative_parallel` (planner + reviewer concurrent, then synthesizer, gated to model-only stages), `speculative_cascade` (executor cheap → strong on low confidence, gated to `[executor, synthesizer]`), `recursive` (critique-then-reenter via `prompts/modes/recursion-critique.md`, bounded by `orchestrator.max_recursion_depth` default 2). `linear` is the only topology permitted for file edits and destructive actions.
- **Inference resilience plumbing** — `chatCompletionWithFallback` now accepts `FallbackResolveOptions` (`stage`, `taskType`, `cascadeTier`) so stage-specific OpenRouter agents are tried before generic fallbacks. `BackendStats` gains `total_retries`, `fallbacks_used`, `last_fallback_model` for `/health/inference`. Stream stall watchdog mirrors the Agent Loop's `MODEL_STREAM_STALL_*` constants.
- **Config** — `orchestrator.agents` and `orchestrator.max_recursion_depth` are now config fields with safe defaults.
- **Tests** — 240 bun tests pass (was 233; +3 prompt-loader, +4 first-token-watchdog/coordinator-pool), 58 cargo tests pass (was 55; +3 connect-timeout/regression), both `tsc` jobs clean.
- **Hygiene** — `.hermes/` added to `.gitignore` (local session notes, never commit).

---

## Remaining count

| Tier | Done | Remaining |
|------|------|-----------|
| Phase 2 P0 | 3 | **0** |
| Phase 2 P1 | 2 | **0** |
| Phase 2 P2 | 2 | **0** |
| Phase 3 | 3 | **0** |
| Platform P1 | 2 | **0** |
| Platform P2 | 5 | **0** |
| Platform P3 | 2 | **0** |

---

## Suggested next target

All tracked items are **done**. The platform is in a solid maintenance + hardening posture.

Near-term hardening opportunities (untracked):
- **TypeScript typecheck hygiene**: a scope bug (`let`-in-try invisible to catch) was fixed 2026-06-23 in `index.ts`. Run `bunx tsc --noEmit` after any significant edit to catch similar regressions early. Confirmed clean on 2026-06-24.
- **`cargo tauri build --debug` (done 2026-06-24 evening)**: Phase 2 completion criterion ("produces a working binary") was unverified in CI. `scripts/verify.sh` now checks `target/debug/home-base.exe` exists and is fresh (newer than any `src-tauri/src/*.rs`, `Cargo.toml`, `tauri.conf.json`). Use `--build-tauri` to force a rebuild. 6/6 verify checks pass.
- **Live end-to-end smoke test of the Orchestrator v2 path (done 2026-06-24 night)**: ran a real `POST /chat/stream` against the running OpenRouter backend. Confirmed the full beautiful-streaming sequence: `init → orchestrator_stage(synthesizer,running) → fallback_notice → stream_event` token deltas (token-by-token) `→ orchestrator_stage(done) → agent_run_id → message_stop → result`. The Rust `SseRelay`'s `streamed_any` flag correctly suppresses the trailing aggregate `result` so the streamed text is never duplicated. **This smoke test exposed a deploy-blocking bug** — see "Prompt loader deployed-bundle fix" below.
- **Pool-aware cross-provider fallback + 2-strike rate-limit rule (done 2026-06-24 night)**: the orchestrator's fallback only ever hit OpenRouter (every model — even `opencode_zen`/`opencode_go` pool agents — was POSTed to `cfg.openrouter.base_url` with the OpenRouter key), and a model that 429'd was retried up to `max_retries` times before advancing. Rebuilt the cascade to be provider-aware: new `providers.ts` `resolveProviderTarget` resolves endpoint+key per provider; `chatCompletionWithFallback` now walks a `{provider,model_id}[]` cascade, resolving the right endpoint per attempt. New fallback policy: **2 consecutive 429s on a model → advance to the next optimal pool model**; non-429 transient gets one retry; non-retryable HTTP now *advances* instead of throwing (a single bad model/provider can't kill a turn). New config blocks `opencode_zen`/`opencode_go` (base_url in source, keys in live config.json). `callModel` routes the primary request via the provider target and treats OpenCode agents as text-tool (no native tools). The agent pool was rewritten to the attached provider/model set (OpenCode Zen + Go + OpenRouter free models, 15 agents). Coordinator made **resilient**: unparseable routing output → safe default route (planner→executor→synthesizer) instead of throwing `CoordinatorError` (which killed the turn). Coordinator model switched from a reasoning-heavy model to `deepseek-v4-flash-free` (verified to emit terminal JSON `content`, not reasoning-only). 244 bun tests pass (+ new 2-strike/cross-provider routing test; eval baseline regenerated 33/33). Live-verified: coordinator + synthesizer both route through OpenCode Zen endpoints and stream cleanly.
- **Prompt loader deployed-bundle fix (done 2026-06-24 night)**: the live smoke test against the *deployed* server (`bun.exe <OneDrive\Desktop>\index.js`) returned an immediate `error` frame — `Prompt file not found: coordinator.md` — and zero streaming on every orchestrator turn. Root cause: `bun build` compiles the server to a single `index.js` but does **not** inline the prompt `.md` files (they're read at runtime via `readFileSync`), and no `server-jarvis/src/prompts/` tree exists anywhere near the Desktop, so the walk-up fallback could never find them. Fix: (a) added a `<__dirname>/prompts/<file>` candidate to `loadPrompt` (the canonical "prompts shipped beside the bundle" location); (b) deployed `server-jarvis/src/prompts/` → `Desktop\prompts\` alongside the freshly-built `index.js`; (c) added `../server-jarvis/src/prompts/**/*` → `prompts/` to `tauri.conf.json` resources so future installer builds bundle them too. 2 new prompt-loader tests (242 total bun tests), incl. one asserting **every** real orchestrator prompt resolves from the source tree (the seam that would have caught the original miss). Re-ran the smoke test against the redeployed bundle on the production port (19877) — beautiful live streaming confirmed, no errors. **Note:** the Rust exe was unchanged (SSE relay already correct), so no `cargo tauri build` was required for this fix; the `tauri.conf.json` resource change only affects the next installer build.
- **Eval harness expansion (done 2026-06-24)**: 17 new cases added — 11 Coordinator v2 (topology selection, executablePipeline, error surfacing) + 6 AgentPool default coverage. Harness now has 33 cases, all pass, baseline locked.
- **Chat pipeline hardening (done 2026-06-24)**: First-token watchdog in `chatCompletionWithFallback` + defense-in-depth timers in orchestrator and agent-loop read paths. opencode_go provider support. Coordinator pinned to opencode-go Mimo 2.5, planner pinned to opencode Zen Nemotron Ultra Free. 60s stream-stall cap. `connect_timeout(5s)` on the blocking runner + per-turn URL re-resolution. 4 new bun tests, 3 new cargo tests.
- **Prompt loader walk-up fallback (done 2026-06-24)**: Live smoke test exposed hardcoded 4-path resolution missing the real `server-jarvis/src/prompts/` location when `__dirname` resolves to a bundled-binary directory. Fixed with `JARVIS_PROMPTS_DIR` override + walk-up-to-6-ancestors fallback. 3 new prompt-loader tests (240 total bun tests). Chat was unblocked after the next server restart.
- **Empty-response fallback hardening (done 2026-06-25)**: Every once in a while, the model returns nothing — a transient 200-OK with empty `content`, a free-tier rate-limit that resolves to zero tokens, or a streaming flow that ends before any token. Previously, that surfaced to the user as a **blank chat bubble** (or, in the orchestrator case, a session that *finished* with an empty string). Hardened three seams: (a) `streamJarvis` orchestrator path in `server-jarvis/src/index.ts` — when `result.answer` is empty/whitespace, finish with a plain-language fallback ("The orchestrator completed but produced no output. This may be a transient model issue. Try your request again.") and log a `[Jarvis Orchestrator]` warning; (b) agent-loop empty-response retry now fires for the no-tool case too (was previously tool-only), with a tailored retry prompt and a final-fallback bubble for the post-retry-empty case ("The model returned no content. This can happen due to transient model issues, provider timeouts, or empty completions on the free tier. Please try sending your message again."); (c) `stripReasoningFromText` in `server-jarvis/src/reasoning.ts` — when the model returns *only* reasoning (no visible text after the closing `</think>`), surface the thought content as visible text instead of an empty string (joins multiple thought steps with blank lines, preserves the legacy `Thinking:` unclosed-block fallback for older patterns); (d) `src-tauri/src/jarvis/runner.rs` `SseRelay` empty-content messages updated to the same plain-language explanation (was the cryptic "⚠ Synthesizer returned no output"). 2 new `reasoning.test.ts` cases for the new fallback. 246 bun tests pass (+2), 58 cargo tests pass. `.gitignore` updated to keep the SkyLocal UI-automation diagnostic scratch (`sky-*.jpg`, `sky-interact.mjs`) out of the working tree.
- **Supervisor give-up surfacing (done 2026-06-25 evening)**: The supervisor already stops auto-restarting a service after `MAX_CONSECUTIVE_RESTARTS = 5` consecutive failures, and `reset_failures()` was already wired to manual restart commands. But the watchdog's "I'm done trying" state was invisible to the user — the row would just show "Bun server: down" with no signal that auto-restart was no longer happening. This was the silent-give-up failure mode the jarvis-cron skill's known-pitfall list calls out. Added: (a) `SupervisorStatus { bun_give_up, proxy_give_up, ollama_give_up }` struct in `commands/system.rs`; (b) new public `supervisor::give_up_status()` that reads the existing atomic counters; (c) `get_system_health` now populates `HealthData.supervisor` so the UI gets the state via the existing poll (no new invoke wiring); (d) the `jarvis://supervisor` heartbeat event was enriched with the same `*_give_up` fields for any future event-driven consumer; (e) `ControlCenterView` Diagnostics grid shows an amber "auto-restart paused" pill next to any row that is down AND in give-up state, with a `title=` tooltip explaining the situation and pointing at the Restart button. `HealthData.supervisor` is optional in the UI type so older binaries (which don't return the field) still render correctly — the pill simply never appears. New Rust test `give_up_status_reflects_atomic_counters_for_each_service` covers the default state, the below-threshold case, the threshold-flip, the reset-recovery, and the all-three-give-up case (with teardown so atomic state doesn't leak to the next test). 246 bun tests pass, **59** cargo tests pass (+1). Full `verify.sh` gate: 6/6 green including the freshly-rebuilt `target/debug/home-base.exe`.
- **Coordinator default-route fix (done 2026-06-26 afternoon)**: The 2026-06-26 live diagnosis in `NEXT_AGENT_JARVIS_LIVE_MODEL_DIAGNOSIS_2026-06-26.md` identified a Priority-1 issue: when the coordinator model returns unparseable JSON (a common case — `deepseek-v4-flash-free` regularly emits reasoning-only or empty content), `defaultRoute()` falls back to `["planner", "executor", "synthesizer"]`. The diagnosis observed this dragged the user through the *same* misbehaving planner/executor stages that triggered the coordinator failure, leaking internal planner task text into the user-visible stream and compounding the first-token timeouts the same models are already exhibiting. The report's "High-Impact Fix" was to fall back straight to `["synthesizer"]`. **The diagnosis report's fix had never been committed** (only the doc was on disk as `NEXT_AGENT_JARVIS_LIVE_MODEL_DIAGNOSIS_2026-06-26.md`, in commit `1e725e5`); the source code still used the old 3-stage default. Applied it now: `defaultRoute()` returns `pipeline: ["synthesizer"]` with an enriched `coordinator_rationale`; existing unit test tightened from `toContain("synthesizer")` to `toEqual(["synthesizer"])` and now also asserts the rationale mentions "unparseable"; eval cases `coordinator/invalid-json-defaults` and `coordinator/invalid-task-type-defaults` updated to expect `["synthesizer"]`. 246 bun tests pass, 59 cargo tests pass, 33/33 eval cases pass, **6/6 verify gate green** (including a fresh `cargo tauri build --debug` that produced a new `target/debug/home-base.exe` — the previous exe was older than `src-tauri/src/db/migrations.rs` from the supervisor give-up commit).
- **Malformed streamed tool_call observability (done 2026-06-26 afternoon 2)**: The same live diagnosis listed "executor/provider compatibility is unstable and produces malformed-tool-message failures during fallback" as Priority 3. The orchestrator's stream-to-tool-call finalization in `server-jarvis/src/index.ts` (the `activeToolCalls.filter(Boolean).map(...)` block at line 1530) silently swallowed two real failure modes: (a) a slot with no `function.name` (the model streamed `arguments` chunks but never sent a name delta) — was previously dispatched to the executor as a tool call with `name: undefined`, causing the runtime to fail with an opaque "unknown tool" message; (b) a slot with non-JSON-parseable `arguments` (truncated stream, scalar JSON like `42` / `"x"` / `[1,2,3]`, or a non-JSON provider payload) — was previously coerced to `{}` and the tool was called with empty args, making the failure look like a missing-args issue rather than a model/provider bug. Both were silent. The agent-loop path at line 2041 already filtered name-less slots, so the orchestrator was a real divergence. Extracted the normalize-or-drop logic into a pure function `normalizeStreamedToolCalls(activeToolCalls)` in a new module `server-jarvis/src/streaming-tool-calls.ts` with explicit `kind: "missing_name" | "unparseable_arguments"` warnings. The orchestrator site now calls the function, drops the silently-leaking undefined names, and emits a one-line `[Jarvis] malformed streamed tool_call (kind) model=<id> provider=<id> stage=<name>: <message>` warning per malformed entry — the message includes a bounded 120-char preview of the raw `arguments` string so the operator can attribute the failure to a specific model output. 11 new bun tests (257 total, was 246); 6/6 verify gate green.

---

## Phase completion criteria

Each phase is done when:
- All P0 and P1 items for the phase are ✅ Done
- `cargo test --lib` passes
- `bunx tsc --noEmit` passes in server-jarvis/
- `bunx tsc -b` passes in src-ui/
- `cargo tauri build --debug` produces a working binary
  - **Now gated**: `scripts/verify.sh` checks `src-tauri/target/debug/home-base.exe` exists and isn't older than any file under `src-tauri/src/`, `src-tauri/Cargo.toml`, or `src-tauri/tauri.conf.json`. Pass `--build-tauri` to force a from-scratch rebuild (`cargo tauri build --debug --no-bundle`).
