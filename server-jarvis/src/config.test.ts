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