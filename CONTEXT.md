# Jarvis (home-base)

A standalone Tauri desktop app — its own agents, sessions, skills, hooks, crons, kanban, and companion sprite — with local-first inference and no runtime dependency on any external agent framework.

## Language

**Jarvis**:
This app. The Tauri shell (Rust + TypeScript) plus its supporting Bun server. Owns its own data model and command surface; depends on no external agent runtime.
_Avoid_: "the client", "the desktop app"

**Inference backend**:
The actual LLM provider behind a chat turn. One of: Ollama (local, default), OpenRouter (cloud), or Claude Code CLI (local). Selected per session via `active_backend`.
_Avoid_: "model", "provider" (used for finer concepts elsewhere)

**`claude_cli_proxy`**:
Python shim at `~/.openclaw/jarvis/hermes/claude_cli_proxy.py`, port 19878. Speaks an Anthropic-compatible `/v1/messages` API and routes to whichever inference backend is active. Auto-spawned by Jarvis at app start alongside Ollama.
_Avoid_: "the bridge", "the gateway"

**Bun server**:
Long-running Bun process (`server-jarvis/`) that the Tauri shell spawns at boot. Hosts the `JARVIS_API` HTTP surface (sessions, config, companion, chat streaming) that the `jarvis_send_message` Tauri command proxies to.
_Avoid_: "the gateway", "the API"

**Chat path (today)**:
UI → `ChatPanel` → `jarvis_send_message` Tauri command → Bun server → `claude_cli_proxy` → inference backend. All native, no external agent runtime.

**Native surface**:
The Tauri commands in `src-tauri/src/commands/` that are backed by SQLite (via `db/`) rather than by the Bun server. Sessions, agents, skills, models, channels, cron, agents, system health — all native Rust.

**Session**:
A conversation thread with an `id`, `agent_id`, ordered messages, and archive state. Stored in SQLite (`commands/sessions.rs`).
_Avoid_: "chat", "conversation"

**Session turn**:
One user message plus the assistant response it produces inside a **Session**. The **Native surface** owns turn persistence: load config/history from SQLite, append the user message, stream inference through the **Bun server**, then append the assistant response.
_Avoid_: "chat request", "stream call"

**Agent**:
A configured identity that owns sessions and can be bound to channels. Its canonical definition lives in **`soul.md`**.

**`soul.md`**:
The canonical manifest for an **Agent**'s identity and instructions, not its runtime state.
_Avoid_: "agent prompt", "profile"

**Agent directory**:
The portable filesystem unit for an **Agent**, rooted at `agents/<slug>/` and centered on **`soul.md`**.
_Avoid_: "agent record", "agent folder" when the portable unit matters

**Capability donor**:
An external codebase used as source material for behaviors and ideas that are re-expressed through Jarvis-native concepts.
_Avoid_: "secondary runtime", "upstream architecture"

**Tool runtime**:
The single Jarvis-native contract for defining and executing tools across all entry surfaces.
_Avoid_: "chat-only tool system", "MCP wrapper layer" when speaking about canonical tool execution

**Execution context**:
The invocation-specific state passed into the **Tool runtime**, including surface, permissions, working scope, and interactivity.
_Avoid_: "tool variant", "separate runtime"

**Permission policy**:
The enforceable Jarvis runtime rules that govern tool access, sandboxing, approvals, and non-interactive constraints.
_Avoid_: "agent personality", "prompt preference"

**Agent lifecycle**:
The Jarvis flow that turns an **Agent directory** into a runnable app entity: discover, validate, project, activate.
_Avoid_: "load and hope", "direct execution from file"

**Runtime projection**:
Jarvis-managed operational state derived from an **Agent** definition and used for scheduling, bindings, and execution, with provenance back to the canonical files.
_Avoid_: "the real agent", "source of truth"

**First migration slice**:
The first proof of the new architecture: **Agent lifecycle**, **Tool runtime**, and one end-to-end code/search capability.
_Avoid_: "multi-agent port", "orchestration-first rewrite"

