import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTwoFilesPatch } from "diff";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import type { ToolRuntime, ExecutionContext } from "./tool-runtime";
import { registerFilesystemBundle, registerSearchBundle } from "./filesystem-bundle";
import { defaultConfig } from "./config";

// These tests run against a real workspace and use WORKSPACE-RELATIVE paths so
// that fs-scope's Windows->WSL translation is a passthrough — making them valid
// on both the Windows test host and the WSL production target.

const cleanups: string[] = [];

function makeTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-fs-test-"));
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function makeRuntime(): ToolRuntime {
  const rt = createToolRuntime();
  registerFilesystemBundle(rt);
  return rt;
}

function makeCtx(workspace: string, surface: ExecutionContext["surface"] = "chat"): ExecutionContext {
  const cfg = defaultConfig();
  cfg.jarvis_path = workspace;
  cfg.tools.enabled = true;
  cfg.tools.sandbox_mode = "workspace";
  return makeExecutionContext(surface, cfg, { workspace_path: workspace });
}

function call(name: string, args: Record<string, unknown>) {
  return { id: `test-${name}`, name, arguments: args };
}

describe("FilesystemBundle registration", () => {
  test("registers all 8 filesystem tools", () => {
    const names = makeRuntime().listTools().map((t) => t.function.name);
    for (const n of ["read_file", "write_file", "edit_file", "multi_edit", "apply_patch", "glob", "grep", "list_directory"]) {
      expect(names).toContain(n);
    }
  });

  test("mutating tools are dangerous + approval-required; read tools are not", () => {
    const defs = Object.fromEntries(makeRuntime().listTools().map((d) => [d.function.name, d]));
    for (const n of ["write_file", "edit_file", "multi_edit"]) {
      expect(defs[n].dangerous).toBe(true);
      expect(defs[n].requires_approval).toBe(true);
    }
    for (const n of ["read_file", "glob", "grep", "list_directory"]) {
      expect(defs[n].dangerous).toBe(false);
      expect(defs[n].requires_approval).toBe(false);
    }
  });
});

describe("FilesystemBundle > read_file", () => {
  test("returns content with line numbers", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "hello.txt"), "line one\nline two\nline three\n");
    const result = await makeRuntime().execute(call("read_file", { path: "hello.txt" }), makeCtx(ws));
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("line one");
    expect(result.output).toMatch(/2 \| line two/);
  });

  test("offset and limit window the output", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "big.txt"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"));
    const result = await makeRuntime().execute(call("read_file", { path: "big.txt", offset: 3, limit: 2 }), makeCtx(ws));
    expect(result.output).toContain("line 3");
    expect(result.output).toContain("line 4");
    expect(result.output).not.toContain("line 5");
  });

  test("missing file returns the legacy not-found string (not a thrown error)", async () => {
    const ws = makeTempWorkspace();
    const result = await makeRuntime().execute(call("read_file", { path: "nope.txt" }), makeCtx(ws));
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("File not found");
  });

  test("read_file on a directory returns an actionable list_directory hint, not 'File not found'", async () => {
    const ws = makeTempWorkspace();
    mkdirSync(join(ws, "subdir"));
    const result = await makeRuntime().execute(call("read_file", { path: "subdir" }), makeCtx(ws));
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("is a directory");
    expect(result.output).toContain("list_directory");
    expect(result.output).not.toContain("File not found");
  });
});

describe("FilesystemBundle > write_file", () => {
  test("writes content and creates parent directories", async () => {
    const ws = makeTempWorkspace();
    const result = await makeRuntime().execute(
      call("write_file", { path: "nested/dir/new.txt", content: "a\nb\nc" }),
      makeCtx(ws),
    );
    expect(result.is_error).toBe(false);
    expect(existsSync(join(ws, "nested", "dir", "new.txt"))).toBe(true);
    expect(readFileSync(join(ws, "nested", "dir", "new.txt"), "utf-8")).toBe("a\nb\nc");
  });
});

