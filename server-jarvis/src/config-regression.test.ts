import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  defaultConfig,
  credentialFingerprint,
  isInvalidWorkspacePath,
  loadConfig,
  normalizeConfig,
  reloadConfigFromDisk,
  resolveAgentsRoot,
  runtimeConfigEvidence,
  runtimeConfigReloadResponse,
  redactedConfigResponse,
  resolveProviderTestConfig,
  validateAgentsRootPath,
  invalidateConfigCache,
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
    expect(cfg.orchestrator.max_recursion_depth).toBeGreaterThan(0);
    expect(cfg.orchestrator.conductor_learning.enabled).toBe(true);
    expect(cfg.orchestrator.skill_distillation.auto_promote).toBe(false);
  });

  test("credential evidence never returns raw key text", () => {
    const cfg = defaultConfig();
    cfg.openrouter.api_key = "sk-or-v1-secret-value";
    cfg.opencode_zen.api_key = "zen-secret-value";
    cfg.opencode_go.api_key = "go-secret-value";
    cfg.orchestrator.enabled = false;

    const evidence = runtimeConfigEvidence(cfg);
    expect(evidence.credentials.openrouter).toEqual({ configured: true, fingerprint: credentialFingerprint("sk-or-v1-secret-value") });
    expect(JSON.stringify(evidence)).not.toContain("secret-value");
    expect(evidence.orchestration_enabled).toBe(false);
  });

  test("reload response contract is metadata-only", () => {
    const cfg = defaultConfig();
    cfg.openrouter.api_key = "sk-or-v1-route-secret";
    const response = runtimeConfigReloadResponse(cfg);
    expect(Object.keys(response).sort()).toEqual(["ok", "runtime"]);
    expect(response.ok).toBe(true);
    expect(JSON.stringify(response)).not.toContain("route-secret");
  });

  test("legacy config response is metadata-only and never contains provider keys", () => {
    const cfg = defaultConfig();
    cfg.openrouter.api_key = "openrouter-route-secret";
    cfg.opencode_zen.api_key = "zen-route-secret";
    cfg.opencode_go.api_key = "go-route-secret";
    const response = redactedConfigResponse(cfg);
    expect(Object.keys(response).sort()).toEqual(["ok", "runtime", "validation"]);
    expect(JSON.stringify(response)).not.toContain("route-secret");
    expect(response).not.toHaveProperty("config");
    expect(response).not.toHaveProperty("openrouter");
  });

  test("provider test config uses the live key when a redacted override is blank", () => {
    const live = defaultConfig();
    live.opencode_zen.api_key = "stored-zen-key";
    const merged = resolveProviderTestConfig({ opencode_zen: { api_key: "" } }, live);
    expect(merged.opencode_zen.api_key).toBe("stored-zen-key");
    expect(JSON.stringify(merged)).toContain("stored-zen-key");
    const replacement = resolveProviderTestConfig({ opencode_zen: { api_key: "replacement-zen-key" } }, live);
    expect(replacement.opencode_zen.api_key).toBe("replacement-zen-key");
  });

  test("shared OpenCode env keys do not populate independent provider slots", () => {
    const names = ["OPENCODE_API_KEY", "OPENCODE_KEY", "OPENCODE_ZEN_API_KEY", "OPENCODE_ZEN_KEY", "OPENCODE_GO_API_KEY", "OPENCODE_GO_KEY"] as const;
    const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      process.env.OPENCODE_API_KEY = "shared-only-key";
      delete process.env.OPENCODE_KEY;
      delete process.env.OPENCODE_ZEN_API_KEY;
      delete process.env.OPENCODE_ZEN_KEY;
      delete process.env.OPENCODE_GO_API_KEY;
      delete process.env.OPENCODE_GO_KEY;
      const cfg = normalizeConfig({ opencode_zen: { api_key: "" }, opencode_go: { api_key: "" } });
      expect(cfg.opencode_zen.api_key).not.toBe("shared-only-key");
      expect(cfg.opencode_go.api_key).not.toBe("shared-only-key");
    } finally {
      for (const name of names) {
        if (prior[name] === undefined) delete process.env[name];
        else process.env[name] = prior[name];
      }
    }
  });

  test("credentialFingerprint is stable, truncated, and blank-safe", () => {
    expect(credentialFingerprint("")).toBeNull();
    expect(credentialFingerprint("same-key")).toBe(credentialFingerprint("same-key"));
    expect(credentialFingerprint("same-key")).toHaveLength(12);
    expect(credentialFingerprint("same-key")).not.toBe(credentialFingerprint("other-key"));
  });

  test("reloadConfigFromDisk bypasses the five-second cache", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "jarvis-config-reload-"));
    const configPath = join(tempRoot, "config.json");
    try {
      const initial = defaultConfig();
      initial.system_prompt = "initial-runtime-prompt";
      writeFileSync(configPath, JSON.stringify(initial), "utf-8");

      invalidateConfigCache();
      expect(loadConfig(configPath).system_prompt).toBe("initial-runtime-prompt");

      const changed = { ...initial, system_prompt: "changed-on-disk-prompt" };
      writeFileSync(configPath, JSON.stringify(changed), "utf-8");
      expect(loadConfig(configPath).system_prompt).toBe("initial-runtime-prompt");

      expect(reloadConfigFromDisk(configPath).system_prompt).toBe("changed-on-disk-prompt");
    } finally {
      invalidateConfigCache();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

