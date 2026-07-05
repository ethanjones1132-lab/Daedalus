import { describe, expect, test } from "bun:test";
import { join } from "path";
import { homedir } from "os";
import {
  defaultConfig,
  isInvalidWorkspacePath,
  normalizeConfig,
  resolveAgentsRoot,
  validateAgentsRootPath,
} from "./config";

describe("jarvis_path self-healing", () => {
  test("detects platform-incompatible and missing workspace paths", () => {
    expect(isInvalidWorkspacePath("/root/workspace", "win32", () => true)).toBe(true);
    expect(isInvalidWorkspacePath("C:\\Projects\\home-base", "linux", () => true)).toBe(true);
    expect(isInvalidWorkspacePath("C:\\Projects\\home-base", "win32", () => true)).toBe(false);
    expect(isInvalidWorkspacePath("C:\\missing", "win32", () => false)).toBe(true);
  });

  test("normalizeConfig heals the literal stale POSIX workspace on Windows", () => {
    const stale = "/root/.openclaw/agents/coderclaw/workspace/Jarvis";
    const cfg = normalizeConfig(
      { jarvis_path: stale },
      { platform: "win32", exists: (path) => path !== stale },
    );
    expect(cfg.jarvis_path).toBe(join(homedir(), ".openclaw", "agents", "coderclaw", "workspace", "home-base"));
    expect(cfg.jarvis_path).not.toBe(stale);
  });

  test("normalizeConfig preserves a valid configured workspace", () => {
    const valid = "C:\\Projects\\home-base-recovered";
    const cfg = normalizeConfig(
      { jarvis_path: valid },
      { platform: "win32", exists: (path) => path === valid },
    );
    expect(cfg.jarvis_path).toBe(valid);
  });
});

// ─── P1-02: Agents Root Configuration ────────────────────────────────────────
// Tests verify behavior through the public config API only.
// No filesystem side-effects outside of querying existing paths.

const DEFAULT_AGENTS_ROOT = join(homedir(), ".openclaw", "jarvis", "agents");

