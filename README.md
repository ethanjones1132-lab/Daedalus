<div align="center">

# Daedalus · Jarvis

**A standalone desktop platform for local-first AI agents.**  
Native Rust shell · Bun HTTP server · React UI · SQLite persistence · Multi-stage orchestrator

[![License](https://img.shields.io/badge/license-MIT-green)](src-tauri/LICENSE)
[![Version](https://img.shields.io/badge/version-3.0.0-blue)](package.json)
[![Tests](https://img.shields.io/badge/tests-925%20bun%20|%2085%20cargo-success)](scripts/verify.sh)
[![Platform](https://img.shields.io/badge/platform-Windows%20|%20Linux%20|%20macOS-lightgrey)]()

</div>

---

## What is this?

**Jarvis** is a standalone desktop app that runs AI agents entirely on your computer — everything stays local. It's built from the ground up to be its own self-contained AI runtime: it doesn't depend on Hermes, OpenClaw, or any external platform. It owns the full stack — native window, web server, database, tool execution, and agent lifecycle — and can optionally talk to cloud services if you choose.

> **Daedalus** is this GitHub repository. **Jarvis** is the app. Same project, two names. The project recovered from a 2026-06 WSL disk wipe and has since been rebuilt into a production-capable platform.

---

## Who is this for?

- **Power users** who want a capable local AI assistant that respects their privacy
- **Developers** who want to build custom agents or integrate the tool runtime into their own workflows
- **Anyone tired of half-baked cloud AI apps** that can't access your files, run code, or work offline

---

## What can it do?

| What you see | How it works |
|:---|---|
| **AI chat with real reasoning** | Every message goes through an **orchestrator pipeline** — a coordinator decides whether to answer directly or plan multi-step work, a planner breaks the request into stages, executors run each stage with tool access, a reviewer checks quality, and a synthesizer compiles the final response. If the plan goes sideways mid-stream, the **conductor** can pause, re-evaluate, and re-plan — just like a human stepping back to rethink. |
| **Read, write, and search your files** | The tool runtime gives the AI controlled access to your filesystem. It can find files, read them, edit them, and search their contents — all bounded by a permission policy (`strict`, `permissive`, or `off`). |
| **Run code and shell commands** | Jarvis can execute terminal commands, run scripts, and pipe results back into the conversation. Output is streamed in real time so you see progress as it happens. |
| **Browse the web** | Web search and page extraction via the tool runtime — the AI can fetch live information from the internet when you ask. |
| **Recurring tasks (cron)** | Schedule agent runs on a timer — daily health checks, automated reports, periodic maintenance. Cron jobs run in a sandbox with no interactive feedback, and their results get delivered back to you. |
| **Self-improving over time** | The **self-tuning system** tracks how each AI model performs on every type of task — response speed, quality, how often it stalls — and automatically adjusts timeouts, routing preferences, and fallback ordering. The **organism loop** goes further: it captures "trajectories" (snapshots of how a task was solved), has a judge evaluate them, and promotes the good ones into reusable skills. |
| **Won't repeat itself** | A **repetition guard** detects when the AI starts producing the same content turn after turn (using Jaccard trigram similarity + degenerate-stream detection) and redirects it to try something genuinely new. |
| **Thorough analysis** | The **evidence sufficiency system** ensures the AI actually reads enough material before answering — it sets minimum read requirements based on how deep the question goes, and won't skip past them. |
| **Your choice of AI models** | Supports local models via Ollama, cloud models via OpenRouter/OpenCode, or Claude CLI — with automatic fallback if the primary is slow or unavailable. OpenCode Zen and Go are available as backup providers. |
| **Connect external tools (MCP)** | Implements the Model Context Protocol (MCP) — a standard for plugging in external tools and data sources — so you can wire up custom capabilities without changing the core. |
| **Agent lifecycle management** | Portable agent directories (a `soul.md` file with capabilities, constraints, and personality). Jarvis discovers, validates, and activates agents from a local store. |

---

## Architecture — the full picture

Jarvis has three main layers:

```
┌──────────────────────────────────────────────────────────────────────┐
│  React UI (src-ui/) — Vite + TypeScript                              │
│  Chat panel · Health dashboard · Agent manager · Settings             │
│  Chat: fetch → http://127.0.0.1:19877/chat/stream (SSE streaming)     │
│  Other views: Tauri IPC → Rust commands → SQLite                      │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────────┐
│  Tauri / Rust (src-tauri/)                                             │
│  SQLite sessions, agents, cron, skills, channel management            │
│  Process supervisor (monitors Bun, Ollama, proxy)                     │
│  Spawns Bun server from bundled resources; background thread boot     │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────────┐
│  Bun server (server-jarvis/) — HTTP :19877                             │
│  Tool runtime · Orchestrator pipeline · SSE streaming                 │
│  Self-tuning DB · Conductor replan · Repetition guard                  │
│  MCP bridge · Eval harness · Prompts from disk                        │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
   Ollama (local)      OpenRouter / OpenCode    Claude CLI
```

### Layer by layer

| Layer | What it does | What's inside |
|-------|-------------|---------------|
| **React UI** | Everything you see and click. The chat panel (`ChatPanel` component), a health dashboard showing model status and server health, an agent manager, cron overview, settings page, and a companion sprite. | Vite, TypeScript, custom components. Chat is SSE-fetch from the Bun server. All non-chat data goes through Tauri IPC to Rust commands. |
| **Rust / Tauri** | The native shell. Manages the desktop window, file system sandbox, SQLite databases, and process supervision (keeps the Bun server and Ollama alive). Bootstraps everything on a background thread so the window appears instantly. | Tauri 2, SQLite via rusqlite, Tokio async runtime. Modules for sessions, agents, cron jobs, skills, channels, and the supervisor. |
| **Bun server** | The AI engine room. Handles all inference requests, tool execution, streaming, orchestration, self-tuning, and MCP connectivity. Prompts (the instructions that shape how the orchestrator plans and executes) are loaded from disk, not baked into code. | Bun with TypeScript. HTTP API on port 19877. Endpoints: `/health`, `/chat/stream`, tool dispatch, cron trigger, eval harness. |

### How a chat message flows

1. You type a message in the **ChatPanel** UI component
2. It calls `jarvis_send_message` → a Tauri IPC command → the Bun server's `/chat/stream` endpoint
3. The **orchestrator** kicks in — the coordinator assesses your request and decides the strategy:
   - **Direct answer** — one model call, no tools, done
   - **Tool-assisted** — reads files, runs code, then answers
   - **Multi-stage plan** — a coordinator + planner break it into stages, executors run each, a reviewer checks quality, the synthesizer compiles the result
4. Throughout the pipeline, the **conductor** tracks progress. If a stage produces unexpected results, it can pause, inject what it's learned so far, and re-plan with revised instructions
5. Results stream back as SSE events — text, tool results, stage transitions, and errors are all real-time
6. Every message is saved to **SQLite** via the Rust layer (`append_message` IPC command)
7. The **self-tuning system** logs model performance (first-token latency, stage duration, routing path) and periodically proposes adjustments

### Behind the scenes systems

| System | What it does | How it works |
|--------|-------------|--------------|
| **Orchestrator** | Routes every request through the right pipeline | Configurable per `orchestrator.enabled`. Has a coordinator, planner, executor pool, reviewer, and synthesizer. Supports multi-model pipelines with fallback across OpenRouter, OpenCode Zen/Go, Ollama, and Claude CLI. |
| **Conductor** | Mid-pipeline re-planning | A persistent KV database that tracks the execution state. When a stage fails or returns unexpected results, the conductor can pause and re-invoke with a summary of what's happened so far. Per-turn and per-session caps prevent infinite re-plans. |
| **Self-tuning** | Automatic performance optimization | An inference feedback loop that scores each model on speed, stall rate, and completion quality. Periodically updates routing preferences, per-model first-token timeouts, and capability adjustments — all from live telemetry, no manual tuning. |
| **Repetition guard** | Prevents repetitive loops | Computes Jaccard trigram similarity between consecutive turns. If similarity exceeds a threshold or the model is detected in a degenerate stream (no-progress loop), it intervenes with a fresh directive. |
| **Evidence sufficiency** | Ensures thorough research | Sets minimum deep-read requirements (3+ content reads) for analysis-style questions, and enforces them. Pre-flight listing commands (like `ls` or `search_files`) don't count — the model must actually read the content. |
| **Organism loop** | Skill distillation from experience | Captures "trajectory snapshots" of how the AI solved a task. A judge evaluates the quality. Good trajectories are distilled into skills (reusable prompt fragments) that get injected into future orchestrator plans. The system can auto-promote or require manual approval. |
| **Fail-fast memorization** | Short-circuits repeated failures | A no-progress memo cache that recognizes when the AI is attempting nearly-identical retries and short-circuits them in under a second instead of burning tokens. |
| **Parallel dispatch** | Faster multi-tool work | Read-only tool batches (multiple file reads, multiple web searches) are dispatched concurrently instead of serially — tool results arrive in parallel. |

---

## Platform milestones

Every major system shipped in the last two months:

| Area | What shipped | When |
|------|-------------|------|
| **Phase 1–3 core** | Tool runtime, eval harness, MCP protocol support | Complete |
| **Orchestrator v2** | Coordinator, agent pool, route normalization, conductor replan, persistent conductor KV | Live |
| **Organism loop** | Judge-gated skill promotion, trajectory-backed distillation, conductor injection | Live |
| **Self-tuning** | Inference feedback loop, stage-specific routing deltas, per-model first-token overrides | Live |
| **Repetition guard** | Cross-turn Jaccard similarity + degenerate-stream detection | Live |
| **Evidence sufficiency** | Depth-scaled deep-read minimums (3+ content reads), pre-flight listing/anchor | Live |
| **Parallel dispatch** | Read-only tool batches dispatched concurrently | Live |
| **Fail-fast memo** | <1s short-circuit for near-identical retries | Live |
| **5-front performance** | Runtime latency, classifier short-circuit, inference feedback, boot reliability, evidence grounding | Complete |
| **Track A (orchestrator health)** | Visible answer sanitizer, structured pipeline state, inference observability | Complete |
| **Track B (conductor)** | Conductor replan, structured stage output, per-session replan + telemetry | Complete |
| **Track C (distillation)** | Trajectory snapshot distillation, organism loop | Complete |
| **Track D (eval)** | GRPO-ready JSONL export, composite reward model | Complete |
| **OpenCode fallback** | Provider credentials, pool availability filtering, per-provider timeouts | Complete |

Latest (2026-07-13): `workspace_read` executor first-token ceiling fix, client-side send-while-streaming guard, live-fire benchmark. See [`PRIORITIES.md`](PRIORITIES.md) for the full changelog with commit SHAs and test counts.

---

## Quick start (for developers)

```bash
git clone https://github.com/ethanjones1132-lab/Daedalus.git
cd Daedalus

cd server-jarvis && bun install && cd ..
cd src-ui && bun install && cd ..

# Terminal 1 — Bun server (hot-reload)
cd server-jarvis && bun run dev

# Terminal 2 — UI dev server
cd src-ui && bun run dev

# Terminal 3 — Tauri app (debug)
cd src-tauri && cargo tauri dev
```

Default API: **http://127.0.0.1:19877** (`/health`, `/chat/stream`).

### Prerequisites

| Tool | Required for | Minimum version |
|------|-------------|-----------------|
| [Rust](https://rustup.rs/) | Building the native shell | 1.85+ |
| [Bun](https://bun.sh/) | Running the server and building the UI | 1.2+ |
| (Optional) [Ollama](https://ollama.com/) | Running AI models locally | — |
| (Optional) API keys | OpenRouter / OpenCode for cloud models | — |

---

## Build & release

### Windows — full-stack deploy script

Run this from a PowerShell terminal at the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-and-deploy.ps1
powershell -ExecutionPolicy Bypass -File scripts\build-and-deploy.ps1 -RestartServer
```

What it does, in order:

1. **`bun build`** the Bun server → `server-jarvis/dist/index.js` (a single bundled file)
2. **`src-ui` production build** → `src-ui/dist` (embedded by Tauri)
3. **`cargo build --release`** → `src-tauri/target/release/home-base.exe`
4. **Copies** the exe, `index.js`, and `prompts/` folder to your Desktop
5. **Writes** `.jarvis-deploy-manifest.json` — a deployment record with git SHA, file hashes, and timestamps

Use `-SkipDeploy` to build without copying. Add `-RestartServer` to kill and restart any running instance after deploy.

### Standalone installer

```bash
cd src-tauri && cargo tauri build
# → NSIS installer: target/release/bundle/nsis/Jarvis_*_x64-setup.exe
```

The `tauri.conf.json` bundles `server-jarvis/dist/index.js` and the full `prompts/` directory as resources.

### Linux / WSL

```bash
bash build-wsl.sh
```

---

## Configuration

### Config file

Auto-created on first run at:

- **Windows:** `%USERPROFILE%\.openclaw\jarvis\config.json`
- **Linux/macOS:** `~/.openclaw/jarvis/config.json`

| Setting | What it does |
|---------|-------------|
| `active_backend` | Which inference backend to use: `ollama` (local), `openrouter` (cloud), or `claude_cli` |
| `openrouter.model` | Which cloud model to call |
| `openrouter.api_key` | API key for OpenRouter |
| `orchestrator.enabled` | Master switch for the multi-stage orchestrator pipeline |
| `orchestrator.max_conductor_replans` | Max re-plans per turn (default 2) |
| `orchestrator.max_conductor_replans_per_session` | Max re-plans across the whole session (default 6) |
| `orchestrator.skill_distillation.auto_promote` | Auto-promote distilled skill candidates without manual review (default: false — judge-gated) |
| `jarvis_path` | Filesystem sandbox root — restricts what folders the AI can read/write |
| `tools.sandbox_mode` | Tool permission policy: `strict` (approve dangerous tools), `permissive` (relaxed), `off` (no sandbox) |
| `tools.enabled` | Master switch for tool execution |

### Runtime environment variables

| Variable | Default | What it does |
|----------|---------|-------------|
| `JARVIS_FIRST_TOKEN_TIMEOUT_MS` | varies by model | How long to wait for the first token before declaring a stall and falling back |
| `JARVIS_VISIBLE_PROGRESS_TIMEOUT_MS` | 180000 (3 min) | For hidden-reasoning models — if no visible output in this time, watchdog fires |
| `JARVIS_TOTAL_TURN_TIMEOUT_MS` | 480000 (8 min) | Absolute deadline for a single turn |

### SQLite databases

| Database | Path | What it stores |
|----------|------|---------------|
| **App data** | `%LOCALAPPDATA%\com.jarvis.desktop\jarvis.db` | Conversations, agents, cron jobs, skills, channel configs |
| **Self-tuning** | `~/.openclaw/jarvis/self-tuning.db` | Agent run records, stage-level timing, model attributions, tuning proposals, trajectory snapshots |

---

## Verification

The fastest way to check everything is healthy:

```bash
bash scripts/verify.sh              # Quick: Rust lint + UI typecheck + server typecheck
bash scripts/verify.sh --test       # Same + cargo test + bun test
bash scripts/verify.sh --build      # Same + build server dist + UI dist
```

Individual checks:

```bash
# Rust — lint only
cargo check --manifest-path src-tauri/Cargo.toml

# Server — typecheck + unit tests
cd server-jarvis && bunx tsc --noEmit && bun test

# UI — typecheck
cd src-ui && bunx tsc -b
```

Full gate (server):

```bash
cd server-jarvis && bun run test:gate
```

---

## Repository layout

```
Daedalus/
├── src-tauri/               # Rust/Tauri — native shell, SQLite, supervisor
│   ├── src/                 #   commands/, sessions, agents, cron, skills, channels
│   └── Cargo.toml           #   Rust crate: home-base v0.1.0
├── server-jarvis/           # Bun — AI engine, orchestrator, tool runtime
│   ├── src/                 #   prompts/, tool bundles, MCP, self-tuning
│   └── package.json         #   Bun package: server-jarvis v3.0.0
├── src-ui/                  # React — chat, dashboard, agent manager
│   ├── src/                 #   components/, ChatPanel, health views
│   └── package.json         #   Vite + TypeScript
├── scripts/                 # verify.sh, build-and-deploy.ps1, claude_cli_proxy.py
├── docs/                    # Architecture decisions, plans, incident reports
├── workspace/               # Action registry + automated workflow tooling
├── agents/                  # Example agent directories (soul.md profiles)
├── CONTEXT.md               # Required reading — canonical project vocabulary
├── AGENTS.md                # Working rules for autonomous coding agents
├── PRIORITIES.md            # Full changelog and improvement backlog
├── HANDOFF.md               # Deep component-level architecture reference
└── RECOVERY_STATUS.md       # 2026-06 WSL recovery provenance
```

### Documentation map

| Document | Read this if... |
|----------|----------------|
| `CONTEXT.md` | You're new to the project — defines all the phase boundaries and canonical terms |
| `AGENTS.md` | You're an autonomous coding agent about to make changes |
| `PRIORITIES.md` | You want the full shipped changelog with test counts and commit SHAs |
| `HANDOFF.md` | You're diving into component-level implementation details |
| `RECOVERY_STATUS.md` | You want to understand the recovery provenance |
| `docs/MASTER_PLAN.md` | You want the long-range platform roadmap |

---

## Repo origins

This codebase started as `home-base-recovered` after a **2026-06 WSL disk wipe** destroyed the original tree. It was recovered from backup, rebuilt, and extended far beyond where the original was. The GitHub remote is now `Daedalus`.

The Rust crate is `home-base` (v0.1.0), the Bun server is `server-jarvis` (v3.0.0), and the app surface is branded **Jarvis** (`com.jarvis.desktop`). These different names come from different layers of the stack — they all point to the same desktop agent platform.

**Current test health:** 925 Bun tests across 90+ files · 85 Cargo tests · both `tsc` jobs clean.

---

## License

MIT — see the Rust crate [`Cargo.toml`](src-tauri/Cargo.toml).

---

<div align="center">

**Daedalus / Jarvis** — Built with Rust, Bun, and TypeScript

[GitHub](https://github.com/ethanjones1132-lab/Daedalus) · [Issues](https://github.com/ethanjones1132-lab/Daedalus/issues)

</div>
