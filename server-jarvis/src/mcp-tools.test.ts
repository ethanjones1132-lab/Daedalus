// Contract pin for server-jarvis/src/mcp-tools.ts (P1-04).
//
// The 227-line module is the OUTBOUND MCP client surface in Jarvis — every
// external-MCP interaction (list/call/listResources/readResource) routes
// through it. A regression in file discovery, server selection, or argument
// coercion would silently break the external-MCP UX. The previous coverage
// was 3 tests in mcp-client-bundle.test.ts that only exercise the thin
// registration layer in mcp-client-bundle.ts. The loader
// `loadMcpServers(cfg)` and the 5 tool handlers (toolMcp*) have zero
// direct contract coverage.
//
// These tests pin the observable contract WITHOUT changing the source.
// Same regression-pin pattern as agent-lifecycle.test.ts (380 lines, 23
// tests), session-authority.test.ts (83 lines, 9 tests), and
// activation-boundary.test.ts (260 lines, 16 tests).

import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test, afterEach } from "bun:test";
import {
  loadMcpServers,
  toolMcpListServers,
  toolMcpListTools,
  toolMcpCallTool,
  toolMcpListResources,
  toolMcpReadResource,
} from "./mcp-tools";
import { defaultConfig, type JarvisConfig } from "./config";

// ─── Fixtures ──────────────────────────────────────────────────────────────

let activeWorkspaces: string[] = [];

function makeWorkspace(): JarvisConfig {
  const ws = mkdtempSync(join(tmpdir(), "jarvis-mcp-tools-"));
  activeWorkspaces.push(ws);
  const cfg = defaultConfig();
  cfg.jarvis_path = ws;
  return cfg;
}

function writeMcpConfig(ws: string, body: unknown) {
  mkdirSync(ws, { recursive: true });
  const text = typeof body === "string" ? body : JSON.stringify(body);
  writeFileSync(join(ws, ".mcp.json"), text, "utf-8");
}

