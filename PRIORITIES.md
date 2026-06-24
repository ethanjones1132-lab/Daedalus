# Jarvis / home-base — Priority Roadmap

Last updated: 2026-06-23 (Phase 2 complete — all items done, TypeScript typecheck regression fixed)
Working copy: `C:\Projects\home-base-recovered`

Quick status: **Phase 1 done · Phase 2 done · Phase 3 done (items already implemented)**

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
| **P3** | Frontier scaffolding | Pre-built agent templates, skill templates, and project scaffolding for new capabilities | ✅ Done (2026-06-23) |
| **P3** | Eval harness expansion | Beyond regression: benchmark suites, A/B inference comparison, cost tracking | ⬜ Not started |

---

## Remaining count

| Tier | Done | Remaining |
|------|------|-----------|
| Phase 2 P0 | 3 | **0** |
| Phase 2 P1 | 2 | **0** |
| Phase 2 P2 | 2 | **0** |
| Phase 3 | 3 | **0** |
| Platform P1 | 2 | **0** |
| Platform P2 | 4 | **0** |
| Platform P3 | 1 | **1** |

---

## Suggested next target

All tracked phases are complete. The remaining P3 item is **Eval harness expansion** — benchmark suites, A/B inference comparison, cost tracking.

Near-term hardening opportunities:
- **TypeScript typecheck hygiene**: a scope bug (`let`-in-try invisible to catch) was fixed 2026-06-23 in `index.ts`. Run `bunx tsc --noEmit` after any significant edit to catch similar regressions early.
- **`cargo tauri build --debug`**: Phase 2 completion criteria include a working debug binary; this has not been formally verified in CI — wire it to the eval gate.
- **Eval harness breadth**: current scenarios cover routing and tool execution; add multi-turn conversation, fallback-chain, and memory-recall scenarios.

---

## Phase completion criteria

Each phase is done when:
- All P0 and P1 items for the phase are ✅ Done
- `cargo test --lib` passes
- `bunx tsc --noEmit` passes in server-jarvis/
- `bunx tsc -b` passes in src-ui/
- `cargo tauri build --debug` produces a working binary
