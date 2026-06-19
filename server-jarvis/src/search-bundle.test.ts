import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import type { ToolRuntime, ExecutionContext } from "./tool-runtime";
import { registerSearchBundle } from "./search-bundle";
import { defaultConfig } from "./config";

// ─── P1-09: Search Bundle Through Canonical ToolRuntime ──────────────────────
// Tests verify behavior via ToolRuntime.execute() only.
// Handlers must produce identical results from chat and agent surfaces.

const cleanups: string[] = [];

function makeTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-search-test-"));
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

/** Create a runtime with the search bundle registered. */
function makeRuntime(): ToolRuntime {
  const rt = createToolRuntime();
  registerSearchBundle(rt);
  return rt;
}

/** Build an ExecutionContext that scopes all paths to the given workspace dir. */
function makeCtx(
  workspace: string,
  surface: ExecutionContext["surface"] = "chat",
): ExecutionContext {
  const cfg = defaultConfig();
  // sandbox_mode "off" so absolute temp-dir paths are accepted
  cfg.tools.sandbox_mode = "off";
  return makeExecutionContext(surface, cfg, { workspace_path: workspace });
}

/** Minimal ToolCall factory. */
function call(name: string, args: Record<string, unknown>) {
  return { id: `test-${name}`, name, arguments: args };
}

// ── Registration ──────────────────────────────────────────────────────────────

describe("SearchBundle registration", () => {
  test("registerSearchBundle registers read_file, glob, and grep tools", () => {
    const rt = makeRuntime();
    const names = rt.listTools().map((t) => t.function.name);
    expect(names).toContain("read_file");
    expect(names).toContain("glob");
    expect(names).toContain("grep");
  });

  test("search tools are not approval-required and not dangerous", () => {
    const rt = makeRuntime();
    for (const def of rt.listTools()) {
      if (["read_file", "glob", "grep"].includes(def.function.name)) {
        expect(def.requires_approval).toBe(false);
        expect(def.dangerous).toBe(false);
      }
    }
  });

  test("registering search bundle twice throws on duplicate tool name", () => {
    const rt = makeRuntime();
    expect(() => registerSearchBundle(rt)).toThrow();
  });
});

// ── read_file ─────────────────────────────────────────────────────────────────

describe("SearchBundle > read_file", () => {
  test("returns file content with line numbers", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "hello.txt"), "line one\nline two\nline three\n");
    const rt = makeRuntime();
    const ctx = makeCtx(ws);

    const result = await rt.execute(call("read_file", { path: join(ws, "hello.txt") }), ctx);

    expect(result.is_error).toBe(false);
    expect(result.output).toContain("line one");
    expect(result.output).toContain("line two");
    // Line numbers should be present
    expect(result.output).toMatch(/1.*line one/);
    expect(result.output).toMatch(/2.*line two/);
  });

  test("returns is_error:true for a non-existent file", async () => {
    const ws = makeTempWorkspace();
    const rt = makeRuntime();
    const ctx = makeCtx(ws);

    const result = await rt.execute(call("read_file", { path: join(ws, "no-such-file.txt") }), ctx);
    expect(result.is_error).toBe(true);
  });

  test("offset and limit parameters window the output", async () => {
    const ws = makeTempWorkspace();
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(ws, "big.txt"), lines.join("\n"));
    const rt = makeRuntime();
    const ctx = makeCtx(ws);

    const result = await rt.execute(
      call("read_file", { path: join(ws, "big.txt"), offset: 3, limit: 2 }),
      ctx,
    );

    expect(result.is_error).toBe(false);
    expect(result.output).toContain("line 3");
    expect(result.output).toContain("line 4");
    expect(result.output).not.toContain("line 1");
    expect(result.output).not.toContain("line 5");
  });

  test("read_file from chat and agent surfaces returns identical output", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "data.txt"), "same content\n");
    const rt = makeRuntime();
    const chatCtx = makeCtx(ws, "chat");
    const agentCtx = makeCtx(ws, "agent");

    const chatResult = await rt.execute(call("read_file", { path: join(ws, "data.txt") }), chatCtx);
    const agentResult = await rt.execute(call("read_file", { path: join(ws, "data.txt") }), agentCtx);

    expect(chatResult.output).toBe(agentResult.output);
    expect(chatResult.is_error).toBe(agentResult.is_error);
  });

  test("read_file is denied in non-interactive context when tools are disabled", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "file.txt"), "content");
    const rt = makeRuntime();
    const cfg = defaultConfig();
    cfg.tools.enabled = false;
    cfg.tools.sandbox_mode = "off";
    const ctx = makeExecutionContext("agent", cfg, { workspace_path: ws });

    const result = await rt.execute(call("read_file", { path: join(ws, "file.txt") }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.output).toContain("disabled");
  });
});

// ── glob ─────────────────────────────────────────────────────────────────────

