# Jarvis (home-base) — Master Plan

**Status:** living document · **Authored:** 2026-06-22 · **Horizon:** ~6 months, phased
**Build state at authoring (all verified by command, not claimed):**
`cargo check` → exit 0 · `src-ui bunx tsc -b` → exit 0 · `server-jarvis bunx tsc --noEmit` → exit 0.

This is the strategic plan for **home-base / Jarvis only** — the standalone Tauri
platform. Hermes (the Nous agent under `%LOCALAPPDATA%\hermes`) is a *capability
donor* and a possible external bridge, **not** part of this plan's runtime. Uses
[`CONTEXT.md`](../CONTEXT.md) terminology throughout.

---

## 0. Executive summary

Jarvis is no longer "a desktop chat app." The evidence in this tree says it is
becoming a **local-first, self-owned operating layer for a fleet of autonomous
product businesses**. The `action-registry` already tracks real commercial
surfaces (WallSlayer, Kalshi/PrizePicks Monster, Snitch LLC, VST3 plugins) as a
cross-project work queue; the four-stage orchestrator, memory tiers, agent
lifecycle, cron, and a canonical Tool runtime are all partially in place. The
recovery from the WSL disk loss is essentially **done at the build level** — the
real work now is turning a green-compiling reconstruction into a *trustworthy,
coherent, self-improving platform*.

The plan has three phases, in strict order:

1. **STABILIZE** — make the foundation honest: one config store, one session
   store, supervised processes, build provenance, no dead husks, no silent "not
   wired" paths. Nothing below it is safe until this is done.
2. **IMPROVE** — make it coherent and trustworthy: the canonical Tool runtime
   with Permission policy, the eval harness wired as a regression gate, UX
   coherence (command palette, confirm modal, a11y), and observable inference.
3. **EVOLVE** — the next evolution: close the **autonomous loop**
   (action-registry → agent dispatch → Tool runtime → verification → registry
   update), build the **intelligence layer** (memory consolidation + skill
   synthesis driven by the eval harness), and expose the Tool runtime as an
   **MCP server** so Jarvis becomes a capability *provider*, not just a consumer.

---

## 1. Where the application is now

### 1.1 The four layers (verified against the tree)

| Layer | Path | Role | State |
|---|---|---|---|
| Rust / Tauri backend | `src-tauri/` | Native command surface (SQLite: sessions, memory, cron, agents, channels, models, system), process mgmt | compiles clean; many commands real, some still stubs |
| Bun server | `server-jarvis/` | `JARVIS_API` HTTP surface + the canonical **Tool runtime** (filesystem/shell/web/meta/task/mcp bundles), SSE streaming, orchestrator | typechecks clean; 186 tests pass |
| React UI | `src-ui/` | Vite + TS; ~24 views; talks to Rust via IPC and to Bun over SSE | typechecks clean; 2 stub views remain |
| `claude_cli_proxy` | `scripts/claude_cli_proxy.py` | Anthropic-compatible `/v1/messages` shim (port 19878) fanning to the active backend | py_compile green |

**Process model at boot:** Jarvis spawns three children — Ollama,
`claude_cli_proxy`, and the Bun server. **Inference backends:** Ollama (local,
default), OpenRouter (cloud), Claude Code CLI (local) — all reached through the
proxy. The **chat path** is fully native: UI → `ChatPanel` →
`jarvis_send_message`/`run_jarvis_message` → Bun server → proxy → backend, with
SSE relayed back through `jarvis/runner.rs`.

### 1.2 The intended architecture (north star, from `CONTEXT.md`)

The domain model is already articulated and is the spine of everything below:

- **Agent** = identity defined by `soul.md`, living in a portable **Agent
  directory** (`agents/<slug>/`), discovered from an app-owned **Agents root**.
- **Agent lifecycle**: discover → validate → **project** → activate, crossing an
  **Activation boundary** (new work picks up changes; in-flight runs are not
  mutated). A **Runtime projection** holds lean, derived, traceable operational
  state — never a second source of truth.
- **Tool runtime**: one canonical, server-side contract. Capability arrives as
  **Tool bundles** (filesystem, shell, web, meta, task, mcp-client); every
  surface composes the bundles it needs via an **Execution context**; **Permission
  policy** is enforced by the runtime, not by `soul.md`.
- **Rollout tiers** (post first-slice): core coding loop → intelligence layer →
  orchestration surfaces → interaction layers.
