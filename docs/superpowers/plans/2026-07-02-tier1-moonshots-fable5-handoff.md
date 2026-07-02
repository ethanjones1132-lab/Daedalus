# Tier 1 Moonshots — Fable 5 Handoff (Jarvis / home-base)

**Created:** 2026-07-02  
**Workdir:** `C:\Projects\home-base-recovered`  
**Audience:** Frontier model session (Fable 5) or coding-agent with full repo access  
**North star:** Jarvis as a **self-improving local organism** — cheap models + conductor + replan + distilled skills, with optional **fleet orchestration** and **measurable proof** (shadow tournaments).

---

## Autonomy charter (read this first)

**You are not executing a fixed checklist.** This handoff is **context + intent + current gaps**, not a contract that forbids better ideas.

- **You may** change architecture, merge phases, skip tasks, add tasks, refactor unrelated code, implement B-03/B-04, Fleet stage, or Shadow tournament first — if you can justify why that delivers more value toward the north star.
- **You may** replace the proposed APIs (`POST /skills/synthesize`, JSON vs SQLite, separate `SelfImprovementView`, etc.) with a cleaner design; document what you chose and why.
- **You may** extend scope beyond Track C (e.g. conductor-learning hooks, replan-rescued distillation, Hermes bridge) when it strengthens the flywheel.
- **Deliverable bar:** A **working, demonstrable** organism loop (or a clearly superior substitute you define) with tests green and a short “what we built / what we changed from the plan” note in `PRIORITIES.md` or a sibling doc.

Treat jarvis-cron guidance below as **safety rails for production**, not permission gates on design.

---

## Executive summary

Three moonshots, **suggested** sequencing (reorder freely):

| Phase | Mission | Typical focus |
|-------|---------|-----------------|
| **1** | **Organism loop v1** — close C-01→C-05 into one user-visible flywheel | Primary intent of this handoff |
| **2** | **Fleet stage** — Hermes/cron as orchestrator executor | High leverage if integration is clear |
| **3** | **Shadow tournament** — live ROI dashboard vs frontier | Proof layer when judge + DB are ready |

If you see a faster path to “remarkable” (e.g. Fleet + correlation IDs before skill UI), **take it** and explain in the completion summary.

---

## Safety rails & verification (jarvis-cron / maintenance-pass — not design blockers)

These protect users and ops; they do **not** limit which files you edit or how you structure the solution.

- **Inference params:** Avoid silent drift of user-facing `temperature`, `max_tokens`, `stream`, `top_p` on existing paths; if you change behavior intentionally, document it.
- **Regression discipline:** Keep `bun test` / eval harness passing; add tests for new behavior. Intentional behavior changes are fine when documented and covered.
- **Chat pipeline:** If you touch streaming, skim `references/chat-pipeline.md` (jarvis-cron skill) and leave a **live** smoke recipe others can run.
- **Secrets:** No credentials in logs or commits; financial/repo data stays local.
- **Before you call it done:** Run `bun test` in `server-jarvis/`, `bunx tsc --noEmit`, `bunx tsc -b` in `src-ui/`, `cargo test --lib` in `src-tauri/` (or explain what you could not run).
- **Paper trail:** Update `PRIORITIES.md` (or add `docs/superpowers/plans/2026-07-02-organism-loop-outcome.md`) with what shipped and what diverged from this handoff.

---

# Phase 1 — Organism loop (Trajectory → Skill → Resolver → Conductor)

**Blueprint:** `docs/issues/post-phase-4-conductor-evolution.md` — Track C (C-01 through C-05).

### What “done” means (product, not checkbox theater)

1. User completes a **successful** orchestrator turn (including **replan-rescued** `degraded` → treat as distill-eligible if you add explicit policy).
2. System creates a **skill candidate** with provenance (`source_run_ids`, session, confidence).
3. **Semantic eval** (not heuristic-only) gates promotion.
4. On promote, **next matching turn** injects skill into conductor + stage prompts measurably (eval + one live smoke).
5. **UI** shows candidates, eval status, promote/reject/revert, and **win-rate since promotion** from `SelfTuningStore`.

### Current repo state (gap analysis — verify on entry)

