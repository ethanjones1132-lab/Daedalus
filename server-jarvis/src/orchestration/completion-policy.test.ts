import { describe, expect, test } from "bun:test";
import {
  applyStricterOutcomeFloor,
  decideCompletion,
  isAuthoritativelyGreen,
} from "./completion-policy";

const none = {
  tier: "none" as const,
  ran: false,
  passed: null,
  detail: "",
  command: "",
  durationMs: 0,
};

const green = {
  tier: "builtin" as const,
  ran: true,
  passed: true,
  detail: "",
  command: "cmake --build C:\\cache\\perihelion",
  durationMs: 12,
};

const failedCheck = {
  tier: "builtin" as const,
  ran: true,
  passed: false,
  detail: "build failed",
  command: "cmake --build C:\\cache\\perihelion",
  durationMs: 12,
};

/**
 * 2026-08-05: `decideCompletion` gated verification on `writeIntent` alone —
 * the sticky task-run flag. When a continuation minted a fresh contract that
 * flag went false, so a turn that wrote 21 files and never compiled fell
 * through to `non_write_complete` → success with check_tier="none". That is
 * the `success_without_runtime_check` class (93 violations in replay).
 *
 * Verification is now required on EVIDENCE (a write landed) or on the turn's
 * own requirement, not only on a classification that can be lost.
 */
describe("verification requirement is evidence-keyed, not flag-keyed", () => {
  const base = {
    pipelineOutcome: "success" as const,
    reconciledStatus: "completed" as const,
    repeated: false,
  };

  test("writes landed with writeIntent false still demand verification", () => {
    const d = decideCompletion({
      ...base,
      writeIntent: false,
      wroteCode: true,
      checkResult: none,
    });
    expect(d.runOutcome).toBe("partial");
    expect(d.reason).toBe("write_unverified");
  });

  test("full_execution requirement demands verification even with no flag", () => {
    const d = decideCompletion({
      ...base,
      writeIntent: false,
      requirement: "full_execution",
      checkResult: none,
    });
    expect(d.runOutcome).toBe("partial");
    expect(d.reason).toBe("write_unverified");
  });

  test("writes landed plus a FAILING check is verification_failed", () => {
    const d = decideCompletion({
      ...base,
      writeIntent: false,
      wroteCode: true,
      checkResult: failedCheck,
    });
    expect(d.runOutcome).toBe("partial");
    expect(d.reason).toBe("verification_failed");
  });

  test("writes landed plus an authoritative green is success", () => {
    const d = decideCompletion({
      ...base,
      writeIntent: false,
      wroteCode: true,
      checkResult: green,
    });
    expect(d.runOutcome).toBe("success");
    expect(d.reason).toBe("verified_complete");
  });

  test("a genuine read-only turn is still non_write_complete", () => {
    const d = decideCompletion({
      ...base,
      writeIntent: false,
      wroteCode: false,
      requirement: "workspace_read",
      checkResult: none,
    });
    expect(d.runOutcome).toBe("success");
    expect(d.reason).toBe("non_write_complete");
  });
});

describe("applyStricterOutcomeFloor", () => {
  test("partial + floor success → still partial", () => {
    expect(applyStricterOutcomeFloor("partial", "success")).toBe("partial");
  });

  test("degraded + floor success → still degraded", () => {
    expect(applyStricterOutcomeFloor("degraded", "success")).toBe("degraded");
  });

  test("success + floor degraded → stricter outcome", () => {
    expect(applyStricterOutcomeFloor("success", "degraded")).toBe("degraded");
  });

  test("success + floor failed → stricter outcome", () => {
    expect(applyStricterOutcomeFloor("success", "failed")).toBe("failed");
  });

  test("null floor → base unchanged", () => {
    expect(applyStricterOutcomeFloor("partial", null)).toBe("partial");
    expect(applyStricterOutcomeFloor("success", null)).toBe("success");
  });

  test("undefined floor → base unchanged", () => {
    expect(applyStricterOutcomeFloor("degraded", undefined)).toBe("degraded");
    expect(applyStricterOutcomeFloor("failed", undefined)).toBe("failed");
  });
});