**Search bundle**:
The first migrated capability set in the **Tool runtime**: workspace file search, text search, and file read.
_Avoid_: "full IDE parity", "LSP-first bundle"

**Tool bundle**:
A small module that registers a cohesive group of tools into the canonical **Tool runtime** (filesystem, shell, web, meta, task, mcp-client). Generalizes the original **Search bundle** pattern. Every surface composes the bundles it needs; no surface defines tool implementations inline.
_Avoid_: "tool plugin", "tool category", "tool dispatcher"

**Server-side runtime**:
The Jarvis-owned execution layer where the canonical **Tool runtime** lives, independent of UI and native entry surfaces.
_Avoid_: "UI tool layer", "Tauri-only execution"

**Agents root**:
The Jarvis-managed filesystem root where live **Agent directories** are discovered, outside any single repo checkout by default.
_Avoid_: "workspace agents folder", "repo-owned live state"

**Activation boundary**:
The point at which a validated **Runtime projection** becomes effective for new work without mutating in-flight execution.
_Avoid_: "hot swap", "silent mid-run update"

**Phase boundary**:
An explicit sequencing boundary that keeps the **First migration slice** focused and defers integrations like cron until core proofs pass.
_Avoid_: "scope creep", "parallel first milestones"

**Exposure boundary**:
A sequencing boundary that keeps external interfaces like MCP export behind proven internal runtime behavior.
_Avoid_: "public surface first", "external contract before core proof"

**Done gate**:
The explicit completion bar for a migration phase, requiring functional, safety, and stability criteria before expansion.
_Avoid_: "soft done", "ship and harden later" for core-architecture phases

**Phase 2 order**:
The agreed phase-2 sequence: external MCP exposure of the proven runtime before cron integration.
_Avoid_: "scheduler-first phase 2", "parallel phase 2 tracks" by default

**Adaptation strategy**:
Capability migration prefers transplant-then-adapt when it clearly improves quality and comprehensiveness; otherwise behavior-first reimplementation is used.
_Avoid_: "always transplant", "always rewrite"

**Transplant gate**:
The objective rule for allowing donor-code transplant: proven parity gain, clean Jarvis runtime fit, and lower long-term maintenance cost.
_Avoid_: "gut-feel transplant", "default rewrite"

**Rollout tiers**:
The staged capability sequence after the first slice: core coding loop, intelligence layer, orchestration surfaces, then optional interaction layers.
_Avoid_: "opportunistic migration", "flat backlog"

## Relationships

- A **Session** belongs to one **Agent** and runs against one **Inference backend** at a time.
- A **Session turn** is persisted by the **Native surface** before and after **Bun server** inference streaming.
- The **Chat path** is fully native — no external agent runtime in the loop.
- **`claude_cli_proxy`** is the single point of fan-out to all three **Inference backends**.
- **Jarvis** auto-spawns three child processes at boot: Ollama, `claude_cli_proxy`, Bun server.
- An **Agent** is defined by **`soul.md`** and then loaded into Jarvis for runtime use.
- An **Agent directory** is the portable filesystem home of an **Agent**.
- A **Capability donor** informs Jarvis features without becoming part of Jarvis runtime architecture.
- The **Tool runtime** is shared by chat, cron, agent execution, and external tool access.
- An **Execution context** changes per invocation while the **Tool runtime** stays canonical.
- **Permission policy** is enforced by Jarvis runtime, not by **`soul.md`**.
- The **Agent lifecycle** is discover, validate, project, activate.
- A **Runtime projection** is derived from **`soul.md`** and holds mutable operational state.
- A **Runtime projection** stays lean: derived operational data plus provenance, not a second canonical copy.
- The **First migration slice** proves the new architecture before orchestration features are adapted.
- The **Search bundle** is the first capability migrated through the new **Tool runtime**.
- The canonical **Tool runtime** lives in the **Server-side runtime**.
- The **Agents root** is app-owned by default and can be configured by Jarvis settings.
- The **Activation boundary** keeps active runs stable while newly projected agent changes apply to future work.
- A **Phase boundary** keeps cron integration out of the **First migration slice**.
- An **Exposure boundary** defers MCP export until after first-slice runtime proof.
- A **Done gate** blocks phase 2 until functional, safety, and stability checks pass.
- **Phase 2 order** is MCP exposure first, then cron integration.
- **Adaptation strategy** is conditional: transplant only when it measurably improves quality and coverage.
- The **Transplant gate** must pass before any donor-code transplant is accepted.
- **Rollout tiers** sequence capabilities after first-slice proof.

