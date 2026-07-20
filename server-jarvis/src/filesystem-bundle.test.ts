import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTwoFilesPatch } from "diff";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import type { ToolRuntime, ExecutionContext } from "./tool-runtime";
import { registerFilesystemBundle, registerSearchBundle } from "./filesystem-bundle";
import { defaultConfig } from "./config";
import { markFileRead } from "./fs-read-cache";

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
  // Auto-approving hook: these tests exercise the tool HANDLERS, so they stand
  // in for a real interactive surface where the user approved the call. Without
  // a hook, approval-gated tools (write/edit/patch) are now correctly DENIED.
  return makeExecutionContext(surface, cfg, {
    workspace_path: workspace,
    requestApproval: async () => true,
  });
}

function makeCtxWithRoots(
  configWorkspace: string,
  invocationWorkspace: string,
  surface: ExecutionContext["surface"] = "chat",
): ExecutionContext {
  const cfg = defaultConfig();
  cfg.jarvis_path = configWorkspace;
  cfg.tools.enabled = true;
  cfg.tools.sandbox_mode = "workspace";
  return makeExecutionContext(surface, cfg, {
    workspace_path: invocationWorkspace,
    requestApproval: async () => true,
  });
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

  test("read_file on a missing path returns is_error with a guidance message", async () => {
    // Deliberate inversion for the 2026-07-05 P0a batch: filesystem failures
    // must be typed errors, not successful tool results containing error prose.
    const ws = makeTempWorkspace();
    const result = await makeRuntime().execute(call("read_file", { path: "nope.txt" }), makeCtx(ws));
    expect(result.is_error).toBe(true);
    expect(result.error).toContain("File not found");
    expect(result.error).toContain("glob");
  });

  test("read_file on a directory returns is_error with an actionable list_directory hint", async () => {
    const ws = makeTempWorkspace();
    mkdirSync(join(ws, "subdir"));
    const result = await makeRuntime().execute(call("read_file", { path: "subdir" }), makeCtx(ws));
    expect(result.is_error).toBe(true);
    expect(result.error).toContain("is a directory");
    expect(result.error).toContain("list_directory");
  });

  test("read_file honors execution-context workspace_path when config.jarvis_path points elsewhere", async () => {
    const configWorkspace = makeTempWorkspace();
    const invocationWorkspace = makeTempWorkspace();
    mkdirSync(join(invocationWorkspace, "src"));
    writeFileSync(join(invocationWorkspace, "src", "target.ts"), "export const target = 1;\n");
    const result = await makeRuntime().execute(
      call("read_file", { path: "src/target.ts" }),
      makeCtxWithRoots(configWorkspace, invocationWorkspace),
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("export const target = 1;");
    expect(result.output).not.toContain("File not found");
  });

  test("read_file resolves relative paths through execution-context session grants", async () => {
    const workspace = makeTempWorkspace();
    const granted = makeTempWorkspace();
    mkdirSync(join(granted, "src"));
    writeFileSync(join(granted, "src", "granted.ts"), "export const granted = true;\n");
    const ctx = makeCtx(workspace);
    ctx.session_grants = [granted];

    const result = await makeRuntime().execute(call("read_file", { path: "src/granted.ts" }), ctx);
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("granted = true");
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

  test("write_file honors execution-context workspace_path when config.jarvis_path points elsewhere", async () => {
    const configWorkspace = makeTempWorkspace();
    const invocationWorkspace = makeTempWorkspace();
    const result = await makeRuntime().execute(
      call("write_file", { path: "outside-root-proof.txt", content: "workspace affinity works\n" }),
      makeCtxWithRoots(configWorkspace, invocationWorkspace),
    );

    expect(result.is_error).toBe(false);
    expect(readFileSync(join(invocationWorkspace, "outside-root-proof.txt"), "utf-8"))
      .toBe("workspace affinity works\n");
    expect(existsSync(join(configWorkspace, "outside-root-proof.txt"))).toBe(false);
  });

  test("write_file selects a granted root when only its candidate parent exists", async () => {
    const workspace = makeTempWorkspace();
    const granted = makeTempWorkspace();
    mkdirSync(join(granted, "generated"));
    const ctx = makeCtx(workspace);
    ctx.session_grants = [granted];

    const result = await makeRuntime().execute(
      call("write_file", { path: "generated/new.txt", content: "granted write\n" }),
      ctx,
    );
    expect(result.is_error).toBe(false);
    expect(readFileSync(join(granted, "generated", "new.txt"), "utf-8")).toBe("granted write\n");
    expect(existsSync(join(workspace, "generated", "new.txt"))).toBe(false);
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
    expect(result.is_error).toBe(true);
    expect(result.error).toContain("has not been read yet");
  });

  test("returns is_error when old_string is missing or ambiguous", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "missing.txt"), "alpha beta");
    writeFileSync(join(ws, "ambiguous.txt"), "hello hello");
    const rt = makeRuntime();
    const ctx = makeCtx(ws);
    await rt.execute(call("read_file", { path: "missing.txt" }), ctx);
    await rt.execute(call("read_file", { path: "ambiguous.txt" }), ctx);

    const missing = await rt.execute(
      call("edit_file", { path: "missing.txt", old_string: "gamma", new_string: "delta" }),
      ctx,
    );
    expect(missing.is_error).toBe(true);
    expect(missing.error).toContain("old_string not found");

    const ambiguous = await rt.execute(
      call("edit_file", { path: "ambiguous.txt", old_string: "hello", new_string: "hi" }),
      ctx,
    );
    expect(ambiguous.is_error).toBe(true);
    expect(ambiguous.error).toContain("appears 2 times");
  });

  test("multi_edit on a missing file returns is_error", async () => {
    const ws = makeTempWorkspace();
    markFileRead(join(ws, "missing.txt"));
    const result = await makeRuntime().execute(
      call("multi_edit", { path: "missing.txt", edits: [{ old_string: "a", new_string: "b" }] }),
      makeCtx(ws),
    );
    expect(result.is_error).toBe(true);
    expect(result.error).toContain("File not found");
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

  // ── 2026-07-18: line-number-gutter tolerance ──
  // read_file returns "    42 | code" but edits must match the RAW file; weak
  // models paste the gutter verbatim and previously fell into a
  // read→edit-fail→re-read death spiral.
  test("edit_file tolerates old/new strings pasted with the read_file gutter", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "g.txt"), "function a() {\n  return 1;\n}\n");
    const rt = makeRuntime();
    const ctx = makeCtx(ws);
    await rt.execute(call("read_file", { path: "g.txt" }), ctx);
    const result = await rt.execute(
      call("edit_file", {
        path: "g.txt",
        old_string: "     2 |   return 1;",
        new_string: "     2 |   return 2;",
      }),
      ctx,
    );
    expect(result.is_error).toBe(false);
    // The gutter must be stripped from BOTH sides — never written into the file.
    expect(readFileSync(join(ws, "g.txt"), "utf-8")).toBe("function a() {\n  return 2;\n}\n");
  });

  test("multi_edit tolerates the gutter the same way", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "h.txt"), "alpha\nbeta\n");
    const rt = makeRuntime();
    const ctx = makeCtx(ws);
    await rt.execute(call("read_file", { path: "h.txt" }), ctx);
    const result = await rt.execute(
      call("multi_edit", {
        path: "h.txt",
        edits: [{ old_string: "     1 | alpha", new_string: "     1 | ALPHA" }],
      }),
      ctx,
    );
    expect(result.is_error).toBe(false);
    expect(readFileSync(join(ws, "h.txt"), "utf-8")).toBe("ALPHA\nbeta\n");
  });
});

