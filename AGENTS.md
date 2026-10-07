# AGENTS.md — Jarvis / home-base Working Rules



This file gives autonomous AI agents the minimal project-specific context needed to work safely in this repo.



## Read first

- `docs/CURRENT_ROADMAP.md` — current product priorities, sequence, and completion criteria

- `CONTEXT.md` — terminology and architecture vocabulary

- `README.md` — lightweight repo overview



## What this repo is

    10|Jarvis / home-base is a standalone Tauri desktop platform with its own native Rust surface, Bun server, React UI, memory system, cron, and agent lifecycle. Preserve that native architecture when making changes.



## Current priorities

- Follow `docs/CURRENT_ROADMAP.md`; it supersedes historical priority ordering.

- Active priority: **#3 — Prove that learning improves future work.** Phases 1–3 source are implemented; the Phase 4 controlled campaign and empirical acceptance remain NOT RUN/open because no pinned loopback Ollama model is available.

- Complete and verify one priority before advancing to the next: memory → goals and execution → demonstrated learning → complete workflows → measured local usefulness.

- Priority #1 and #2 runtime acceptance remain open/NOT RUN. Priority #4 source was implemented and committed under an explicit sequence override, but real-task acceptance remains open. Source delivery does not close any runtime or empirical acceptance gate. Reliability, build provenance, UI honesty, and regression work support the active priority. Record urgent interruptions and return to it afterward.



## Key areas

- `src-tauri/` — Rust/Tauri backend

    20|- `server-jarvis/` — Bun server + tool runtime

- `src-ui/` — React UI

- `docs/` — specs, ADRs, audits, and design notes

- `workspace/action-registry/` — action-registry workspace



## Working rules

1. Use `CONTEXT.md` terminology; do not flatten native concepts into vague substitutes.

2. Verify claims with real builds, tests, logs, or concrete code evidence.

3. Distinguish Rust/Tauri, Bun server, UI, and coordination-layer issues clearly.

4. Prefer fixes that preserve architecture intent over quick hacks.

    30|5. If docs and code diverge, say which side you verified.
