# Trustworthy In-Turn Conductor (Rungs 1+2) — Design Spec

- **Date:** 2026-07-25
- **Status:** Approved (brainstorm complete) → implementation planning
- **Author:** Ethan + Claude
- **Related:** `2026-07-24-verification-gated-conductor-design.md`; live Perihelion session `01187b3d-…` (turns 3 & 7)

## 1. Motivation & staircase context

The conductor doesn't meet expectations as an autonomous driver. The full vision is a five-rung staircase (trustworthy verdicts → in-turn loop ownership → segment autonomy → checkpoint-autonomous → fully autonomous), decided as "start narrow, aim wide": ship the floor first, earn each rung by demonstrated trust. This spec covers **Rungs 1+2 together**, the smallest coherent first slice, with **decomposition explicitly deferred to a later rung** (out of scope here).

Two live failures motivate it, both from the same Perihelion session:
- **Turn 3** ("implement the entire plan in one pass"): routed `topology=recursive`, 0 writes, 1 read — narrated a plan and was marked `success`.
- **Turn 7** ("execute phase 2"): 39 tool calls, 35 reads, 0 writes, ran 9.6 minutes to the turn-budget wall before giving up.

**Reframed thesis (locked):** the goal is not a bigger executor brain — it's a conductor capable enough to audit and repair a *sub-par* executor's work until it's actually good, proven by holding the executor constant (even downgraded) while upgrading conductor supervision.

## 2. Locked decisions

| Fork | Decision |
|------|----------|
| Scope | Rungs 1 (trustworthy verdicts) + 2 (in-turn loop ownership) as one project. Decomposition (facet #3, true multi-turn planning) deferred to a later rung — smallest scope now. |
| Intervention model | **Hybrid (Approach C).** Deterministic reflexes handle the obvious/cheap cases with zero inference; only genuinely ambiguous mid-loop calls escalate to the resident local conductor. Full resident-model-owns-everything (Approach B) is the future goal, not now. |
| Candidate conductor models | Both downloaded GGUFs (`Qwythos-9B-Claude-Mythos-5-1M-MTP-Q4_K_M`, `nanbeige4.2-3b-Q6_K`, at `E:\models\gguf\`) are evaluated **as the resident always-on local conductor** (routing + supervision + the new mid-loop checkpoint) — not as executor swaps. Executor held constant so any lift is attributable to conductor supervision, matching the reframed thesis. |

## 3. Rung 1 — topology-invariant trust (root cause confirmed)

`PipelineExecutor.execute()` (pipeline.ts) has two `evaluateEffectGate(...)` fallback calls (~L3941 and ~L3983) that omit `request`/`assumeWriteIntent` — every other call site in the file (~L3452, 3500, 3730, 3760) passes both. Without them, write-intent silently collapses to "is the profile `full`?" instead of what was actually asked. Turns whose route reaches these two fallback calls without an executor-site gate having already fired (recursive/planner-heavy routes did, in the observed incident) get a **free pass on zero writes**.

**Fix:** thread `request` (the method's own parameter) and `options.taskRunWriteIntent` into both calls, matching the established pattern exactly. This makes the no-write fence topology-invariant by construction — every route funnels through the same `execute()`, so one fix covers all topologies.

## 4. Rung 2 — in-turn loop ownership

### 4.1 Intervention vocabulary

```ts
type LoopIntervention =
  | { kind: "continue" }
  | { kind: "inject"; note: string }
  | { kind: "force_write"; note: string }       // reuses existing WRITE_EFFECT_NUDGE machinery
  | { kind: "redirect"; tool: string; note: string }  // reuses existing dead-tool tracker
  | { kind: "abort"; reason: string };           // ends the turn NOW with a clean partial, not a timeout
```

### 4.2 Deterministic reflexes (zero inference)

Evaluated every executor turn-loop iteration, right alongside the existing `shouldPressWriteEffect` check (pipeline.ts `runExecutorStage`, ~L2141-2168):
- structurally-dead tool (existing `DeadToolTracker`) → `redirect`
- write-intent turn, reads ≥ N, 0 writes, stage-remaining-budget below a "still time to recover" threshold → `force_write` (generalizes today's `shouldPressWriteEffect`/nudge)
- write-intent turn, 0 writes, stage-remaining-budget below a **critical** threshold → `abort` (turn-7's fix: a clean early partial instead of a 9.6-minute timeout)

### 4.3 Resident-model escalation (the ambiguous middle only)

When reflexes are inconclusive (e.g., many reads, some but not enough writes, budget not yet critical — "is this productive exploration or a spiral?"), escalate to the resident conductor. **No new wiring needed**: `LiveConductor`'s `supervisorModel` is already bound in `index.ts` (`localSupervisor` → `persistentConductor.supervise(...)`) — the escalation is a new method on `LiveConductor` reusing that same call, with its own compact prompt/schema, under a bounded per-turn escalation cap (mirroring the existing 4/run stage-supervision cap).

### 4.4 Config

New `orchestrator.conductor.in_turn_driver` block: `{ enabled: false, min_reads_before_spiral_check: N, force_write_budget_floor_ms, abort_budget_floor_ms, max_escalations_per_turn }`. Default off, canary before default-on — mirrors the verification-gate rollout pattern.

## 5. Model A/B (operational, tied to the same thesis)

Register both GGUFs as Ollama models (Modelfile pointing at `E:\models\gguf\...`), then A/B each as `orchestrator.conductor.model` against the current `qwen3.5:4b`, executor/model pool held constant, measuring: routing JSON-schema adherence, supervision decision quality (does it correctly call `abort`/`force_write` on the reflex-ambiguous cases), and latency (resident conductor is on the hot path — a 9B model's tokens/sec matters). This validates *which* model should sit in the resident-conductor role Rung 2 is built around.

## 6. Success criteria

- Rung 1: a zero-write, write-intent turn is caught (`no_write_effect`) across linear/recursive/cascade — new cross-topology regression test.
- Rung 2: replaying Perihelion turn 7's shape (large multi-file phase, read-heavy) no longer runs to the 8-minute wall — either converges on a write or `abort`s early with a clean partial.
- Reflex/escalation costs stay bounded (most turns: zero extra inference).
- Full `bun test` green; behind `in_turn_driver.enabled` (default off).

## 7. Out of scope

Rung 3+ (segment/cross-turn/full autonomy), true decomposition, Approach B (resident owns the whole loop) — all explicitly deferred.
