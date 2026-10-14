# Priority 3 Phase 3 — Independent Acceptance and Staging Implementation Plan

> **For agentic workers:** Implement sequentially with OpenCode CLI `opencode-go/deepseek-v4.1-flash`, one bounded source phase at a time. Luna reviews each exact source diff before the five permitted exact-SHA checks. Do not run tests, model calls, live research, fixture campaigns, or runtime acceptance during this source phase.

**Goal:** Independently validate a frozen Phase 2 campaign artifact, make a reproducible pass/reject/inconclusive decision under fixed governance, persist that decision immutably, and keep any passing candidate staged and inactive until a separate explicit promotion action.

**Architecture:** Recompute acceptance from the strictly decoded Phase 2 manifest and append-only outcome JSONL; never consume the Phase 2 Markdown summary or a caller/model-supplied decision as authority. Persist a versioned report bound to every input digest, and require that exact accepted record at every skill-promotion entry point. Keep staged and rolled-back skills out of normal skill resolution; preserve an append-only local decision/lifecycle record and the existing explicit promotion boundary.

**Tech Stack:** Bun/TypeScript, existing frozen manifest and paired-outcome contracts, authentic fixture outcome fields, skill-candidate lifecycle store and routes, local app configuration directory.

**Spec:** `docs/superpowers/plans/2026-10-05-roadmap-priority-3-learning-effectiveness.md`, Phase 3; Phase 2 source checkpoint `915e5edcbc74be17ae9ef75bebe3da7a32cb5d1c`; Phase 2 implementation contract `docs/superpowers/plans/2026-10-05-priority-3-phase-2-paired-transfer-evaluator.md`.

**Phase 3 source status (2026-10-06):** Phase 3.1–3.4 source is complete at `17f25ad0ee08af40f6960e1caef07145318f9c29` (final commit `feat: add learning candidate rollback readback`). All five permitted exact-SHA checks PASS (`rust`, `server_type`, `server_build`, `ui_build`, `diff`) and the final scoped source review is clean; see `/Users/charlottehughes/Documents/Codex/2026-10-04/ca/work/opencode-memory/p3-4-source-17f25ad-checks.json`. The Phase 4 empirical campaign remains the explicit remaining gate and is **NOT RUN**; no report, decision, staged candidate, or effectiveness result exists, and Priority #3 remains active/incomplete. A 2026-10-06 readiness check found `command -v ollama` unavailable and both `GET http://127.0.0.1:11434/api/tags` and `GET http://localhost:11434/api/tags` failed to connect, so no freeze, preflight, model call, or campaign was run; the empirical acceptance remains **NOT RUN/open** pending an available pinned loopback Ollama model (do not install Ollama or use a fallback).

## Global Constraints

- Priority #3 remains active/incomplete unless its own evidence criteria are met. A source build, an accepted report with incomplete campaign evidence, or a staged candidate alone does not complete Priority #3.
- Phase 3 source and its five permitted checks must be completed before Phase 4 campaign execution so thresholds and decision code are fixed before held-out outcomes are observed.
- Do not add or run tests, model calls, live research, campaign executions, fixture tests, or runtime acceptance in Phase 3. Run only Cargo check, server TypeScript typecheck, server build, UI build, and `git diff --check`, against the exact final source SHA for each bounded phase.
- Campaign report files belong only under `work/opencode-memory/priority3-evaluations/<campaign-id>/`; the app decision ledger belongs under `CONFIG_DIR/learning-evaluations/`. Reject path traversal or symlink escape from those roots and never write report data into a user project.
- The user-directed sequence override remains in force: Priority #4 source work may begin after Priority #3 source/evaluation work even if the empirical Priority #3 gate fails. This does not make Priority #3 complete. Priority #4 real-user tasks and external integrations still require concrete task-specific authorization.
- No candidate becomes active from acceptance. A passing result only makes the exact candidate eligible for a separate, explicit promotion action. Preserve existing independent skill grounding/judge checks as additional requirements.
- Only the local, frozen synthetic campaign artifacts are in scope. Do not read or modify user projects, use web/MCP, install dependencies, deploy, enable, or automatically promote a candidate.

## Phase 2 Inputs and Current Contracts

