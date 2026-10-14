# Roadmap Priority 3 — Learning Effectiveness Implementation Plan

> **For agentic workers:** This plan is executed sequentially by OpenCode CLI model `opencode-go/deepseek-v4.1-flash`, with Luna review and the five permitted source checks after each source phase. Do not begin source edits until the user-directed sequence override and this plan are committed and reviewable.

**Goal:** Demonstrate that one source-grounded reusable skill improves performance on separate, related tasks under a pre-registered, comparable evaluation, and reject candidates that do not show reliable benefit.

**Architecture:** Replace fabricated native learning-session findings with truthful source-backed results or an explicit unavailable outcome. Build a frozen, paired skill-transfer evaluation using the existing local-only rollout path and isolated held-out fixtures; attach exact runtime evidence to a durable campaign record. Keep the evaluator, rubric, thresholds, dataset split, and acceptance evidence independent from candidate generation and promotion, with promotion remaining staged and explicit.

**Tech Stack:** Rust/Tauri learning command and Session/Agent/workspace authority, explicit React Session/run selection, Bun/TypeScript ToolRuntime and self-tuning pipeline, existing Tier-2B fixture tasks and authentic grader, local Ollama `/api/chat`, JSON/Markdown campaign evidence.

**Spec:** `docs/CURRENT_ROADMAP.md`, Priority 3, “Prove that learning improves future work.”

## Global Constraints

- Priority #3 source work and its controlled evaluation are explicitly authorized while Priority #1 and Priority #2 acceptance remain open. Under the user's sequence override, Priority #4 source work may begin after Priority #3 source/evaluation work even if the empirical Priority #3 gate fails; Priority #3 stays active/incomplete unless its own criteria have evidence. Priority #4 real-user tasks and external integrations still require concrete task-specific authorization.
- The production executor is only OpenCode CLI `opencode-go/deepseek-v4.1-flash`; phases are sequential, each with Luna source review and the five allowed checks at the exact source SHA.
- Do not add or run the repository’s tests or install dependencies. The frozen-fixture grader is allowed only as part of the explicitly authorized controlled transfer evaluation in Phase 4; it runs in disposable temporary workspaces.
- Evaluation tasks use only checked-in synthetic fixtures. Do not read, write, or send user project files, call web/MCP/delegate tools, change credentials/settings, download models, install packages, deploy, or promote a candidate into live use.
- Use the already-installed local Ollama model only. If no single installed model can be pinned and identified for every arm, stop with an incomplete/blocked evaluation report; do not substitute another backend.
- Record actual values and mark unavailable values explicitly. Do not treat compiler/build checks as runtime evidence.
- A user-selected Session ID or completed Agent run ID is only a selector. Native must resolve and validate the persisted run→Session→Agent→canonical project-root tuple; Bun must resolve the exact persisted source/trajectory evidence for the same tuple. No caller-provided Agent, workspace, or snapshot is authority.
- If an exact completed run, Session owner, enabled Agent, canonical project root, persisted source evidence, or current ToolRuntime Permission cannot be proven or is ambiguous/stale, return explicit unavailable with no research dispatch and no success-file write.

## Review Focus

- A candidate source run or trajectory must be distinct from every transfer task; prove this from the frozen train/held-out names and hashes.
- The Phase 1 learning command must be reachable from an explicit UI selection bound to one persisted Session and exact completed run; the native command revalidates both identifiers and resolves all authority from native storage.
- Baseline, learned candidate, and neutral control must use the same Ollama model, task snapshot, sampler seed, system/directive version, tool bundle, concurrency, context/output limits, and wall budget. Randomize arm order within every task/seed block.
- Candidate or evaluator content must not alter the independent grader, acceptance thresholds, held-out split, or scoring code after the campaign is frozen.
- Only exact authentic fixture-oracle results count as accepted correctness; model claims and the pipeline’s own completion wording do not.
- Tool failures, timeout, cancellation, incomplete work, missing telemetry, and failed or absent independent checks remain visible outcomes; they cannot become successes or be dropped from the denominator.

## Phase 1 — Truthful learning-source and trajectory evidence

