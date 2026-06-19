│  │  │  - /health, /status, /config            │  │  │
│  │  │  - /skills, /tools, /models             │  │  │
│  │  │  - Ollama + OpenRouter + Claude CLI     │  │  │
│  │  └─────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────┐  │  │
│  │  │  Ollama (:11434) — qwen3.5-9b:latest    │  │  │
│  │  └─────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────┐  │  │
│  │  │  Claude CLI Proxy (:19878)              │  │  │
│  │  │  - Anthropic /v1/messages → claude CLI  │  │  │
│  │  └─────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Inference Pathways (3 total)
1. **Ollama (default):** Bun server → `http://<windows-host>:11434/v1/chat/completions`
2. **OpenRouter:** Bun server → `https://openrouter.ai/api/v1/chat/completions`
3. **Claude CLI:** Bun server → spawns `claude` subprocess with `--output-format stream-json`

### WSL → Windows Host IP Resolution
The Bun server resolves the Windows host IP via `/proc/net/route` (default gateway), then `/etc/resolv.conf` nameserver, then `ip route show default`, falling back to `172.17.0.1`. This is needed because WSL2 runs in a separate network namespace.

---

## 3. Key Components

### Rust Backend (`src-tauri/src/`)
| File | Purpose |
|------|---------|
| `lib.rs` | Process management (Ollama, Bun server, Claude proxy spawning), WSL path conversion, port checking |
| `commands/jarvis_commands.rs` | Chat commands, model discovery, memory system, direct Ollama fallback |
| `commands/sessions.rs` | SQLite session/message CRUD, compaction |
| `commands/settings.rs` | Config load/save (SQLite-backed), writes `~/.openclaw/jarvis/config.json` |
| `commands/models.rs` | Model profile CRUD, Ollama/OpenRouter discovery |
| `commands/memory.rs` | Memory entry CRUD, search |
| `commands/skills.rs` | Skill management, bundled skill seeding |
| `commands/system.rs` | Health checks, doctor report, logs, approvals, devices, nodes, hooks |
| `commands/cron.rs` | Cron job CRUD, run history |
| `commands/agents.rs` | Agent CRUD, channel binding |
| `commands/channels.rs` | Channel CRUD, login/logout |
| `db/mod.rs` | SQLite connection wrapper |
| `db/migrations.rs` | All table creation (settings, sessions, messages, memory, skills, cron_jobs, cron_runs, agents, channels, model_profiles, companion) |
| `jarvis/types.rs` | All config structs (JarvisConfig, OllamaConfig, OpenRouterConfig, etc.) |
| `wsl.rs` | Windows host IP resolution from WSL |

### Bun Server (`server-jarvis/src/`)
| File | Purpose |
|------|---------|
| `index.ts` | HTTP server, SSE streaming, model discovery, connection testing |
| `config.ts` | Config types, defaults, load/save, validation |
| `ollama.ts` | Ollama health, model listing, pulling, URL resolution |
| `openrouter.ts` | OpenRouter health, model listing |
| `claude-cli.ts` | Claude CLI subprocess spawning, streaming JSON parsing |
| `reasoning.ts` | Chain-of-Thought reasoning parser (`<think>`, `<reasoning>` tags) |
| `tools.ts` | Tool definitions (read_file, write_file, edit_file, bash, glob, grep, etc.) |
| `bridge.ts` | TCP bridge on port 19876 for external agent connections |
| `football.ts` | NFL 2025 player stats database (hardcoded) |
| `prizepicks.ts` | PrizePicks prediction engine, system prompt, context building |

### Frontend (`src-ui/`)
- React + TypeScript + Vite
- Components: JarvisView, HermesChat, MemoryView, SkillsView, CronView, SettingsView, ModelProfilesView, etc.
- Communicates with Rust backend via Tauri IPC (`invoke()`)
- Listens to SSE events: `jarvis://token`, `jarvis://done`, `jarvis://error`, `jarvis://tool_call`

---

## 4. Build & Deploy

### Cross-compile for Windows (from WSL):
```bash
cd src-tauri
cargo build --release --target x86_64-pc-windows-gnu
cp target/x86_64-pc-windows-gnu/release/home-base.exe /mnt/c/Users/ethan/OneDrive/Desktop/Jarvis.exe
```

### Frontend build:
```bash
cd src-ui