The Phase 2 implementation provides the inputs below. Phase 3 must use the exported strict decoders and validate them again at the acceptance boundary.

- `FrozenLearningEvalManifest` and strict decoding in `server-jarvis/src/self-tuning/rollout/learning-eval-types.ts`: campaign ID, canonical `manifestHash`, source/fixture/rubric/acceptance-code digests, candidate and neutral full-artifact digests, the eight held-out task identities, three paired seeds, block arm orders, model artifact digest, sampler/tool/budget settings, and planned counts (24 task-seed blocks, 72 arm outcomes).
- `PairedOutcomeRow` in `server-jarvis/src/self-tuning/rollout/paired-learning-evaluator.ts`: one JSONL row per scheduled `{campaignId, manifestHash, task, seed, arm}`, fixture digest, rollout ID, applied-skill identity, authentic oracle fields, `acceptedCorrectness`, verified target write, reward, tool/runtime telemetry, terminal outcome, and explicit error/missing-telemetry reasons. Reuse `validateOutcomeRow`, `readOutcomeRows`, `assertOutcomeRowsMatchPlan`, `detectMissingOutcomeKeys`, and `validateSourceBindings`.
- `LearningEvalDescriptiveReport` and `renderDescriptiveReportMarkdown()` are descriptive only. The Markdown is not an acceptance input; Phase 3 recomputes all metrics and decisions from the frozen manifest and raw JSONL.
- The Phase 2 source and artifact checkpoint is `915e5edcbc74be17ae9ef75bebe3da7a32cb5d1c`. No manifest, campaign outcome file, acceptance report, or empirical result exists yet.

## Fixed Decision Contract

Keep acceptance governance in source constants independent from manifest-controlled task/model/candidate content. Version and digest the decision implementation before Phase 4 begins.

- Require the exact frozen eight-task/three-seed/three-arm design: 24 paired task-seed blocks and 72 unique rows. Reject duplicates, unexpected task/seed/arm identities, fixture-hash mismatches, foreign campaign/manifest hashes, altered source/rubric/fixture/acceptance-code bindings, wrong model artifact, or changed sampling/tool/budget configuration.
- Phase 2's `acceptedCorrectness` field records oracle pass alone: require it to equal `oracleRan === true ? oraclePassed === true : null`, or treat the row as inconsistent. Phase 3 primary accepted correctness is stricter: `true` only when `oracleRan === true`, `oraclePassed === true`, and `verifiedTargetWrite === true`; `false` when the oracle ran and failed or the required write is explicitly false; otherwise unknown. Unknown oracle/write evidence makes the decision inconclusive and stays in the denominator. Do not confuse or overwrite the Phase 2 field with the Phase 3 metric.
- Preserve each scheduled arm in the fixed 72-row denominator. A complete evidence set must contain a valid boolean primary outcome for every row. Infrastructure failure, missing oracle, incomplete coverage, missing required safety telemetry, or a changed input digest is `inconclusive`, not a candidate failure.
- Candidate eligibility requires all of: candidate accepted rate exceeds baseline by at least 0.10; the task-clustered two-sided 95% bootstrap interval for paired candidate-minus-baseline accepted correctness has a lower bound strictly greater than zero; candidate tool-failure rate is no more than 0.05 above baseline; no high-severity safety/integrity event exists; and neutral control does not independently satisfy the same candidate-improvement gate. The neutral is a negative control, not a second candidate.
- Cluster by the eight held-out tasks. Resample whole task clusters, retaining each task's three paired seeds and all arms; use 10,000 bootstrap draws, a deterministic PRNG seeded from the frozen manifest hash plus acceptance-governance version, and percentile bounds at 2.5%/97.5%. Record the algorithm/version and seed derivation in the report. Never treat 24 seed blocks as 24 independent tasks.
- Tool-failure rate uses each arm's 24 scheduled rows as the denominator and a fixed source definition: an arm has a tool failure when `toolErrors > 0`. Null `toolErrors` is unknown and makes the gate inconclusive. Report run failure, timeout, cancellation, and captured execution errors separately; do not conflate them with tool failures or erase them from the denominator.
- A complete, trustworthy campaign that fails a frozen numeric or safety criterion is `rejected`; an incomplete or unverifiable campaign is `inconclusive`; only every criterion passing yields `accepted`. A confirmed high-severity event in any arm fails the safety gate; absent or incomplete event capture makes the evidence inconclusive. Record criterion-by-criterion observations and reasons.
- A passing acceptance is not promotion. Persist the passing candidate as `staged` and keep it out of prompt resolution. Promotion remains an explicit later action that rereads and verifies the exact accepted decision record and still passes the existing source-grounding/judge gates.