describe("isAuthoritativelyGreen", () => {
  test("tier none with passed true is not green", () => {
    expect(
      isAuthoritativelyGreen({
        tier: "none",
        ran: true,
        passed: true,
        detail: "",
        command: "",
        durationMs: 0,
      }),
    ).toBe(false);
  });

  test("builtin ran and passed is green", () => {
    expect(isAuthoritativelyGreen(green)).toBe(true);
  });

  test("undefined check is not green", () => {
    expect(isAuthoritativelyGreen(undefined)).toBe(false);
  });
});

describe("decideCompletion", () => {
  test("open TaskPlan prevents a successful run", () => {
    expect(decideCompletion({
      pipelineOutcome: "success",
      reconciledStatus: "active",
      writeIntent: true,
      repeated: false,
      checkResult: green,
    })).toEqual({ taskStatus: "active", runOutcome: "partial", reason: "task_plan_open" });
  });

  test("write task with tier none stays resumable", () => {
    expect(decideCompletion({
      pipelineOutcome: "success",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: false,
      checkResult: none,
    })).toEqual({ taskStatus: "paused", runOutcome: "partial", reason: "write_unverified" });
  });

  test("completed plan and authoritative green check can succeed", () => {
    expect(decideCompletion({
      pipelineOutcome: "success",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: false,
      checkResult: green,
    })).toEqual({ taskStatus: "completed", runOutcome: "success", reason: "verified_complete" });
  });

  test("repetition remains degraded even with a green check", () => {
    expect(decideCompletion({
      pipelineOutcome: "success",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: true,
      checkResult: green,
    })).toEqual({
      taskStatus: "paused",
      runOutcome: "degraded",
      reason: "repetition_detected",
    });
  });

  test("partial pipeline cannot become complete through a drained ledger", () => {
    expect(decideCompletion({
      pipelineOutcome: "partial",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: false,
      checkResult: green,
    })).toEqual({ taskStatus: "paused", runOutcome: "partial", reason: "pipeline_partial" });
  });

  test("degraded pipeline cannot become a successful write run", () => {
    expect(decideCompletion({
      pipelineOutcome: "degraded",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: false,
      checkResult: green,
    })).toEqual({ taskStatus: "paused", runOutcome: "degraded", reason: "pipeline_degraded" });
  });

  test("pipeline_failed when pipelineOutcome is failed", () => {
    expect(decideCompletion({
      pipelineOutcome: "failed",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: false,
      checkResult: green,
    })).toEqual({ taskStatus: "failed", runOutcome: "failed", reason: "pipeline_failed" });
  });

  test("pipeline_failed when reconciledStatus is failed", () => {
    expect(decideCompletion({
      pipelineOutcome: "success",
      reconciledStatus: "failed",
      writeIntent: true,
      repeated: false,
      checkResult: green,
    })).toEqual({ taskStatus: "failed", runOutcome: "failed", reason: "pipeline_failed" });
  });

  test("verification_failed when writeIntent + checkResult.passed === false", () => {
    expect(decideCompletion({
      pipelineOutcome: "success",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: false,
      checkResult: failedCheck,
    })).toEqual({ taskStatus: "paused", runOutcome: "partial", reason: "verification_failed" });
  });

  test("non_write_complete when no write intent and completed plan", () => {
    expect(decideCompletion({
      pipelineOutcome: "success",
      reconciledStatus: "completed",
      writeIntent: false,
      repeated: false,
      checkResult: none,
    })).toEqual({
      taskStatus: "completed",
      runOutcome: "success",
      reason: "non_write_complete",
    });
  });

  test("missing checkResult still write_unverified for write intent + completed plan", () => {
    expect(decideCompletion({
      pipelineOutcome: "success",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: false,
    })).toEqual({ taskStatus: "paused", runOutcome: "partial", reason: "write_unverified" });
  });

  test("undefined checkResult still write_unverified for write intent + completed plan", () => {
    expect(decideCompletion({
      pipelineOutcome: "success",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: false,
      checkResult: undefined,
    })).toEqual({ taskStatus: "paused", runOutcome: "partial", reason: "write_unverified" });
  });
});