- **Phase boundaries / Exposure boundary / Done gate**: cron deferred until the
  first slice proves out; MCP *export* is Phase-2 and gated behind proven
  internal runtime behavior; a phase isn't "done" without functional + safety +
  stability proof.

Migration history (per `CONTEXT.md`): **v3.0.0** removed the Hermes bridge and
made SQLite the sole canonical store for domain entities; **v3.1.0** unified tool
execution onto the canonical Tool runtime via Tool bundles and deleted the legacy
`tools.ts` dispatcher.

### 1.3 The surface that exists

- **~24 React views**: Jarvis chat, ControlCenter, Memory, ModelProfiles,
  SystemHealth, Settings, Agents, Channels, Cron, Gateway, Hooks, Nodes,
  Devices, Plugins, Skills, Approvals, Commitments, ActionRegistry, Companion
  sprite (Mythos), HermesChat, ToolApproval, and stubs SelfImprovement /
  PrizePicksPanel.
- **Native command surface** in `src-tauri/src/commands/` (action_registry,
  agents, channels, cron, memory, models, sessions, settings, skills, system,
  legacy, recovery_stubs).
- **A cross-project autonomous work registry** (`workspace/action-registry/`)
  tracking commercial products with priorities, acceptance criteria, evidence,
  lifecycle, and due dates — already the backbone of an autonomous operator.

### 1.4 What's verified working

All three subsystems build/typecheck green; `server-jarvis` has 186 passing
tests + an orchestration eval harness; the action-registry CI items
(theme-toggle, ci-pipeline, eval-harness, test-coverage) are done; chat streams
end-to-end through the native path; memory tiers (hot/warm/cold) read live.

---

## 2. Honest assessment — strengths, risks, debt

**Strengths**
- A genuinely coherent **domain model** (`CONTEXT.md`) most projects never write
  down — the hard architectural thinking is already done.
- A real **autonomous-operator** primitive (action-registry) with evidence and
  acceptance criteria, not a toy todo list.
- Clean build across four languages after a catastrophic disk loss, with a
  **doc-driven recovery discipline** (verify-by-command, durable backlogs).

**Risks / structural debt** (each becomes a Phase-1 or Phase-2 item)
- **Fragmented sources of truth.** Two config stores (file `~/.openclaw/jarvis/
  config.json` vs SQLite `settings`) and *three* session stores (Tauri file dir,
  Bun history, SQLite `sessions`). This is the #1 correctness hazard —
  multi-agent and reliability work is unsafe on top of it.
  ([COMPLETION_BACKLOG.md](COMPLETION_BACKLOG.md))
- **Silent-failure class of bug.** The "two-config-store trap" and the
  Tailwind/theme-husk bug (green build hiding a dead UI) are the same disease:
  *a passing build that hides a dead path*. The CI theme-husk guard is a start;
  the principle needs to generalize.
- **Unsupervised child processes.** Three spawned children with no watchdog —
  exactly the failure mode that took down the Hermes gateway this week. A crash
  of Ollama / proxy / Bun server silently degrades the app.
- **Untested reliability seams.** The SSE frame handler in `runner.rs` is inline
  in a thread closure with no tests; bridge/runtime reliability is an explicit
  `AGENTS.md` priority.
- **Contract mismatches & silent stubs.** `jarvis_save_companion` errors against
  the Bun `POST /companion` (interaction, not save); cold-memory Drive archival
  in `engine.rs` is a placeholder; several `recovery_stubs.rs` commands are
  no-ops with no UI caller yet.
- **Hermes-surface ambiguity.** `CONTEXT.md` says the bridge was removed in
  v3.0.0, yet `HermesChat.tsx`, `lib/hermes.ts`, `GatewayView`, `ChannelsView`,
  and `src-tauri/src/jarvis/hermes/` still exist, and `AGENTS.md` lists an
  "OpenClaw bridge" as a priority. **Decide:** is external-agent bridging a live
  feature or are these husks? Today it is neither-fully.
- **No build provenance.** `APP_VERSION` is a hardcoded `"3.0.0"` string; a stale
  binary can't be detected against source (the documented `build-optimized.ps1`
  is itself a husk — rebuild with `cargo tauri build`).
- **Inference fragility.** No model routing/fallback; the referenced
  `inference_metrics.csv` doesn't exist (only `automate_inference_metrics.py`);
  a dead model id = a dead chat (the persisted OpenRouter key is also invalid).

---

## 3. Phase 1 — STABILIZE (foundation must be honest)