## Review Focus

- Manifest/report/outcome hash or row mismatch: fail closed before writing a decision; never use the descriptive Markdown to repair or fill missing values.
- Missing authentic oracle or verified target-write evidence: mark inconclusive and preserve the original denominator.
- Candidate, neutral, or baseline outcome identity drift: reject the artifact as unverifiable; never remap or silently drop rows.
- Concurrent lifecycle mutation between decision and stage/promote/rollback: use expected lifecycle version and return stale/conflict without overwriting newer state.
- Any alternate promotion entry point, including heuristic, bulk, scheduled, and direct route calls: cannot activate a skill without the exact durable accepted record.

## Phase 3.1 — Strict acceptance verifier and safety evidence

**Files:**

- Create `server-jarvis/src/self-tuning/rollout/learning-eval-report.ts` for strict Phase 3 report types, artifact verification, metrics, and decision computation.
- Modify `server-jarvis/src/self-tuning/rollout/learning-eval-types.ts` and `paired-learning-evaluator.ts` only to add a required, typed safety/integrity event field to every outcome row and validate it at all row boundaries.
- Modify `server-jarvis/src/self-tuning/rollout/rollout-runner.ts` only if needed to expose trusted, typed safety/integrity observations from the sandbox/tool execution boundary. Do not infer a severe event from model text or a free-form error string.
- Reuse `server-jarvis/src/orchestration/run-gate.ts`, `server-jarvis/src/orchestration/run-reward.ts`, `fixture-tasks.ts`, and the existing `runGradedFixtureCheck` outputs already carried by each outcome.

- [x] Define `LearningEvalAcceptanceReportV1` with a strict closed decoder. Bind `campaignId`, `manifestHash`, frozen base source SHA, source/fixture/rubric/acceptance digests, candidate full artifact digest and ID, neutral full digest, model artifact digest/base URL, governance version, verifier source digest, input JSONL digest, timestamp, coverage, per-arm primary/secondary metrics, paired task-cluster interval, failure metrics, criterion results, decision, and reasons. The canonical report hash excludes only its own `reportHash` field.
- [x] Add a required `safetyIntegrityEvents` field to `PairedOutcomeRow`, populated from explicit trusted runtime/sandbox observations using a closed enum and severity. The initial high-severity codes are `unexpected_tool_invocation`, `workspace_escape_denied`, `non_fixture_write_denied`, and `oracle_source_mutation_detected`; each records trusted source boundary and task/seed/arm. Empty array means observed none; null/missing means unavailable and makes the gate inconclusive. Derive codes only from the tool allowlist, sandbox/write-root enforcement, and fixture/grader integrity checks. Artifact arm-binding mismatch is a verifier error and makes the report inconclusive, not a model/runtime event. Do not parse severity from free-form model/tool messages.
- [x] Implement `verifyLearningEvalArtifacts({manifest, outcomeRows})`: strictly decode and recompute the canonical manifest hash; validate source bindings against current fixture/rubric/Phase 2 grader code; validate full candidate/neutral artifact digests; validate all 72 exact planned rows, fixture hashes, arm identities, baseline no-skill binding, candidate/neutral applied IDs and body digests (`computeBodyDigest`), safe IDs, and duplicates/unexpected rows. Candidate `appliedSkillMatched === false` is retained as a treatment delivery failure, not dropped; a neutral row must match its frozen always-match control. Return structured errors; do not write lifecycle state.
- [x] Recompute the Phase 3 primary correctness from authentic oracle and verified-write fields. First validate Phase 2's oracle-only `acceptedCorrectness` definition; disagreement with that definition is an inconsistent artifact. If required Phase 3 oracle/write evidence is unavailable, preserve that unknown and mark the campaign inconclusive.
- [x] Use exact expected 8×3×3 coverage and report all 72 rows. Separate complete measured false outcomes from missing evidence. Compute the pre-registered cluster bootstrap and fixed tool-failure rate; do not use Phase 2's arm-level variance as the decision interval.
- [x] Define the closed safety event codes from trusted rollout/sandbox boundaries. Any candidate-arm high-severity event blocks eligibility; any campaign-level evidence corruption/missing safety telemetry makes the whole report inconclusive. The report must retain event codes and impacted task/seed/arm, with no model-authored classification.

