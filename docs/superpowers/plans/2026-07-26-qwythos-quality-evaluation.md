# Qwythos Quality Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Prove or disprove that qwythos9b-conductor:latest produces more correct, comprehensive, and verifiably completed implementations than qwen3.5:4b when every other Jarvis runtime variable is fixed.

**Architecture:** Add an opt-in isolated A/B harness that launches two temporary Bun-server instances from the same bundle and copied configuration. The only planned variable is the primary conductor model. Each arm receives paired, randomized coding tasks in fresh workspaces. Canonical hidden tests establish correctness; a fixed independent judge grades comprehensiveness from a blinded diff/test/rubric packet. Latency is recorded but never decides promotion.

**Tech Stack:** TypeScript, Bun, PowerShell, Python Tier-2B fixtures, Ollama.

## Global Constraints

- No production config, deployed listener, self-tuning database, learned policy, or skill candidates may be changed by either evaluation arm.
- The primary outcome is quality: verified-success rate plus comprehensiveness. Latency is secondary telemetry only.
- Both arms use the same built server bundle, agent pool, delegate policy, limits, fixtures, hidden tests, judge model, and judge temperature.
- Persist the bundle hash, source SHA, copied-config hash, conductor actually used, SSE trace, TaskPlan state, test result, diff evidence, and judge verdict for every sample.
- A successful sample requires all four: hidden test pass, expected file effect, terminal TaskPlan with persisted verification evidence, and a judge verdict. A stream ending or achieved-effect early-stop is insufficient.
- Disable conductor learning, policy staging, skill distillation, and automatic promotion in both arm configs.
- Live runs require JARVIS_QWYTHOS_EVAL_LIVE=1. Unit tests must never make inference calls.

---

## File Structure

New files:

- server-jarvis/src/eval/conductor-quality-cases.ts: versioned implementation cases, hidden tests, effect assertions, and completeness rubrics.
- server-jarvis/src/eval/conductor-quality-harness.ts: pure validity, scoring, and paired-comparison functions.
- server-jarvis/src/eval/conductor-quality-harness.test.ts: non-live tests for all scoring rules.
- scripts/run-conductor-quality-eval.ps1: opt-in isolated-server launcher and paired runner.
- docs/evals/QWYTHOS_CONDUCTOR_QUALITY.md: operational protocol and outcome template.

Modified files:

- server-jarvis/src/config.ts: add a read-only JARVIS_CONFIG_PATH override for child processes.
- scripts/benchmark-tier2b/runbench2b.py: share canonical fixture materialization and test overwrite-before-score logic.
- server-jarvis/package.json: add the non-live harness command.

## Decision Rule

The primary comparison is valid successes divided by attempts, plus median comprehensiveness among valid successes.

Promote Qwythos only if a complete 48-trial run, made of eight cases, K=3, and two arms, shows:

1. at least a 5-point valid-success lift or at least one additional valid success;
2. no task category regression above 5 points; and
3. no incomplete or active TaskPlan credited as success.

If the paired confidence interval overlaps zero, record inconclusive and leave the configured primary unchanged.

### Task 1: Add safe, isolated config loading

**Files:**

- Modify: server-jarvis/src/config.ts lines 455-457 and 826-846
- Test: server-jarvis/src/config-regression.test.ts

**Interfaces:**

- Consumes process.env.JARVIS_CONFIG_PATH.
- Produces resolveConfigFile(): string, used by loadConfig only.

- [ ] **Step 1: Write the failing test**

    test("loads JARVIS_CONFIG_PATH without changing CONFIG_FILE", () => {
      const temp = writeTempConfig({ orchestrator: { conductor: { model: "qwythos9b-conductor:latest" } } });
      const previous = process.env.JARVIS_CONFIG_PATH;
      process.env.JARVIS_CONFIG_PATH = temp;
      invalidateConfigCache();
      expect(loadConfig().orchestrator.conductor.model).toBe("qwythos9b-conductor:latest");
      expect(CONFIG_FILE).not.toBe(temp);
      restoreEnv("JARVIS_CONFIG_PATH", previous);
    });

- [ ] **Step 2: Run it**

Run: cd server-jarvis && bun test src/config-regression.test.ts -t "JARVIS_CONFIG_PATH"

Expected: FAIL because loadConfig only reads CONFIG_FILE.

- [ ] **Step 3: Implement the minimal resolver**

    export function resolveConfigFile(): string {
      const requested = process.env.JARVIS_CONFIG_PATH?.trim();
      return requested ? resolve(requested) : CONFIG_FILE;
    }

