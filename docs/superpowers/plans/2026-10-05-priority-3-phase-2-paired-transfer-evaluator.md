# Priority 3 Phase 2 — Paired Transfer Evaluator Implementation Plan

> **For agentic workers:** The user-directed production executor is OpenCode CLI `opencode-go/deepseek-v4.1-flash`, one bounded source slice at a time, with Luna review and the five allowed source checks at each exact SHA. Do not run tests or the evaluation campaign in this phase.

**Goal:** Build a frozen, local-only paired evaluator that can compare baseline, a training-derived skill candidate, and a neutral control on separate held-out fixture tasks under identical model and resource budgets.

**Architecture:** Reuse the existing fixture loader, authentic graded-fixture oracle, `runOneRollout`, local Ollama transport, skill candidate validator, and skill resolver. Add a versioned immutable campaign manifest and a non-persistent candidate-injection path that uses the production skill rendering and token budget. The CLI's preflight and artifact schema are implemented here; actual model calls and report-producing runs are deferred to the explicitly authorized Phase 4 campaign.

**Tech Stack:** TypeScript/Bun, existing `fixture-tasks.ts`, `rollout-runner.ts`, `local-call-model.ts`, `ollama-local-transport.ts`, `skill-resolver.ts`, `skill-distiller.ts`, `skill-candidate-validation.ts`, and JSON/JSONL evidence.

**Spec:** [Priority 3 full plan](2026-10-05-roadmap-priority-3-learning-effectiveness.md), especially Phases 2–4. Phase 1 source checkpoint is `77f60d488a5f8f42c321deeb7b154e1def17c88b`.

## Global Constraints

- Priority #3 remains active and incomplete; no empirical benefit or promotion may be claimed from a source build.
- This phase adds implementation only. Do not run repository tests, model calls, live research, or the campaign. The campaign is the separate Phase 4 activity.
- Use only checked-in synthetic fixtures. Do not read or modify user project files, access web/MCP, delegate work, install packages, change credentials, deploy, or promote a candidate.
- The eventual campaign uses one exact installed local Ollama model/version for every arm; absent or mixed identity means incomplete, never fallback.
- Baseline, candidate, and neutral control share each task, seed, model, prompt/directive, tool bundle, concurrency, context/output limits, and time budget.
- Candidate and evaluator must not inspect held-out outcomes before the manifest, candidate body/hash, rubric, thresholds, and split are frozen.
- Every scheduled arm remains in the denominator, including failure, timeout, cancellation, missing oracle, and unavailable telemetry.
- No production trajectory, user Skill store, promotion store, or live SelfTuningStore writes. Temporary evaluation state uses the existing in-memory/no-op safeguards.
- End the source phase with the exact five permitted checks only: Cargo check, server typecheck, server build, UI build, and diff-check. Do not add or run tests.

## Review Focus

- Candidate injection must never persist or promote the candidate and must use the same trigger matching, ordering, token limit, and rendered prompt contract as promoted skills.
- Candidate training evidence must come from a declared training fixture and remain disjoint from the eight held-out fixtures.
- A malformed, mutated, incomplete, or incompatible manifest must stop before any model call.
- Missing authentic oracle or incomplete task/seed/arm coverage must yield `inconclusive`; failed runs cannot disappear from the report.
- A different local model identity, altered budgets, or a changed source/fixture/rubric hash invalidates comparability.

---

## Scope and existing interfaces

The current source provides:

- `TRAINING_TASKS`, `HELD_OUT_TASKS`, and `FIXTURE_K` from `server-jarvis/src/self-tuning/rollout/fixture-tasks.ts`.
- `runOneRollout({ theta, task, seed }, callModel)` from `rollout-runner.ts`; it creates and removes a fresh fixture workspace and consults the authentic fixture test through `runGradedFixtureCheck`.
- `makeLocalCallModel` and `callOllamaChat` for local model execution and sampler statistics.
- `resolveSkillsForTurn` / `appendSkillsToPrompt` for production trigger matching, rendering, and token budget, but current rollout requests do not inject an evaluation-only skill.
- `buildSkillCandidate` and `validateSkillCandidate` for source-grounded candidate construction and strict candidate validation.

Do not edit the CMA-ES optimization loop or expose held-out tasks to candidate generation. Prefer narrow, explicit injected-skill parameters over module-global state.

## Phase 2.1 — Immutable manifest and strict preflight

**Files:**
- Create `server-jarvis/src/self-tuning/rollout/learning-eval-types.ts`.
- Create `server-jarvis/src/self-tuning/rollout/paired-learning-evaluator.ts`.
- Create `server-jarvis/scripts/benchmark-learning-transfer.ts`.
- Read-only reuse of `fixture-tasks.ts`, `ollama-local-transport.ts`, and package configuration.

- [x] Define versioned `LearningEvalManifest` and strict decoder. Freeze campaign ID, base source SHA, fixture/rubric/acceptance code hashes, training fixture and trajectory identity, candidate body+digest, neutral-control body+digest, exact held-out names+fixture hashes, backend/model identity, sampler settings, tool bundle, stage/context/output settings, run deadline, paired seeds, arm order, thresholds, and schema/governance versions.
- [x] Hash the canonical serialized manifest with stable key ordering. A post-freeze mutation, unknown required field, duplicate task/seed/arm key, incorrect fixture split, or invalid hash is a hard preflight failure.
- [x] Preflight requires exactly the existing held-out fixture set, exactly three paired seeds per held-out task, and baseline/candidate/neutral arms for every pair; record the planned count (eight tasks × three seeds × three arms = 72 outcomes; 24 paired task-seed blocks).
- [x] Preflight resolves and pins one installed local Ollama model/version and rejects missing/mixed model identity. No model request runs during preflight or this phase.

