// ═══════════════════════════════════════════════════════════════
// ── Tier A Done-Gate Test Harness (Core Coding Loop) ──
// ═══════════════════════════════════════════════════════════════
//
// Authoritative gate suite for Tier A (core coding loop) completion: safe file
// operations + patch workflows through the canonical ToolRuntime. MUST remain
// green before later Tier work.
//
//   FUNCTIONAL GATE
//     A file-backed coding loop (read → write → edit → apply_patch) completes
//     end-to-end through the canonical ToolRuntime on the interactive surface.
//
//   SAFETY GATE
//     Mutating tools (write_file/edit_file/multi_edit/apply_patch) are denied
//     on the non-interactive cron surface, and an interactive "ask" that is
//     rejected via requestApproval does not run the handler.
//
//   STABILITY GATE
//     The read-before-write guard blocks blind edits/patches, and apply_patch
//     fails cleanly (without writing) on a context mismatch.
//
// Each gate section includes at least one assertion whose failure message names
// the violated gate explicitly.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTwoFilesPatch } from "diff";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import type { ExecutionContext, ToolRuntime } from "./tool-runtime";
import { registerFilesystemBundle } from "./filesystem-bundle";
import { defaultConfig } from "./config";

const cleanups: string[] = [];

function makeTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-tier-a-gate-"));
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

function makeCtx(
  workspace: string,
  surface: ExecutionContext["surface"] = "chat",
  overrides: Partial<ExecutionContext> = {},
): ExecutionContext {
  const cfg = defaultConfig();
  cfg.jarvis_path = workspace;
  cfg.tools.enabled = true;
  return makeExecutionContext(surface, cfg, { workspace_path: workspace, ...overrides });
}

function call(name: string, args: Record<string, unknown>) {
  return { id: `gate-${name}`, name, arguments: args };
}

const MUTATING = ["write_file", "edit_file", "multi_edit", "apply_patch"];

// ── FUNCTIONAL GATE ─────────────────────────────────────────────────────────
describe("Tier A FUNCTIONAL gate: coding loop through canonical runtime", () => {
  test("GATE-TA-F1: read → write → edit → apply_patch completes end-to-end", async () => {
    const ws = makeTempWorkspace();
    const rt = makeRuntime();
    // Interactive surface that auto-approves so the dangerous/approval tools run.
    const ctx = makeCtx(ws, "chat", { requestApproval: async () => true });

    // write a new file
    const w = await rt.execute(call("write_file", { path: "code.ts", content: "const a = 1;\nconst b = 2;\nconst c = 3;\n" }), ctx);
    expect(w.is_error).toBe(false);
    expect(existsSync(join(ws, "code.ts"))).toBe(true);

    // read it (also satisfies the read-before-write guard)
    const r = await rt.execute(call("read_file", { path: "code.ts" }), ctx);
    expect(r.is_error).toBe(false);

    // edit it
    const e = await rt.execute(call("edit_file", { path: "code.ts", old_string: "const b = 2;", new_string: "const b = 22;" }), ctx);
    expect(e.is_error).toBe(false);
    expect(readFileSync(join(ws, "code.ts"), "utf-8")).toContain("const b = 22;");

    // patch it
    const before = readFileSync(join(ws, "code.ts"), "utf-8");
    const after = before.replace("const c = 3;", "const c = 33;");
    const patch = createTwoFilesPatch("code.ts", "code.ts", before, after);
    const p = await rt.execute(call("apply_patch", { path: "code.ts", patch }), ctx);
    expect(p.is_error).toBe(false);
    expect(readFileSync(join(ws, "code.ts"), "utf-8")).toBe(after);
    // FUNCTIONAL GATE: the full coding loop must run through the canonical runtime.
    expect(readFileSync(join(ws, "code.ts"), "utf-8")).toContain("const c = 33;");
  });
});

// ── SAFETY GATE ─────────────────────────────────────────────────────────────
describe("Tier A SAFETY gate: policy + approval on mutating tools", () => {
  test("GATE-TA-S1: every mutating tool is denied on the non-interactive cron surface", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "f.txt"), "x\n");
    const rt = makeRuntime();
    const ctx = makeCtx(ws, "cron");
    for (const name of MUTATING) {
      const args = name === "apply_patch"
        ? { path: "f.txt", patch: "" }
        : name === "multi_edit"
        ? { path: "f.txt", edits: [] }
        : name === "edit_file"
        ? { path: "f.txt", old_string: "x", new_string: "y" }
        : { path: "f.txt", content: "y" };
      const res = await rt.execute(call(name, args), ctx);
      // SAFETY GATE: non-interactive cron must never run an approval-required tool.
      expect(res.is_error).toBe(true);
      expect(res.error).toMatch(/non-interactive|approval/i);
    }
  });

  test("GATE-TA-S2: an interactive 'ask' rejected via requestApproval does not run the handler", async () => {
    const ws = makeTempWorkspace();
    const rt = makeRuntime();
    const ctx = makeCtx(ws, "chat", { requestApproval: async () => false });
    const res = await rt.execute(call("write_file", { path: "blocked.txt", content: "nope" }), ctx);
    // SAFETY GATE: a rejected approval must block the write.
    expect(res.is_error).toBe(true);
    expect(existsSync(join(ws, "blocked.txt"))).toBe(false);
  });
});

// ── STABILITY GATE ──────────────────────────────────────────────────────────
describe("Tier A STABILITY gate: guards + clean failure", () => {
  test("GATE-TA-ST1: edit_file and apply_patch refuse a file not read in this session", async () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "g.txt"), "alpha\nbeta\n");
    const rt = makeRuntime();
    const ctx = makeCtx(ws, "chat", { requestApproval: async () => true });

    const e = await rt.execute(call("edit_file", { path: "g.txt", old_string: "alpha", new_string: "ALPHA" }), ctx);
    expect(e.is_error).toBe(true);
    expect(e.error).toContain("has not been read yet");

    const patch = createTwoFilesPatch("g.txt", "g.txt", "alpha\nbeta\n", "ALPHA\nbeta\n");
    const p = await rt.execute(call("apply_patch", { path: "g.txt", patch }), ctx);
    // STABILITY GATE: blind patches must be refused.
    expect(p.is_error).toBe(true);
    expect(p.error).toContain("has not been read yet");
  });

  test("GATE-TA-ST2: apply_patch fails cleanly without writing on a context mismatch", async () => {
    const ws = makeTempWorkspace();
    const before = "one\ntwo\nthree\n";
    writeFileSync(join(ws, "h.txt"), before);
    const rt = makeRuntime();
    const ctx = makeCtx(ws, "chat", { requestApproval: async () => true });
    await rt.execute(call("read_file", { path: "h.txt" }), ctx);
    const patch = createTwoFilesPatch("h.txt", "h.txt", "no\nmatch\nhere\n", "no\nMATCH\nhere\n");
    const p = await rt.execute(call("apply_patch", { path: "h.txt", patch }), ctx);
    // STABILITY GATE: a non-applying patch must leave the file untouched.
    expect(readFileSync(join(ws, "h.txt"), "utf-8")).toBe(before);
  });
});
