# Verification-Gated Conductor — Design Spec

- **Date:** 2026-07-24
- **Status:** Approved (brainstorm complete) → implementation planning
- **Author:** Ethan + Claude
- **Related:** memory `tier2b-benchmark-diagnosis-2026-07-24`, `orchestrator-audit-2026-06-30`, `jarvis-local-conductor-unblocked`, `jarvis-write-path-fixes-2026-07-17`

## 1. Motivation

The 2026-07-24 tier-2B run (27/30, ~50% over single-deepseek) was root-caused from `self-tuning.db`. Category A (algorithmic, single-file) was 12/12 — the reasoning core is not the bottleneck. Every miss and all the waste was *mechanism*:

1. **Nothing proves the work.** The self-verify loop couldn't fire (harness didn't seed the test — fixed separately), a wrong fix read as `success` (`pkg_auth-1` hallucinated a file that didn't exist), and the self-tuner is trained on narration, not truth. The `outcome` label was anti-correlated with correctness: 0/27 passing runs were labeled `success`; the only `success` labels went to the task that actually failed.
2. **Massive waste.** One-line fixes burned 28–45 tool calls; the executor thrashed against structurally-broken tools (`glob`/`grep` → "Executable not found", `bash` → "not_permitted") and over-ran stages after the goal was met.

Reframe: the highest-potential lever is not more model — it's **closing the loop from execution to verified truth**, and letting the resident local conductor own the runtime decisions with real senses instead of guessing from prose.

## 2. Objective & success criteria

**Objective:** An executed check that passes becomes simultaneously (a) the completion gate and (b) the self-tuner's reward signal — kept cost-neutral by a thrift governor that funds the extra step out of the waste it removes.

Success criteria:
- The 3 tier-2B misses (`pkg_discount`, `pkg_auth`, `safe_divide_batch`) convert to passes on re-run (verification catches the un-applied/wrong fix and repairs it).
- `agent_runs.outcome` correlates with real correctness: verified passes labeled `success`; unverified/failed work is not.
- Median tool-calls-per-change-turn drops materially from the 28–45 range (thrift).
- The self-tuner reward reads executed exit codes, tier-weighted; a model-authored (`synth`) check can never earn full reward.
- Most turns spend **zero** extra inference (deterministic fast-paths); resident-model judgment fires only on ambiguity, within the existing 4/run cap.

## 3. Locked design decisions

| Fork | Decision |
|------|----------|
| When verify & thrift tension | Neither wins — the executed check is both the correctness gate and the learning signal; thrift keeps it cost-neutral. |
| Check source | **Tiered**: `existing` → `builtin` → `synth` → `none`, with reward tiers (existing/builtin full, synth partial/reviewer-gated, none = heuristic). |
| Who runs the check | **Runtime-owned, deterministic** (Approach C). The runtime executes the check and captures the exit code — the model never decides whether it passed. Ungameable reward by construction. |
| Reviewer | Reuse the existing reviewer stage. It becomes a **truth-anchored judge** (receives the `CheckResult` as authoritative evidence), and a strong deterministic check can bypass it entirely (thrift). |
| Conductor ownership | The resident `PersistentConductor` (live-loaded, KV-cached local model) owns the **ambiguous verify/thrift judgments** via `supervise()`; deterministic fast-paths handle unambiguous green/red. Design seams left for future full inner-loop ownership. |

## 4. Architecture

```
executor completes (writeIntent && successfulWrites>0)
        │
        ▼
  ┌─────────────────┐   deterministic, no inference
  │  check-runner   │   detect (tiered) → execute → CheckResult
  └─────────────────┘
        │
        ▼
  conductor decision (LiveConductor.afterStage)
        ├── existing/builtin PASS ──────────► mark_verified(runtime_check); drop queued reviewer; advance   [fast-path]
        ├── any tier FAIL ──────────────────► start_repair_chain(detail injected)                            [fast-path]
        └── synth PASS | none | conflict ───► PersistentConductor.supervise(facts) ──► mark_verified(partial)
                                                                                    │  or escalate_reviewer
                                                                                    │  or start_repair_chain
                                                                                    ▼
                                              reviewer stage (CheckResult injected as authoritative evidence)
        │
        ▼
  reward/self-tuner: runOutcome threads CheckResult → verified_via + check_tier persisted
```

Thrift governors (dead-tool suppression, achieved-effect early-stop) run inside `LiveConductor` off the same signals (`CheckResult`, effect-gate, `onToolResult`).

## 5. Component specs

### 5.1 `check-runner.ts` (façade over existing gates)

**Reuse note:** this is NOT built from scratch. `run-gate.ts` (`runWrittenCodeGate`/`findRunnableTarget`) already does tiered Python target selection (`explicit_test`/`adjacent_test` → existing; `standalone_script` → synth) and captures exit codes; `syntax-gate.ts` (`gateWrittenSyntax`) is the builtin static check. Both are already invoked at the executor site in `pipeline.ts` (~3299-3312). The check-runner is a thin façade that maps these into the tiered `CheckResult` and adds language coverage; language extensions (TS/Rust) are a follow-on phase.


```ts
export interface CheckResult {
  tier: "existing" | "builtin" | "synth" | "none";
  ran: boolean;
  passed: boolean | null;   // null = detected but could not run
  detail: string;           // failing assertion / compiler error, truncated ~400 chars
  command: string;          // executed command, for telemetry
  durationMs: number;
}

export function detectCheck(input: {
  workspaceRoot: string;
  changedPaths: string[];
  planItem?: TaskPlanItem;   // acceptance criteria may declare a synth check
}): DetectedCheck | null;   // { tier, command, cwd } or null → tier "none"

export async function runCheck(detected: DetectedCheck, opts: {
  timeoutMs: number;        // default ~15000
}): Promise<CheckResult>;
```

Detection (deterministic, file-glob + config sniff):
- **existing**: adjacent test files (`_t.py`, `test_*.py`, `*_test.py`, `*.test.ts`, `*.spec.ts`), or declared scripts (`package.json` `scripts.test`/`scripts.typecheck`, `Cargo.toml` → `cargo test`, presence of `pytest.ini`/`pyproject` pytest config).
- **builtin** (no existing): language-native static check on changed files —
  - Python: `python -m py_compile <files>` + optional smoke import.
  - TS/JS: `tsc --noEmit` (scoped) or `node --check`.
  - Rust: `cargo check`.
- **synth**: only when a plan item's acceptance criteria define a check, or the executor wrote a test this turn. Runs it; flagged for partial reward.
- **none**: nothing runnable.

Execution: same sandbox/workspace as the executor (reuse sandbox/`safePath`), bounded timeout, no network, capture exit code + stderr tail. Running model-written code is within the executor's existing trust boundary — no new surface.

### 5.2 Conductor decision flow (`conductor.ts` / `LiveConductor.afterStage`)

New branch after a change-executor completes, before synthesizer:
- Invoke check-runner → `CheckResult`.
- **Fast-paths (no inference):**
  - `existing`/`builtin` && `passed` → `mark_verified` with new `gradingMode: "runtime_check"`; if `reviewer` is queued, remove it (thrift); advance.
  - `passed === false` (any tier) → `start_repair_chain` with `flaggedIssues = detail` so repair targets the real error. Bounded by existing `repairCycleCount`/`maxRepairCycles`.
- **Resident-model judgment** (`PersistentConductor.supervise`) when: `synth && passed`, `tier === "none"`, or a conflict with the effect-gate (`no_write_effect` despite a pass). Supervise input includes the `CheckResult`, effect-gate verdict, and evidence assessment. It returns a directive: `mark_verified(partial)` / `escalate_reviewer` / `start_repair_chain`. Counts against the 4/run supervision cap.
- **Reviewer escalation**: inject `CheckResult` into the reviewer prompt as authoritative evidence (mirror the effect-gate "do NOT contradict this" notice). Verdict → `mark_verified(reviewer_mediated)` or `start_repair_chain` as today.

New directive/type additions: `gradingMode: "runtime_check"` (extend `TaskPlanGradingMode`); optional `require_verification` internal signal is NOT needed — verification is runtime-invoked, not model-requested.

### 5.3 Reviewer integration

No change to the reviewer stage mechanics. Change is in what it receives: an authoritative `CheckResult` block prepended to its context when escalated. Its verdict parsing (`parseReviewerVerdict`) and the `reviewer_mediated` mark path are reused unchanged.

### 5.4 Thrift governors (`LiveConductor`, deterministic)

- **Dead-tool suppression**: in `onToolResult`, track failures keyed by (tool, error-signature). After ≥2 non-recoverable structural failures (`Executable not found`, `not_permitted`, `EACCES` on a system tool), suppress further calls to that tool for the turn and inject a one-line redirect (e.g., "glob unavailable — use read_file/list_directory"). Reuses the tool-heal classification vocabulary.
- **Achieved-effect early-stop**: once a turn has a verified check pass AND the active plan item is `verified`, truncate remaining non-essential stages and route straight to synthesizer.

Both reversible, bounded, no inference. `#4 runtime tool health` (bundling ripgrep / bash permission) remains the root fix; dead-tool suppression is the resilience layer.

### 5.5 Reward / self-tuner (`index.ts`, `self-tuning`)

- Thread `CheckResult` into `runOutcome` derivation:
  - `existing`/`builtin` pass → `success`, full reward, distillation-eligible.
  - `synth` pass → `success` flagged `verified_via: "synth"`, partial reward, distillation-eligible only if reviewer-confirmed.
  - unrecovered fail → `failed`/`degraded` with a real `errorCode`.
  - `none` → today's heuristic path, cross-checked against the `consequentialFailures` effect-gate fix (2026-07-24).
- Persist `verified_via` (`runtime_check` | `synth` | `reviewer` | `heuristic`) and `check_tier` on `agent_runs` (new columns or the existing JSON blob). Dashboards + tuner distinguish verified from heuristic outcomes.
- Anti-gaming property: strongest reward requires a check the model did not author; the runtime captures the exit code, so the pass/fail cannot be fabricated.

### 5.6 Config surface

New `orchestrator.verification` block: `{ enabled: boolean (default false), check_timeout_ms: 15000, tier_reward: { existing:1, builtin:1, synth:0.5, none:0 }, thrift: { dead_tool_suppression: true, achieved_effect_early_stop: true } }`. Feature-flagged; integrates with existing policy-staging (canary/LKG).

## 6. Testing strategy

- **Unit (deterministic, mirror edit-match.test.ts):** check-runner detection per-language fixtures; pass/fail capture; tier assignment. Conductor decision flow with a mocked check-runner + mocked `supervise` (fast-path green/red, ambiguous escalation). Thrift governors (suppression triggers after N, early-stop truncates queue). Reward mapping (tier → outcome/verified_via).
- **Integration:** the tier-2B benchmark is the end-to-end test. Re-run (post-deploy) expects the 3 misses to convert and per-turn tool-calls to drop.
- **Regression:** full `bun test` green; effect-gate and conductor existing suites unaffected.

## 7. Rollout

Config-flagged off → canary via policy-staging → on. Live-fire the tier-2B benchmark against the redeployed server (rebuild server-jarvis to Desktop per the deploy-trap memory; verify via `/health` git_sha) before flipping default.

## 8. Out of scope (future, sequenced)

- **Full inner-loop conductor ownership** (brainstorm option 2): mid-execution resident-model check-in to interrupt thrash in real time. This spec leaves the seams; it lands once option 1 is proven live.
- **#4 runtime tool health**: bundle ripgrep / fix `bash` permission (root fix for dead tools). Queued next.
- **#2 Claude CLI hard-stage escalation**: cost-aware escalation of flaky stages to the `claude_cli` engine to lift the model-pool ceiling. Later priority.