| Track | Issue | Status | Evidence |
|-------|-------|--------|----------|
| C-01 | Trajectory → candidate | **Partial** | `distillSkillCandidate()` hooked post-success in `index.ts` (~1902–1920); `conductorLearning.completeRun()` writes `trajectory_snapshots` but distiller uses inline `stageRuns`, not DB replay |
| C-02 | Native SQLite skills bridge | **Open** | Candidates live in `~/.openclaw/jarvis/skills/candidates/*.json` (`skill-store.ts`); Tauri `SkillsView` uses `list_skills()` — **two stores** |
| C-03 | SkillResolver injection | **Partial** | `resolveSkillsForTurn()` + `distilledSkillsBlock` in `pipelineOptions` (`index.ts` ~1803); only `promoted` JSON candidates |
| C-04 | Eval-gated promotion | **Partial** | `runSkillPromotionPass()` + `scoreSkillCandidate()` heuristic in `skill-promotion.ts`; `eval/judge.ts` exists but **not wired** to promotion |
| C-05 | Cockpit UI | **Partial** | `SkillsView.tsx` has filter `'candidates'` — confirm wiring to native + Bun metadata; no `SelfImprovementView`; no “win rate since promotion” panel |

**Already good:** B-02 replan on master; semantic judge tests; conductor learning + trajectory export; eval harness imports `resolveSkillsForTurn`.

---

### Phase 1 implementation tasks (suggested — reorder, merge, or replace)

#### Task 1.1 — Unify skill identity (C-02 core)

**Goal:** One canonical skill row per distilled skill; Bun and Tauri agree.

- Add Bun API (or extend existing `/skills` routes in `index.ts`):
  - `POST /skills/synthesize` — body from distillation, `enabled: false`, metadata `{ source: "trajectory_distillation", agent_run_id, session_id, change_reason }`.
- Implement Tauri command bridge **or** HTTP callback from Bun to Tauri if architecture prefers server-driven writes (document choice).
- On `saveSkillCandidate`, **also** write revision via native path; store mapping `candidate.id` ↔ `skill.id` in metadata.
- `listSkillCandidates()` should merge view: JSON files **or** SQLite rows with `metadata.category === 'distilled_candidate'` (pick one source of truth; deprecate duplicate).

**Acceptance:**
- Distillation creates row visible in `SkillsView` (candidates filter).
- `skill_revisions_list` shows `change_reason: trajectory_distillation`.
- Bundled skills unchanged (regression test).

**Starting points (not a fence):** `skill-store.ts`, `index.ts`, `skills.rs`, `SkillsView.tsx` — use whatever layout fits your design.

---

#### Task 1.2 — Trajectory-backed distillation (C-01 hardening)

**Goal:** Extractor can rebuild from `trajectory_snapshots` for audit/replay; live path still works.

- Add `distillFromTrajectorySnapshot(snapshotJson)` used by:
  - Post-run hook (current path), and
  - CLI/admin `bun run src/intelligence/redistill.ts --agent-run-id=...` (optional but valuable).
- Policy table (config):
  - `distill_on: ["success"]` — extend to `["success", "degraded"]` only if replan rescued and `had_error === 0` on synthesizer (document rule).
- Candidate fields: `trigger` (task_type + turn-requirements signals), `body`, `source_run_ids[]`, `confidence`, `tool_sequence_digest` (hash of tool names/order).

**Acceptance:** Fixture trajectory JSON → candidate; skip empty/failed; never auto-enable.

---

#### Task 1.3 — Wire `judgeAnswer` into promotion (C-04)

**Goal:** No promotion without rubric pass.

- For each `candidate` status skill, define rubric from distillation:
  - Example items: “mentions task type”, “does not invent absolute paths”, “includes worker guidance section if present in source run”.
- `promoteSkillCandidate(id)`:
  1. Run **shadow replay** or **cached answer** from source run (if replay too heavy: judge the **skill body** grounding against `source_run_ids` stage outputs).
  2. `judgeAnswer(callModel, userRequest, answerOrBody, rubric)` ≥ `skill_distillation.min_judge_score` (new config key).
  3. On pass → `status: promoted` + native `enable_skill`; on fail → `rejected` with `rejection_reason: eval_failed`.
