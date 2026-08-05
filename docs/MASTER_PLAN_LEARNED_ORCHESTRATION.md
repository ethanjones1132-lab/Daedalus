# Learned Orchestration — Roadmap

**Date:** 2026-08-05
**Status:** strategy. Phases A–D are actionable; Phase E is research.

---

## The core insight

Sakana Fugu's result is that a **0.6B–7B learned coordinator** orchestrating three frontier models scores 73.7 on SWE-Bench Pro against Opus 4.8 at 69.2. The intelligence that produced the +4.5 lives in a model smaller than our conductor. It is not big — it is **trained**.

Fugu's coordinator was optimized by CMA-ES (Trinity) and GRPO (Conductor) against task outcomes. Training an orchestrator needs three things:

| Requirement | Sakana | Jarvis |
|---|---|---|
| Reward signal | Benchmark scores | **Compile / test / filesystem ground truth** — denser, objective, already built |
| Rollouts | Frontier API calls — expensive | **Free tier + local — near-zero marginal cost** |
| Parameterized policy | Trained coordinator model | **Missing.** Hand-written heuristics |

The asymmetry that matters: **Sakana's rollouts cost frontier API dollars. Ours cost electricity.** Sakana could not afford 100,000 rollouts over Opus. We can afford 100,000 over qwen3.5 and the free pool.

The cheap pool is not the handicap to overcome. It is the thing that makes the training loop affordable. Nobody has trained an orchestrator over a weak pool because everyone with the expertise to do it is optimizing frontier models, where rollouts are expensive and the base is already strong.

**The gap to Fugu is not model quality. It is that our policy is code and theirs is learned.**

---

## What we keep (Fugu does not have these)

The technical report is explicit: **Fugu has no verifier role.** Its gains come from coordination alone, which works because its workers are frontier-quality. Ours are not — so our verification layer is not a deficiency relative to Fugu, it is the correct compensation for our regime, and it is a genuine lead.

| Asset | Why it matters |
|---|---|
| Ground-truth verification — filesystem snapshots, build gate, write-landing | Fugu has none. For a weak pool this is the difference between progress and noise |
| Replayable evidence store — 364 runs, typed violations, per-stage attributions | This is a **training set**. Sakana had to generate theirs |
| Calibration — reports `partial` when partial | Nobody measures this. It is the most defensible product claim we have |
| Real workspace mutation with proof | Fugu is answer-oriented; we change files and prove it |

**Design constraint for every phase below:** none of these may be traded away for benchmark points. The moment reward can be earned without ground truth, the whole loop rots (see Anti-gaming, Phase B).

---

## Phase A — Raise the floor: eliminate guessing

**Rationale.** Perihelion's failures were not reasoning failures. Six of seven error-causing symbols were fabricated APIs (`juce::isnan`, `StateVariableTPTFilterType::notch`, `Slider::setTextFromValueFunction`). The rest were `edit_file` no-match and 15 straight `executor_no_tool` turns. **Every one was missing input, not weak inference.**

Two reasons this comes first. It is free — local greps and reads, no API quota. And it reduces variance, which the Phase D optimizer needs: a noisy worker makes reward attribution noisy, and CMA-ES will spend its budget chasing that noise.

**A1 — Symbol grounding.** Before a write turn, extract identifiers the task names, grep the project's actual dependency source for them, inject real signatures (or their absence) into the executor prompt. A model told `juce::isnan` does not exist and `std::isnan` does cannot fabricate it.

**A2 — Exact-text edit contract.** The runtime supplies current file content; it does not ask the model to recall it. Before dispatching `edit_file`, verify `old_string` actually occurs in the file. If not, repair locally and retry **in-process** — no new API call.

**A3 — Local pre-flight verification.** Check the model's proposed output against ground truth (symbol exists? string present? path in scope?) before the write lands. This is search on the verification axis, costing zero quota.

**Exit criterion:** fabricated-API and no-match write failures approach zero on a fixture suite. Executor no-tool rate falls from the measured 44%.

---

## Phase B — Make reward objective and hack-resistant

**Rationale.** A learned policy is only as good as its reward. Sakana's own history is the cautionary tale: their AI CUDA Engineer reported large speedups that came from generated code exploiting the evaluation harness rather than being faster. **A search process optimizes exactly what you measure.**

