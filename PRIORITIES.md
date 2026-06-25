# Jarvis / home-base — Priority Roadmap

Last updated: 2026-06-24 (Evening pass — debug-binary freshness now wired into `verify.sh`; Phase 2 completion criterion met)
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

---

## Phase completion criteria

Each phase is done when:
- All P0 and P1 items for the phase are ✅ Done
- `cargo test --lib` passes
- `bunx tsc --noEmit` passes in server-jarvis/
- `bunx tsc -b` passes in src-ui/
- `cargo tauri build --debug` produces a working binary
  - **Now gated**: `scripts/verify.sh` checks `src-tauri/target/debug/home-base.exe` exists and isn't older than any file under `src-tauri/src/`, `src-tauri/Cargo.toml`, or `src-tauri/tauri.conf.json`. Pass `--build-tauri` to force a from-scratch rebuild (`cargo tauri build --debug --no-bundle`).