describe("FilesystemBundle > edit_file (read-before-edit guard)", () => {
  test("refuses to edit a file that has not been read", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "f.txt"), "hello world");
    const result = await makeRuntime().execute(
      call("edit_file", { path: "f.txt", old_string: "hello", new_string: "hi" }),
      makeCtx(ws),
    );
    expect(result.output).toContain("has not been read yet");
  });

  test("edits after the file has been read in the same runtime/process", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "f.txt"), "hello world");
    const rt = makeRuntime();
    const ctx = makeCtx(ws);
    await rt.execute(call("read_file", { path: "f.txt" }), ctx);
    const result = await rt.execute(
      call("edit_file", { path: "f.txt", old_string: "hello", new_string: "hi" }),
      ctx,
    );
    expect(result.is_error).toBe(false);
    expect(readFileSync(join(ws, "f.txt"), "utf-8")).toBe("hi world");
  });
});

describe("FilesystemBundle > apply_patch (Tier A)", () => {
  test("apply_patch is registered in the full bundle but NOT the read-only search bundle", () => {
    const full = makeRuntime().listTools().map((t) => t.function.name);
    expect(full).toContain("apply_patch");

    const search = createToolRuntime();
    registerSearchBundle(search);
    const searchNames = search.listTools().map((t) => t.function.name);
    expect(searchNames).not.toContain("apply_patch");
  });

  test("apply_patch is dangerous + approval-required", () => {
    const def = makeRuntime().listTools().find((d) => d.function.name === "apply_patch")!;
    expect(def.dangerous).toBe(true);
    expect(def.requires_approval).toBe(true);
  });

  test("refuses to patch a file that has not been read", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "p.txt"), "alpha\nbeta\ngamma\n");
    const patch = createTwoFilesPatch("p.txt", "p.txt", "alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\n");
    const result = await makeRuntime().execute(call("apply_patch", { path: "p.txt", patch }), makeCtx(ws));
    expect(result.output).toContain("has not been read yet");
  });

  test("applies a unified diff after the file has been read", async () => {
    const ws = makeTempWorkspace();
    const before = "alpha\nbeta\ngamma\n";
    const after = "alpha\nBETA\ngamma\n";
    writeFileSync(join(ws, "p.txt"), before);
    const patch = createTwoFilesPatch("p.txt", "p.txt", before, after);
    const rt = makeRuntime();
    const ctx = makeCtx(ws);
    await rt.execute(call("read_file", { path: "p.txt" }), ctx);
    const result = await rt.execute(call("apply_patch", { path: "p.txt", patch }), ctx);
    expect(result.is_error).toBe(false);
    expect(readFileSync(join(ws, "p.txt"), "utf-8")).toBe(after);
  });

  test("returns an error (without writing) when the patch does not apply", async () => {
    const ws = makeTempWorkspace();
    const before = "alpha\nbeta\ngamma\n";
    writeFileSync(join(ws, "p.txt"), before);
    // Patch built against different content → context mismatch.
    const patch = createTwoFilesPatch("p.txt", "p.txt", "x\ny\nz\n", "x\nY\nz\n");
    const rt = makeRuntime();
    const ctx = makeCtx(ws);
    await rt.execute(call("read_file", { path: "p.txt" }), ctx);
    const result = await rt.execute(call("apply_patch", { path: "p.txt", patch }), ctx);
    expect(result.output.toLowerCase()).toMatch(/could not|did not|does not|failed|not apply/);
    expect(readFileSync(join(ws, "p.txt"), "utf-8")).toBe(before);
  });
});

describe("FilesystemBundle > grep + glob + list_directory", () => {
  test("grep finds files containing the pattern", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "match.ts"), "const SECRET = 1;\n");
    writeFileSync(join(ws, "nomatch.ts"), "const x = 1;\n");
    const result = await makeRuntime().execute(call("grep", { pattern: "SECRET", path: ws }), makeCtx(ws));
    expect(result.output).toContain("match.ts");
    expect(result.output).not.toContain("nomatch.ts");
  });

  test("glob matches a single-level pattern", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "alpha.ts"), "");
    writeFileSync(join(ws, "beta.txt"), "");
    const result = await makeRuntime().execute(call("glob", { pattern: "*.ts", path: ws }), makeCtx(ws));
    expect(result.output).toContain("alpha.ts");
    expect(result.output).not.toContain("beta.txt");
  });

  test("list_directory lists entries with the count header", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "a.txt"), "");
    mkdirSync(join(ws, "sub"));
    const result = await makeRuntime().execute(call("list_directory", { path: "." }), makeCtx(ws));
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("a.txt");
    expect(result.output).toContain("sub");
  });
});