describe("SearchBundle > glob", () => {
  test("finds files matching a simple pattern", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "alpha.ts"), "");
    writeFileSync(join(ws, "beta.ts"), "");
    writeFileSync(join(ws, "gamma.txt"), "");
    const rt = makeRuntime();
    const ctx = makeCtx(ws);

    const result = await rt.execute(call("glob", { pattern: "*.ts", path: ws }), ctx);

    expect(result.is_error).toBe(false);
    expect(result.output).toContain("alpha.ts");
    expect(result.output).toContain("beta.ts");
    expect(result.output).not.toContain("gamma.txt");
  });

  test("returns 'No files matched' when pattern matches nothing", async () => {
    const ws = makeTempWorkspace();
    const rt = makeRuntime();
    const ctx = makeCtx(ws);

    const result = await rt.execute(call("glob", { pattern: "*.xyz", path: ws }), ctx);

    expect(result.is_error).toBe(false);
    expect(result.output).toContain("No files matched");
  });

  test("recursive ** pattern finds nested files", async () => {
    const ws = makeTempWorkspace();
    mkdirSync(join(ws, "src", "sub"), { recursive: true });
    writeFileSync(join(ws, "src", "a.ts"), "");
    writeFileSync(join(ws, "src", "sub", "b.ts"), "");
    const rt = makeRuntime();
    const ctx = makeCtx(ws);

    const result = await rt.execute(call("glob", { pattern: "**/*.ts", path: ws }), ctx);

    expect(result.is_error).toBe(false);
    expect(result.output).toContain("a.ts");
    expect(result.output).toContain("b.ts");
  });

  test("glob from chat and agent surfaces returns identical output", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "file.ts"), "");
    const rt = makeRuntime();
    const chatCtx = makeCtx(ws, "chat");
    const agentCtx = makeCtx(ws, "agent");

    const chatResult = await rt.execute(call("glob", { pattern: "*.ts", path: ws }), chatCtx);
    const agentResult = await rt.execute(call("glob", { pattern: "*.ts", path: ws }), agentCtx);

    expect(chatResult.output).toBe(agentResult.output);
  });
});

// ── grep ──────────────────────────────────────────────────────────────────────

describe("SearchBundle > grep", () => {
  test("finds files containing the pattern", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "match.ts"), "const SECRET = 'hello';\n");
    writeFileSync(join(ws, "nomatch.ts"), "const x = 1;\n");
    const rt = makeRuntime();
    const ctx = makeCtx(ws);

    const result = await rt.execute(
      call("grep", { pattern: "SECRET", path: ws }),
      ctx,
    );

    expect(result.is_error).toBe(false);
    expect(result.output).toContain("match.ts");
    expect(result.output).not.toContain("nomatch.ts");
  });

  test("returns 'No matches found' when nothing matches", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "file.ts"), "nothing here\n");
    const rt = makeRuntime();
    const ctx = makeCtx(ws);

    const result = await rt.execute(
      call("grep", { pattern: "XYZZY_NOMATCH", path: ws }),
      ctx,
    );

    expect(result.is_error).toBe(false);
    expect(result.output).toContain("No matches found");
  });

  test("content output mode returns matching lines with line numbers", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "code.ts"), "// line 1\nconst FIND_ME = true;\n// line 3\n");
    const rt = makeRuntime();
    const ctx = makeCtx(ws);

    const result = await rt.execute(
      call("grep", { pattern: "FIND_ME", path: ws, output_mode: "content" }),
      ctx,
    );

    expect(result.is_error).toBe(false);
    expect(result.output).toContain("FIND_ME");
    expect(result.output).toMatch(/:\d+:/); // line number in output
  });

  test("head_limit caps the number of results", async () => {
    const ws = makeTempWorkspace();
    // Create 10 files all containing the pattern
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(ws, `file${i}.ts`), `const X = ${i}; // MATCH\n`);
    }
    const rt = makeRuntime();
    const ctx = makeCtx(ws);

    const result = await rt.execute(
      call("grep", { pattern: "MATCH", path: ws, head_limit: 3 }),
      ctx,
    );

    expect(result.is_error).toBe(false);
    // At most 3 lines in output
    const lines = result.output.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  test("grep from chat and agent surfaces returns identical output", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "x.ts"), "const TARGET = 1;\n");
    const rt = makeRuntime();
    const chatCtx = makeCtx(ws, "chat");
    const agentCtx = makeCtx(ws, "agent");

    const chatResult = await rt.execute(call("grep", { pattern: "TARGET", path: ws }), chatCtx);
    const agentResult = await rt.execute(call("grep", { pattern: "TARGET", path: ws }), agentCtx);

    expect(chatResult.output).toBe(agentResult.output);
  });
});

// ── End-to-end: lifecycle + runtime ──────────────────────────────────────────

describe("SearchBundle > end-to-end with file-backed agent", () => {
  test("scan agent directory with glob through canonical runtime", async () => {
    const ws = makeTempWorkspace();
    // Create a small project inside the workspace
    mkdirSync(join(ws, "agents", "my-agent"), { recursive: true });
    writeFileSync(join(ws, "agents", "my-agent", "soul.md"), `---
slug: my-agent
name: My Agent
---
Agent instructions.`);
    writeFileSync(join(ws, "agents", "my-agent", "notes.txt"), "some notes");

    const rt = makeRuntime();
    const ctx = makeCtx(ws);

    // Find soul.md using glob through the canonical runtime
    const result = await rt.execute(call("glob", { pattern: "**/soul.md", path: ws }), ctx);

    expect(result.is_error).toBe(false);
    expect(result.output).toContain("soul.md");
  });

  test("read soul.md content through canonical runtime", async () => {
    const ws = makeTempWorkspace();
    const soulContent = `---
slug: my-agent
name: My Agent
---
The agent's instructions go here.`;
    mkdirSync(join(ws, "agents", "my-agent"), { recursive: true });
    const soulPath = join(ws, "agents", "my-agent", "soul.md");
    writeFileSync(soulPath, soulContent);

    const rt = makeRuntime();
    const ctx = makeCtx(ws);

    const result = await rt.execute(call("read_file", { path: soulPath }), ctx);

    expect(result.is_error).toBe(false);
    expect(result.output).toContain("my-agent");
    expect(result.output).toContain("The agent's instructions go here.");
  });
});