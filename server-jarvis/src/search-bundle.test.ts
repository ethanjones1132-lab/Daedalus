import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import type { ToolRuntime, ExecutionContext } from "./tool-runtime";
import { registerSearchBundle } from "./search-bundle";
import { defaultConfig } from "./config";

// The search bundle now shares the canonical filesystem handlers (see
// filesystem-bundle.ts). These tests verify the read-only REGISTRATION contract
// and that the shared handlers work through this entry point. Workspace-relative
// paths keep them valid on both the Windows test host and the WSL production target.

const cleanups: string[] = [];
function makeTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-search-test-"));
  cleanups.push(dir);
  return dir;
}
afterEach(() => {
  while (cleanups.length) {
    const d = cleanups.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function makeRuntime(): ToolRuntime {
  const rt = createToolRuntime();
  registerSearchBundle(rt);
  return rt;
}
function makeCtx(ws: string, surface: ExecutionContext["surface"] = "chat"): ExecutionContext {
  const cfg = defaultConfig();
  cfg.jarvis_path = ws;
  cfg.tools.enabled = true;
  cfg.tools.sandbox_mode = "workspace";
  return makeExecutionContext(surface, cfg, { workspace_path: ws });
}
function call(name: string, args: Record<string, unknown>) {
  return { id: `t-${name}`, name, arguments: args };
}

describe("SearchBundle registration", () => {
  test("registers only the read-only triad (read_file, glob, grep)", () => {
    const names = makeRuntime().listTools().map((t) => t.function.name).sort();
    expect(names).toEqual(["glob", "grep", "read_file"]);
  });

  test("search tools are not approval-required and not dangerous", () => {
    for (const def of makeRuntime().listTools()) {
      expect(def.requires_approval).toBe(false);
      expect(def.dangerous).toBe(false);
    }
  });

  test("registering the search bundle twice throws on duplicate tool name", () => {
    const rt = makeRuntime();
    expect(() => registerSearchBundle(rt)).toThrow();
  });
});

describe("SearchBundle behavior (shared filesystem handlers)", () => {
  test("read_file returns content with line numbers", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "hello.txt"), "line one\nline two\n");
    const result = await makeRuntime().execute(call("read_file", { path: "hello.txt" }), makeCtx(ws));
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("line one");
    expect(result.output).toMatch(/2 \| line two/);
  });

  test("grep produces identical output from chat and agent surfaces", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "x.ts"), "const TARGET = 1;\n");
    const chat = await makeRuntime().execute(call("grep", { pattern: "TARGET", path: ws }), makeCtx(ws, "chat"));
    const agent = await makeRuntime().execute(call("grep", { pattern: "TARGET", path: ws }), makeCtx(ws, "agent"));
    expect(chat.output).toBe(agent.output);
    expect(chat.output).toContain("x.ts");
  });
});
