import { describe, expect, test } from "bun:test";
import { join } from "path";
import { homedir } from "os";
import {
  defaultConfig,
  normalizeConfig,
  resolveAgentsRoot,
  validateAgentsRootPath,
} from "./config";

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
