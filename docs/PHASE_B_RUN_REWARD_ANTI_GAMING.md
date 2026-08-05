# Phase B run reward — anti-gaming argument

**Date:** 2026-08-05  
**Code:** `server-jarvis/src/orchestration/run-reward.ts`  
**Exit criterion:** reward computable offline from a stored run, reproducible on replay, with a written argument for why each term cannot be farmed.

---

## Evaluator ownership

The scalar objective is evaluator-owned configuration, not agent policy. Its
three weights and overclaim penalty are fixed by `RUN_REWARD_POLICY`, excluded
from `OrchestrationTheta`, and not accepted from stored run snapshots. A policy
candidate can change behavior, but cannot change how that behavior is scored.

## What is optimized

```
score ∈ [-1, 1] = baseScore(writes, check, plan) − overclaimPenalty
```

| Term | Ground truth | Not used |
|------|----------------|----------|
| **writes** | Paths with real content delta (tool success + path; preferred: write-effect fingerprints) that pass the same target/status filter as the effect gate | Model prose claiming a write; status/log docs; non-target paths |
| **check** | Independent runtime `CheckResult` (`existing` / `builtin`, ran, passed) | Reviewer accept/reject; synthesizer narrative; `synth` tier |
| **plan** | Count of plan items with acceptance checks in status `verified` | Reviewer-mediated grading as a free float (items only count when ledger says verified) |

`declaredOutcome` is **only** an input to the B3 overclaim penalty. It never increases score.

---

## Why each term cannot be farmed

### Writes

1. **Content delta, not claim.** Credit requires a successful write tool (or fingerprint delta). Narrating a patch does not score.
2. **Task targets when known.** If the request/plan names paths, only those paths credit. Writing `NOTES.md` or inventing adjacent files earns zero write term.
3. **Status/log denylist.** Without targets, basenames matching `*_STATUS*.md` / `*_LOG*.md` never credit (same rule as the write-effect gate). A task that *names* `EXECUTION_LOG.md` can still target it explicitly.
4. **Write-required flag.** Read-only turns drop the write weight (re-normalize); inventing fake write-required labels is a policy input from requirement/writeIntent/wroteCode, not from the model.

**Residual risk:** a successful write tool that writes garbage to a target path still earns the write term. That is intentional — the **check** term must fail independent compile/test. Writes alone cannot max the score when a check is required.

### Check

1. **Independent tiers only.** `existing` (project tests) and `builtin` (detected build system) can score 1. `synth` is authored/selected by the runtime → check term **always 0** (cannot farm a self-authored oracle).
2. **Decline is not partial success (B2 hard zero).** On write-required turns, if the check is missing, `tier: none`, or `!ran`, the **entire score is forced to 0**. Partial credit from writes/plan is wiped. Therefore `check_tier: none` is never profitable.
3. **Failed check ≠ decline.** A real fail (`passed: false`) zeros the check term but allows an honest partial (writes may still contribute). That distinguishes “tried and broke the build” from “avoided the oracle.”

**Residual risk:** gaming the *project’s* tests by editing the test file. Mitigated when targets exclude test paths or when the oracle is a pre-existing build the agent did not invent; full hermetic oracles are Phase D fixture design, not B1–B3.

### Plan

1. **Only items with acceptance checks** enter the denominator. Empty check lists do not inflate totals.
2. **Verified status is ledger state** produced by runtime grading paths that already require grounding (writes/checks). Raw model “mark done” without `verified` does not count.

**Residual risk:** weak acceptance kinds. `manual` never auto-verifies; `reviewer_pass` is blocked from being a *reward term* here because plan evidence only counts `status === "verified"` already applied by the ledger, not live reviewer opinion at reward time.

### Declared outcome (B3)

1. **Overclaim penalty.** If `declaredOutcome === "success"` and there is no independent passing check, subtract `OVERCLAIM_PENALTY` (0.5). That is **strictly worse** than the same base terms declared as `partial`/`degraded`.
2. Combined with hard zero on declined checks, claiming success with `check_tier: none` yields **negative** score (`−0.5`), not zero.

---

## Offline replay

Persisted on `agent_runs`:

- `reward_score` — scalar
- `reward_json` — `{ snapshot, breakdown }`

Replay:

```ts
computeRunRewardFromStored(JSON.parse(reward_json).snapshot)
// ≡ original breakdown fields (deterministic)
```

No model calls, no filesystem re-read required when the snapshot already holds `changedPaths` and check/plan fields.

---

## Explicit non-goals (later phases)

- θ-weighting of terms (Phase C)
- CMA-ES over the scalar (Phase D)
- Hermetic fixture oracles the agent cannot edit (Phase D fixtures)