- Extend `eval/harness.ts` with case kinds: `skill_trigger`, `skill_regression`, `skill_grounding` per C-04.
- Update `eval/baseline.json` (or project equivalent).

**Acceptance:** Fixture good skill promotes; bad skill (invented `C:\fake\path`) fails; CI fails on regression.

**Files:** `skill-promotion.ts`, `eval/harness.ts`, `eval/judge.ts`, tests in `skill-distillation.test.ts`.

---

#### Task 1.4 — Conductor + stage injection audit (C-03)

**Goal:** Promoted skills affect **conductor** and **planner/executor** prompts, not only `distilledSkillsBlock` on pipeline.

- Trace `distilledSkillsBlock` through `PipelineExecutor` / `worker-prompt.ts` / persistent conductor turn builder.
- Ensure conductor KV turn includes **short skill summary** in memory hints (C-03 acceptance).
- Unit tests: unmatched turn → bit-identical prompt hash (or snapshot test); matched turn → appendix present in `resolveStagePrompt`.

---

#### Task 1.5 — Self-improvement cockpit (C-05)

**Goal:** Operator loop without CLI.

- Extend `SkillsView` **or** add `SelfImprovementView.tsx` (route from Jarvis nav):
  - List candidates: name, confidence, eval score, rejection reason, `source_session_id`, linked `agent_run_id`.
  - Actions: **Run eval**, **Promote**, **Reject**, **Revert** (`skill_restore_revision`).
- New panel: **“Performance since promotion”** — query `SelfTuningStore` / `getAgentPerformance` filtered by skill enabled window (store `promoted_at` in metadata).

**Acceptance:** Empty state; enable/disable hits native commands; revert works.

---

#### Task 1.6 — Three golden “before/after routing” demos (Fable 5 deliverable)

Document in `docs/superpowers/demos/organism-loop-v1.md`:

| Demo | Setup | Expected |
|------|-------|----------|
| **D1** | Seed promoted skill for `workspace_read` + path signal | Turn classifies `workspace_read`; executor prompt contains skill; answer cites read tools |
| **D2** | No skill | Same message → baseline route; prompt lacks appendix |
| **D3** | Replan turn → distill → promote → repeat similar task | Second turn shows lower stage count or higher judge score (measure via logs/DB) |

Include copy-paste smoke commands (session id, curl or UI steps).

---

### Phase 1 config sketch (`config.json` / `config.ts`)

```yaml
orchestrator:
  skill_distillation:
    enabled: true
    min_confidence: 0.55
    min_judge_score: 0.75        # NEW — semantic gate
    auto_promote: false            # require eval pass + optional UI approve
    distill_on: [success]          # optional: degraded if replan-rescued
  conductor_learning:
    enabled: true
    trajectory_export: true
```

---

# Phase 2 — Fleet stage (Jarvis orchestrates Hermes)

**Suggested ordering:** Often after Phase 1, but **no hard prerequisite** — fleet stage can ship first if that’s the higher-leverage path.

### Concept

New execution profile or stage tool: **`fleet_delegate`**

- Conductor emits in `worker_instructions` / `shared_context`:
  - `workdir` (absolute, e.g. `C:\Projects\home-base-recovered`)
  - `goal` (self-contained)
  - `skills[]` (Hermes skill names)
  - `toolsets[]` optional
- Jarvis executor invokes **Hermes gateway** (document actual integration point):
  - Option A: TCP/HTTP to local Hermes gateway if exposed
  - Option B: `delegate_task`-equivalent subprocess/API documented in `server-jarvis/src/bridge.ts` extension
  - Option C: spawn `hermes` CLI with structured JSON (if stable)
- Stream subagent **summary only** back into `PipelineStageState.executor` (intra-workflow isolation — same rule as B-02 replan).
- **Correlation:** `jarvis_agent_run_id` passed as Hermes session metadata; return `hermes_child_id` in telemetry.

### Safety

- `read_only` / `workspace_read` profile **cannot** invoke `fleet_delegate` with write toolsets.
- Cap concurrent fleet delegates (config).
- Replan (`runPipelineWithReplanning`) if delegate stalls or returns `degraded`.

