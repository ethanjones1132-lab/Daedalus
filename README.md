# Jarvis (home-base)

**Version 3.0.0** · Standalone **Tauri** desktop platform for local-first AI agents.

Jarvis is its own runtime: native **Rust/Tauri** shell, **Bun** HTTP server, **React** UI, SQLite-backed sessions and agents, a canonical **Tool runtime**, multi-stage **orchestrator** (coordinator + agent pool), cron, skills, channels, MCP exposure, and a companion sprite — with **no dependency** on an external agent framework (OpenClaw/Hermes are optional bridges, not the core).

This repository (`home-base-recovered`) is the **working source of truth** for the Jarvis desktop app, rebuilt and extended after a 2026-06 WSL disk loss. The tree is **production-capable**: Rust, Bun server, and UI typecheck; hundreds of Bun tests and Cargo tests pass on `master` (see [Verify](#verify)).

---

## What Jarvis does

| Area | Capability |
|------|------------|
| **Chat** | SSE streaming from the Bun server; orchestrator pipelines (planner, executor, reviewer, synthesizer, conductor replan); fallback across OpenRouter / OpenCode Zen / OpenCode Go / Ollama / Claude CLI |
| **Tools** | Filesystem, shell, web, meta, task, and MCP-client bundles through one **Tool runtime** and permission policy |
| **Agents** | Portable **Agent directories** (`soul.md` + projection); lifecycle discover → validate → activate |
| **Memory & skills** | Native skills store; distilled skill candidates with judge-gated promotion |
| **Cron** | Scheduled agent runs with non-interactive sandbox defaults |
| **Health** | Supervisor for Bun/Ollama/proxy; inference metrics and conductor cache on `/health/inference` |
| **Desktop UX** | Control center, system health, agents, channels, skills, companion, build provenance badge |

Terminology is defined in [`CONTEXT.md`](CONTEXT.md). Use those terms in code, docs, and issues.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  React UI (src-ui/) — Vite + TypeScript                         │
│  Jarvis chat: fetch → http://127.0.0.1:19877/chat/stream (SSE)  │
│  Other views: Tauri IPC → SQLite / native commands              │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│  Tauri / Rust (src-tauri/)                                      │
│  Sessions, agents, cron, skills, channels, supervisor, DB       │
│  Spawns Bun server (index.js beside exe or resources/)          │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│  Bun server (server-jarvis/) — JARVIS_API :19877                  │
│  Tool runtime · orchestrator · streaming · MCP · eval harness     │
│  Prompts loaded from disk: server-jarvis/src/prompts/ (bundled)  │
└───────────────────────────┬─────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   Ollama (local)    OpenRouter / OpenCode    Claude CLI
                    (cloud / routed APIs)
```

| Layer | Path | Role |
|-------|------|------|
| **Native surface** | `src-tauri/` | SQLite, IPC, process supervisor, WSL/native Bun spawn, build provenance |
| **Bun server** | `server-jarvis/` | HTTP API, SSE chat, Tool runtime, orchestrator, config hot-reload |
| **UI** | `src-ui/` | Jarvis views, health banner, streaming chat (`JarvisView.tsx`) |
| **Prompts** | `server-jarvis/src/prompts/` | Coordinator, stage modes, conductor — **not** inlined into `index.js` |
| **Proxy (optional)** | `scripts/claude_cli_proxy.py` | Anthropic-compatible shim (~port 19878) when using Claude CLI backend |
| **Action registry** | `workspace/action-registry/` | Cross-project action items (Python workspace) |

**Chat path (authoritative for the desktop chat tab):**  
`JarvisView` → `POST /chat/stream` on the Bun server → orchestrator (if enabled) → inference backend → SSE frames (`stream_event`, `orchestrator_stage`, tools, `result`).  
Persistence: user/assistant messages via Tauri `append_message` to SQLite.

**Inference backends** (per config `active_backend`): `ollama`, `openrouter`, `claude_cli`, plus routed providers (`opencode_zen`, `opencode_go`) inside the orchestrator fallback cascade.

---

## Prerequisites

| Tool | Used for |
|------|----------|
| [Rust](https://rustup.rs/) + Cargo | `src-tauri/` |
| [Bun](https://bun.sh/) | `server-jarvis/`, `src-ui/` scripts |
| Node deps | `bun install` in `server-jarvis/` and `src-ui/` |

**Windows:** Native builds use `cargo tauri build` (NSIS installer). The supervisor can spawn **native** `bun.exe` + bundled `index.js`, or fall back to WSL in dev setups.

**Optional:** Ollama, API keys for OpenRouter/OpenCode, Python 3 for `claude_cli_proxy` and action-registry.

---

## Quick start (development)

```bash
# Clone
git clone https://github.com/ethanjones1132-lab/home-base-recovered.git
cd home-base-recovered

# Dependencies
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

Config file (server reads with short TTL cache):

- **Windows:** `%USERPROFILE%\.openclaw\jarvis\config.json`
- **Linux/macOS:** `~/.openclaw/jarvis/config.json`

SQLite (native app data):

- **Windows:** `%LOCALAPPDATA%\com.jarvis.desktop\jarvis.db`

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

Use `-SkipDeploy` to build only.

### Tauri installer

```bash
cd src-tauri
cargo tauri build   # NSIS: target/release/bundle/nsis/Jarvis_*_x64-setup.exe
```

`tauri.conf.json` bundles `server-jarvis/dist/index.js` and `prompts/**` as resources.

### Linux / WSL helper

```bash
bash build-wsl.sh
```

---

## Verify

Fast cross-subsystem check:

```bash
bash scripts/verify.sh
bash scripts/verify.sh --test          # include cargo test
bash scripts/verify.sh --build         # also build server dist + UI
```

Individual checks:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cd server-jarvis && bunx tsc --noEmit && bun test
cd src-ui && bunx tsc -b
```

Eval regression gate (server):

```bash
cd server-jarvis && bun run test:gate
```

---

## Configuration highlights

| Key | Purpose |
|-----|---------|
| `active_backend` | Primary inference backend |
| `openrouter.model` / API keys | Cloud models and fallbacks |
| `orchestrator.enabled` | Multi-stage coordinator pipelines |
| `jarvis_path` | Workspace root for filesystem sandbox |
| `tools.sandbox_mode` | `strict` \| `permissive` \| `off` — see note below |
| `tools.enabled` | Master switch for tool execution |

**Sandbox:** `permissive` relaxes dangerous-tool approval; **path sandboxing** still applies unless `sandbox_mode` is `off`. Set `jarvis_path` to your repo root on Windows if reads should target that tree.

---

## Repository layout

```
home-base-recovered/
├── src-tauri/           # Rust/Tauri backend, supervisor, SQLite
├── server-jarvis/       # Bun server, orchestrator, tool runtime, prompts
├── src-ui/              # React UI
├── scripts/             # verify.sh, build-and-deploy.ps1, recovery utilities
├── docs/                # ADRs, plans, audits, superpowers handoffs
├── workspace/           # action-registry and overnight handoffs
├── agents/              # Example agent directories (soul.md)
├── CONTEXT.md           # Canonical vocabulary
├── AGENTS.md            # Rules for coding agents
├── PRIORITIES.md        # Living roadmap and shipped changelog
├── RECOVERY_STATUS.md   # Recovery history and verification log
└── HANDOFF.md           # Deeper architecture reference
```

---

## Documentation map

| Doc | Audience |
|-----|----------|
| [`CONTEXT.md`](CONTEXT.md) | Everyone — terms and phase boundaries |
| [`AGENTS.md`](AGENTS.md) | Autonomous coding agents |
| [`PRIORITIES.md`](PRIORITIES.md) | What shipped recently; P0–P3 backlog |
| [`RECOVERY_STATUS.md`](RECOVERY_STATUS.md) | Recovery provenance and command-verified state |
| [`HANDOFF.md`](HANDOFF.md) | Component-level architecture |
| [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md) | Long-range platform plan |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | Feature handoffs and implementation plans |

**Live runtime ops:** After changing server code, rebuild and deploy **`index.js` + `prompts/`** together; stale Desktop bundles are a common source of “fixes don’t apply” incidents. See [`docs/superpowers/plans/2026-07-02-jarvis-live-issues-priority-plan.md`](docs/superpowers/plans/2026-07-02-jarvis-live-issues-priority-plan.md).

---

## Platform status (summary)

As of **2026-07** on `master`:

- **Phase 1–3** platform milestones (tool runtime, eval harness, MCP exposure) are **done** per `PRIORITIES.md`.
- **Orchestrator v2** (coordinator, agent pool, route normalization, conductor replan, persistent conductor KV) is **live**.
- **Organism loop v1** (judge-gated skill promotion, conductor injection) shipped with tests.
- Recent hardening: synthesizer **VisibleAnswerStreamSanitizer**, empty-completion cascade, turn-requirements classifier, inference observability.

For exact test counts and commit-level history, read **`PRIORITIES.md`** (updated each maintenance pass).

---

## Contributing & agent workflow

1. Read **`CONTEXT.md`** and **`AGENTS.md`** before editing.
2. Preserve the split: Rust = persistence/IPC, Bun = inference/tools/streaming, UI = presentation.
3. Verify with **`scripts/verify.sh`** or targeted `bun test` / `cargo test`.
4. Do not commit secrets; config lives under `~/.openclaw/jarvis/`.

---

## License & origin

Private application codebase (`jarvis-desktop` / `com.jarvis.desktop`). Recovered and maintained as **home-base-recovered** on GitHub.

**Remote:** `https://github.com/ethanjones1132-lab/home-base-recovered.git`