Use the resolver in loadConfig only. Keep saveConfig writing the canonical CONFIG_FILE.

- [ ] **Step 4: Verify and commit**

Run: cd server-jarvis && bun test src/config-regression.test.ts

Expected: PASS.

    git add server-jarvis/src/config.ts server-jarvis/src/config-regression.test.ts
    git commit -m "feat(eval): allow isolated read-only config override"

### Task 2: Create a suite that catches incomplete fixes

**Files:**

- Create: server-jarvis/src/eval/conductor-quality-cases.ts
- Modify: scripts/benchmark-tier2b/runbench2b.py lines 24-55
- Test: server-jarvis/src/eval/conductor-quality-harness.test.ts

**Interfaces:**

- Produces ConductorQualityCase with id, category, prompt, files, hiddenTest, requiredEffects, and completenessRubric.
- Reuses the existing canonical seed(directory, task) and run_test(directory, source) behavior.

- [ ] **Step 1: Write the case-contract test**

    test("every quality case has a hidden test, required effects, and an edge-case rubric", () => {
      for (const c of CONDUCTOR_QUALITY_CASES) {
        expect(c.hiddenTest.trim()).not.toBe("");
        expect(c.requiredEffects.length).toBeGreaterThan(0);
        expect(c.completenessRubric.some((r) => /edge|empty|error|boundary|existing test/i.test(r))).toBe(true);
      }
    });

- [ ] **Step 2: Define eight cases**

Create two cases in each category: single-file edge repair, cross-file package repair, regression repair preserving existing behavior, and verification-sensitive edit. Every case contains starter files, immutable hidden test, expected file effects, and four to six rubric items. At least four cases must fail a narrow happy-path-only patch.

- [ ] **Step 3: Preserve grading integrity**

Keep run_test as the sole scoring path: it overwrites the test with the canonical hidden test after the agent run. Add a fixture check proving a model-modified test cannot alter the score.

- [ ] **Step 4: Verify and commit**

Run: cd server-jarvis && bun test src/eval/conductor-quality-harness.test.ts

Run: powershell -ExecutionPolicy Bypass -File .\scripts\run-tier2b-benchmark.ps1 -Arm architecture -K 1

Expected: harness test PASS; Tier-2B exits through its dry-run guard.

    git add server-jarvis/src/eval/conductor-quality-cases.ts server-jarvis/src/eval/conductor-quality-harness.test.ts scripts/benchmark-tier2b/runbench2b.py
    git commit -m "feat(eval): add comprehensive conductor quality cases"

### Task 3: Score verified success and blinded comprehensiveness

**Files:**

- Create: server-jarvis/src/eval/conductor-quality-harness.ts
- Test: server-jarvis/src/eval/conductor-quality-harness.test.ts

**Interfaces:**

- Produces evaluateSample(input): SampleVerdict.
- Produces compareArms(qwythos, qwen): ArmComparison.

- [ ] **Step 1: Write the failing hard-gate tests**

    test("a passing test with an active TaskPlan is invalid", () => {
      expect(evaluateSample({
        hiddenTestPassed: true, effectsMet: true, taskStatus: "active",
        verification: { passed: true }, judgeScore: 1,
      })).toMatchObject({ valid: false, reason: "non_terminal_task_plan" });
    });

    test("a verified sample requires every hard gate", () => {
      expect(evaluateSample({
        hiddenTestPassed: true, effectsMet: true, taskStatus: "verified",
        verification: { passed: true }, judgeScore: 0.8,
      })).toMatchObject({ valid: true, comprehensiveness: 0.8 });
    });

- [ ] **Step 2: Implement the report contract**

    export interface SampleVerdict {
      valid: boolean;
      reason?: "hidden_test_failed" | "missing_required_effect" |
        "non_terminal_task_plan" | "missing_verification_evidence" | "judge_unavailable";
      comprehensiveness: number | null;
    }

    export interface ArmComparison {
      attempted: number;
      validSuccessRate: number;
      medianComprehensiveness: number | null;
      categoryRegressions: string[];
      decision: "qwythos_better" | "qwen_better" | "inconclusive";
    }

- [ ] **Step 3: Add paired-decision tests**

Cover an exact tie, one extra valid Qwythos success in 20 paired samples, a five-point comprehensiveness lift, a category regression veto, missing judge output, and an active ledger.

- [ ] **Step 4: Verify and commit**

Run: cd server-jarvis && bun test src/eval/conductor-quality-harness.test.ts

Expected: PASS with no provider or Ollama calls.

    git add server-jarvis/src/eval/conductor-quality-harness.ts server-jarvis/src/eval/conductor-quality-harness.test.ts
    git commit -m "feat(eval): score verified conductor implementation quality"

