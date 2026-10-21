import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { defaultConfig, normalizeConfig } from "./config";
import { preflightCheck } from "./preflight-checks";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import type { ToolDefinition, ToolErrorCode } from "./tool-types";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "jarvis-preflight-"));
}

function withWorkspace(fn: (root: string) => void): void {
  const root = workspace();
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeDef(name: string, required: string[] = []): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: `Test tool: ${name}`,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          required.map((r) => [r, { type: "string", description: r }]),
        ),
        required,
      },
    },
    requires_approval: false,
    dangerous: false,
  };
}

describe("preflight error code", () => {
  test("preflight_blocked is a valid tool error code", () => {
    const code: ToolErrorCode = "preflight_blocked";
    expect(code).toBe("preflight_blocked");
  });
});

describe("placeholder arguments", () => {
  test("blocks a placeholder path", () => {
    withWorkspace((root) => {
      const r = preflightCheck(
        { id: "1", name: "read_file", arguments: { path: "path/to/your/file.ts" } },
        { workspacePath: root },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.repair).toContain("actual path");
    });
  });

  test("blocks a placeholder URL", () => {
    withWorkspace((root) => {
      const r = preflightCheck(
        { id: "1", name: "web_fetch", arguments: { url: "https://example.com/<your-page>" } },
        { workspacePath: root },
      );
      expect(r.ok).toBe(false);
    });
  });

  test("blocks a TODO stub path", () => {
    withWorkspace((root) => {
      const r = preflightCheck(
        { id: "1", name: "read_file", arguments: { path: "TODO" } },
        { workspacePath: root },
      );
      expect(r.ok).toBe(false);
    });
  });

  test("allows a real file whose name contains TODO", () => {
    // `docs/TODO.md` is a real documentation file, not an invented path — the
    // placeholder pattern must only match TODO as a whole path segment.
    withWorkspace((root) => {
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "docs", "TODO.md"), "- [ ] ship it\n");
      const r = preflightCheck(
        { id: "1", name: "read_file", arguments: { path: "docs/TODO.md" } },
        { workspacePath: root },
      );
      expect(r.ok).toBe(true);
    });
  });

  test("allows a real-looking url", () => {
    withWorkspace((root) => {
      const r = preflightCheck(
        { id: "1", name: "web_fetch", arguments: { url: "https://docs.vllm.ai/en/latest/" } },
        { workspacePath: root },
      );
      expect(r.ok).toBe(true);
    });
  });
});

describe("read of a nonexistent file", () => {
  test("blocks and names the missing path", () => {
    withWorkspace((root) => {
      const r = preflightCheck(
        { id: "1", name: "read_file", arguments: { path: "nope.ts" } },
        { workspacePath: root },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain("nope.ts");
        expect(r.repair).toContain("list_dir");
      }
    });
  });

  test("blocks through the relative_workspace_path alias", () => {
    withWorkspace((root) => {
      const r = preflightCheck(
        { id: "1", name: "read_file", arguments: { relative_workspace_path: "nope.ts" } },
        { workspacePath: root },
      );
      expect(r.ok).toBe(false);
    });
  });

  test("allows a file that exists", () => {
    withWorkspace((root) => {
      writeFileSync(join(root, "real.ts"), "export const a = 1;\n");
      const r = preflightCheck(
        { id: "1", name: "read_file", arguments: { path: "real.ts" } },
        { workspacePath: root },
      );
      expect(r.ok).toBe(true);
    });
  });

  test("does not block writes to files that do not exist yet", () => {
    withWorkspace((root) => {
      const r = preflightCheck(
        { id: "1", name: "write_file", arguments: { path: "brand-new.ts", content: "x" } },
        { workspacePath: root },
      );
      expect(r.ok).toBe(true);
    });
  });

  test("allows a relative path when no workspace root is known", () => {
    // Undecidable: resolving against the process cwd would test a different
    // directory than the call meant. Conservative by design — allow.
    const r = preflightCheck(
      { id: "1", name: "read_file", arguments: { path: "nope.ts" } },
      {},
    );
    expect(r.ok).toBe(true);
  });
});

