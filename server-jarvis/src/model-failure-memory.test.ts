import { beforeEach, describe, expect, test } from "bun:test";
import {
  excludedModelKeys,
  HARD_FAILURE_COOLDOWN_MS,
  HARD_FAILURE_STRIKE_THRESHOLD,
  isTemporarilyExcluded,
  recordHardFailure,
  recordStall,
  recordSuccess,
  resetModelFailureMemory,
  STALL_COOLDOWN_MS,
  STALL_STRIKE_THRESHOLD,
} from "./model-failure-memory";

beforeEach(() => {
  resetModelFailureMemory();
});

describe("model-failure-memory", () => {
  test("below strike threshold is not excluded", () => {
    const now = 1_000_000;
    recordHardFailure("opencode_zen", "north-mini-code-free", now);
    expect(HARD_FAILURE_STRIKE_THRESHOLD).toBe(2);
    expect(isTemporarilyExcluded("opencode_zen", "north-mini-code-free", now)).toBe(false);
  });

  test("2 strikes excludes the model", () => {
    const now = 1_000_000;
    recordHardFailure("opencode_zen", "north-mini-code-free", now);
    recordHardFailure("opencode_zen", "north-mini-code-free", now + 10);
    expect(isTemporarilyExcluded("opencode_zen", "north-mini-code-free", now + 20)).toBe(true);
  });

  test("success clears strikes and cooldown", () => {
    const now = 1_000_000;
    recordHardFailure("opencode_zen", "north-mini-code-free", now);
    recordHardFailure("opencode_zen", "north-mini-code-free", now + 10);
    expect(isTemporarilyExcluded("opencode_zen", "north-mini-code-free", now + 20)).toBe(true);

    recordSuccess("opencode_zen", "north-mini-code-free");
    expect(isTemporarilyExcluded("opencode_zen", "north-mini-code-free", now + 30)).toBe(false);
    expect(excludedModelKeys(now + 30).has("opencode_zen:north-mini-code-free")).toBe(false);
  });

  test("cooldown expiry allows one probe attempt, and a subsequent failure re-excludes immediately", () => {
    const now = 1_000_000;
    recordHardFailure("opencode_zen", "north-mini-code-free", now);
    recordHardFailure("opencode_zen", "north-mini-code-free", now + 10);
    expect(isTemporarilyExcluded("opencode_zen", "north-mini-code-free", now + 20)).toBe(true);

    // Still within cooldown window.
    const stillCoolingDown = now + 10 + HARD_FAILURE_COOLDOWN_MS - 1;
    expect(isTemporarilyExcluded("opencode_zen", "north-mini-code-free", stillCoolingDown)).toBe(true);

    // Cooldown window has fully elapsed: one probe attempt is allowed.
    const afterCooldown = now + 10 + HARD_FAILURE_COOLDOWN_MS + 1;
    expect(isTemporarilyExcluded("opencode_zen", "north-mini-code-free", afterCooldown)).toBe(false);

    // A single subsequent hard failure (the probe failing) re-triggers
    // cooldown immediately — no need for a second strike this time, since
    // strikes were only decremented to threshold-1 on expiry.
    recordHardFailure("opencode_zen", "north-mini-code-free", afterCooldown + 5);
    expect(isTemporarilyExcluded("opencode_zen", "north-mini-code-free", afterCooldown + 6)).toBe(true);
  });

  test("cooldown expiry followed by a successful probe clears the entry entirely", () => {
    const now = 1_000_000;
    recordHardFailure("opencode_zen", "north-mini-code-free", now);
    recordHardFailure("opencode_zen", "north-mini-code-free", now + 10);
    const afterCooldown = now + 10 + HARD_FAILURE_COOLDOWN_MS + 1;
    expect(isTemporarilyExcluded("opencode_zen", "north-mini-code-free", afterCooldown)).toBe(false);

    recordSuccess("opencode_zen", "north-mini-code-free");
    expect(excludedModelKeys(afterCooldown + 100).size).toBe(0);
  });

  test("excludedModelKeys returns provider:modelId keys currently in cooldown", () => {
    const now = 1_000_000;
    recordHardFailure("opencode_zen", "north-mini-code-free", now);
    recordHardFailure("opencode_zen", "north-mini-code-free", now + 1);
    recordHardFailure("openrouter", "some-other-model", now); // only 1 strike, not excluded

    const keys = excludedModelKeys(now + 2);
    expect(keys.has("opencode_zen:north-mini-code-free")).toBe(true);
    expect(keys.has("openrouter:some-other-model")).toBe(false);
    expect(keys.size).toBe(1);
  });

  test("strikes for different provider:model keys are independent", () => {
    const now = 1_000_000;
    recordHardFailure("opencode_zen", "model-a", now);
    recordHardFailure("openrouter", "model-a", now); // different provider, same model id
    expect(isTemporarilyExcluded("opencode_zen", "model-a", now)).toBe(false);
    expect(isTemporarilyExcluded("openrouter", "model-a", now)).toBe(false);
  });
});