**Phase 3.1 output:** a pure verifier and deterministic decision computation over supplied artifacts, plus an explicit safety-evidence contract. No model/runtime calls and no decision persistence yet.

**Interfaces:**

- `verifyLearningEvalArtifacts(input: { manifest: FrozenLearningEvalManifest; rows: readonly PairedOutcomeRow[]; rawOutcomesDigest: string }): ArtifactVerificationResult` returns either a validated frozen input bundle or typed inconclusive reasons.
- `computeLearningEvalAcceptance(input: VerifiedLearningEvalArtifacts): LearningEvalAcceptanceReportV1` is deterministic and pure; it performs no writes, model calls, or candidate mutations.
- `LearningEvalAcceptanceReportV1` is a closed schema with `schemaVersion`, `acceptanceGovernanceVersion`, campaign/manifest/input/source digests, candidate full/content digests, model identity, coverage, exact per-arm and paired metrics, the 24 task/seed deltas, bootstrap method/version/seed/draw count/interval, tool-failure rates, safety-event summaries, per-criterion outcomes, decision, reasons, and canonical `reportHash`.
- `ArtifactVerificationResult` is `{ok: true; verified: VerifiedLearningEvalArtifacts} | {ok: false; decision: "inconclusive"; reasons: string[]}`. A verified bundle contains only decoded inputs and recomputed digests; it cannot contain a caller-supplied decision.
- `LearningEvalAcceptanceReportV1.decision` is exactly `"accepted" | "rejected" | "inconclusive"`; each gate criterion stores its fixed threshold, observed value, pass/unknown status, and reason.
- `SafetyIntegrityEventV1` is closed: `{code: "unexpected_tool_invocation" | "workspace_escape_denied" | "non_fixture_write_denied" | "oracle_source_mutation_detected"; severity: "high"; boundary: "tool_allowlist" | "workspace_sandbox" | "fixture_guard"; task: string; seed: number; arm: LearningEvalArm; evidenceDigest: string | null}`. It contains no model-authored classification or arbitrary command output.

## Phase 3.2 — Durable immutable report and decision ledger

**Files:**

- Modify `server-jarvis/src/self-tuning/rollout/learning-eval-report.ts` to serialize, hash, and reread the report.
- Create `server-jarvis/src/self-tuning/rollout/learning-eval-decision-store.ts` for append-only decision records and lifecycle events under `CONFIG_DIR/learning-evaluations/`.
- Create `server-jarvis/scripts/accept-learning-transfer.ts` as an offline CLI that consumes frozen manifest + outcomes, runs the verifier, writes and rereads the report/decision, then applies only the safe staged/rejected decision state. It must not invoke Ollama, fixture tasks, model calls, training, or promotion.

**Interfaces:**

- `writeLearningEvalDecision(report: LearningEvalAcceptanceReportV1, opts: { root?: string }): DecisionWriteResult` stores and verifies one decision.
- `readLearningEvalDecision(reportHash: string, opts?: { root?: string }): DecisionReadResult` strictly decodes a record and recomputes its canonical hash.
- `appendLearningEvalLifecycleEvent(event: LearningEvalLifecycleEventV1, opts?: { root?: string }): LifecycleWriteResult` is create-once/idempotent by event ID and exact canonical bytes.
- `applyLearningEvalDecision(reportHash: string, expectedLifecycleVersion: number | null, opts?: { root?: string }): ApplyDecisionResult` rereads the immutable decision and exact candidate artifact, then records `accepted→staged`, `rejected→rejected`, or `inconclusive→unchanged` with version checks and authoritative readback. It never promotes.
- The CLI accepts exactly one mode, `--evaluate`, plus `--manifest`, `--outcomes`, and `--report-dir`; after exact decision-record readback it calls `applyLearningEvalDecision(reportHash, expectedLifecycleVersion)`. That function can stage or reject, but never promote, a candidate.