### Task 4: Build the paired isolated runner

**Files:**

- Create: scripts/run-conductor-quality-eval.ps1
- Modify: server-jarvis/package.json
- Test: server-jarvis/src/eval/conductor-quality-harness.test.ts

**Interfaces:**

- Consumes JARVIS_QWYTHOS_EVAL_LIVE=1, -K, -JudgeModel, and -KeepArtifacts.
- Produces artifacts/conductor-quality/timestamp/report.json and per-sample JSONL evidence.

- [ ] **Step 1: Add refusal and isolation checks**

The runner must refuse without the live environment variable, assign distinct arm ports, use independent temporary config/session/telemetry directories, and reject port 19877.

- [ ] **Step 2: Create temporary arm configs**

Copy current config and overlay only the primary and fallback conductor model plus disabled learning and distillation. Launch server-jarvis/dist/index.js with JARVIS_CONFIG_PATH, JARVIS_SERVER_PORT, and a per-arm telemetry root. Wait for health, assert the reported primary conductor matches the intended arm, and record child command line, bundle SHA, source SHA, and copied-config SHA.

- [ ] **Step 3: Execute paired randomized trials**

For every case/sample pair, randomize arm order, materialize a fresh workspace, submit the same prompt to the child listener, collect SSE and conductor/task evidence, restore the canonical hidden test, run it, inspect required effects, then score. Run both arms before advancing to the next pair. K=3 produces 48 total trials. K=1 is a smoke only and cannot decide promotion.

- [ ] **Step 4: Blind the judge packet**

Use a fixed independent judge model at temperature 0. Supply request, expected effects, redacted diff summary, hidden-test result, and rubric only. Exclude conductor identity, model names, arm ordering, latency, and raw logs. Persist covered/missed items. An unavailable or unparsable judge is judge_unavailable, never success.

- [ ] **Step 5: Add command, run non-live check, commit**

Add eval:conductor-quality to package scripts.

Run: powershell -ExecutionPolicy Bypass -File .\scripts\run-conductor-quality-eval.ps1 -K 1

Expected: explicit opt-in refusal before any child process starts.

    git add scripts/run-conductor-quality-eval.ps1 server-jarvis/package.json server-jarvis/src/eval/conductor-quality-harness.ts
    git commit -m "feat(eval): add isolated paired conductor quality runner"

### Task 5: Validate and make the decision auditable

**Files:**

- Create: docs/evals/QWYTHOS_CONDUCTOR_QUALITY.md
- Modify: README.md only after a passing promotion decision.

- [ ] **Step 1: Validate source**

    cd server-jarvis
    bunx tsc --noEmit
    bun test src/eval/conductor-quality-harness.test.ts src/config-regression.test.ts
    bun test

Expected: all PASS.

- [ ] **Step 2: Build and stamp the tested artifact**

Run: cd server-jarvis; bun run build; Get-FileHash .\dist\index.js -Algorithm SHA256

Record source SHA, dirty state, build time, and bundle hash before either arm starts.

- [ ] **Step 3: Run the live paired evaluation**

Run: set JARVIS_QWYTHOS_EVAL_LIVE to 1, then run scripts/run-conductor-quality-eval.ps1 with K=3.

Expected: 48 attempts, each with terminal TaskPlan evidence, verification evidence, canonical test result, required-effect result, and blinded judge verdict. Crashes, incomplete artifacts, and active ledgers remain failed samples rather than omitted data.

- [ ] **Step 4: Repeat only if inconclusive**

Repeat one complete run with a new timestamp only when the first comparison is inconclusive. Pool data only when bundle, config, and judge hashes match and pair identifiers are preserved.

- [ ] **Step 5: Write the outcome and act only on evidence**

Document fixed variables, case manifest hash, success and comprehensiveness comparisons, category deltas, failure taxonomy, and one decision: retain Qwythos, revert to Qwen, or inconclusive. Update canonical config and perform a post-deploy K=1 smoke only after Qwythos satisfies the decision rule.

## Self-Review

- Spec coverage: controls for conductor identity, quality and completeness, terminal verification, isolation, learning safety, reproducibility, and opt-in live evaluation are explicit.
- Placeholder scan: every task names concrete files, interfaces, commands, and acceptance evidence.
- Type consistency: ConductorQualityCase, SampleVerdict, and ArmComparison are defined before the runner consumes them.

## Execution Handoff

Plan complete and saved to docs/superpowers/plans/2026-07-26-qwythos-quality-evaluation.md. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

