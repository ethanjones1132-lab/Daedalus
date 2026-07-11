import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config";
import { isOrchestrationEnabled } from "./runtime-mode";

describe("isOrchestrationEnabled", () => {
  test("defaults to enabled for the established Jarvis runtime", () => {
    expect(isOrchestrationEnabled(defaultConfig())).toBe(true);
  });

  test("disables orchestration only when the persisted master flag is false", () => {
    const cfg = defaultConfig();
    cfg.orchestrator.enabled = false;
    expect(isOrchestrationEnabled(cfg)).toBe(false);
  });
});