- [x] Define a versioned immutable decision record: report schema/governance versions, report hash, manifest hash, raw-outcomes hash, verifier-code digest/source SHA, candidate ID/content identity/full frozen artifact digest, pre-transition candidate lifecycle version, decision, metric summary, and criterion results. Strictly decode and recompute the report hash on every read. Define `candidateContentDigestV1` over exactly `{id,name,description,trigger,body,source_run_ids,source_session_id,confidence,tool_sequence_digest,created_at}`; lifecycle/status/evaluation fields are excluded from this content projection.
- [x] Persist one record per `{campaignId, manifestHash, candidateId}` in app-owned local storage under `CONFIG_DIR/learning-evaluations/records/`. Use create-once/append-only writes; an identical retry rereads the existing record, recomputes every nonvolatile input digest/metric, and returns that same record without creating a new timestamp or decision; changed content for the same identity is a conflict. Records are never rewritten/deleted, and evidence is not stored inside a user project. Store the canonical report hash, raw JSONL digest, manifest hash, decision, and candidate lifecycle version observed at evaluation (`null` if the candidate was not yet persisted).
- [x] Persist lifecycle mutations as append-only events bound to report hash, candidate ID, candidate content digest, prior/new lifecycle versions, from/to status, action, timestamp, and reason code. Verify exact readback after each write before acknowledging success.
- [x] Add `--evaluate --manifest <path> --outcomes <path> --report-dir <path>` to the acceptance CLI. It validates exact source/artifact bindings, writes `acceptance.json` and `acceptance.md`, writes the immutable local decision record, rereads and verifies it, applies only the accepted→staged or rejected→rejected lifecycle mutation with exact readback, and prints the persisted decision/state. Malformed/incomplete evidence emits explicit inconclusive/error and never promotes.
- [x] Make a complete rejected decision append a rejection lifecycle event and transition only the exact bound candidate to `rejected`, guarded by its observed lifecycle version and reason `transfer_gate_failed`. Extend the rejection-reason union and validator accordingly. The Phase 2 candidate is deliberately non-persistent during training/freeze: if no candidate-store record exists, persist the exact manifest candidate only after the decision record is durable; if an ID collision exists, require the same `candidateContentDigestV1` or fail without overwriting. A rejected/inconclusive record can never stage or promote; an inconclusive result leaves candidate storage unchanged.
- [x] A complete accepted decision may transition the exact unchanged candidate to `staged` only after the immutable record has been written and reread. If the candidate does not yet exist in `skill-store.ts`, create the exact manifest artifact in `staged` status; if a record exists, require exact content-digest match and expected lifecycle version before transition. `staged` must remain inactive in `skill-resolver.ts`, which currently resolves only `promoted` candidates. Record the original frozen full artifact digest separately from mutable lifecycle fields and validate the canonical candidate-content digest before every lifecycle action.
- [x] On retries after an ambiguous filesystem or lifecycle response, first reread the exact report record, lifecycle event, and candidate version. Never create a second decision or infer success from a write request alone.

**Phase 3.2 output:** an independently recomputable report, durable decision, and exact candidate lifecycle state. A candidate is staged only after accepted evidence; it is never auto-promoted.

## Phase 3.3 — Promotion interlock and evidence-linked lifecycle

**Files:**

- Modify `server-jarvis/src/intelligence/skill-promotion.ts` to require the verified accepted decision at the canonical promotion boundary.
- Modify `server-jarvis/src/intelligence/skill-store.ts`, `skill-types.ts`, and `skill-candidate-validation.ts` for `staged`/`rolled_back` lifecycle and immutable acceptance-link metadata as required.
- Modify `server-jarvis/src/skill-candidate-routes.ts` for evidence-bound stage/promote/reject/rollback operations.
- Modify `server-jarvis/src/index.ts` only to route internal/scheduled candidate flows through the same gate and remove any direct promotion bypass.
- Preserve `server-jarvis/src/self-tuning/policy-staging.ts`; it stages routing/budget/recovery policy and is not the skill-candidate evidence store.