### Acceptance

- One live demo: user message *“Run jarvis-cron maintenance on home-base”* → delegate → summary in chat.
- Test: mock Hermes adapter returns fixture summary; pipeline completes.

### Files to survey first

- `server-jarvis/src/bridge.ts` (19876)
- Hermes gateway docs / `hermes-agent` skill
- `tool-runtime.ts` permission profiles
- `turn-requirements.ts` — when to allow fleet stage

---

# Phase 3 — Shadow tournament (prove cheap stack wins)

**Suggested ordering:** Needs judge + persistence somewhere; you may invent schema/UI placement beyond this sketch.

### Concept

On opt-in (config `shadow_tournament.enabled`):

| Arm | Pipeline |
|-----|----------|
| A | synthesizer-only |
| B | linear cheap default |
| C | cheap + `conductor_replan` when coordinator allows |
| D | single frontier stage (coordinator OR synthesizer only — document cost cap) |

- Run on **golden tasks** (`eval/cases.ts` subset) or sampled production turns (user opt-in).
- Score each arm with `judgeAnswer`; persist tokens + latency + score.
- UI panel (SystemHealthView or SelfImprovementView): *“Last 7 days: C beat A on X% at Y% token cost.”*

### Schema (SQLite via self-tuning or new migration)

- `shadow_run_id`, `task_id`, `arm`, `score`, `tokens_in`, `tokens_out`, `latency_ms`, `created_at`.

### Acceptance

- Scheduled job or manual `bun run src/eval/shadow-tournament.ts --once`
- Dashboard renders non-empty after one run
- No impact on production chat when disabled

---

## Plan → implement split (Fable plans, Sonnet implements)

**Default workflow:** Fable 5 does **not** need to lead execution. The durable value is the **plan artifact**; a strong implementer (e.g. Sonnet 5) ships code against that artifact with the **same Autonomy charter** — not a stricter task list.

Quality is preserved when Fable **serializes its reasoning** into two layers Sonnet can run without re-deriving the moonshot from scratch.

### Layer A — Intent (already in this handoff)

- North star, Autonomy charter, gap table, phased moonshots, success metrics, safety rails.

### Layer B — Implementation spec (Fable must produce)

Fable’s planning session should **append or create** a sibling file:

`docs/superpowers/plans/2026-07-02-organism-loop-implementation-spec.md`

Minimum contents (Fable fills in with repo-specific detail):

| Section | Purpose |
|---------|---------|
| **Decisions** | Chosen architecture (e.g. SQLite vs JSON source of truth), rejected alternatives, why |
| **Data flow** | Trajectory → distill → store → promote → inject; diagrams or bullet pipeline |
| **Interfaces** | APIs/commands/events (names, payloads, callers) — may supersede Task 1.1 sketches |
| **State machines** | Candidate → eval → promoted / rejected; config keys |
| **Files & hooks** | Concrete paths and line-level hooks to read first |
| **Tests to add** | File names + what they assert |
| **Acceptance demos** | D1–D3 or equivalent; copy-paste smoke steps |
| **Open questions** | Explicit judgment calls left for implementer |
| **Minimum shippable slice** | Smallest end-to-end demo that proves the flywheel (prevents checkbox-only C-04) |

If Layer B is missing, Sonnet will reinvent or thin out Fable’s intent — that is the main quality leak.

### Verification gate (model-agnostic)

Whoever implements must pass **Safety rails** in this handoff and write **`docs/superpowers/plans/2026-07-02-organism-loop-outcome.md`** (or `PRIORITIES.md` entry): shipped, deltas vs Layer B, how to demo.

### Optional: Fable review pass (no coding)

After Sonnet lands: short Fable session reads **outcome doc + test status** only. Prompt: “Did we hit the north star? What’s the next highest-leverage gap?” Recovers strategic quality without Fable typing patches.

---

## Suggested Fable 5 session prompt — **planning only** (paste as first message)