**B1 — Single scalar run reward, ground truth only.** Composed of: writes landed (filesystem diff, not model claim), build/test outcome, plan items verified against acceptance checks. **No model-judged component.** A reviewer model's opinion is not reward.

**B2 — Anti-gaming constraints.**
- Reward requires the *task target* files to change. Writing `NOTES.md` earns nothing.
- The oracle must be one the runtime did not author. A build the agent configured is not an independent check.
- Reward zero, not partial credit, when the check declines. `check_tier: none` must never be profitable — otherwise the optimizer learns to avoid checkable work.

**B3 — Calibration in the objective.** Overclaiming (success declared, check failed) is penalized harder than an honest partial. This bakes our differentiator into what the system optimizes for, rather than leaving it as a property we hope survives.

**Exit criterion:** reward computable offline from a stored run, reproducible on replay, with a written argument for why each term cannot be farmed.

---

## Phase C — Extract policy from mechanism

**Rationale.** Routing decisions are currently constants scattered across modules — `FORCE_WRITE_NUDGE_CAP`, `LOCAL_STAGE_MIN_WINDOW_MS`, `NO_TOOL_DEMOTION_THRESHOLD`, `ERROR_RATE_BENCH_THRESHOLD`, `MAX_DIRECTIVES_PER_TURN`, stage budgets, pipeline inclusion rules, delegate eligibility thresholds. Each was hand-derived from an incident. **That is a policy vector written in prose.**

Every threshold shipped this week was a human reading the evidence store and picking a number. Task 5's no-tool demotion threshold is a hand-derived policy an optimizer would find on its own — along with dozens of interactions nobody would think to write.

**C1 — Define θ.** One explicit parameter vector covering every routing, budget, and threshold decision. Estimated 20–50 dimensions, which is squarely in CMA-ES's comfortable range.

**C2 — Route decisions through a policy object.** Replace module-level constants with lookups against the active θ. `policy-staging.ts` already has `PolicySnapshot`, canary, and last-known-good machinery — this extends it rather than inventing it.

**C3 — Reproducible rollouts.** θ snapshot + fixture + seed must replay to the same trajectory, or the optimizer is fitting noise.

**Exit criterion:** every hand-tuned constant reachable through θ; the current values reproduce today's behaviour exactly as a baseline.

---

## Phase D — Rollout harness and CMA-ES

**Rationale.** This is where Fugu's actual method gets applied. sep-CMA-ES over a config vector is a black-box optimizer — no gradients, no ML infrastructure, no training rig. It is achievable with the pieces we already have.

**D1 — Fixture suite with objective oracles.** 30–50 tasks that compile or run tests. Extend `tier2b` and the existing eval harness. Held-out split from the start — a policy tuned on its own test set proves nothing.

**D2 — Parallel local rollout runner.** Ollama has no quota. Free tier for the lanes that need it. This is offline training, **not** inference-time shotgunning — it never touches a user's turn or their quota. That distinction is the whole reason this is affordable for us and was not for Sakana.

**D3 — sep-CMA-ES over θ** against the Phase B reward. Start with the highest-variance dimensions: model-per-stage selection, budgets, delegate thresholds.

**D4 — Promotion.** Canary → LKG through the existing policy-staging path. A learned θ that regresses calibration is rejected regardless of its score.

**Exit criterion:** a learned θ beats the hand-tuned baseline on held-out fixtures, cost-normalized, without regressing calibration.

---

## Phase E — Learned coordinator (research)

Only after Phase D demonstrates lift. Replace the routing decision with a small trained model rather than a parameter vector — Fugu's actual architecture. Much heavier: needs a policy network, GRPO or equivalent, and far more rollouts.

**Do not start here.** Phase D answers whether the signal exists at all, cheaply. If tuned θ produces no lift on a weak pool, a trained coordinator will not either, and we will have learned that for the price of some local compute.

---

## What we are not doing

- **Chasing a frontier worker pool.** That is Fugu's architecture and it is closed to us. Orchestration multiplies what is in the pool; three ~70-point models coordinating to 73.7 does not imply a 25-point pool reaches 70.
- **Inference-time shotgunning.** Rejected on quota grounds and on evidence: the free pool already took ~15 executor turns and produced zero writes. That is best-of-15, and it failed. Sampling fixes variance; our failures are missing input.
- **Dropping verification to match Fugu's design.** Their workers are frontier-quality. Ours are not.
- **"Crush frontier on benchmarks" as the framing.** Their numbers come from scaffolded systems too. The honest and more interesting claim is cost-normalized parity plus calibration nobody else measures.