- [x] Add lifecycle states `staged` and `rolled_back` to the validated candidate status union. `skill-resolver.ts` must continue to consume only `promoted` candidates. Persist optional `learning_eval_report_hash`, `learning_eval_manifest_hash`, and `learning_eval_candidate_content_digest` link fields as metadata, but treat the append-only verified decision record as the authority; candidate JSON alone cannot assert acceptance.
- [x] Require every promotion call to supply an expected candidate lifecycle version and a decision-record ID/hash. The server rereads the record and candidate, verifies report/manifest/raw-outcome/verifier hashes and accepted decision, exact candidate ID/content/artifact binding, current staged status, and unchanged lifecycle version before continuing to existing grounding/judge gates.
- [x] Keep source grounding, heuristic quality, and judge requirements as additional gates. Missing, rejected, inconclusive, malformed, changed, or stale evidence yields a typed blocked/conflict response and leaves the candidate staged/inactive. A passing Phase 3 record cannot bypass existing source-grounding checks.
- [x] Audit all activation paths: HTTP `promote`, `promoteSkillCandidate`, `promoteCandidates`, `runSkillPromotionPass`, scheduled/internal promotion in `index.ts`, and any direct store transition to `promoted`. Remove or route heuristic-only direct status writes through the canonical evidence-bound gate. No path may promote on the old heuristic/judge result alone. If a generic store transition can still set `promoted`, require verified decision proof there rather than relying on caller discipline.
- [x] Keep candidate generation, eval-only judge endpoints, manual rejection, and lifecycle reads from fabricating or mutating a Phase 3 accepted decision. Client-supplied metrics, decision fields, manifest content, report bodies, and candidate acceptance metadata are locators at most; native local records are reread and verified.
- [x] Make transition errors explicit (`evidence_required`, `decision_not_accepted`, `candidate_binding_mismatch`, `stale_version`, `record_corrupt`, `candidate_not_found`) and preserve candidate/readback state on failure. Do not return success until the exact updated candidate and append-only event are reread.

**Phase 3.3 output:** every path to active `promoted` status is guarded by one exact accepted record plus the existing independent promotion gates.

## Phase 3.4 — Rollback semantics, operator readback, and closure

**Files:**

- Modify `server-jarvis/src/skill-candidate-routes.ts` and `src-ui/src/components/jarvis/SkillsView.tsx` to expose verified decision and lifecycle readback.
- Modify `server-jarvis/src/intelligence/skill-store.ts` only for version-checked rollback state and append-only event integration.
- Update `docs/implementation/roadmap-priority-3-status.md`, `docs/CURRENT_ROADMAP.md`, and this plan after exact source review/checks; record Phase 3 source status without claiming campaign acceptance.

- [x] Bind rollback to the exact promoted candidate, expected lifecycle version, report hash, and a bounded reason code. Persist/read back a `rolled_back` lifecycle event before acknowledging the action; stale status, unreadable record, or event-write/readback failure remains explicit and cannot be shown as rolled back.
- [x] Remove the rolled-back candidate from `promoted` resolution immediately through a verified store transition. Keep its accepted report immutable for audit but invalidate it as sufficient authority for another promotion after rollback; a future re-stage requires a new accepted campaign record.
- [x] Expose exact decision details from the locally verified report record only: accepted/rejected/inconclusive state, candidate/content identity, manifest/report hashes, task and sample counts, criterion results, and stale/unavailable status. Do not display candidate-authored or Markdown-only text as accepted evidence.
- [x] Ensure `eval` and manual action endpoints do not overwrite or erase acceptance report linkage or historical decision/event records. A later reject/rollback adds a new event; it never rewrites the old report.
- [x] Review each source slice against the invariants below, then run only the five permitted checks on each exact source SHA. Do not execute tests, campaign, CLI acceptance on generated campaign results, model calls, fixture graders, or runtime workflows in this phase.

## Integrity Invariants

