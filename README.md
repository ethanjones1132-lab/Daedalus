<div align="center">

# Daedalus · Jarvis

**A standalone Tauri desktop platform for local-first AI agents.**  
Native Rust shell · Bun HTTP server · React UI · SQLite persistence · Multi-stage orchestrator

[![License](https://img.shields.io/badge/license-MIT-green)](src-tauri/LICENSE)
[![Version](https://img.shields.io/badge/version-3.0.0-blue)](package.json)
[![Bun Tests](https://img.shields.io/badge/tests-925%20bun%20|%2085%20cargo-success)](scripts/verify.sh)
[![Platform](https://img.shields.io/badge/platform-Windows%20|%20Linux%20|%20macOS-lightgrey)]()
[![Runtime](https://img.shields.io/badge/runtime-Rust%20|%20Bun%20|%20React-blueviolet)]()

</div>

---

## Overview

**Jarvis** (this repo — **Daedalus** on GitHub) is its own agent runtime: no dependency on OpenClaw, Hermes, or any external framework. It owns its full stack — native window, server, UI, persistence, tool execution, and agent lifecycle — and can optionally bridge to external runtimes when needed.

Built after a 2026-06 WSL disk loss, the tree was **recovered, rebuilt, and extended** into a production-capable platform. Today the entire stack compiles cleanly:  
**925 Bun tests** across 90+ files · **85 Cargo tests** · both `tsc` jobs clean — on every commit.

---

## What Jarvis does

| Area | Capability |
|------|------------|
| **Chat** | SSE streaming via Bun server; orchestrator pipelines (coordinator + planner + executor + reviewer + synthesizer + conductor replan); fallback across OpenRouter, OpenCode Zen/Go, Ollama, Claude CLI |
| **Tool runtime** | Unified execution contract for filesystem, shell, web, meta, task, MCP-client bundles — sandboxed by permission policy |
| **Agents** | Portable agent directories (`soul.md` + runtime projection); lifecycle: discover → validate → activate |
| **Memory & skills** | Native skills store; organism loop with judge-gated skill promotion from trajectory snapshots |
| **Cron** | Scheduled agent runs with non-interactive sandbox; system jobs for inference feedback tuning |
| **Self-tuning** | Inference feedback loop — model routing scores, first-token timeouts, capability adjustments all updated automatically from live telemetry |
| **Repetition guard** | Jaccard trigram similarity + degenerate-stream detection prevents no-progress repeat loops |
| **Conductor replan** | Persistent conductor KV that can pause mid-pipeline, re-invoke with a stage-execution summary, and resume with revised instructions |
| **Orchestrator health** | Supervisor for Bun/Ollama/proxy; inference metrics; stage-level budget tracking; per-model first-token overrides |
| **Desktop UX** | Control center, system health, agents, skills, channels, companion sprite, build provenance badge, ChatPanel component |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  React UI (src-ui/) — Vite + TypeScript                              │
│  Jarvis chat: fetch → http://127.0.0.1:19877/chat/stream (SSE)       │
│  Other views: Tauri IPC → SQLite / native Rust commands              │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────────┐
│  Tauri / Rust (src-tauri/)                                             │
│  Sessions, agents, cron, skills, channels, supervisor, SQLite DB      │
│  Spawns Bun server (index.js beside exe or in resources/)            │
│  bootstrap_services on background thread — no WebView blocking        │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────────┐
│  Bun server (server-jarvis/) — JARVIS_API :19877                       │
│  Tool runtime · orchestrator · streaming · MCP · eval harness         │
│  Self-tuning DB · conductor learning · repetition guard               │
│  Prompts loaded from disk: server-jarvis/src/prompts/                  │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
   Ollama (local)      OpenRouter / OpenCode    Claude CLI
                     (cloud / routed APIs)
```

| Layer | Path | Role |
|-------|------|------|
| **Native surface** | `src-tauri/` | SQLite, IPC, process supervisor, WSL/native Bun spawn, build provenance |
| **Bun server** | `server-jarvis/` | HTTP API, SSE chat, Tool runtime, orchestrator, config hot-reload, self-tuning |
| **UI** | `src-ui/` | Jarvis views, health banner, streaming chat (`ChatPanel`), companion sprite |
| **Prompts** | `server-jarvis/src/prompts/` | Coordinator, stage modes, conductor — **not** inlined into `index.js` |
| **Proxy (optional)** | `scripts/claude_cli_proxy.py` | Anthropic-compatible shim (~port 19878) for Claude CLI backend |
| **Action registry** | `workspace/action-registry/` | Cross-project action tracking (Python workspace) |

**Chat path (authoritative for the desktop chat tab):**  
`ChatPanel` → `jarvis_send_message` Tauri command → Bun server `/chat/stream` → orchestrator (coordinator + agent pool) → inference backend → SSE frames (`stream_event`, `orchestrator_stage`, tools, `result`).  
Persistence: messages via Tauri `append_message` to SQLite.

**Inference backends** (per config `active_backend`): `ollama`, `openrouter`, `claude_cli`, plus routed fallback providers (`opencode_zen`, `opencode_go`) inside the orchestrator cascade.

---

## Platform status

As of **2026-07-13** on `master`:

| Milestone | Status | Details |
|-----------|--------|---------|
| **Phase 1–3** (tool runtime, eval harness, MCP) | ✅ Done | Per `PRIORITIES.md` |
| **Orchestrator v2** | ✅ Live | Coordinator, agent pool, route normalization, conductor replan, persistent conductor KV |
| **Organism loop v1** | ✅ Live | Judge-gated skill promotion, trajectory-backed distillation, conductor injection |
| **Self-tuning** | ✅ Live | Inference feedback loop, stage-specific routing deltas, per-model first-token overrides |
| **Repetition guard** | ✅ Live | Cross-turn Jaccard similarity + degenerate-stream detection on `master` |
| **Evidence sufficiency** | ✅ Live | Depth-scaled deep-read minimums (3+ content reads), pre-flight listing/anchor |
| **Parallel tool dispatch** | ✅ Live | Read-only tool batches dispatched concurrently |
| **Fail-fast no-progress memo** | ✅ Live | <1s short-circuit for near-identical retries |
| **5-front performance work** | ✅ Done | Runtime latency, classifier short-circuit, inference feedback, boot reliability, evidence grounding |
| **A-01 → A-05 Track A** | ✅ Done | VisibleAnswerStreamSanitizer, structured pipeline state, inference observability |
| **B-01 → B-04 Track B** | ✅ Done | Conductor replan, structured stage output, per-session replan cap with telemetry |
| **C-01 Track C** | ✅ Done | Trajectory snapshot distillation, organism loop |
| **D-01 Track D** | ✅ Done | GRPO-ready JSONL export, composite reward model |
| **OpenCode Zen/Go fallbacks** | ✅ Done | Provider credentials, pool availability filtering, per-provider timeouts |

For exact test counts and commit-level history, see [`PRIORITIES.md`](PRIORITIES.md).

---

## Prerequisites

| Tool | Used for | Min version |
|------|----------|-------------|
| [Rust](https://rustup.rs/) + Cargo | `src-tauri/` | 1.85.0 |
| [Bun](https://bun.sh/) | `server-jarvis/`, `src-ui/`, build scripts | 1.2+ |
| Node deps | `bun install` in `server-jarvis/` and `src-ui/` | — |

**Windows:** Native builds use `cargo tauri build` (NSIS installer). The supervisor spawns native `bun.exe` + bundled `index.js`; WSL fallback is available for dev setups.

**Optional:** Ollama for local inference, API keys for OpenRouter/OpenCode, Python 3 for `claude_cli_proxy` + action-registry.

---

## Quick start (development)

```bash
# Clone — yes, the GitHub remote is Daedalus
git clone https://github.com/ethanjones1132-lab/Daedalus.git
cd Daedalus

# Install dependencies
cd server-jarvis && bun install && cd ..
cd src-ui && bun install && cd ..

# Terminal 1 — Bun server (hot reload)
cd server-jarvis && bun run dev

# Terminal 2 — UI dev server (Tauri beforeDevCommand also starts this)
cd src-ui && bun run dev

# Terminal 3 — Tauri app (debug)
cd src-tauri && cargo tauri dev
```

Default API: **http://127.0.0.1:19877** (`/health`, `/chat/stream`).

### Config

Config file (server reads with short TTL cache):

- **Windows:** `%USERPROFILE%\.openclaw\jarvis\config.json`
- **Linux/macOS:** `~/.openclaw/jarvis/config.json`

SQLite databases:

| DB | Path | Contents |
|----|------|----------|
| **App data** | `%LOCALAPPDATA%\com.jarvis.desktop\jarvis.db` | Sessions, agents, skills, cron, channels |
| **Self-tuning** | `~/.openclaw/jarvis/self-tuning.db` | Agent runs, stage runs, model attributions, tuning proposals, trajectory snapshots |

---

## Build & release

### Full stack (recommended on Windows)

One-shot build + deploy to OneDrive Desktop (`Jarvis.exe`, `index.js`, `prompts/`):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-and-deploy.ps1
powershell -ExecutionPolicy Bypass -File scripts\build-and-deploy.ps1 -RestartServer
```

Stages:

1. `bun build` → `server-jarvis/dist/index.js`
2. `src-ui` production build → `src-ui/dist` (embedded by Tauri)
3. `cargo build --release` → `src-tauri/target/release/home-base.exe`
4. Copy **exe + index.js + prompts/** to Desktop (prompts are required for orchestrator)
5. Writes `.jarvis-deploy-manifest.json` with git SHA, file hashes, and timestamps

Use `-SkipDeploy` to build only.

### Tauri installer

```bash
cd src-tauri
cargo tauri build   # NSIS: target/release/bundle/nsis/Jarvis_*_x64-setup.exe
```

`tauri.conf.json` bundles `server-jarvis/dist/index.js` and `prompts/**` as resources. The `automate_inference_metrics.py` script is also bundled for self-tuning cron jobs.

### Linux / WSL helper

```bash
bash build-wsl.sh
```

---

## Verify

Fast cross-subsystem check (all gates in one command):

```bash
bash scripts/verify.sh
bash scripts/verify.sh --test          # include cargo test
bash scripts/verify.sh --build         # also build server dist + UI
```

Individual checks:

```bash
cargo check --manifest-path src-tauri/Cargo.toml         # Rust lint
cd server-jarvis && bunx tsc --noEmit && bun test        # Server typecheck + tests
cd src-ui && bunx tsc -b                                  # UI typecheck
```

Eval regression gate (server):

```bash
cd server-jarvis && bun run test:gate
```

---

## Configuration highlights

| Key | Purpose |
|-----|---------|
| `active_backend` | Primary inference backend (`ollama`, `openrouter`, `claude_cli`) |
| `orchestrator.enabled` | Multi-stage coordinator pipelines on/off |
| `orchestrator.max_conductor_replans` | Per-turn replan budget (default 2) |
| `orchestrator.max_conductor_replans_per_session` | Per-session replan cap (default 6) |
| `orchestrator.skill_distillation.auto_promote` | Auto-promote distilled candidates (default: false — judge gated) |
| `openrouter.model` / API keys | Cloud models and fallback providers |
| `JARVIS_FIRST_TOKEN_TIMEOUT_MS` | Per-model first-token stall override |
| `JARVIS_VISIBLE_PROGRESS_TIMEOUT_MS` | Progress watchdog for hidden reasoning (default 180s) |
| `JARVIS_TOTAL_TURN_TIMEOUT_MS` | Absolute turn deadline (default 480s) |
| `jarvis_path` | Workspace root for filesystem sandbox |
| `tools.sandbox_mode` | `strict` \| `permissive` \| `off` |
| `tools.enabled` | Master switch for tool execution |

**Sandbox:** `permissive` relaxes dangerous-tool approval; path sandboxing still applies unless mode is `off`. Set `jarvis_path` to your repo root on Windows for read targeting.

---

## Repository layout

```
Daedalus/
├── src-tauri/              # Rust/Tauri backend, supervisor, SQLite persistence
├── server-jarvis/          # Bun server, orchestrator, tool runtime, self-tuning, prompts
├── src-ui/                 # React UI (Vite + TypeScript)
├── scripts/                # verify.sh, build-and-deploy.ps1, recovery utilities
├── docs/                   # ADRs, plans, audits, superpowers handoffs, outcome reports
├── workspace/              # Action-registry and overnight handoffs
├── agents/                 # Example agent directories (soul.md)
├── CONTEXT.md              # Canonical vocabulary (required reading before editing)
├── AGENTS.md               # Rules for autonomous coding agents
├── PRIORITIES.md           # Living roadmap and shipped changelog (425+ lines of history)
├── RECOVERY_STATUS.md      # Recovery provenance and command-verified state
└── HANDOFF.md              # Deeper architecture reference
```

---

## Documentation map

| Doc | Audience |
|-----|----------|
| [`CONTEXT.md`](CONTEXT.md) | Everyone — canonical terms and phase boundaries |
| [`AGENTS.md`](AGENTS.md) | Autonomous coding agents |
| [`PRIORITIES.md`](PRIORITIES.md) | Full shipped changelog, P0–P3 backlog, platform milestones |
| [`RECOVERY_STATUS.md`](RECOVERY_STATUS.md) | Recovery provenance and command-verified state |
| [`HANDOFF.md`](HANDOFF.md) | Component-level architecture for developers |
| [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md) | Long-range platform plan |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | Feature handoffs, incident forensics, implementation plans |

**Live runtime ops:** After changing server code, rebuild and deploy **`index.js` + `prompts/`** together. A stale Desktop bundle is the most common source of "fixes don't apply" incidents. The deploy script writes a manifest so drift is detectable.

---

## Repo origins

This repository was originally `home-base-recovered` (the 2026-06 WSL disk recovery). It now lives at:

**GitHub:** `https://github.com/ethanjones1132-lab/Daedalus`

The Rust crate is `home-base` (v0.1.0), the Bun server is `server-jarvis` (v3.0.0), and the app surface is branded **Jarvis** (`com.jarvis.desktop`). These names come from different layers of the stack — all point to the same desktop agent platform.

---

## Contributing & agent workflow

1. Read [`CONTEXT.md`](CONTEXT.md) and [`AGENTS.md`](AGENTS.md) before editing anything.
2. Preserve the split: Rust = persistence/IPC, Bun = inference/tools/streaming, UI = presentation.
3. Verify with `bash scripts/verify.sh` or targeted `bun test` / `cargo test`.
4. Do not commit secrets; config lives under `~/.openclaw/jarvis/`.
5. Commit messages follow conventional-commits: `fix|feat|docs|test|chore|perf|refactor`.

---

## License

MIT — see the Rust crate `Cargo.toml` and `LICENSE` files in each subdirectory.

---

## Changelog highlights

| Date | What |
|------|------|
| 2026-07-13 | workspace_read executor first-token ceiling fix; client-side send-while-streaming guard; live-fire benchmark |
| 2026-07-12 | Phases 2–5 of comprehensive performance plan (evidence sufficiency, parallel dispatch, fail-fast memo, telemetry fix, benchmark scenarios) |
| 2026-07-11 | Orchestration runtime reliability plan; `learned-pool-state.ts` contract pin (19 tests) |
| 2026-07-10 | 5-front performance work: runtime latency, classifier short-circuit, inference feedback, boot reliability, repo grounding |
| 2026-07-09 | Session replan cap with telemetry; cron-runtime contract pin; inference feedback system job |
| 2026-07-08 | Verify.sh MSYS path fix; Tool bundle API stabilization closed |
| 2026-07-07 | D-01 trajectory corpus export; Track A UI follow-up; Workspace-affinity eviction pin |
| 2026-07-05 | P0a false-completion/spill/continuation/liveness remediation |
| 2026-07-04 | Per-session replan cap + telemetry; VisibleAnswerStreamSanitizer |
| 2026-07-02 | P0-B first-token timeout fix; Organism loop v1; C-01 distillation hardening |

Full changelog with test counts, commit SHAs, and verification status: [`PRIORITIES.md`](PRIORITIES.md).

---

<div align="center">

**Daedalus / Jarvis** — Built with Rust, Bun, and TypeScript

[GitHub](https://github.com/ethanjones1132-lab/Daedalus) · [Issues](https://github.com/ethanjones1132-lab/Daedalus/issues)

</div>
