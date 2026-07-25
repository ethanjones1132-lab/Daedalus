import { describe, expect, test } from "bun:test";
import { writtenPathsFrom, runBuildCheck, detectorFor, type ExecResult, type DetectInput } from "./build-check";
import type { ToolCallRecord } from "./stage-output";

function call(name: string, path?: string, is_error = false): ToolCallRecord {
  return { name, arguments: path ? { path } : {}, output: "ok", is_error, duration_ms: 1 };
}

describe("writtenPathsFrom", () => {
  test("collects successful write-effect paths, dedupes, skips errors/reads", () => {
    const calls = [
      call("write_file", "a.cpp"),
      call("edit_file", "a.cpp"),          // dup
      call("read_file", "b.cpp"),          // not a write
      call("write_file", "c.py", true),    // errored write
      call("multi_edit", "d.rs"),
    ];
    expect(writtenPathsFrom(calls).sort()).toEqual(["a.cpp", "d.rs"]);
  });

  test("includes apply_patch as a write effect", () => {
    const calls = [call("apply_patch", "x.md")];
    expect(writtenPathsFrom(calls)).toEqual(["x.md"]);
  });

  test("returns empty for an empty call list", () => {
    expect(writtenPathsFrom([])).toEqual([]);
  });

  test("ignores write calls whose arguments.path is missing/non-string", () => {
    const calls: ToolCallRecord[] = [
      { name: "write_file", arguments: {}, output: "ok", is_error: false, duration_ms: 1 },
      { name: "write_file", arguments: { path: 42 }, output: "ok", is_error: false, duration_ms: 1 },
      { name: "write_file", arguments: { path: "   " }, output: "ok", is_error: false, duration_ms: 1 },
      { name: "write_file", arguments: { path: "ok.txt" }, output: "ok", is_error: false, duration_ms: 1 },
    ];
    expect(writtenPathsFrom(calls)).toEqual(["ok.txt"]);
  });
});

function di(over: Partial<{ root: string; files: string[]; makefile: string }>): DetectInput {
  const files = new Set((over.files ?? []).map((p) => p.replace(/\\/g, "/")));
  return {
    root: over.root ?? "/ws",
    writtenPaths: [],
    exists: (p: string) => files.has(p.replace(/\\/g, "/")),
    readText: (p: string) => (p.endsWith("Makefile") ? (over.makefile ?? null) : null),
  };
}

describe("detector registry", () => {
  test("cargo detected from Cargo.toml → cargo check", () => {
    const d = detectorFor(di({ files: ["/ws/Cargo.toml"] }));
    expect(d?.id).toBe("cargo");
    expect(d?.cmd).toMatchObject({ command: "cargo", args: ["check", "--quiet"] });
  });

  test("cmake declines when no configured build dir exists", () => {
    expect(detectorFor(di({ files: ["/ws/CMakeLists.txt"] }))).toBeNull();
  });

  test("cmake runs incremental build when a configured build dir exists", () => {
    const sep = require("path").sep as string;
    const d = detectorFor(di({ files: ["/ws/CMakeLists.txt", "/ws/build/CMakeCache.txt"] }));
    expect(d?.id).toBe("cmake");
    expect(d?.cmd.command).toBe("cmake");
    expect(d?.cmd.args).toEqual(["--build", `/ws/build`.replace(/\//g, sep)]);
  });

  test("go detected from go.mod → go build ./...", () => {
    expect(detectorFor(di({ files: ["/ws/go.mod"] }))?.id).toBe("go");
  });

  test("node detected from tsconfig.json → tsc --noEmit", () => {
    const d = detectorFor(di({ files: ["/ws/tsconfig.json"] }));
    expect(d?.id).toBe("node");
    expect(d?.cmd.args).toContain("--noEmit");
  });

  test("make only when a check/test target exists", () => {
    expect(detectorFor(di({ files: ["/ws/Makefile"], makefile: "all:\n\tgcc x\n" }))).toBeNull();
    const d = detectorFor(di({ files: ["/ws/Makefile"], makefile: "check:\n\tctest\n" }));
    expect(d?.cmd).toMatchObject({ command: "make", args: ["check"] });
  });

  test("cargo wins over cmake when both markers present (precedence)", () => {
    const d = detectorFor(di({ files: ["/ws/Cargo.toml", "/ws/CMakeLists.txt", "/ws/build/CMakeCache.txt"] }));
    expect(d?.id).toBe("cargo");
  });
});

function fakeExec(map: Record<string, Partial<ExecResult>>) {
  return async (_cmd: string, _args: string[]): Promise<ExecResult> => {
    const base: ExecResult = { code: 0, enoent: false, timedOut: false, stderr: "", stdout: "" };
    return { ...base, ...(map[_cmd] ?? {}) };
  };
}
function files(...paths: string[]) {
  const s = new Set(paths.map((p) => p.replace(/\\/g, "/")));
  return (p: string) => s.has(p.replace(/\\/g, "/"));
}

describe("runBuildCheck", () => {
  test("clean build → clean outcome", async () => {
    const r = await runBuildCheck({
      root: "/ws", writtenPaths: ["/ws/a.rs"], timeoutMs: 1000,
      exists: files("/ws/Cargo.toml"), exec: fakeExec({ cargo: { code: 0 } }),
    });
    expect(r.kind).toBe("clean");
    if (r.kind === "clean") expect(r.command).toContain("cargo check");
  });

  test("failed build → failed outcome with stderr detail", async () => {
    const r = await runBuildCheck({
      root: "/ws", writtenPaths: ["/ws/a.rs"], timeoutMs: 1000,
      exists: files("/ws/Cargo.toml"),
      exec: fakeExec({ cargo: { code: 101, stderr: "error[E0425]: cannot find value `x`" } }),
    });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.detail).toContain("E0425");
  });

  test("toolchain absent (ENOENT) skips to next detector, then honest none", async () => {
    const r = await runBuildCheck({
      root: "/ws", writtenPaths: ["/ws/a.rs"], timeoutMs: 1000,
      exists: files("/ws/Cargo.toml"), exec: fakeExec({ cargo: { enoent: true } }),
    });
    expect(r.kind).toBe("not_applicable");
  });

  test("timeout → not_applicable", async () => {
    const r = await runBuildCheck({
      root: "/ws", writtenPaths: ["/ws/a.rs"], timeoutMs: 1000,
      exists: files("/ws/Cargo.toml"), exec: fakeExec({ cargo: { timedOut: true, code: null } }),
    });
    expect(r.kind).toBe("not_applicable");
    if (r.kind === "not_applicable") expect(r.reason).toContain("timed out");
  });

  test("no detector and no python → honest not_applicable", async () => {
    const r = await runBuildCheck({
      root: "/ws", writtenPaths: ["/ws/a.cpp"], timeoutMs: 1000,
      exists: files(), exec: fakeExec({}),
    });
    expect(r.kind).toBe("not_applicable");
  });
});