*Goal: a platform where every visible path is real, every source of truth is
singular, and every long-lived process is supervised. Done-gate: no silent
"not wired"/dead path reachable from the UI; one config store; one session
store; supervised processes; provenance visible.*

1. **Unify the config store.** Pick one source of truth (recommend SQLite
   `settings`, with the file store as an import-once migration). Route
   `jarvis_save_config` and `load_jarvis_config` through it; eliminate the
   `jarvis_path`-in-SQLite / `active_backend`-in-file split.
2. **Unify the session store.** Collapse Tauri file dir + Bun history + SQLite
   `sessions` to one (recommend SQLite, per the v3.0.0 "SQLite is canonical"
   decision); the others become projections or are deleted.
3. **Process supervisor.** A health-checked supervisor for Ollama,
   `claude_cli_proxy`, and the Bun server — liveness probe + bounded restart +
   surfaced status in `SystemHealthView`/`HealthBanner`. (Apply the watchdog
   lesson from the Hermes gateway incident: detect-dead-then-relaunch, idempotent.)
4. **Build provenance / stale-binary guard.** Stamp builds with git SHA +
   timestamp, surface in-app (HealthBanner/Gateway), warn when the running
   binary lags `HEAD`. (action-registry: `jarvis-eng-build-provenance`)
5. **Reconcile recovery contract mismatches.** Fix the `jarvis_save_companion`
   contract; implement or *formally defer* cold-memory Drive archival; ensure no
   user-reachable command returns a silent "not wired" error.
   (action-registry: `jarvis-eng-contract-mismatches`)
6. **Decide the Hermes/OpenClaw surface.** Either make the bridge a real,
   tested, optional capability (a *capability donor* reached over a defined
   contract) or delete `HermesChat`/`lib/hermes.ts`/`jarvis/hermes/` as husks.
   No half-state.
7. **Recover the last stub views** (SelfImprovementView, PrizePicksPanel) or
   formally retire them. ([COMPLETION_BACKLOG.md](COMPLETION_BACKLOG.md))
8. **Extract + unit-test the SSE frame handler** out of the `runner.rs` thread
   closure so token/result/error relay is covered.

---

## 4. Phase 2 — IMPROVE (coherence & trust)

*Goal: the architecture in `CONTEXT.md` becomes real and enforced, the platform
proves itself on every change, and the UX is coherent. Done-gate: Tool runtime
is the sole execution path with Permission policy enforced; eval harness gates
CI; inference is observable and resilient.*

1. **Cement the canonical Tool runtime + Permission policy.** Finish the Tool
   bundles as the *only* execution path (chat, cron, agent, mcp). Implement
   **Permission policy** enforcement — sandboxing, approvals, non-interactive
   constraints — wired to the existing `ApprovalsView`/`ToolApprovalModal`.
   Drive everything through **Execution context**, not per-surface forks.
2. **Eval harness as a regression gate.** The harness exists and CI exists —
   now make a regression in the inference/tool path *fail the build*. Capture a
   baseline; assert structured outputs; run in CI on PR.
3. **Inference resilience + observability.** Model routing with fallback
   (a dead model id must degrade gracefully, not kill chat); revive
   `inference_metrics.csv` via `automate_inference_metrics.py`; surface
   latency/cost/error per backend in `SystemHealthView`. Validate the
   OpenRouter key path end-to-end (currently invalid).
4. **UX coherence pass.** Cmd/Ctrl+K command palette over the ~19 nav targets;
   reusable styled confirm modal replacing `window.confirm`; the
   `useResourceList<T>` hook to DRY the 9 list views; the a11y/keyboard pass
   (focus trap, `aria-selected`, Esc-to-close). (action-registry: command-palette,
   confirm-modal, dry-resource-list, a11y-pass)
5. **Generalize the "no dead path" guard.** Extend the theme-husk CSS assertion
   into a broader build-time check that every nav view resolves to a live
   command and every registered command has a consumer or is explicitly marked
   internal. The disease is "green build hides dead path" — vaccinate against
   the class, not the instance.

---

## 5. Phase 3 — EVOLVE (the next evolution of the platform)

*This is where Jarvis stops being an app you operate and becomes a platform that
operates. Sequenced per the `CONTEXT.md` **Rollout tiers** and gated behind
Phases 1–2.*

### 5.1 Close the autonomous loop (the flagship bet)
The action-registry already encodes *what needs doing* with acceptance criteria
and evidence. The Agent lifecycle, orchestrator, Tool runtime, and cron already
exist in pieces. **The evolution is to connect them into one closed loop:**