describe("no-op edits", () => {
  test("blocks an edit whose old and new strings are identical", () => {
    withWorkspace((root) => {
      writeFileSync(join(root, "f.ts"), "const a = 1;\n");
      const r = preflightCheck(
        {
          id: "1",
          name: "edit_file",
          arguments: { path: "f.ts", old_string: "const a = 1;", new_string: "const a = 1;" },
        },
        { workspacePath: root },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("identical");
    });
  });

  test("allows an edit that changes something", () => {
    withWorkspace((root) => {
      writeFileSync(join(root, "f.ts"), "const a = 1;\n");
      const r = preflightCheck(
        {
          id: "1",
          name: "edit_file",
          arguments: { path: "f.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
        },
        { workspacePath: root },
      );
      expect(r.ok).toBe(true);
    });
  });
});

describe("vague searches", () => {
  test("blocks an empty query", () => {
    withWorkspace((root) => {
      const r = preflightCheck(
        { id: "1", name: "web_search", arguments: { query: "   " } },
        { workspacePath: root },
      );
      expect(r.ok).toBe(false);
    });
  });

  test("blocks a grep with no pattern", () => {
    withWorkspace((root) => {
      const r = preflightCheck(
        { id: "1", name: "grep", arguments: { path: "src" } },
        { workspacePath: root },
      );
      expect(r.ok).toBe(false);
    });
  });

  test("allows a specific query", () => {
    withWorkspace((root) => {
      const r = preflightCheck(
        { id: "1", name: "web_search", arguments: { query: "vllm openai compatible server tool calling" } },
        { workspacePath: root },
      );
      expect(r.ok).toBe(true);
    });
  });
});

describe("unknown tools are not this layer's problem", () => {
  test("passes through tools with no registered checks", () => {
    withWorkspace((root) => {
      const r = preflightCheck(
        { id: "1", name: "some_future_tool", arguments: { anything: 1 } },
        { workspacePath: root },
      );
      expect(r.ok).toBe(true);
    });
  });
});

describe("preflight config", () => {
  test("is off by default so the pipeline is unchanged", () => {
    expect(defaultConfig().tools.preflight_checks).toBe(false);
  });

  test("an existing config without the key keeps the off default", () => {
    expect(normalizeConfig({ tools: { enabled: true } }).tools.preflight_checks).toBe(false);
  });

  test("an explicit enable survives normalization", () => {
    expect(normalizeConfig({ tools: { preflight_checks: true } }).tools.preflight_checks).toBe(true);
  });

  test("an explicit disable survives a round trip", () => {
    const cfg = normalizeConfig({ tools: { preflight_checks: true } });
    const roundTrip = normalizeConfig(JSON.parse(JSON.stringify(cfg)));
    expect(roundTrip.tools.preflight_checks).toBe(true);
  });
});

describe("runtime wiring", () => {
  test("blocks a doomed call before the handler runs when enabled", async () => {
    await withWorkspaceAsync(async (root) => {
      const runtime = createToolRuntime();
      let handlerRan = false;
      runtime.register(makeDef("read_file", ["path"]), async () => {
        handlerRan = true;
        return "should not happen";
      });

      const cfg = defaultConfig();
      cfg.tools.preflight_checks = true;
      const ctx = makeExecutionContext("agent", cfg, { workspace_path: root });

      const result = await runtime.execute(
        { id: "1", name: "read_file", arguments: { path: "missing.ts" } },
        ctx,
      );

      expect(handlerRan).toBe(false);
      expect(result.is_error).toBe(true);
      expect(result.error_code).toBe("preflight_blocked");
      expect(result.output).toContain("missing.ts");
      expect(result.output).toContain("list_dir");
    });
  });

  test("with the toggle off the same call reaches the handler unchanged", async () => {
    await withWorkspaceAsync(async (root) => {
      const runtime = createToolRuntime();
      let handlerRan = false;
      runtime.register(makeDef("read_file", ["path"]), async () => {
        handlerRan = true;
        return "handler output";
      });

      const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: root });
      // defaultConfig() carries preflight_checks: false by default.
      const result = await runtime.execute(
        { id: "1", name: "read_file", arguments: { path: "missing.ts" } },
        ctx,
      );

      expect(handlerRan).toBe(true);
      expect(result.is_error).toBe(false);
      expect(result.output).toBe("handler output");
    });
  });

  test("a valid call still reaches the handler when enabled", async () => {
    await withWorkspaceAsync(async (root) => {
      writeFileSync(join(root, "real.ts"), "export const a = 1;\n");
      const runtime = createToolRuntime();
      runtime.register(makeDef("read_file", ["path"]), async () => "file body");

      const cfg = defaultConfig();
      cfg.tools.preflight_checks = true;
      const ctx = makeExecutionContext("agent", cfg, { workspace_path: root });

      const result = await runtime.execute(
        { id: "1", name: "read_file", arguments: { path: "real.ts" } },
        ctx,
      );

      expect(result.is_error).toBe(false);
      expect(result.output).toBe("file body");
    });
  });
});

async function withWorkspaceAsync(fn: (root: string) => Promise<void>): Promise<void> {
  const root = workspace();
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