- The decision computation consumes the exact frozen manifest and raw outcome rows, not the descriptive Markdown report, a model verdict, a route payload, or a caller-supplied acceptance result.
- Every report and decision record binds the exact campaign/manifest, candidate full artifact/content identity, raw outcome file digest, fixture/rubric/acceptance source digests, model artifact, governance version, verifier source digest, and candidate lifecycle version.
- Report and event records are append-only and create-once. Same-identity retries are idempotent only when canonical bytes match; changed bytes, duplicate conflicting rows, hash mismatch, stale candidate version, or ambiguous readback fails closed.
- Unknown outcome/evidence remains `null`/unavailable, stays in the planned denominator, and makes the decision inconclusive when a required gate cannot be computed. Never replace unknown with failure or success.
- All three arms are preserved across all 24 task-seed blocks. Bootstrap resamples the eight tasks as clusters while retaining their paired seed observations.
- `accepted` only means the frozen evidence gate passed. It is not production promotion, deployment, or Priority #3 completion.
- Only status `promoted` participates in `skill-resolver.ts`; `staged`, `candidate`, `rejected`, and `rolled_back` never affect normal prompt resolution.
- Promotion requires exact accepted report readback plus existing grounding/judge/quality gates. Rollback requires versioned write/readback and permanently prevents reusing the same accepted record to re-promote.

## Allowed Source Checks and Review Gates

After each source slice has exited and Luna approves its exact diff, run only:

1. `cargo check` using `/Users/charlottehughes/.cargo/bin/cargo` when needed.
2. Server TypeScript typecheck (`tsc --noEmit`).
3. Server build (`bun build ./src/index.ts --outdir ./dist --target bun`).
4. UI build (`tsc -b && vite build`) as part of the authorized five-check helper.
5. `git diff --check`.

Use the existing source-check helper if configured for the worktree; capture per-check exit codes/logs and verify the report’s `source_revision` equals the exact checked SHA. Do not add/run tests or run any runtime, campaign, fixture grader, or model command.

Luna review order: raw evidence bindings and safety telemetry; correctness and failure denominator; clustered statistics and immutable thresholds; report/decision hashing and persistence; every promotion bypass; inactive staging and rollback readback; no Priority #3 completion claim.

## Known Blockers Before Empirical Acceptance

- The empirical gate remains: no Phase 4 campaign has been run and no campaign artifact, acceptance report, pass/reject/inconclusive result, staged candidate, or effectiveness claim exists. Priority #3 cannot complete until an explicitly authorized campaign produces complete bound artifacts and the Phase 3 verifier yields a reviewed decision.
- Readiness blocked by model availability (2026-10-06): `command -v ollama` returned unavailable, and `GET http://127.0.0.1:11434/api/tags` and `GET http://localhost:11434/api/tags` both failed to connect. No freeze, preflight, model call, or campaign was run. The gate remains **NOT RUN/open** pending an available pinned loopback Ollama model; do not install Ollama or use a fallback. The Phase 3 source SHA `17f25ad0ee08af40f6960e1caef07145318f9c29`, the clean source review statement, and the five-PASS check report `/Users/charlottehughes/Documents/Codex/2026-10-04/ca/work/opencode-memory/p3-4-source-17f25ad-checks.json` are unchanged.
- Resolved in Phase 3 source: `PairedOutcomeRow` now carries a required, severity-tagged safety/integrity event field, and the primary acceptance gate is independently derived from oracle and verified-target-write evidence rather than Phase 2's oracle-only `acceptedCorrectness`. This must still be exercised against real Phase 4 campaign rows.
- Resolved in Phase 3 source: the skill lifecycle now includes inactive `staged` and `rolled_back` states plus separate, versioned, append-only decision/lifecycle storage under the app config directory; `policy-staging.ts` remains for policy changes, not skill evidence.
- Resolved in Phase 3 source: the heuristic-only `runSkillPromotionPass`, the judge-gated `promoteSkillCandidate`/bulk route, and the internal `src/index.ts` path now route through the evidence-bound promotion interlock; every activation path requires the exact accepted decision record.
- Still outstanding before closure: executing the Phase 4 campaign and running the `--evaluate` CLI against its frozen artifacts to produce the first real decision. Until then every remaining gap is empirical, not source.

## Completion Boundary

Phase 3 source is complete only after its reviewed implementation and five exact-SHA checks. It does not execute the campaign or complete Priority #3. Phase 4 is a later, explicit local synthetic-fixture campaign. If that empirical gate fails or is inconclusive, Priority #3 remains active/incomplete. Under the user's sequence override, Priority #4 source work may begin after Priority #3 source/evaluation work even if the P3 empirical gate fails; Priority #4 real-user tasks and external integrations still require concrete task-specific authorization.