describe("agents_root configuration", () => {
  // ── Tracer bullet ──────────────────────────────────────────────────────────

  test("defaultConfig produces agents_root pointing to app-owned default path", () => {
    const cfg = defaultConfig();
    expect(cfg.agents_root).toBe(DEFAULT_AGENTS_ROOT);
  });

  // ── resolveAgentsRoot ──────────────────────────────────────────────────────

  test("custom agents_root in config is returned verbatim", () => {
    const cfg = defaultConfig();
    cfg.agents_root = "/custom/agents/dir";
    expect(resolveAgentsRoot(cfg)).toBe("/custom/agents/dir");
  });

  test("empty agents_root falls back to the default path", () => {
    const cfg = defaultConfig();
    cfg.agents_root = "";
    expect(resolveAgentsRoot(cfg)).toBe(DEFAULT_AGENTS_ROOT);
  });

  test("whitespace-only agents_root falls back to the default path", () => {
    const cfg = defaultConfig();
    cfg.agents_root = "   ";
    expect(resolveAgentsRoot(cfg)).toBe(DEFAULT_AGENTS_ROOT);
  });

  // ── validateAgentsRootPath ─────────────────────────────────────────────────

  test("validateAgentsRootPath on a real existing directory returns valid:true", () => {
    // homedir() is guaranteed to exist on any machine running these tests
    const result = validateAgentsRootPath(homedir());
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("validateAgentsRootPath on a non-existent path returns valid:false with an error", () => {
    const result = validateAgentsRootPath("/this/path/does/not/exist/9a8b7c");
    expect(result.valid).toBe(false);
    expect(typeof result.error).toBe("string");
    expect((result.error as string).length).toBeGreaterThan(0);
  });

  test("validateAgentsRootPath returns the resolved_path in all cases", () => {
    const path = homedir();
    const result = validateAgentsRootPath(path);
    expect(result.resolved_path).toBeTruthy();
    expect(result.resolved_path.length).toBeGreaterThan(0);
  });

  test("validateAgentsRootPath on empty string returns valid:false", () => {
    const result = validateAgentsRootPath("");
    expect(result.valid).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  test("validateAgentsRootPath rejects paths containing .. traversal components", () => {
    const result = validateAgentsRootPath("../../etc");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("..");
  });
});

// ─── Top-K sampling (ADR 0002 Layer 1) ───────────────────────────────────────
describe("top_k sampling", () => {
  test("defaultConfig sets top_k to 40", () => {
    expect(defaultConfig().top_k).toBe(40);
  });

  test("normalizeConfig fills in a missing top_k with the default 40", () => {
    const cfg = normalizeConfig({});
    expect(cfg.top_k).toBe(40);
  });

  test("an explicit top_k survives normalization", () => {
    const cfg = normalizeConfig({ top_k: 12 });
    expect(cfg.top_k).toBe(12);
  });
});

// ─── Blank saved fields must not clobber non-empty defaults ───────────────────
// Regression: a persisted partial config such as
//   {"active_backend":"openrouter","openrouter":{"api_key":"sk-...","base_url":"","model":""}}
// used to survive normalization verbatim, leaving the OpenRouter URL empty.
// streamJarvis then built `fetch("/chat/completions")` → "URL is invalid", and
// every orchestrator stage failed, which made chat appear completely dead.
describe("normalizeConfig blank-field protection", () => {
  test("an empty openrouter.base_url falls back to the default URL", () => {
    const cfg = normalizeConfig({ openrouter: { base_url: "" } });
    expect(cfg.openrouter.base_url).toBe(defaultConfig().openrouter.base_url);
    expect(cfg.openrouter.base_url).not.toBe("");
  });

  test("an empty openrouter.model falls back to the default model", () => {
    const cfg = normalizeConfig({ openrouter: { model: "" } });
    expect(cfg.openrouter.model).toBe(defaultConfig().openrouter.model);
    expect(cfg.openrouter.model).not.toBe("");
  });

  test("the real-world blanked openrouter config heals on load", () => {
    const cfg = normalizeConfig({
      active_backend: "openrouter",
      openrouter: { api_key: "sk-or-v1-test", base_url: "", model: "" },
    });
    expect(cfg.openrouter.base_url).toBe(defaultConfig().openrouter.base_url);
    expect(cfg.openrouter.model).toBe(defaultConfig().openrouter.model);
    // A genuinely-supplied value (the key) is still preserved.
    expect(cfg.openrouter.api_key).toBe("sk-or-v1-test");
  });

  test("a non-empty override still wins over the default", () => {
    const cfg = normalizeConfig({ openrouter: { model: "anthropic/claude-sonnet-4" } });
    expect(cfg.openrouter.model).toBe("anthropic/claude-sonnet-4");
  });

  test("clearing a field whose default is empty stays empty", () => {
    // api_key's default is "", so an explicit "" is a no-op, not a fallback.
    const cfg = normalizeConfig({ openrouter: { api_key: "" } });
    expect(cfg.openrouter.api_key).toBe("");
  });
});

// ─── Interactive tool approval (Track B follow-up) ───────────────────────────
describe("tools.interactive_approval", () => {
  test("defaults to false (legacy passthrough preserved)", () => {
    expect(defaultConfig().tools.interactive_approval).toBe(false);
  });

  test("normalizeConfig fills in a missing interactive_approval with false", () => {
    expect(normalizeConfig({}).tools.interactive_approval).toBe(false);
  });

  test("an explicit interactive_approval:true survives normalization", () => {
    const cfg = normalizeConfig({ tools: { interactive_approval: true } });
    expect(cfg.tools.interactive_approval).toBe(true);
  });
});

describe("orchestrator agent pool config", () => {
  test("defaultConfig provides a sane enabled agent pool", () => {
    const agents = defaultConfig().orchestrator.agents;
    expect(agents.length).toBeGreaterThanOrEqual(3);
    expect(agents.every((agent) => agent.enabled)).toBe(true);
    expect(agents.some((agent) => agent.default_for.includes("executor"))).toBe(true);
    expect(agents.some((agent) => agent.default_for.includes("reviewer"))).toBe(true);
  });

  test("normalizeConfig fills in missing orchestrator agents", () => {
    const cfg = normalizeConfig({ orchestrator: { enabled: true } });
    expect(cfg.orchestrator.agents.length).toBe(defaultConfig().orchestrator.agents.length);
  });

  test("defaultConfig enables a bounded recursive orchestrator depth", () => {
    expect(defaultConfig().orchestrator.max_recursion_depth).toBe(2);
  });

  test("orchestrator.max_conductor_replans defaults to 2 (B-02 replan budget)", () => {
    expect(defaultConfig().orchestrator.max_conductor_replans).toBe(2);
  });

  test("orchestrator.max_conductor_replans_per_session defaults to 6 (B-04 session replan budget)", () => {
    expect(defaultConfig().orchestrator.max_conductor_replans_per_session).toBe(6);
  });

  test("normalizeConfig preserves an explicit max_conductor_replans_per_session (B-04)", () => {
    const cfg = normalizeConfig({
      orchestrator: { enabled: true, max_conductor_replans_per_session: 12 },
    });
    expect(cfg.orchestrator.max_conductor_replans_per_session).toBe(12);
  });

  test("normalizeConfig fills in missing orchestrator recursion depth", () => {
    const cfg = normalizeConfig({ orchestrator: { enabled: true } });
    expect(cfg.orchestrator.max_recursion_depth).toBe(2);
  });

  test("defaultConfig uses Gemma 4 E2B as the local persistent conductor", () => {
    const conductor = defaultConfig().orchestrator.conductor;
    expect(conductor.model).toBe("gemma4:e2b");
    expect(conductor.fallback_model).toBe("gemma4:e4b");
    expect(conductor.output_mode).toBe("tool_call");
    expect(conductor.enabled).toBe(true);
  });

  test("normalizeConfig fills in missing conductor settings", () => {
    const cfg = normalizeConfig({ orchestrator: { enabled: true } });
    expect(cfg.orchestrator.conductor.model).toBe("gemma4:e2b");
    expect(cfg.orchestrator.conductor.fallback_model).toBe("gemma4:e4b");
    expect(cfg.orchestrator.conductor.output_mode).toBe("tool_call");
  });

  test("defaultConfig enables conductor KV persistence (Track A)", () => {
    const conductor = defaultConfig().orchestrator.conductor;
    expect(conductor.kv_persist).toBe(true);
    expect(conductor.kv_backend).toBe("ollama");
  });

  test("normalizeConfig fills in missing conductor KV settings", () => {
    const cfg = normalizeConfig({ orchestrator: { enabled: true } });
    expect(cfg.orchestrator.conductor.kv_persist).toBe(true);
    expect(cfg.orchestrator.conductor.kv_backend).toBe("ollama");
  });

  test("defaultConfig enables skill distillation (Track C)", () => {
    const distillation = defaultConfig().orchestrator.skill_distillation;
    expect(distillation.enabled).toBe(true);
    expect(distillation.min_confidence).toBeGreaterThan(0);
    expect(distillation.promotion_eval_delta).toBeGreaterThan(0);
    expect(distillation.max_candidates).toBeGreaterThan(0);
  });

  test("normalizeConfig fills in missing skill distillation settings", () => {
    const cfg = normalizeConfig({ orchestrator: { enabled: true } });
    expect(cfg.orchestrator.skill_distillation.enabled).toBe(true);
    expect(cfg.orchestrator.skill_distillation.min_confidence).toBe(0.55);
    expect(cfg.orchestrator.skill_distillation.max_candidates).toBe(200);
  });

  test("defaultConfig disables auto_promote by default (organism loop v1 safety default)", () => {
    const distillation = defaultConfig().orchestrator.skill_distillation;
    expect(distillation.auto_promote).toBe(false);
    expect(distillation.min_judge_score).toBeGreaterThan(0);
    expect(distillation.min_judge_score).toBeLessThanOrEqual(1);
  });

  test("defaultConfig enables orchestrator session memory", () => {
    const memory = defaultConfig().orchestrator.session_memory;
    expect(memory.enabled).toBe(true);
    expect(memory.persist).toBe(true);
    expect(memory.max_tool_results).toBeGreaterThan(0);
  });

  test("defaultConfig enables Phase 4 conductor learning loop", () => {
    const learning = defaultConfig().orchestrator.conductor_learning;
    expect(learning.enabled).toBe(true);
    expect(learning.trajectory_export).toBe(true);
    expect(learning.min_samples_for_heuristics).toBeGreaterThan(0);
  });

  test("normalizeConfig fills in missing conductor learning settings", () => {
    const cfg = normalizeConfig({ orchestrator: { enabled: true } });
    expect(cfg.orchestrator.conductor_learning.enabled).toBe(true);
    expect(cfg.orchestrator.conductor_learning.instruction_ab_epsilon).toBeGreaterThan(0);
  });

  test("explicit orchestrator agents survive normalization", () => {
    const cfg = normalizeConfig({
      orchestrator: {
        agents: [
          {
            id: "custom-agent",
            provider: "openrouter",
            model_id: "openrouter/free",
            capabilities: { code: 0.1, reasoning: 0.9, speed: 0.8, cost: 1, json_reliability: 0.7 },
            default_for: ["coordinator"],
            enabled: true,
          },
        ],
      },
    });
    expect(cfg.orchestrator.agents.map((agent) => agent.id)).toEqual(["custom-agent"]);
  });
});