describe("FilesystemBundle > grep on a single file (2026-07-18)", () => {
  // Live incident: the write-repair rewriter located its edit target with
  // grep(path=<file>) and got "Directory not found", derailing the repair.
  test("grep accepts a FILE path and searches just that file", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "proc.cpp"), "void prepareToPlay() {\n  reset();\n}\nvoid other() {}\n");
    const result = await makeRuntime().execute(
      call("grep", { pattern: "prepareToPlay", path: "proc.cpp", output_mode: "content" }),
      makeCtx(ws),
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("prepareToPlay");
    expect(result.output).toContain("1:");
  });

  test("grep on a missing path still errors with glob guidance", async () => {
    const ws = makeTempWorkspace();
    const result = await makeRuntime().execute(
      call("grep", { pattern: "x", path: "nope-dir" }),
      makeCtx(ws),
    );
    expect(result.is_error).toBe(true);
    expect(result.error).toContain("glob");
  });
});

describe("FilesystemBundle > read_file continuation note (2026-07-18)", () => {
  test("a cut-off read names the window and the exact continuation call", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "big.txt"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"));
    const result = await makeRuntime().execute(
      call("read_file", { path: "big.txt", limit: 4 }),
      makeCtx(ws),
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("showing lines 1-4 of 10 total");
    expect(result.output).toContain("offset=5");
  });

  test("a complete read carries no continuation note", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "small.txt"), "one\ntwo\n");
    const result = await makeRuntime().execute(
      call("read_file", { path: "small.txt" }),
      makeCtx(ws),
    );
    expect(result.output).not.toContain("showing lines");
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
    expect(result.is_error).toBe(true);
    expect(result.error).toContain("has not been read yet");
  });

  test("apply_patch on a missing file returns is_error", async () => {
    const ws = makeTempWorkspace();
    const path = join(ws, "missing.txt");
    markFileRead(path);
    const patch = createTwoFilesPatch("missing.txt", "missing.txt", "a\n", "b\n");
    const result = await makeRuntime().execute(call("apply_patch", { path: "missing.txt", patch }), makeCtx(ws));
    expect(result.is_error).toBe(true);
    expect(result.error).toContain("File not found");
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
    expect(result.is_error).toBe(true);
    expect(result.error?.toLowerCase()).toMatch(/could not|did not|does not|failed|not apply/);
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

  test("missing search roots return typed errors for glob, grep, and list_directory", async () => {
    const ws = makeTempWorkspace();
    const rt = makeRuntime();
    const ctx = makeCtx(ws);

    for (const [name, args] of [
      ["glob", { pattern: "**/*.ts", path: "missing" }],
      ["grep", { pattern: "x", path: "missing" }],
      ["list_directory", { path: "missing" }],
    ] as const) {
      const result = await rt.execute(call(name, args), ctx);
      expect(result.is_error).toBe(true);
      expect(result.error).toContain("not found");
    }
  });

  test("glob and list_directory default to execution-context workspace_path when config.jarvis_path is stale", async () => {
    const configWorkspace = makeTempWorkspace();
    const invocationWorkspace = makeTempWorkspace();
    mkdirSync(join(invocationWorkspace, "src"));
    writeFileSync(join(invocationWorkspace, "src", "alpha.ts"), "export const alpha = 1;\n");

    const ctx = makeCtxWithRoots(configWorkspace, invocationWorkspace);
    const list = await makeRuntime().execute(call("list_directory", { path: "." }), ctx);
    expect(list.is_error).toBe(false);
    expect(list.output).toContain("src");

    const glob = await makeRuntime().execute(call("glob", { pattern: "**/*.ts" }), ctx);
    expect(glob.is_error).toBe(false);
    expect(glob.output).toContain("alpha.ts");
  });
});