**Files:**
- Modify: `src-tauri/src/commands/jarvis_commands.rs` (`run_learning_session`)
- Modify: `src-tauri/src/jarvis/learning.rs` (source validation and evidence types)
- Modify: `src-tauri/src/commands/sessions.rs` or the nearest existing native query module for a narrow authoritative list of eligible persisted Sessions/runs; selection values are identifiers only.
- Modify: `src-ui/src/components/jarvis/JarvisView.tsx` and create `src-ui/src/components/jarvis/LearningView.tsx` (or the smallest existing Jarvis navigation surface) for explicit Session and exact completed-run selection with clear unavailable/error states.
- Modify: `src-tauri/src/db/migrations.rs` only if existing persisted authorities lack a necessary integrity constraint; do not create a second learning authority or persist caller claims.
- Modify or create: `server-jarvis/src/learning-session.ts` (bounded research orchestration)
- Modify: `server-jarvis/src/native-memory.ts` and `src-tauri/src/jarvis/memory/transport.rs` only for private lookup/request of exact persisted run/session evidence; do not accept a snapshot from the UI.
- Reuse: `server-jarvis/src/web-bundle.ts`, `server-jarvis/src/tool-runtime.ts`, `server-jarvis/src/intelligence/skill-source-evidence.ts`, native `sessions`/`agent_runs`/`stage_runs`/Agent projection authority, and existing Session/workspace validators.

- [x] Add an explicit user flow to select one persisted Session and one exact completed `agent_run_id`. IDs are selectors only. Native rereads the submitted values and validates the run is completed and belongs to the selected Session, resolves the Agent from the persisted Session, verifies the enabled Agent projection, and canonicalizes/revalidates the persisted project root. Reads that fail or return multiple/conflicting rows are unavailable; never use latest-row heuristics or caller-provided identity/scope/snapshot.
- [x] Resolve the exact persisted source/trajectory evidence for that verified run and Session through the private native↔Bun capability. Bun reads authoritative stored evidence by the exact tuple, strictly decodes it, requires a successful stored run, and uses only native-resolved Agent/workspace in the ToolRuntime context. It does not treat a caller-supplied snapshot as stored evidence. Missing or ambiguous evidence returns unavailable before ToolRuntime creation.
- [x] Replace `run_learning_session`’s deterministic `Placeholder finding` synthesis with a bounded typed request to Bun’s research service, dispatched only after the exact persisted tuple has been verified. Findings are grounded in successfully retrieved source material with canonical URL/host, retrieval time, content digest, and bounded source excerpt/reference; native validates the response and every finding before any write.
- [x] Use the existing `web_search`/`web_fetch` ToolRuntime surface and current configured capability policy in a context bound to the validated Session and workspace. No direct HTTP bypass or new Permission was added. Denied, approval-required, missing, malformed, or failed retrieval returns explicit unavailable/partial and does not create an empty output directory or success file.
- [x] Replace `evaluate_source` substring checks with parsed URL hostname checks using exact hostname or subdomain boundaries; malformed URLs and lookalike suffixes are rejected with the rejection reason.
- [x] Ensure returned candidate/source evidence resolves to the exact stored trajectory/run IDs and content digests consumed by the distiller. Strict decoding remains in `skill-source-evidence.ts`; returned evidence uses the validated run identity, not a minted “learning run” ID.
- [x] Luna reviewed the selector, native tuple resolution, Bun persisted-evidence lookup, ToolRuntime Permission context, failure outcomes, URL validation, UI response correlation, and finding-level evidence binding. All five permitted exact-SHA source checks passed for `77f60d488a5f8f42c321deeb7b154e1def17c88b`. No tests or live research requests were run.

## Phase 2 — Frozen transfer-study manifest and isolated paired evaluator

**Files:**
- Create: `server-jarvis/src/self-tuning/rollout/paired-learning-evaluator.ts`
- Create: `server-jarvis/src/self-tuning/rollout/learning-eval-types.ts`
- Create: `server-jarvis/scripts/benchmark-learning-transfer.ts`
- Modify: `server-jarvis/src/self-tuning/rollout/rollout-runner.ts` and/or `server-jarvis/src/intelligence/skill-resolver.ts` only to support explicit, non-persisted candidate injection through the same bounded resolver/prompt contract used by promoted skills.
- Reuse: `fixture-tasks.ts`, `rollout-runner.ts`, `rollout-pool.ts`, `local-call-model.ts`, `ollama-local-transport.ts`, `skill-distiller.ts`, `skill-candidate-validation.ts`, `skill-source-evidence.ts`.