## Phase 2.2 — Ephemeral skill injection through the production resolver

**Files:**
- Modify `server-jarvis/src/intelligence/skill-resolver.ts` only to accept a narrowly typed, explicit evaluation-only candidate input.
- Modify `server-jarvis/src/orchestration` call site(s) that attach skills to the prompt, identified during this slice's bounded source map.
- Modify `server-jarvis/src/self-tuning/rollout/rollout-runner.ts` to pass an optional immutable skill override through its existing execution path.

- [x] Add an explicit parameter for at most one validated frozen candidate/control skill; do not read it from user stores, route payloads, environment variables, or a global mutable registry.
- [x] Pass the candidate through existing task type/trigger matching, normal ordering, rendering, and the existing 1,200-token cap. Baseline receives no skill; neutral control receives the manifest-frozen neutral skill through the same path.
- [x] Make the injected skill's body and digest immutable for the whole campaign; fail if its digest differs from the manifest. Verify the executor records which arm skill was applied without changing the task text, oracle, or production skill status.
- [x] Preserve current rollout `NODE_ENV=test` in-memory-store guard and temporary workspace cleanup. Do not run the campaign here.

## Phase 2.3 — Training candidate and paired outcome collector

**Files:**
- Modify `rollout-runner.ts` to return bounded runtime/oracle evidence needed by the evaluator.
- Modify or create a narrowly scoped helper under `server-jarvis/src/self-tuning/rollout/` for training-run evidence and paired arm identities.
- Reuse `skill-distiller.ts` and `skill-candidate-validation.ts` without persistence/promotion.

- [x] Run one declared synthetic training fixture only in the eventual campaign, capture its real in-memory stage/tool trajectory and authentic oracle outcome, and derive a candidate via the existing distiller with `persist: false`. Reject failed, unaccepted, malformed, unsupported, or source-less evidence.
- [x] Require training task/trajectory identity to be absent from every held-out task/seed arm. Freeze and hash candidate body before any held-out result is read.
- [x] For each preregistered held-out task and seed, run baseline, candidate, and neutral-control arms serially in randomized manifest order, with the same local model, `num_ctx=16,384`, `num_predict=1,024`, `temperature=0`, `top_p=0.95`, filesystem-only tools, 180-second model-call deadline, and five-minute total rollout cap.
- [x] Capture exact authentic oracle pass/fail, verified target write, accepted-correctness, reward breakdown, task/arm/seed, wall time, tool errors, model calls, token data when supplied, timeout/cancel state, and resource observations available from the runtime. Missing measurements are `null` with a reason.
- [x] Persist one outcome row for every scheduled arm, even when execution, oracle, or telemetry fails. Keep failures in the denominator and return `inconclusive` for missing evidence or incomplete coverage.

## Phase 2.4 — Artifact integrity, report inputs, and source gate

**Files:**
- Complete `paired-learning-evaluator.ts` and `benchmark-learning-transfer.ts`.
- Create no campaign result artifact in this source phase; Phase 4 creates campaign outputs under `work/opencode-memory/priority3-evaluations/<campaign-id>/`.
- Update the Priority 3 status/handoff only after Luna's review and exact-SHA checks.

- [x] CLI modes are limited to `--freeze`, `--preflight`, and `--campaign`. `--freeze` runs only the training fixture and freezes the manifest; `--preflight` validates source/config/fixture/model readiness without calls; and `--campaign` requires a frozen manifest and performs separate explicit campaign execution.
- [x] Write outcomes as append-only JSONL with stable campaign/task/arm/seed identity and immutable manifest hash; reject duplicate/conflicting writes and detect missing planned rows before report generation.
- [x] Compute only descriptive Phase 2 outputs: accepted correctness by arm, paired candidate-minus-baseline and neutral-minus-baseline deltas by task/seed, variability, sample count, failures, and secondary timing/resource summaries. Phase 3 owns independent acceptance and the pass/reject/inconclusive decision.
- [x] Luna reviews split integrity, candidate injectivity, source/evidence bindings, backend/budget comparability, immutable artifact behavior, complete failure denominator, no production writes, and campaign non-execution.
- [x] Run only the five permitted exact-SHA source checks; add/run no tests and make no model calls.

## Source checkpoint — 2026-10-05

All Phase 2.1–2.4 source items above are implemented and reviewed at exact source SHA `915e5edcbc74be17ae9ef75bebe3da7a32cb5d1c`. Luna's review confirmed that the existing manifest decoder already rejects an empty or whitespace-only oracle tier, so no further source correction was needed. The five permitted exact-SHA source checks all passed with exit code 0: Cargo check, server TypeScript typecheck, server build, UI build, and `git diff --check` (Rust emitted existing warnings; Vite emitted its existing large-chunk advisory). Tests, model calls, the controlled campaign, independent acceptance, staging/rollback, and the effectiveness result have **NOT RUN**; Phase 3 and Phase 4 remain open and Priority #3 stays active/incomplete. This checkpoint records source completion only.

## Handoff and completion boundary

Phase 2 source work does not prove that learning improves future tasks. It must produce a reviewable frozen-evaluator implementation and passing source checks only. The actual campaign is a later, explicit Phase 4 action; Phase 3 must independently validate the report, thresholds, failure denominator, and staging/rollback decision before any candidate can be eligible for explicit promotion.