## Flagged ambiguities

- "Agent" previously meant a SQLite-backed app record; resolved: an **Agent** is canonically defined by **`soul.md`**, while app-managed state is a runtime projection.
- "soul.md" could have meant a full agent manifest; resolved: **`soul.md`** is identity-only, while mutable bindings and run state belong to the **Runtime projection**.
- "where an agent lives" could have meant a DB row or loose file; resolved: the portable unit is the **Agent directory** rooted at `agents/<slug>/`.
- "src-claude-code" could have meant a runtime to preserve; resolved: it is a **Capability donor** whose behaviors should be adapted into Jarvis-native abstractions.
- "tooling" could have meant multiple parallel execution systems; resolved: Jarvis has one canonical **Tool runtime** shared across entry surfaces.
- "different surfaces need different tools" could have meant separate implementations; resolved: surfaces vary through **Execution context**, not separate tool definitions.
- "agent instructions" could have meant enforceable security rules; resolved: **Permission policy** lives in Jarvis runtime, while **`soul.md`** may only express preferences.
- "loading an agent" could have meant reading files directly on demand; resolved: agents follow the **Agent lifecycle** before they become runnable.
- "runtime projection" could have meant a hidden second source of truth; resolved: it is lean, derived, and traceable back to canonical files.
- "where to start" could have meant porting orchestration first; resolved: the **First migration slice** is lifecycle plus runtime plus one code/search capability.
- "code/search capability" could have meant full LSP/editor parity; resolved: the first proof point is the **Search bundle**.
- "where tools run" could have meant UI or split execution; resolved: the canonical **Tool runtime** lives in the **Server-side runtime**.
- "where agents live" could have meant the dev repo; resolved: live agents are discovered from the app-owned **Agents root** by default.
- "reloading an agent" could have meant mutating active work; resolved: changes cross an **Activation boundary** and apply to future activations by default.
- "what ships first" could have meant adding cron immediately; resolved: a **Phase boundary** defers cron until after the first slice proves lifecycle and runtime.
- "who consumes first" could have meant external MCP clients; resolved: an **Exposure boundary** keeps MCP export in phase 2.
- "phase complete" could have meant feature-only progress; resolved: a **Done gate** requires functional, safety, and stability proof before expansion.
- "phase 2 priority" could have meant scheduler integration first; resolved: **Phase 2 order** is MCP exposure before cron.
- "how to migrate capabilities" could have meant one fixed method; resolved: **Adaptation strategy** is selective transplant with adaptation, otherwise behavior-first reimplementation.
- "when transplant is allowed" could have meant subjective judgment only; resolved: the **Transplant gate** requires parity gain, Jarvis-fit, and maintenance win.
- "migration order" could have meant whichever task is convenient; resolved: **Rollout tiers** enforce phased capability sequencing.

## Migration History

- **v3.0.0 (May 2026)**: Hermes bridge fully removed. Chat surface rewritten to use native `jarvis_send_message` → Bun server path. All duplicate `jarvis_*` commands removed from invoke_handler. SQLite-backed commands are the sole canonical path for all domain entities.
- **v3.1.0 (June 2026)**: Tool execution unified. The chat surface stopped delegating to the legacy `tools.ts` dispatcher; all surfaces (chat, cron, agent, mcp) now execute through the canonical **Tool runtime** via **Tool bundles**. The duplicate `read_file`/`glob`/`grep` implementations were collapsed onto one set of shared handlers. `tools.ts` was deleted; the previously-orphaned `agent-tools.ts` (task bundle) and `mcp-tools.ts` (mcp-client bundle) were wired in as live, policy-governed capabilities.