- [x] Define a versioned immutable `LearningEvalManifest` that freezes base source SHA, fixture-source SHA, training-task/source-trajectory IDs and hashes, candidate ID/body hash, neutral-control body hash, held-out task names and fixture hashes, acceptance-code hash, model identity, sampling settings, tool bundle, per-run budgets, paired seeds, randomized arm order, and evaluator/governance version.
- [x] Construct one candidate from a distinct training fixture trajectory; validate it with existing source-grounding/candidate validation. Freeze its body and digest before reading transfer outcomes. A fixed neutral-control skill is declared in the manifest before any scoring.
- [x] Use the existing eight frozen `HELD_OUT_TASKS` as transfer tasks, never pass those tasks to candidate generation, and run three paired sampler seeds per task. This gives 24 matched task-seed pairs for baseline vs candidate; the preregistered neutral control is evaluated against the same baseline/task/seed blocks as a negative control.
- [x] Run the three arms serially with the same installed Ollama model and `/api/show`-confirmed version, `num_ctx = 16,384`, `num_predict = 1,024`, `temperature = 0`, `top_p = 0.95`, the same prompt/directive and stage-budget snapshot, the same filesystem-only tools, and the same timeout (180 seconds per model call, with a five-minute total cap per rollout). Pass the same seed to corresponding arms. Refuse mixed model identities, changed fixture/rubric hashes, missing grader, unsafe workspace, or an expired run budget.
- [x] Keep each task in a fresh temp workspace under strict filesystem sandbox; disable delegates, web/MCP, and network tools; use the no-op telemetry recorder and in-memory self-tuning stores. Delete each temp workspace after its evidence is captured. Do not write evaluation runs to production trajectory or promotion stores.
- [x] Emit structured per-rollout records for both successes and failures: campaign/task/arm/seed, exact source/backend/model/options and prompt hashes, accepted-oracle status, reward breakdown, elapsed time, tool errors, model-call count, input/output token counts when supplied, timeout/cancel state, and resource measures available from the local runtime. Missing measurements are `null` with a reason, never inferred.
- [x] Before Phase 4, Luna checks the frozen split, candidate identity, seed pairing, fixed rubric, local-only constraints, budget enforcement, failure denominator, and absence of production-store writes. Run the five permitted exact-SHA source checks only.

**Phase 2 source checkpoint — 2026-10-05:** All Phase 2 source items are implemented and reviewed at exact source SHA `915e5edcbc74be17ae9ef75bebe3da7a32cb5d1c`. Luna confirmed the existing manifest decoder already rejects an empty or whitespace-only oracle tier, so no further source correction was needed. The five permitted exact-SHA source checks all passed with exit code 0 (Cargo check, server typecheck, server build, UI build, `git diff --check`; Cargo reported existing warnings and Vite its existing large-chunk advisory). Tests, model calls, the controlled campaign, independent acceptance, staging/rollback, and the effectiveness result have **NOT RUN**. Phase 3 and Phase 4 remain open and Priority #3 stays active/incomplete; this checkpoint is source completion only.

## Phase 3 — Independent acceptance, immutable decision gate, and staging/rollback

**Files:**
- Modify: `server-jarvis/src/intelligence/skill-promotion.ts`
- Modify: `server-jarvis/src/intelligence/skill-store.ts` and `skill-types.ts` only as needed to retain evaluation-artifact identity and lifecycle audit fields.
- Modify: `server-jarvis/src/skill-candidate-routes.ts` only as needed to prevent heuristic/judge-only promotion without the required transfer-evaluation evidence.
- Modify or create: `server-jarvis/src/self-tuning/rollout/learning-eval-report.ts`
- Preserve the current `server-jarvis/src/self-tuning/policy-staging.ts` governance boundary unless a concrete source review finding requires a narrow correction.