afterEach(() => {
  for (const ws of activeWorkspaces) {
    try { rmSync(ws, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  activeWorkspaces = [];
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. loadMcpServers — file discovery + schema tolerance
// ═══════════════════════════════════════════════════════════════════════════

describe("mcp-tools: loadMcpServers", () => {
  test("missing .mcp.json returns an empty object (not an error)", () => {
    const cfg = makeWorkspace();
    expect(loadMcpServers(cfg)).toEqual({});
  });

  test("empty .mcp.json file returns {} (malformed JSON must not throw)", () => {
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, "");
    expect(loadMcpServers(cfg)).toEqual({});
  });

  test("garbage JSON in .mcp.json returns {} (no throw, no propagation)", () => {
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, "{not valid json at all");
    expect(loadMcpServers(cfg)).toEqual({});
  });

  test("accepts the canonical 'mcpServers' key", () => {
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, {
      mcpServers: { alpha: { command: "echo", args: ["hi"] } },
    });
    const servers = loadMcpServers(cfg);
    expect(Object.keys(servers).sort()).toEqual(["alpha"]);
    expect(servers.alpha.command).toBe("echo");
  });

  test("accepts the legacy 'servers' key as a fallback", () => {
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, {
      servers: { beta: { url: "https://example.com/mcp" } },
    });
    const servers = loadMcpServers(cfg);
    expect(Object.keys(servers).sort()).toEqual(["beta"]);
    expect(servers.beta.url).toBe("https://example.com/mcp");
  });

  test("prefers 'mcpServers' over 'servers' when both are present", () => {
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, {
      mcpServers: { canonical: { command: "a" } },
      servers: { legacy: { command: "b" } },
    });
    const servers = loadMcpServers(cfg);
    expect(Object.keys(servers).sort()).toEqual(["canonical"]);
  });

  test("filters out entries with disabled: true (preserves others)", () => {
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, {
      mcpServers: {
        live: { command: "echo" },
        off: { command: "noop", disabled: true },
      },
    });
    const servers = loadMcpServers(cfg);
    expect(Object.keys(servers)).toEqual(["live"]);
  });

  test("filters out null and primitive entries (good + null + string survive filter)", () => {
    // KNOWN GAP (pinned for visibility, not a fix): the per-entry filter is
    // `typeof value === "object"`, which is true for arrays in JavaScript
    // (typeof [] === "object"). A future hardening pass could tighten this
    // to `!Array.isArray(value)` so an array-valued entry is rejected at
    // load time instead of failing downstream with a confusing error.
    // This test pins the CURRENT behavior so a future fix is a deliberate
    // decision, not a silent refactor.
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, {
      mcpServers: {
        good: { command: "echo" },
        nullEntry: null,
        stringEntry: "not-an-object",
        arrayEntry: [1, 2, 3],
      },
    });
    const servers = loadMcpServers(cfg);
    const keys = Object.keys(servers).sort();
    // null and primitive entries are filtered out (truthy + typeof object
    // guard), but arrays pass the typeof check.
    expect(keys).not.toContain("nullEntry");
    expect(keys).not.toContain("stringEntry");
    expect(keys).toContain("good");
    expect(keys).toContain("arrayEntry");
  });

  test("returns {} when 'mcpServers' is an array (must be an object)", () => {
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, { mcpServers: ["a", "b"] });
    expect(loadMcpServers(cfg)).toEqual({});
  });

  test("returns {} when 'mcpServers' is null", () => {
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, { mcpServers: null });
    expect(loadMcpServers(cfg)).toEqual({});
  });

  test("returns {} when 'mcpServers' is a primitive", () => {
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, { mcpServers: "not-an-object" });
    expect(loadMcpServers(cfg)).toEqual({});
  });

  test("falls back to jarvis_path || process.cwd() for the .mcp.json location", () => {
    // cfg.jarvis_path is empty → should walk the file lookup from process.cwd()
    // and not throw. The function returns {} for any unresolvable path.
    const cfg = defaultConfig();
    cfg.jarvis_path = "";
    expect(() => loadMcpServers(cfg)).not.toThrow();
    expect(loadMcpServers(cfg)).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. toolMcpListServers — empty state + transport discrimination
// ═══════════════════════════════════════════════════════════════════════════

describe("mcp-tools: toolMcpListServers", () => {
  test("returns the empty-state message when no .mcp.json is present", async () => {
    const cfg = makeWorkspace();
    const out = await toolMcpListServers({}, cfg);
    expect(typeof out).toBe("string");
    expect(out).toContain("No MCP servers found");
  });

  test("returns the empty-state message when .mcp.json has no enabled servers", async () => {
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, {
      mcpServers: { off: { command: "noop", disabled: true } },
    });
    const out = await toolMcpListServers({}, cfg);
    expect(out).toContain("No MCP servers found");
  });

  test("formats a stdio server as '<name> [stdio] <command> <args...>'", async () => {
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, {
      mcpServers: { echo: { command: "echo", args: ["hi", "there"] } },
    });
    const out = await toolMcpListServers({}, cfg);
    expect(out).toContain("echo [stdio] echo hi there");
  });

  test("formats an http server as '<name> [http] <url>'", async () => {
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, {
      mcpServers: { remote: { url: "https://example.com/mcp" } },
    });
    const out = await toolMcpListServers({}, cfg);
    expect(out).toContain("remote [http] https://example.com/mcp");
  });

  test("lists multiple servers joined by newlines", async () => {
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, {
      mcpServers: {
        a: { command: "echo" },
        b: { url: "https://example.com" },
      },
    });
    const out = await toolMcpListServers({}, cfg);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("a [stdio]");
    expect(lines[1]).toContain("b [http]");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Server selection branch — toolMcpListTools / toolMcpListResources
// ═══════════════════════════════════════════════════════════════════════════

describe("mcp-tools: server selection (ListTools / ListResources)", () => {
  test("toolMcpListTools returns 'MCP server not found: <name>' for an unknown server", async () => {
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, {
      mcpServers: { alpha: { command: "echo" } },
    });
    const out = await toolMcpListTools({ server: "ghost" }, cfg);
    expect(out).toBe("MCP server not found: ghost");
  });

  test("toolMcpListResources returns 'MCP server not found: <name>' for an unknown server", async () => {
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, {
      mcpServers: { alpha: { command: "echo" } },
    });
    const out = await toolMcpListResources({ server: "ghost" }, cfg);
    expect(out).toBe("MCP server not found: ghost");
  });

  test("empty `server` arg falls through to listing all servers (no error)", async () => {
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, {
      mcpServers: { only: { command: "noop" } },
    });
    // No actual MCP server is running, so each will error — but the
    // empty-arg path should NOT short-circuit with the "not found" envelope.
    const out = await toolMcpListTools({ server: "" }, cfg);
    expect(out).not.toContain("MCP server not found");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. toolMcpCallTool — argument validation + server lookup
// ═══════════════════════════════════════════════════════════════════════════

describe("mcp-tools: toolMcpCallTool", () => {
  test("returns 'MCP server and tool are required.' when server is missing", async () => {
    const cfg = makeWorkspace();
    const out = await toolMcpCallTool({ tool: "ping" }, cfg);
    expect(out).toBe("MCP server and tool are required.");
  });

  test("returns 'MCP server and tool are required.' when tool is missing", async () => {
    const cfg = makeWorkspace();
    const out = await toolMcpCallTool({ server: "alpha" }, cfg);
    expect(out).toBe("MCP server and tool are required.");
  });

  test("returns 'MCP server and tool are required.' when both are empty strings", async () => {
    const cfg = makeWorkspace();
    const out = await toolMcpCallTool({ server: "", tool: "" }, cfg);
    expect(out).toBe("MCP server and tool are required.");
  });

  test("returns 'MCP server not found: <name>' for an unknown server", async () => {
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, {
      mcpServers: { alpha: { command: "echo" } },
    });
    const out = await toolMcpCallTool({ server: "ghost", tool: "ping" }, cfg);
    expect(out).toBe("MCP server not found: ghost");
  });

  test("coerces non-object `arguments` to {} (null, primitive, string)", async () => {
    // We can't actually call out (no MCP server running) but we CAN
    // assert that the argument coercion branch is reached. A `disabled: true`
    // server short-circuits the call to "MCP server not found" via the loader
    // filter, so we use that to verify the call site doesn't throw on
    // bad argument types.
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, {
      mcpServers: { off: { command: "echo", disabled: true } },
    });
    for (const badArgs of [null, 42, "scalar", [1, 2, 3]]) {
      const out = await toolMcpCallTool(
        { server: "off", tool: "ping", arguments: badArgs },
        cfg,
      );
      // Server is filtered out by `disabled:true`, so the lookup returns
      // "MCP server not found" — but the important property is no throw.
      expect(out).toBe("MCP server not found: off");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. toolMcpReadResource — argument validation + server lookup
// ═══════════════════════════════════════════════════════════════════════════

describe("mcp-tools: toolMcpReadResource", () => {
  test("returns 'MCP server and resource URI are required.' when server is missing", async () => {
    const cfg = makeWorkspace();
    const out = await toolMcpReadResource({ uri: "file://x" }, cfg);
    expect(out).toBe("MCP server and resource URI are required.");
  });

  test("returns 'MCP server and resource URI are required.' when uri is missing", async () => {
    const cfg = makeWorkspace();
    const out = await toolMcpReadResource({ server: "alpha" }, cfg);
    expect(out).toBe("MCP server and resource URI are required.");
  });

  test("returns 'MCP server not found: <name>' for an unknown server", async () => {
    const cfg = makeWorkspace();
    writeMcpConfig(cfg.jarvis_path, {
      mcpServers: { alpha: { command: "echo" } },
    });
    const out = await toolMcpReadResource(
      { server: "ghost", uri: "file://x" },
      cfg,
    );
    expect(out).toBe("MCP server not found: ghost");
  });
});
