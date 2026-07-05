import { beforeEach, describe, expect, test } from "bun:test";
import {
  excludedModelKeys,
  HARD_FAILURE_COOLDOWN_MS,
  HARD_FAILURE_STRIKE_THRESHOLD,
  isTemporarilyExcluded,
  recordHardFailure,
  recordSuccess,
  resetModelFailureMemory,
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
