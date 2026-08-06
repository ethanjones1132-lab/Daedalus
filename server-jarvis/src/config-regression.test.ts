import { describe, expect, test } from "bun:test";
import { homedir } from "os";
import {
  defaultConfig,
  isInvalidWorkspacePath,
  normalizeConfig,
  resolveAgentsRoot,
  validateAgentsRootPath,
} from "./config";

describe("configuration regression coverage retained during Task 6", () => {
  test("detects platform-incompatible and missing workspace paths", () => {
    expect(isInvalidWorkspacePath("/root/workspace", "win32", () => true)).toBe(true);
    expect(isInvalidWorkspacePath("C:\\Projects\\home-base", "linux", () => true)).toBe(true);
    expect(isInvalidWorkspacePath("C:\\Projects\\home-base", "win32", () => true)).toBe(false);
    expect(isInvalidWorkspacePath("C:\\missing", "win32", () => false)).toBe(true);
  });

  test("heals the known stale POSIX workspace on Windows", () => {
    const stale = "/root/.openclaw/agents/coderclaw/workspace/Jarvis";
    const cfg = normalizeConfig({
      jarvis_path: stale,
    }, {
      platform: "win32",
      exists: (path) => path !== stale,
    });
    expect(cfg.jarvis_path).not.toBe(stale);
    expect(cfg.jarvis_path.toLowerCase()).toContain("home-base");
  });

  test("preserves valid configured workspace paths", () => {
    const valid = "C:\\Projects\\home-base-recovered";
    expect(normalizeConfig({ jarvis_path: valid }, {
      platform: "win32",
      exists: (path) => path === valid,
    }).jarvis_path).toBe(valid);
  });

  test("resolves and validates the agent root safely", () => {
    const cfg = defaultConfig();
    expect(resolveAgentsRoot(cfg)).toBe(cfg.agents_root);
    expect(validateAgentsRootPath(homedir()).valid).toBe(true);
    expect(validateAgentsRootPath("").valid).toBe(false);
    expect(validateAgentsRootPath("../../etc").valid).toBe(false);
  });

  test("preserves sampling defaults and explicit overrides", () => {
    expect(defaultConfig().top_k).toBe(40);
    expect(normalizeConfig({}).top_k).toBe(40);
    expect(normalizeConfig({ top_k: 12 }).top_k).toBe(12);
  });

  test("blank provider fields cannot erase usable defaults", () => {
    const cfg = normalizeConfig({
      active_backend: "openrouter",
      openrouter: { api_key: "test-key", base_url: "", model: "" },
    });
    expect(cfg.openrouter.base_url).toBe(defaultConfig().openrouter.base_url);
    expect(cfg.openrouter.model).toBe(defaultConfig().openrouter.model);
    expect(cfg.openrouter.api_key).toBe("test-key");
  });

  test("normalizes approval and orchestrator safety defaults", () => {
    const cfg = defaultConfig();
    expect(cfg.tools.interactive_approval).toBe(false);
    expect(cfg.tools.allowed_roots).toEqual([]);
    expect(cfg.tools.grant_session_roots).toBe(true);
    expect(cfg.orchestrator.max_recursion_depth).toBeGreaterThan(0);
    expect(cfg.orchestrator.conductor_learning.enabled).toBe(true);
    expect(cfg.orchestrator.skill_distillation.auto_promote).toBe(true);
    expect(cfg.tools.run_gate).toBe(true);
  });

  test("preserves the run-gate kill switch through normalization", () => {
    expect(normalizeConfig({ tools: { run_gate: false } }).tools.run_gate).toBe(false);
  });

  test("round-trips explicit filesystem root settings through Bun normalization", () => {
    const cfg = normalizeConfig({
      tools: {
        allowed_roots: ["C:\\Projects\\one", "D:\\Data"],
        grant_session_roots: false,
      },
    });
    const roundTrip = normalizeConfig(JSON.parse(JSON.stringify(cfg)));
    expect(roundTrip.tools.allowed_roots).toEqual(["C:\\Projects\\one", "D:\\Data"]);
    expect(roundTrip.tools.grant_session_roots).toBe(false);
  });

  test("defaults local conductor keep-warm on with a three-minute refresh interval", () => {
    // Post-2026-07-26 conductor hardening: 10m left Qwythos cold under GPU
    // thrash; 3m keep-warm interval for first-turn readiness.
    const cfg = normalizeConfig({});
    expect(cfg.orchestrator.conductor.keep_warm).toBe(true);
    expect(cfg.orchestrator.conductor.keep_warm_interval_ms).toBe(180_000);
  });

  test("defaults Claude CLI delegate exploration and thrash TTL bounds", () => {
    const delegate = normalizeConfig({}).claude_cli.delegate;
    expect(delegate.exploration_limit_ms).toBe(45_000);
    expect(delegate.native_fallback_reserve_ms).toBe(30_000);
    expect(delegate.thrash_ttl_ms).toBe(30 * 60_000);
    expect(delegate.timeout_ms).toBe(420_000);
    expect(delegate.free_thrash_threshold).toBe(2);
  });

  test("verification prepare_cmake defaults and honor explicit overrides", () => {
    const defaults = defaultConfig().orchestrator.verification;
    expect(defaults.prepare_cmake).toBe(true);
    expect(defaults.prepare_timeout_ms).toBe(120_000);
    expect(defaults.check_timeout_ms).toBe(600_000);

    const overridden = normalizeConfig({
      orchestrator: {
        verification: {
          prepare_cmake: false,
          prepare_timeout_ms: 5_000,
          check_timeout_ms: 15_000,
        },
      },
    }).orchestrator.verification;
    expect(overridden.prepare_cmake).toBe(false);
    expect(overridden.prepare_timeout_ms).toBe(5_000);
    expect(overridden.check_timeout_ms).toBe(15_000);

    // Round-trip serialization preserves prepare flags without inventing secrets.
    const roundTrip = normalizeConfig(JSON.parse(JSON.stringify({
      orchestrator: { verification: overridden },
    })));
    expect(roundTrip.orchestrator.verification.prepare_cmake).toBe(false);
    expect(roundTrip.orchestrator.verification.prepare_timeout_ms).toBe(5_000);
    const serialized = JSON.stringify(roundTrip);
    expect(serialized).not.toMatch(/sk-|OPENROUTER_API_KEY|Bearer /i);
  });
});