---

## The claim this builds toward

> The first trained orchestrator over a free and local model pool — measured cost-normalized, with calibration as a first-class metric.

Fugu leaves an explicit gap: the technical report contains **no ablation with small, local, or cheap workers**, and does not claim orchestration compensates for weak ones. That question is unanswered in the literature.

We are unusually well-placed to answer it: we have the ground-truth harness, the run database, and a rollout cost that rounds to zero. Whether the answer is "further than anyone expected" or "not far," it is worth knowing, and we can find out for the price of local compute.

---

## Sequencing

```
A (raise floor, free)  →  B (reward)  →  C (policy vector)  →  D (CMA-ES)  →  E (research)
```

A and B can run in parallel. C depends on nothing but touches many files, so it should not overlap with A. D depends on all three.

**First concrete step:** Phase A1. It attacks the single largest measured failure class, costs no quota, and needs no new architecture.

---

## Phase A status (2026-08-05)

### A1 — Symbol grounding — **shipped**

- Pure module `server-jarvis/src/orchestration/symbol-grounding.ts`: local identifier extraction (backticks, `a::b` / `a.b.c`, CamelCase, `name(`), stoplist + 8-cap, content-mode grep orchestration with dep-dir miss pass, and `[Runtime grounding: symbol table]` formatting (found hits as `path:line`; missing symbols get an explicit NOT FOUND anti-fabrication line; block budget ~4000 chars).
- Pipeline hook in `runExecutorStage`: on write turns (`requiresWriteEffect`), runs before `delegate_first` so both native `executorMessages` and the Claude delegate prompt receive the same table. Greps go through `runToolCall` (sandbox + `toolCalls` evidence). Compact summary lands in executor `diagnostic_json` (`grounding_symbols_*`). Missing symbols feed A3 via `groundingMissingSymbols`.
- Unit tests: `symbol-grounding.test.ts`. Tier-2B category **E** bait fixture: `clamp_with_lib` in `scripts/benchmark-tier2b/tasks.py`.

### A2 — Exact-text edit contract — **shipped**

- Pure module `server-jarvis/src/edit-contract.ts`: `repairEditPair` / `repairMultiEditPairs` — exact → gutter-strip → whitespace-tolerant unique match (`locateEditMatch`); rewrites `old_string` to the exact on-disk span so a subsequent replace cannot miss.
- Live path: `filesystem-bundle` `edit_file` / `multi_edit` use the contract (parity with legacy `tools.ts` tolerant path that the bundle previously lacked).
- In-process recovery: `substituteToolCall` (tool-heal) accepts optional `fileContent` and, on `old_string not found`, re-dispatches the same tool with repaired args — **no model round-trip**. Pipeline loads live content into that hook after failed edits.
- Pre-dispatch: `runToolCall` runs write preflight (shared with A3) and mutates args when a repair is available before the handler executes.

### A3 — Local pre-flight verification — **shipped**

- Pure module `server-jarvis/src/write-preflight.ts`: before a write lands, check path-in-scope, read-before-edit, old_string present (via A2 repair), multi_edit non-empty apply set, and **fabricated symbols** — identifiers A1 grepped as NOT FOUND must not appear in proposed `content` / `new_string` / patch text.
- Pipeline `runToolCall` blocks denied writes with a clear error (`handler_error` / `policy_denied` for scope) without mutating the file.
- Unit tests: `write-preflight.test.ts`, `edit-contract.test.ts`, extended `tool-heal.test.ts` / `filesystem-bundle.test.ts`.

### Measured

- Targeted suites (edit-contract, write-preflight, tool-heal, filesystem-bundle, edit-match, symbol-grounding) + full `src/orchestration/` suite — pass. `tsc --noEmit` clean.
- Live `--live` measurement against the architecture arm is **pending** (not run in this session).

### Still open

- Phase C θ wiring for grounding / preflight constants.
- Live fixture measurement of fabricated-API / no-match write rates after A1–A3.