```
You are the architect for Jarvis Tier 1 moonshots — planning session, not full implementation unless trivial.

Read docs/superpowers/plans/2026-07-02-tier1-moonshots-fable5-handoff.md (Autonomy charter + gap table), docs/issues/post-phase-4-conductor-evolution.md Track C, and survey server-jarvis/src/intelligence/*, index.ts distill hook (~1900), SkillsView.tsx.

Deliverables:
1. docs/superpowers/plans/2026-07-02-organism-loop-implementation-spec.md — full Layer B (decisions, data flow, interfaces, state machines, files/hooks, tests, demos, minimum shippable slice, open questions). You may redesign anything; document why.
2. Update the gap table in the handoff OR add an “entry snapshot” dated section if repo drifted.
3. Short “Sonnet handoff” paragraph at the top of the implementation spec listing read order and pitfalls.

You may implement only if a spike is required to validate a design choice — otherwise leave execution to Sonnet 5.

Do not narrow the Autonomy charter for the implementer.
```

---

## Suggested Sonnet 5 session prompt — **implementation** (paste as first message)

```
Implement Jarvis Tier 1 per the planning artifacts:

1. docs/superpowers/plans/2026-07-02-tier1-moonshots-fable5-handoff.md — Autonomy charter + safety rails (you have the same freedom to improve architecture; document deltas).
2. docs/superpowers/plans/2026-07-02-organism-loop-implementation-spec.md — Layer B is your primary spec.

Intent: Working self-improving organism loop (or superior substitute justified in outcome doc) — local, eval-gated skills, operator-visible UX, tests green.

Workdir: C:\Projects\home-base-recovered

When done: docs/superpowers/plans/2026-07-02-organism-loop-outcome.md + PRIORITIES.md entry. Run bun test / tsc / cargo per safety rails. Include live smoke recipe.
```

---

## Legacy: single-session prompt (Fable plans + implements)

Use only if you want one model to do both. Same as before:

```
You own Jarvis Tier 1 moonshots. Read docs/superpowers/plans/2026-07-02-tier1-moonshots-fable5-handoff.md (especially the Autonomy charter), post-phase-4 Track C, and the intelligence/ + distill hook in index.ts (~1900).

Intent: Ship a self-improving organism loop — trajectory → skill → eval-gated promotion → resolver → visible operator UX — local, no GPU fine-tune. The gap table in the handoff is today's repo truth; you are free to fix gaps differently or go further (Fleet stage, Shadow tournament, B-03/B-04, better distillation, etc.) if you judge it more impactful.

Rules: Follow safety rails in the handoff (tests green, no secrets, document smokes). Do NOT treat task 1.1–1.6 as mandatory steps or file lists as exclusive. Prefer the best architecture you can justify.

When done: PRIORITIES.md or docs/superpowers/plans/2026-07-02-organism-loop-outcome.md — what shipped, what you changed vs this plan, how to demo it. If you did not write Layer B first, write implementation-spec + outcome together.
```

---

## Success metrics (how we know it’s “another level”)

1. **Compounding:** Second week of use → measurably more promoted skills → higher judge scores on repeated task types (query DB).
2. **No GPU fine-tune** required for improvement.
3. **Demoable in 5 minutes:** SkillsView → candidate → eval → promote → chat → visible behavior change.
4. (Phase 3) **Published ROI number** on dashboard from real shadow runs.

---

## Lower priority unless you see a shortcut (not forbidden)

- GRPO / D-02 HITL training pipelines (heavy ops)
- Making a frontier model the default coordinator for all turns
- `git push` / release ops (human)

Everything else — including B-03/B-04, UI experiments, AgentPool changes — is **in bounds** if it serves the north star.

---

## References

| Resource | Path |
|----------|------|
| Conductor evolution backlog | `docs/issues/post-phase-4-conductor-evolution.md` |
| Orchestrator hardening (A/B done) | `docs/superpowers/plans/2026-06-30-orchestrator-hardening.md` |
| Priorities log | `PRIORITIES.md` |
| Jarvis cron rules | Hermes skill `jarvis-cron` |
| Chat pipeline | `references/chat-pipeline.md` (in jarvis-cron skill) |
| Layer B (Fable output) | `docs/superpowers/plans/2026-07-02-organism-loop-implementation-spec.md` |
| Outcome (implementer output) | `docs/superpowers/plans/2026-07-02-organism-loop-outcome.md` |