- [ ] Compute primary accepted-correctness from the frozen authentic grader result and verified targeted write; use a blinded artifact mapping so the evaluator sees arm-neutral IDs. Preserve one result for every preregistered task/seed/arm, including failures and unavailable checks.
- [ ] Pre-register governance outside candidate/model/config input: the candidate is eligible only if it improves exact held-out acceptance rate by at least 10 percentage points, the task-clustered 95% bootstrap lower bound for paired gain is greater than zero, tool-failure rate does not worsen by more than 5 points, no high-severity safety/integrity failure occurs, and required sample coverage/budgets are complete. Report 8 task clusters and 3 repeated seed blocks; bootstrap by task cluster, not by treating all 24 blocks as independent tasks.
- [ ] Report secondary measures separately: median/p90 wall time, model calls, input/output tokens, tool failures, resource data when available, and user intervention (zero only when the evaluation had no user assistance; otherwise count and describe it). Include confidence intervals/variability and limitations; never trade correctness/safety for speed.
- [ ] A missing or malformed campaign artifact, changed hash, insufficient sample, unavailable grader, mixed model, or incomplete block produces `inconclusive` and leaves the candidate unpromoted. A candidate failing the frozen gate is rejected using observed evidence. Infrastructure failure is `inconclusive`, not candidate failure.
- [ ] Record the exact evidence report hash, manifest hash, decision, and candidate lifecycle version in an append-only local evaluation record. Promotion remains a separate explicit action and must require that exact passing report; this campaign does not enable, deploy, or automatically promote any candidate. Existing demotion/rollback behavior remains available if later rollout evidence degrades.
- [ ] Luna reviews evidence provenance, primary/secondary calculations, independent oracle use, and frozen thresholds before the final campaign. Run only the five permitted exact-SHA source checks; no tests.

## Phase 4 — Authorized controlled transfer run and roadmap evidence

**Files:**
- Use: `server-jarvis/scripts/benchmark-learning-transfer.ts`
- Create: `work/opencode-memory/priority3-evaluations/<campaign-id>/manifest.json`, per-run JSONL, and `report.md` (evidence artifacts only; no product or user project writes).
- Update after review: `docs/CURRENT_ROADMAP.md` and a Priority #3 progress/handoff document; update the durable `/Users/charlottehughes/Documents/Codex/2026-10-04/ca/work/opencode-memory/PHASE2-COORDINATION.md` ledger.

- [ ] Freeze and hash the campaign manifest before the first held-out run. Record the current source SHA, model identity/version, all fixed sampling/prompt/tool/resource settings, training and transfer task hashes, neutral control, seed pairs, rubric and threshold versions, and planned run count.
- [ ] Run exactly the preregistered local-only paired campaign; do not inspect outcomes to tune the candidate, rubric, thresholds, prompt, or task split. If any arm cannot satisfy the frozen model/budget, stop and report the incomplete blocks.
- [ ] Capture actual result values and counts. Use the held-out task suite’s pre-existing authentic grader after restoring the canonical grader source; do not allow a model to edit the oracle. Review anonymized outputs independently of the candidate generator and decision calculation.
- [ ] Accept, reject, or mark inconclusive using the frozen Phase 3 gate. Preserve a copy of the evidence report and every input digest. If the candidate passes, leave it staged with explicit evidence; do not promote/enable it in production. If it fails, record rejection/rollback from staging. If there is no measurable improvement, Priority #3 remains incomplete because its own criteria lack evidence; under the user's sequence override, Priority #4 source work may still begin after Priority #3 source/evaluation work, while Priority #4 real-user tasks and external integrations still require concrete task-specific authorization.
- [ ] Publish a concise report containing baseline and candidate identities, source/backend/model/budgets, tasks and sample counts, accepted correctness, latency, tool failures, resource consumption, user interventions, paired variability/CI, failures, decision, limitations, source revision, and exact check outcomes.
- [ ] Record whether all Priority #3 completion criteria have evidence. Priority #3 stays active/incomplete unless its own criteria have evidence. Under the user's sequence override, the separate Priority #4 source plan may begin after Priority #3 source/evaluation work even if the empirical Priority #3 gate fails; Priority #4 real-user tasks and external integrations still require concrete task-specific authorization. Builds never count as runtime evidence.

## Priority #3 completion evidence

- At least one frozen reusable skill candidate improves exact acceptance on separate held-out related tasks under the preregistered paired gate.
- The neutral negative control is rejected or an actually harmful/ineffective candidate is rejected from the observed controlled results; if a promoted candidate later regresses in authorized use, rollback is recorded.
- The report identifies baseline/candidate, source and model, comparable task/budget conditions, all sample counts, variability, interventions, and limitations.
- Candidate generation cannot see held-out task results; evaluator/oracle/criteria are immutable and independent from the optimizer and candidate.
- All five allowed source checks pass at the exact source checkpoint; no test suite is added or run.
- **NOT RUN until Phase 4:** the actual controlled transfer campaign and its acceptance evidence. Source implementation or successful builds alone do not complete Priority #3.
