import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import * as realChildProcess from "node:child_process";

/**
 * DS-26: `config.ts` used to discover the Windows home by running a blocking
 * `execSync` of a Windows shell during module evaluation, so every server
 * start paid a child-process spawn before the self-log, the SQLite open and
 * `serve()`. These tests arm a tripwire on `child_process` that records and
 * throws on any call, so putting the spawn back fails them.
 */
const childProcessCalls: string[] = [];

function tripwire(name: string) {
  return (..._args: unknown[]): never => {
    childProcessCalls.push(name);
    throw new Error(`config.ts must not call child_process.${name}() (DS-26)`);
  };
}

/**
 * Snapshot of the real module, taken before anything is mocked, so the mock
 * can be handed back at the end of the file: `mock.restore()` is documented
 * not to undo `mock.module()` overrides, and a throwing stub left installed
 * would break every later test file that spawns a process.
 */
const realChildProcessExports = { ...realChildProcess };

// Only the process-spawning entry points are replaced; a module reaching for
// any of them during config resolution trips the test. Everything else is
// passed through so importing `child_process` still resolves every export.
const tripwireModule = {
  ...realChildProcessExports,
  exec: tripwire("exec"),
  execFile: tripwire("execFile"),
  execFileSync: tripwire("execFileSync"),
  execSync: tripwire("execSync"),
  fork: tripwire("fork"),
  spawn: tripwire("spawn"),
  spawnSync: tripwire("spawnSync"),
};

// config.ts imports the un-prefixed specifier historically, so both spellings
// are muzzled. Registered at file scope, before any import of ./config.
mock.module("child_process", () => tripwireModule);
mock.module("node:child_process", () => tripwireModule);

beforeEach(() => {
  childProcessCalls.length = 0;
});

afterAll(() => {
  mock.module("child_process", () => realChildProcessExports);
  mock.module("node:child_process", () => realChildProcessExports);
});

describe("config module import path (DS-26)", () => {
  test("importing config.ts spawns no child process", async () => {
    const config = await import("./config");

    // The module really did evaluate, and the exported constants keep their
    // names and shapes.
    expect(config.CONFIG_DIR.length).toBeGreaterThan(0);
    expect(config.CONFIG_FILE).toBe(join(config.CONFIG_DIR, "config.json"));
    expect(config.SESSIONS_DIR).toBe(join(config.CONFIG_DIR, "sessions"));
    expect(config.COMPANION_FILE).toBe(join(config.CONFIG_DIR, "companion.json"));
    expect(config.LOGS_DIR).toBe(join(config.CONFIG_DIR, "logs"));

    expect(childProcessCalls).toEqual([]);
  });

  test("config.ts source never imports or executes child_process", () => {
    // Deterministic companion to the tripwire: module caches can hide an
    // import-time spawn from a late spy, but the shipped source cannot.
    const source = readFileSync(join(import.meta.dir, "config.ts"), "utf-8");
    expect(source).not.toMatch(/from\s+["'](?:node:)?child_process["']/);
    expect(source).not.toMatch(/require\(\s*["'](?:node:)?child_process["']\s*\)/);
    expect(source).not.toMatch(/\bexecSync\s*\(/);
    expect(source).not.toMatch(/\bexecFileSync\s*\(/);
    expect(childProcessCalls).toEqual([]);
  });
});

describe("Windows home resolution without a subprocess (DS-26)", () => {
  test("maps USERPROFILE to the same /mnt/<drive> form as the old shell echo", async () => {
    const { resolveWindowsHome } = await import("./config");

    expect(resolveWindowsHome({ USERPROFILE: "C:\\Users\\example" })).toBe("/mnt/c/Users/example");
    expect(resolveWindowsHome({ USERPROFILE: "c:\\Users\\example" })).toBe("/mnt/c/Users/example");
    expect(resolveWindowsHome({ USERPROFILE: "D:\\Profiles\\example" })).toBe("/mnt/d/Profiles/example");
    // Already in the WSL shape a WSL-spawned server may inherit.
    expect(resolveWindowsHome({ USERPROFILE: "/mnt/c/Users/example" })).toBe("/mnt/c/Users/example");

    expect(childProcessCalls).toEqual([]);
  });

  test("falls back to HOMEDRIVE + HOMEPATH as the secondary Windows profile", async () => {
    const { resolveWindowsHome } = await import("./config");

    expect(resolveWindowsHome({ HOMEDRIVE: "C:", HOMEPATH: "\\Users\\example" })).toBe("/mnt/c/Users/example");
    expect(resolveWindowsHome({ USERPROFILE: "not-a-path", HOMEDRIVE: "D:", HOMEPATH: "\\Data\\example" }))
      .toBe("/mnt/d/Data/example");

    expect(childProcessCalls).toEqual([]);
  });

  test("prefers an existing WSL-side config dir for a visible Windows profile", async () => {
    const { locateConfigDir } = await import("./config");

    const winHome = "/mnt/c/Users/example";
    const winDir = join(winHome, ".openclaw", "jarvis");
    const resolved = locateConfigDir(
      { USERPROFILE: "C:\\Users\\example" },
      "/home/example",
      (path) => path === winDir || path === join(winDir, "config.json"),
    );

    expect(resolved).toBe(winDir);
    expect(childProcessCalls).toEqual([]);
  });
});

describe("fallback when no Windows profile is visible (DS-26)", () => {
  test("resolution falls back to homedir() and does not spawn", async () => {
    const { locateConfigDir, resolveWindowsHome } = await import("./config");

    const home = join(homedir(), "example-home");
    const expected = join(home, ".openclaw", "jarvis");
    const neverExists = () => false;

    // No Windows profile in the environment at all.
    expect(resolveWindowsHome({})).toBeNull();
    expect(locateConfigDir({}, home, neverExists)).toBe(expected);

    // A Windows profile is visible but the WSL-side config dir is not there,
    // which is the shape a Windows-spawned server has today.
    expect(locateConfigDir({ USERPROFILE: "C:\\Users\\example" }, home, neverExists)).toBe(expected);

    // Repeated resolution reuses the memoised value instead of re-resolving.
    expect(locateConfigDir(undefined, home, neverExists)).toBe(expected);
    expect(locateConfigDir(undefined, home, neverExists)).toBe(expected);

    expect(childProcessCalls).toEqual([]);
  });
});
