# AGENTS.md — Jarvis / home-base Working Rules



This file gives autonomous AI agents the minimal project-specific context needed to work safely in this repo.



## Read first

- `CONTEXT.md` — terminology and architecture vocabulary

- `README.md` — lightweight repo overview



## What this repo is

    10|Jarvis / home-base is a standalone Tauri desktop platform with its own native Rust surface, Bun server, React UI, memory system, cron, and agent lifecycle. Preserve that native architecture when making changes.



## Current priorities

- Build provenance and stale-binary prevention

- Eval / regression harness work

- Bridge and runtime reliability

- Follow-through on already-identified platform items: profile provisioning UI, frontier scaffolding, OpenClaw bridge, Tauri shell rewire, eval harness



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

