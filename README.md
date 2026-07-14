<div align="center">

# Daedalus · Jarvis

**A desktop app for local-first AI agents.**  
Native speed · Your own models · Full control

[![License](https://img.shields.io/badge/license-MIT-green)](src-tauri/LICENSE)
[![Version](https://img.shields.io/badge/version-3.0.0-blue)](package.json)
[![Tests](https://img.shields.io/badge/tests-925%20bun%20|%2085%20cargo-success)](scripts/verify.sh)
[![Platform](https://img.shields.io/badge/platform-Windows%20|%20Linux%20|%20macOS-lightgrey)]()

</div>

---

## What is this?

**Jarvis** is a standalone desktop app that runs AI agents locally on your computer. Everything stays on your machine — your chats, your data, your models.

Think of it as a personal AI workstation. You can talk to it, ask it to read your files, run code, browse the web, or schedule recurring tasks — all without sending your data to a third-party cloud service.

> **Daedalus** is the name of this GitHub repository. **Jarvis** is the app it builds. They're the same project.

---

## Who is this for?

- **Power users** who want a capable local AI assistant that respects their privacy
- **Developers** who want to build on top of a modular AI agent platform
- **Anyone tired of half-baked cloud AI apps** that can't access your files or run your tools

---

## What can it do?

| What you see | What it means for you |
|:---|---|
| **Smart chat** | Have real conversations. Jarvis can break down complex requests, use multiple AI models, and fall back to a different one if the first is too slow. |
| **Read & write your files** | Ask it to find a file, summarize a document, or edit code — it works with your actual filesystem. |
| **Run code and commands** | It can execute shell commands, run scripts, and show you results right in the chat. |
| **Browse the web** | Search the internet or pull content from web pages when you ask. |
| **Remembers what matters** | Jarvis keeps conversations in a local database, learns from past turns, and gets better over time without sharing your data. |
| **Recurring tasks (cron)** | Schedule it to run jobs on a timer — daily reports, health checks, automated maintenance. |
| **Connect external tools** | Plug in additional capabilities via a standard tool interface. |
| **Your choice of AI models** | Use local models (via Ollama), cloud APIs (OpenRouter), or Claude CLI — switch any time. |

---

## Quick look under the hood (the 30-second version)

```
You type a message
        │
        ▼
   React UI ──────► Bun server (the brain)
                         │
                    ┌────┴────┐
                    ▼         ▼
               Local AI    Cloud AI
               (Ollama)    (OpenRouter)
```

- **React UI** — The chat window you see and click.
- **Bun server** — The engine room. Handles your requests, runs the AI, manages tools, and decides which model to call.
- **Rust/Tauri shell** — The native wrapper. Manages windows, file system access, database storage, and keeps the server alive.
- **SQLite database** — Everything (conversations, settings, agent profiles) is stored locally in a small database file.

For the full technical architecture (module layers, data flow, and component boundaries), see the [Technical architecture](#technical-architecture) section below.

---

## What's been happening lately

| Recent milestone | What it means |
|:---|---|
| **Self-improving AI** | Jarvis tracks how well each AI model performs and automatically adjusts timeouts, model choices, and budgets — no manual tuning needed. |
| **Won't repeat itself** | A repetition guard detects when the AI starts giving the same answer twice and redirects it to try something more useful. |
| **Better research** | When you ask it to "analyze this repo" or "read through these files," it now makes sure it actually reads enough content before answering. |
| **Parallel reads** | Reading multiple files at once is much faster — they're fetched concurrently instead of one at a time. |
| **Smarter pipelines** | The orchestrator can pause mid-request, check what it's learned so far, and adjust its plan before continuing. |
| **Graceful failures** | If the AI stalls on first-token generation (slow model), it now falls back to a faster model instead of leaving you with a blank bubble. |
| **Multi-provider fallback** | OpenCode Zen and Go are available as backup providers if your primary model is down or slow. |

A detailed changelog with commit SHAs and test counts: [`PRIORITIES.md`](PRIORITIES.md).

---

## Quick start (for developers)

```bash
git clone https://github.com/ethanjones1132-lab/Daedalus.git
cd Daedalus

cd server-jarvis && bun install && cd ..
cd src-ui && bun install && cd ..

# Terminal 1 — Bun server
cd server-jarvis && bun run dev

# Terminal 2 — UI
cd src-ui && bun run dev

# Terminal 3 — Tauri app
cd src-tauri && cargo tauri dev
```

The API lives at **http://127.0.0.1:19877** (`/health`, `/chat/stream`).

### What you need installed

| Tool | For | Version |
|------|-----|---------|
| [Rust](https://rustup.rs/) | Building the native shell | 1.85+ |
| [Bun](https://bun.sh/) | Running the server and UI | 1.2+ |
| (Optional) [Ollama](https://ollama.com/) | Running AI models locally | — |
| (Optional) API keys | OpenRouter, OpenCode for cloud models | — |

---

## Build & release

### Windows — one-shot build + deploy

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-and-deploy.ps1
powershell -ExecutionPolicy Bypass -File scripts\build-and-deploy.ps1 -RestartServer
```

This builds the full stack (Bun server → React UI → Rust exe) and copies everything to your Desktop as `Jarvis.exe` + `index.js` + `prompts/`.

### Standalone installer

```bash
cd src-tauri && cargo tauri build
# → NSIS installer in target/release/bundle/nsis/
```

### Linux / WSL

```bash
bash build-wsl.sh
```

---

## Configuration

Settings live in a config file (auto-created):

- **Windows:** `%USERPROFILE%\.openclaw\jarvis\config.json`
- **Linux/macOS:** `~/.openclaw/jarvis/config.json`

| Setting | What it controls |
|---------|-----------------|
| `active_backend` | Which AI backend to use: `ollama` (local), `openrouter` (cloud), or `claude_cli` |
| `openrouter.model` | Which cloud model to use (and API keys for fallback providers) |
| `orchestrator.enabled` | Turn on/off the multi-step planning pipeline |
| `jarvis_path` | Which folder the AI is allowed to read/write |
| `tools.sandbox_mode` | How strict the tool permission policy is (`strict` / `permissive` / `off`) |

### Where data is stored

| Data | Location |
|------|----------|
| Conversations, agents, skills | `%LOCALAPPDATA%\com.jarvis.desktop\jarvis.db` |
| Performance telemetry | `~/.openclaw/jarvis/self-tuning.db` |

---

## Verify it works

```bash
bash scripts/verify.sh              # Quick check
bash scripts/verify.sh --test       # Including Rust tests
bash scripts/verify.sh --build      # Full build + test
```

Or individually:

```bash
cargo check --manifest-path src-tauri/Cargo.toml       # Rust
cd server-jarvis && bunx tsc --noEmit && bun test      # Server
cd src-ui && bunx tsc -b                                # UI
```

---

## Repository layout

```
Daedalus/
├── src-tauri/           # Rust/Tauri — native shell, database, supervisor
├── server-jarvis/       # Bun — AI server, tools, orchestrator, prompts
├── src-ui/              # React — the UI you see and interact with
├── scripts/             # Build, deploy, and recovery utilities
├── docs/                # Plans, architecture decisions, incident reports
├── workspace/           # Action registry and cross-project tooling
├── agents/              # Example agent profiles (soul.md)
├── CONTEXT.md           # Vocabulary guide — read before editing code
├── AGENTS.md            # Rules for AI coding agents
├── PRIORITIES.md        # Complete changelog and roadmap
└── HANDOFF.md           # Deep architecture reference
```

---

## Technical architecture

For those who want the full picture:

```
┌──────────────────────────────────────────────────────────────────────┐
│  React UI (src-ui/) — Vite + TypeScript                              │
│  Jarvis chat: fetch → http://127.0.0.1:19877/chat/stream             │
│  Other views: Tauri IPC → SQLite / native Rust commands              │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────────┐
│  Tauri / Rust (src-tauri/)                                             │
│  Sessions, agents, cron, skills, supervisor, SQLite DB                │
│  Spawns Bun server (index.js); bootstrap_services on background thread│
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
```

| Layer | Path | What it does |
|-------|------|-------------|
| **Native shell** | `src-tauri/` | Windows/macOS/Linux window, file access, database, process supervision |
| **AI server** | `server-jarvis/` | HTTP API, real-time chat, tool execution, orchestration, self-tuning |
| **User interface** | `src-ui/` | Chat panel, health dashboard, settings, agent management |
| **AI prompts** | `server-jarvis/src/prompts/` | Instructions that shape how the orchestrator behaves |
| **Optional proxy** | `scripts/claude_cli_proxy.py` | Bridge for using Claude CLI as an inference backend |
| **Action registry** | `workspace/action-registry/` | Cross-project task tracking (Python) |

**How a chat message flows:**
1. You type a message in the chat panel
2. The Rust shell sends it to the Bun server
3. The orchestrator analyzes your request and picks a strategy (direct answer, read files, run tools, or a complex multi-step plan)
4. The server calls the appropriate AI model(s) — local or cloud
5. Results stream back in real time
6. The conversation is saved to the local SQLite database

---

## License

MIT — see the Rust crate [`Cargo.toml`](src-tauri/Cargo.toml).

---

<div align="center">

**Daedalus / Jarvis** — Built with Rust, Bun, and TypeScript

[GitHub](https://github.com/ethanjones1132-lab/Daedalus) · [Issues](https://github.com/ethanjones1132-lab/Daedalus/issues)

</div>