// ── Stall registry (added 2026-07-16 evening, commit cfba2db) ────────────────
// The 2026-07-16 cross-turn stall incident (session 10cf071d) showed that
// within-call cascade advance isn't enough: a model that stalls at first
// token burns the synthesis runway of every turn. Stalls get their own
// 2-strike / 5-min registry beside hard failures. These tests pin the
// observable contract — the cfba2db commit added the source changes but no
// direct test coverage of `recordStall` / `STALL_*` / cross-registry
// isolation existed in this file.
describe("stall registry (cross-turn stall memory)", () => {
  test("below STALL_STRIKE_THRESHOLD is not excluded", () => {
    const now = 1_000_000;
    expect(STALL_STRIKE_THRESHOLD).toBe(2);
    expect(STALL_COOLDOWN_MS).toBe(5 * 60_000);
    recordStall("opencode_go", "deepseek-v4-flash", now);
    expect(isTemporarilyExcluded("opencode_go", "deepseek-v4-flash", now)).toBe(false);
  });

  test("2 stall strikes excludes the model with stall cooldown", () => {
    const now = 1_000_000;
    recordStall("opencode_go", "deepseek-v4-flash", now);
    recordStall("opencode_go", "deepseek-v4-flash", now + 10);
    expect(isTemporarilyExcluded("opencode_go", "deepseek-v4-flash", now + 20)).toBe(true);
    // Still in stall cooldown (5min) right before expiry:
    expect(isTemporarilyExcluded("opencode_go", "deepseek-v4-flash", now + 10 + STALL_COOLDOWN_MS - 1)).toBe(true);
  });

  test("stall cooldown expiry allows one probe attempt and a subsequent stall re-excludes immediately", () => {
    const now = 1_000_000;
    recordStall("opencode_go", "deepseek-v4-flash", now);
    recordStall("opencode_go", "deepseek-v4-flash", now + 10);
    expect(isTemporarilyExcluded("opencode_go", "deepseek-v4-flash", now + 20)).toBe(true);

    // Cooldown elapsed → one probe attempt allowed.
    const afterCooldown = now + 10 + STALL_COOLDOWN_MS + 1;
    expect(isTemporarilyExcluded("opencode_go", "deepseek-v4-flash", afterCooldown)).toBe(false);

    // A single subsequent stall (the probe failing) re-excludes immediately,
    // starting a fresh stall cooldown at the new failure's timestamp.
    recordStall("opencode_go", "deepseek-v4-flash", afterCooldown + 5);
    expect(isTemporarilyExcluded("opencode_go", "deepseek-v4-flash", afterCooldown + 6)).toBe(true);
  });

  test("stall cooldown expiry followed by a successful probe clears the entry entirely", () => {
    const now = 1_000_000;
    recordStall("opencode_go", "deepseek-v4-flash", now);
    recordStall("opencode_go", "deepseek-v4-flash", now + 10);
    const afterCooldown = now + 10 + STALL_COOLDOWN_MS + 1;
    expect(isTemporarilyExcluded("opencode_go", "deepseek-v4-flash", afterCooldown)).toBe(false);

    recordSuccess("opencode_go", "deepseek-v4-flash");
    expect(excludedModelKeys(afterCooldown + 100).size).toBe(0);
  });

  test("recordSuccess clears BOTH registries for a key (stall + hard-fail)", () => {
    const now = 1_000_000;
    // 1 hard-fail strike + 2 stall strikes → only the stall side is over threshold.
    recordHardFailure("opencode_zen", "model-x", now);
    recordStall("opencode_zen", "model-x", now);
    recordStall("opencode_zen", "model-x", now + 5);
    expect(isTemporarilyExcluded("opencode_zen", "model-x", now + 10)).toBe(true);

    recordSuccess("opencode_zen", "model-x");
    expect(isTemporarilyExcluded("opencode_zen", "model-x", now + 20)).toBe(false);
    expect(excludedModelKeys(now + 20).has("opencode_zen:model-x")).toBe(false);
  });

  test("stall registry and hard-failure registry are independent for the same key", () => {
    const now = 1_000_000;
    // 1 hard-fail (under hard-fail threshold of 2) + 2 stalls (over stall threshold).
    // The model should be excluded (because of stalls) but the hard-fail
    // strike count must be preserved — a hard-fail strike later must still
    // require ONE more hard-fail to cross the hard-fail threshold (i.e. the
    // strike counts do not bleed into each other).
    recordHardFailure("opencode_go", "deepseek-v4-flash", now);
    recordStall("opencode_go", "deepseek-v4-flash", now);
    recordStall("opencode_go", "deepseek-v4-flash", now + 10);
    expect(isTemporarilyExcluded("opencode_go", "deepseek-v4-flash", now + 20)).toBe(true);

    // Cooldown elapsed on the stall side, model gets one probe attempt.
    const afterStallCooldown = now + 10 + STALL_COOLDOWN_MS + 1;
    expect(isTemporarilyExcluded("opencode_go", "deepseek-v4-flash", afterStallCooldown)).toBe(false);

    // Now add a second hard-fail — should cross the hard-fail threshold (2)
    // and re-exclude the model with a HARD-failure cooldown, independent of
    // the (now-decayed) stall state.
    recordHardFailure("opencode_go", "deepseek-v4-flash", afterStallCooldown + 1);
    expect(isTemporarilyExcluded("opencode_go", "deepseek-v4-flash", afterStallCooldown + 2)).toBe(true);
    // And the hard-fail cooldown uses its own 10-min window, not the 5-min stall one.
    const justBeforeHardCooldown = afterStallCooldown + 1 + HARD_FAILURE_COOLDOWN_MS - 1;
    expect(isTemporarilyExcluded("opencode_go", "deepseek-v4-flash", justBeforeHardCooldown)).toBe(true);
  });

  test("excludedModelKeys returns stall-excluded keys with provider:modelId format", () => {
    const now = 1_000_000;
    recordStall("opencode_go", "deepseek-v4-flash", now);
    recordStall("opencode_go", "deepseek-v4-flash", now + 1);
    recordStall("openrouter", "another-staller", now); // only 1 strike, not excluded
    recordHardFailure("opencode_zen", "hard-failer", now);
    recordHardFailure("opencode_zen", "hard-failer", now + 1); // also excluded on hard-fail side

    const keys = excludedModelKeys(now + 2);
    expect(keys.has("opencode_go:deepseek-v4-flash")).toBe(true);
    expect(keys.has("openrouter:another-staller")).toBe(false);
    expect(keys.has("opencode_zen:hard-failer")).toBe(true);
    expect(keys.size).toBe(2);
  });

  test("resetModelFailureMemory clears the stall registry too", () => {
    const now = 1_000_000;
    recordStall("opencode_go", "deepseek-v4-flash", now);
    recordStall("opencode_go", "deepseek-v4-flash", now + 1);
    expect(excludedModelKeys(now + 2).size).toBe(1);

    resetModelFailureMemory();
    expect(excludedModelKeys(now + 2).size).toBe(0);
    expect(isTemporarilyExcluded("opencode_go", "deepseek-v4-flash", now + 2)).toBe(false);
  });

  test("stall strikes for different provider:model keys are independent", () => {
    const now = 1_000_000;
    recordStall("opencode_go", "model-a", now);
    recordStall("opencode_go", "model-a", now + 1); // excluded on opencode_go
    recordStall("openrouter", "model-a", now); // only 1 strike, not excluded on openrouter
    expect(isTemporarilyExcluded("opencode_go", "model-a", now + 5)).toBe(true);
    expect(isTemporarilyExcluded("openrouter", "model-a", now + 5)).toBe(false);
  });

  test("hard-fail cooldown is unaffected by an intervening stall strike on a different key", () => {
    // Regression guard: the two registries must not share a cooldown clock.
    // A stall strike on key B must not extend key A's hard-fail cooldown.
    const now = 1_000_000;
    recordHardFailure("opencode_zen", "model-a", now);
    recordHardFailure("opencode_zen", "model-a", now + 1);
    const aCooldownEnd = now + 1 + HARD_FAILURE_COOLDOWN_MS;
    expect(isTemporarilyExcluded("opencode_zen", "model-a", aCooldownEnd - 1)).toBe(true);

    // Lots of stall activity on a different key in the meantime.
    for (let i = 0; i < 5; i++) {
      recordStall("opencode_go", "model-b", now + 100 + i);
    }
    // Key A's hard-fail cooldown has not been touched.
    expect(isTemporarilyExcluded("opencode_zen", "model-a", aCooldownEnd - 1)).toBe(true);
  });
});
