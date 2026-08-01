import { createHash } from "crypto";
import { join, resolve } from "path";
import { describe, expect, test } from "bun:test";
import {
  ensureVerificationWorkspace,
  type EnsureVerificationWorkspaceInput,
  type VerificationExecCall,
  type VerificationExecResult,
} from "./verification-workspace";

const ROOT = "C:\\work\\Perihelion";
const STATE_ROOT = "C:\\Users\\test\\.openclaw\\jarvis";

function hashRoot(root: string): string {
  return createHash("sha256").update(resolve(root)).digest("hex");
}

function expectedCacheDir(root = ROOT, stateRoot = STATE_ROOT): string {
  return join(stateRoot, "build-cache", hashRoot(root));
}

function makeExists(files: string[]) {
  const set = new Set(files.map((p) => p.replace(/\\/g, "/").toLowerCase()));
  return (p: string) => set.has(p.replace(/\\/g, "/").toLowerCase());
}

function recordingExec(result: Partial<VerificationExecResult> = {}) {
  const calls: VerificationExecCall[] = [];
  const base: VerificationExecResult = {
    code: 0,
    enoent: false,
    timedOut: false,
    stderr: "",
    stdout: "",
  };
  const exec = async (
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<VerificationExecResult> => {
    calls.push({ command, args, cwd, timeoutMs });
    return { ...base, ...result };
  };
  return { calls, exec };
}

function baseInput(
  over: Partial<EnsureVerificationWorkspaceInput> & {
    files?: string[];
  } = {},
): EnsureVerificationWorkspaceInput {
  const { files, ...rest } = over;
  return {
    root: ROOT,
    stateRoot: STATE_ROOT,
    prepareTimeoutMs: 120_000,
    exists: makeExists(files ?? []),
    mkdir: () => {},
    ...rest,
  };
}

describe("ensureVerificationWorkspace", () => {
  test("non-CMake workspaces return not_applicable without spawning", async () => {
    const { calls, exec } = recordingExec();
    const r = await ensureVerificationWorkspace(baseInput({
      files: [join(ROOT, "Cargo.toml")],
      exec,
    }));
    expect(r).toEqual({ kind: "not_applicable" });
    expect(calls).toEqual([]);
  });

  test("existing workspace build/CMakeCache.txt returns ready without configuring", async () => {
    const { calls, exec } = recordingExec();
    const buildDir = join(ROOT, "build");
    const r = await ensureVerificationWorkspace(baseInput({
      files: [
        join(ROOT, "CMakeLists.txt"),
        join(buildDir, "CMakeCache.txt"),
      ],
      exec,
    }));
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") {
      expect(r.buildDir).toBe(buildDir);
      expect(r.prepared).toBe(false);
      expect(r.command).toContain("cmake --build");
    }
    expect(calls).toEqual([]);
  });

  test("unconfigured CMake configures into stateRoot/build-cache/<sha256(root)>", async () => {
    const { calls, exec } = recordingExec();
    const mkdirCalls: string[] = [];
    const expectedCache = expectedCacheDir();
    const r = await ensureVerificationWorkspace(baseInput({
      files: [join(ROOT, "CMakeLists.txt")],
      exec,
      mkdir: (p) => { mkdirCalls.push(p); },
    }));

    expect(r.kind).toBe("ready");
    if (r.kind === "ready") {
      expect(r.buildDir).toBe(expectedCache);
      expect(r.prepared).toBe(true);
      expect(r.command).toContain("cmake -S");
    }
    expect(mkdirCalls).toContain(expectedCache);
    expect(calls).toEqual([{
      command: "cmake",
      args: ["-S", ROOT, "-B", expectedCache],
      cwd: ROOT,
      timeoutMs: 120_000,
    }]);
  });

  test("second call reuses configured cache without re-running cmake", async () => {
    const files = new Set([join(ROOT, "CMakeLists.txt")].map((p) => p.replace(/\\/g, "/").toLowerCase()));
    const exists = (p: string) => files.has(p.replace(/\\/g, "/").toLowerCase());
    const { calls, exec } = recordingExec();
    // After first configure succeeds, tests simulate cache by adding CMakeCache.
    const mkdir = (p: string) => {
      files.add(join(p, "CMakeCache.txt").replace(/\\/g, "/").toLowerCase());
    };

    const first = await ensureVerificationWorkspace(baseInput({ exists, exec, mkdir }));
    expect(first.kind).toBe("ready");
    if (first.kind === "ready") {
      // Mark cache present for reuse (mkdir already added it; re-add for clarity).
      files.add(join(first.buildDir, "CMakeCache.txt").replace(/\\/g, "/").toLowerCase());
    }

    const secondCalls: VerificationExecCall[] = [];
    const second = await ensureVerificationWorkspace(baseInput({
      exists,
      exec: async (command, args, cwd, timeoutMs) => {
        secondCalls.push({ command, args, cwd, timeoutMs });
        return { code: 0, enoent: false, timedOut: false, stderr: "", stdout: "" };
      },
      mkdir: () => {},
    }));

    expect(second.kind).toBe("ready");
    if (second.kind === "ready") {
      expect(second.buildDir).toBe(expectedCacheDir());
      expect(second.prepared).toBe(false);
    }
    expect(secondCalls).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("configure timeout returns unavailable with bounded diagnostics", async () => {
    const { calls, exec } = recordingExec({
      code: null,
      timedOut: true,
      stderr: "configure hung\n".repeat(50),
    });
    const r = await ensureVerificationWorkspace(baseInput({
      files: [join(ROOT, "CMakeLists.txt")],
      exec,
    }));
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") {
      expect(r.detail.toLowerCase()).toMatch(/timed?\s*out|timeout/);
      expect(r.detail.length).toBeLessThanOrEqual(400);
      expect(r.command).toContain("cmake -S");
    }
    expect(calls).toHaveLength(1);
  });

  test("configure failure returns unavailable with bounded diagnostics", async () => {
    const long = "CMake Error: bad generator\n".repeat(40);
    const { exec } = recordingExec({ code: 1, stderr: long });
    const r = await ensureVerificationWorkspace(baseInput({
      files: [join(ROOT, "CMakeLists.txt")],
      exec,
    }));
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") {
      expect(r.detail).toContain("CMake Error");
      expect(r.detail.length).toBeLessThanOrEqual(400);
      expect(r.command).toContain(`-B ${expectedCacheDir()}`);
    }
  });

  test("cmake binary missing (ENOENT) is unavailable", async () => {
    const { exec } = recordingExec({ enoent: true, code: null });
    const r = await ensureVerificationWorkspace(baseInput({
      files: [join(ROOT, "CMakeLists.txt")],
      exec,
    }));
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") {
      expect(r.detail.toLowerCase()).toMatch(/cmake|not found|enoent|unavailable/);
    }
  });

  test("prefers out/ over cold cache when configured", async () => {
    const { calls, exec } = recordingExec();
    const outDir = join(ROOT, "out");
    const r = await ensureVerificationWorkspace(baseInput({
      files: [
        join(ROOT, "CMakeLists.txt"),
        join(outDir, "CMakeCache.txt"),
      ],
      exec,
    }));
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") {
      expect(r.buildDir).toBe(outDir);
      expect(r.prepared).toBe(false);
    }
    expect(calls).toEqual([]);
  });
});
