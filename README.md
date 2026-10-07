<div align="center">

# Daedalus · Jarvis

**A local-first desktop platform for AI agents, and a testbed for making agent completion verifiable.**

Rust/Tauri shell · Bun orchestration server · React UI · SQLite · MIT

</div>

---

## What this is

**Current development direction:** [Current Product Roadmap](docs/CURRENT_ROADMAP.md) is the source of truth for priority order and completion criteria. Work proceeds one priority at a time: memory, goals and execution, demonstrated learning, complete daily workflows, then measured local usefulness. **Priority #3 — Prove that learning improves future work — is active:** Phases 1–3 source are implemented, while the controlled campaign and empirical acceptance remain NOT RUN/open pending an available pinned loopback Ollama model. Priorities #1 and #2 runtime acceptance remain open; Priority #4 source is implemented, while real-task acceptance remains open.

**Jarvis** is a desktop application that runs AI agents on your own machine. It owns its full stack — native window, HTTP server, database, tool runtime, and agent lifecycle — and depends on no external agent platform. It can call out to cloud models if you configure it to, or run against local models through Ollama or llama.cpp.

**Daedalus** is the GitHub repository. **Jarvis** is the application. Same project; the names come from different layers of the stack, and the [Repo origins](#repo-origins) section explains why.

The part worth a reviewer's attention is not the chat app. It's the machinery underneath it:

> **The runtime captures the exit code. The model never decides whether it passed.**

That one constraint is the spine of this codebase. An agent that grades its own work will eventually learn to narrate success, and any reward signal built on that narration is training on a lie. Everything below is downstream of refusing that.

---

## Three systems worth reading

### 1. Runtime-owned verification

When a turn changes code, the runtime executes a real check and reads its exit code. The model's claim of success is not an input.

The check-runner is tiered by trust — the project's own tests first, then a language-appropriate build/syntax check, then a model-authored check — and returns a **tri-state** `CheckOutcome`: `clean`, `failed`, or `not_applicable`.

The third state is the whole point. An earlier version returned `{ran: true, passed: true}` for a project with no Python files in it, so a repository the checker couldn't actually inspect produced a green pass. The detector registry (cargo / cmake / go / node / make, with a Python syntax fallback) now returns `not_applicable` when it finds no build system, and that is recorded honestly as `none` rather than promoted to a vacuous green.

The invariant the system enforces: *a write-intent run is `success` only when its TaskPlan is drained **and** an authoritative check ran and passed. `check_tier=none` must produce `partial` and keep the run resumable.*

### 2. Offline trace replay as an evaluation harness

Every orchestrated turn is written to `self-tuning.db`. For a long time that database was effectively write-only — the tuner read narrow slices and nothing else touched it.

Two defects diagnosed by hand in July took instrumented builds, log reading, and roughly 400k tokens per attempt. Both were already sitting in the database. A query would have surfaced either in milliseconds.

`server-jarvis/src/eval/conductor-replay.ts` (282 lines, 17 tests) replays stored traces against five invariants — `repeated_nudge`, `placeholder_in_note`, `stage_deadline_exceeded`, `noop_executor_turns`, `turn_cap_saturation`:

```bash
bun scripts/replay-conductor.ts [--limit N] [--since TS] [--db PATH] [--json]
```

First run over **500 stored runs found 117 violations across 68 runs (14%)** — and independently ranked the run that had been diagnosed by hand as the worst in the corpus, hitting all five rules.

Scope, stated honestly: this is invariant and regression checking over recorded traces. It is not a counterfactual simulator.

### 3. Phase D — policy optimization over the orchestrator

The orchestrator's behavior is parameterized as a policy vector **θ** (Phase C, `a5212fd`), and Phase D tunes it as a black box:

| Piece | Commit | What it is |
|---|---|---|
| sep-CMA-ES core + fixture **held-out split** + rollout-local-only routing | `3ee568c` | Separable CMA-ES over θ, with fixtures partitioned so tuning cannot fit the evaluation set |
| In-process rollout runner + bounded-concurrency pool | `bb34d6a` | Rollouts execute in-process against local models rather than shelling out per trial |
| CMA-ES campaign driver + policy-staging proposal | `ec3a193` | Drives a campaign end to end and stages the resulting policy for review |
| Fixture suite expansion 11 → 39 | `0143a51` | Widens the task set the policy is scored against |
| Offline write-effect reward corrections | `689f64d`, `dc73e3d` | Credits hidden-file writes, and read-then-fixed files outside the named target set |

Rollouts run against local models through a dedicated Ollama transport (`self-tuning/rollout/ollama-local-transport.ts`), so a tuning campaign costs compute rather than API spend.

This is why runtime-owned verification matters beyond hygiene: the reward the optimizer maximizes is grounded in an executed check result. Ungameable by construction is not a slogan here — it is the precondition that makes the search meaningful.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  React UI (src-ui/) — Vite + TypeScript                              │
│  Chat · health dashboard · agent manager · cron · settings           │
│  Chat: SSE fetch → 127.0.0.1:19877/chat/stream                       │
│  Everything else: Tauri IPC → Rust commands → SQLite                 │
└────────────────────────────┬─────────────────────────────────────────┘
┌────────────────────────────▼─────────────────────────────────────────┐
│  Tauri / Rust (src-tauri/) — crate `home-base`                       │
│  SQLite: sessions, agents, cron, skills, channels                    │
│  Process supervisor (Bun, Ollama, proxy) · background-thread boot    │
└────────────────────────────┬─────────────────────────────────────────┘
┌────────────────────────────▼─────────────────────────────────────────┐
│  Bun server (server-jarvis/) — HTTP :19877                           │
│  Orchestrator pipeline · tool runtime · SSE · MCP bridge             │
│  Verification gate · replay eval · self-tuning · Phase-D campaigns   │
└────────────────────────────┬─────────────────────────────────────────┘
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
   Ollama (local)     OpenRouter / OpenCode    Claude CLI
```

### The orchestration pipeline

A turn is assessed by a **coordinator**, which selects a topology: a direct answer, a tool-assisted turn, or a multi-stage plan run by a **planner**, an **executor** pool, a **reviewer**, and a **synthesizer**. Topologies are `linear`, `speculative_parallel`, `speculative_cascade`, and `recursive` — and `linear` is the only one permitted for file edits or destructive actions.

The **conductor** supervises mid-flight. When a stage returns something unexpected, it can pause, inject what has been learned, and re-plan, bounded by per-turn and per-session caps.

Supporting systems, all live:

| System | What it does |
|---|---|
| **Repetition guard** | Trigram Jaccard similarity across consecutive turns, threshold `0.25` — calibrated between an observed incident range of 0.315–0.414 and a genuinely-different answer at 0.092 |
| **Evidence sufficiency** | Depth-scaled minimum deep-reads before answering. Listing commands don't count; an earlier version let `git_metadata` calls pose as content reads |
| **Stage budgets** | `MIN_VIABLE_STAGE_MS` per stage, set below the measured p50 of successful runs (reviewer p50 9.7s n=458; planner p75 9.0s n=1249; executor p50 3.1s n=3112). A stage that cannot plausibly finish in its window is refused rather than started and killed |
| **Fail-fast memo** | Sub-second short-circuit for near-identical retries |
| **Parallel dispatch** | Read-only tool batches dispatched concurrently |
| **Organism loop** | Trajectory snapshots → judge evaluation → skill promotion. `auto_promote` defaults to `false`; `min_judge_score` 0.75 |
| **Trajectory export** | `trajectory_snapshots` → GRPO-ready JSONL with a normalized composite reward in [0,1] |

---

## Quick start

```bash
git clone https://github.com/ethanjones1132-lab/Daedalus.git
cd Daedalus

cd server-jarvis && bun install && cd ..
cd src-ui && bun install && cd ..

cd server-jarvis && bun run dev     # terminal 1 — API on :19877
cd src-ui        && bun run dev     # terminal 2 — UI
cd src-tauri     && cargo tauri dev # terminal 3 — desktop shell
```

| Prerequisite | For | Minimum |
|---|---|---|
| [Rust](https://rustup.rs/) | native shell | 1.85+ |
| [Bun](https://bun.sh/) | server + UI build | 1.2+ |
| [Ollama](https://ollama.com/) *(optional)* | local models, Phase-D rollouts | — |
| OpenRouter / OpenCode key *(optional)* | cloud models | — |

### Build

```bash
# Windows full-stack deploy
powershell -ExecutionPolicy Bypass -File scripts\build-and-deploy.ps1 -RestartServer

# Installer
cd src-tauri && cargo tauri build   # → target/release/bundle/nsis/Jarvis_*_x64-setup.exe

# Linux / WSL
bash build-wsl.sh
```

---

## Verification

```bash
bash scripts/verify.sh              # rust lint + both tsc jobs
bash scripts/verify.sh --test       # + cargo test + bun test
bash scripts/verify.sh --build      # + server dist + UI dist
```

**Last full recorded run — 2026-08-01: 2,469/2,469 Bun tests and 115/115 Cargo tests green, both `tsc` jobs clean.**

The tree has grown since that run: **185 test files under `server-jarvis/src`**, 215 across the repo including the UI. Reproduce with `bash scripts/verify.sh --test` rather than trusting this paragraph — the number in a README is a claim, and the command is the evidence.

Suite growth is itself the artifact of how this repo is maintained: **240 Bun tests on 2026-06-24 → 2,469 on 2026-08-01**, added by a cron-driven maintenance loop that ships small, test-first, commit-attributed changes on a daily cadence. `PRIORITIES.md` records each pass with its commit SHAs and the test delta it produced.

---

## State of the documentation

Stated plainly, because a reviewer will find this anyway:

- **`PRIORITIES.md` is the real changelog and it stops at 2026-08-01.** `master` runs to 2026-08-07. The Phase-D work described above is in git history and in the source tree, but not in that file.
- **Plan checkboxes in `docs/superpowers/plans/` are not a reliable completion signal, in either direction.** One shipped six-phase plan still reports 0/34 boxes checked; another would report 73 unchecked despite having landed. Read `git log`, not the boxes.
- **`CONTEXT.md` is the vocabulary for the Tauri/native surface** — sessions, agents, `soul.md`, tool runtime, permission policy, activation boundary. It predates the orchestration layer and does not define conductor/executor/reviewer. Its **Flagged ambiguities** section — 21 entries of the form *"X could have meant Y; resolved: Z"* — is the part worth reading.
- **Several items are operator-gated and off by default,** including the verification-gated conductor's Phase-6 rollout flag and the A/B GGUF evaluation. Off by default means not proven at scale, and it is labeled that way on purpose.

---

## Configuration

Config is auto-created at `%USERPROFILE%\.openclaw\jarvis\config.json` (Windows) or `~/.openclaw/jarvis/config.json`.

| Key | Meaning |
|---|---|
| `active_backend` | `ollama` · `openrouter` · `llama_cpp` · `claude_cli` |
| `llama_cpp.base_url` / `llama_cpp.model` | OpenAI-compatible llama.cpp endpoint (default `http://127.0.0.1:8080/v1`) and the model alias it serves |
| `llama_cpp.server_path` | `llama-server` executable. Blank in source; set per machine in Settings or `JARVIS_LLAMA_SERVER_PATH` |
| `llama_cpp.model_path` | GGUF model file. Blank in source; set per machine in Settings or `JARVIS_LLAMA_MODEL_PATH` |
| `llama_cpp.mtp_path` | Optional MTP draft head (Settings or `JARVIS_LLAMA_MTP_PATH`); blank starts llama-server without MTP |
| `orchestrator.enabled` | Master switch for the multi-stage pipeline |
| `orchestrator.max_conductor_replans` | Per-turn replan cap (default 2) |
| `orchestrator.max_conductor_replans_per_session` | Per-session cap (default 6) |
| `orchestrator.skill_distillation.auto_promote` | Default `false` — promotion is judge-gated |
| `verification.check_timeout_ms` | Default 90000; 15s was fine for `py_compile`, not for `cargo check` on a cold tree |
| `jarvis_path` | Filesystem sandbox root |
| `tools.sandbox_mode` | `strict` · `permissive` · `off` |

llama.cpp artifact paths are machine-specific, so the code ships them blank. The native shell reads them from the `llama_cpp` entry of the App database settings table (edited through Settings; the Bun server's `config.json` carries the same block). A path set there always wins; the `JARVIS_LLAMA_*` environment variables only fill blank fields. If `llama_cpp.port` already has a server listening, Jarvis uses it as-is. Otherwise a missing `server_path` or `model_path` fails the launch with an error naming the setting to fill in.

| Database | Path | Holds |
|---|---|---|
| App | `%USERPROFILE%\.local\share\com.jarvis.desktop\jarvis.db` (`~/.local/share/...` on Linux) | Conversations, agents, cron, skills, channels |
| Self-tuning | `~/.openclaw/jarvis/self-tuning.db` | Run records, stage timing, model attribution, trajectories, tuning proposals |

---

## Repository layout

```
Daedalus/
├── src-tauri/        Rust/Tauri — native shell, SQLite, supervisor (crate: home-base)
├── server-jarvis/    Bun — orchestrator, tool runtime, verification, eval, self-tuning
│   └── src/
│       ├── orchestration/   coordinator, pipeline, conductor, run-gate, check-runner
│       ├── eval/            conductor-replay — offline trace invariants
│       └── self-tuning/     cma-es/ (sep-CMA-ES, campaigns) · rollout/ (runner, pool, Ollama)
├── src-ui/           React + Vite — chat, dashboard, agent manager
├── scripts/          verify.sh, build-and-deploy.ps1, benchmark-tier2b/, replay-conductor.ts
├── docs/             ADRs, plans, incident reports
├── CONTEXT.md        Vocabulary for the native surface + flagged ambiguities
├── AGENTS.md         Working rules for autonomous coding agents in this repo
├── PRIORITIES.md     Changelog with commit SHAs and test deltas (through 2026-08-01)
├── HANDOFF.md        Component-level architecture reference
└── RECOVERY_STATUS.md  2026-06 WSL recovery provenance
```

---

## Repo origins

This tree began as `home-base-recovered` after a **2026-06 WSL disk wipe** destroyed the original. It was reconstructed — partly from backups, partly from agent transcripts — and rebuilt well past where it had been. The first two commits, both dated 2026-06-18, are that recovery.

The Rust crate is `home-base`, the Bun package is `server-jarvis` v3.0.0, the app bundle is `com.jarvis.desktop`, and the remote is `Daedalus`. Four names, one system. `RECOVERY_STATUS.md` has the provenance.

---

## License

MIT — see [LICENSE](LICENSE). Copyright © 2026 Ethan Jones.

---

<div align="center">

[GitHub](https://github.com/ethanjones1132-lab/Daedalus) · [Issues](https://github.com/ethanjones1132-lab/Daedalus/issues)

</div>