> action-registry item → **Agent lifecycle** dispatch (project + activate an
> Agent against the item) → **Tool runtime** execution under **Permission
> policy** → verification against the item's `acceptance_criteria` → registry
> update (status/evidence/result_summary) → memory write.

This turns home-base into a *supervised autonomous operator* for the product
fleet. Requires: an agent **supervisor/scheduler** (concurrent Agents with the
Activation boundary honored), a verification step that runs the item's own
acceptance commands (the registry already stores them as `evidence.kind=command`),
and hard **Permission policy** gates on anything `approval_required`.

### 5.2 Build the intelligence layer (the moat)
Per the rollout tiers, the layer above the core coding loop. Jarvis's
differentiator should be a **self-improving loop it owns end-to-end** (the same
idea Hermes proves, but native here):
- **Memory consolidation**: promote/demote across hot/warm/cold tiers with
  confidence decay; deduplicate; surface in `SelfImprovementView`
  (currently a stub — make it the cockpit for this).
- **Skill synthesis from successful trajectories**: when an autonomous loop
  succeeds, distil the trajectory into a reusable Skill (`SkillsView` already
  exists); the **eval harness from Phase 2 is the judge** of whether a synthesized
  skill is kept.
- **Eval-driven self-improvement**: the harness is not just a CI gate — it's the
  fitness function. Changes (prompts, skills, routing) are accepted only if they
  move the eval baseline.

### 5.3 Expose the Tool runtime as an MCP server (Exposure boundary / Phase-2 order)
Per `CONTEXT.md`'s **Phase 2 order** (MCP exposure *before* further cron
integration) and **Exposure boundary** (gated behind proven internal runtime).
Once the runtime is canonical and policy-enforced, export it as an MCP server so
Jarvis's capabilities are reusable by *any* MCP host — including Hermes, Claude
Code, and IDEs. This flips Jarvis from a capability *consumer* to a capability
*provider* and is the cleanest way to let the external-agent ecosystem use
Jarvis without coupling to its core.

### 5.4 Interaction layers (last tier — respect the phase boundary)
Only after the above: reach Jarvis off the laptop (messaging/remote surfaces, à
la the Hermes gateway). Deliberately last per the rollout tiers — do not let an
interaction surface jump the queue ahead of the core loop and intelligence layer.

---

## 6. Sequencing, dependencies, done-gates

```
Phase 1 STABILIZE ──┬── unify config store ─────────┐
                    ├── unify session store ─────────┤ (both gate 5.1)
                    ├── process supervisor           │
                    ├── build provenance             │
                    ├── reconcile contracts          │
                    ├── decide Hermes surface        │
                    └── SSE handler tests             │
Phase 2 IMPROVE ────┬── Tool runtime + Permission ───┤ (gates 5.1, 5.3)
                    ├── eval harness as gate ────────┤ (gates 5.2)
                    ├── inference resilience/obs.     │
                    ├── UX coherence pass             │
                    └── generalized dead-path guard   │
Phase 3 EVOLVE ─────┬── 5.1 autonomous loop ─────────┘ depends on 1+ Tool runtime
                    ├── 5.2 intelligence layer ── depends on eval gate
                    ├── 5.3 MCP export ── depends on canonical runtime + policy
                    └── 5.4 interaction layers ── last, behind a phase boundary
```

**Done-gates (per `CONTEXT.md`):** no phase advances without functional + safety
+ stability proof, verified by command. Phase 1's gate is "no dead/duplicated
source of truth and no unsupervised process." Phase 2's gate is "Tool runtime is
the sole, policy-enforced execution path and the eval harness blocks
regressions." Phase 3 items each carry their own acceptance criteria into the
action-registry.

## 7. Cross-cutting principles (apply in every phase)

- **Verify by command, not by claim** (`AGENTS.md` rule 2).
- **One source of truth per concept** — the recovery's biggest scars are all
  duplication scars.
- **Preserve architecture intent over quick hacks** (`AGENTS.md` rule 4); use
  `CONTEXT.md` vocabulary so concepts don't get flattened.
- **Vaccinate against "green build hides dead path"** — every new surface needs
  a live-path assertion.
- **Permission policy is runtime-enforced**, never advisory in `soul.md` —
  especially as the autonomous loop gains the ability to act on real products.

---

*Next step options: convert each Phase-1/2 item into `action-registry` entries
with acceptance criteria so the daily restoration routine can execute them, or
break Phase 1 into issues. See the summary in chat.*
