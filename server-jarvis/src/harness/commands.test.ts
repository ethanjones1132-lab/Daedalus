import { describe, expect, test } from "bun:test";
import { HARNESS_COMMANDS, type HarnessCommand } from "./commands";

/**
 * Names that cannot be spawned directly by `execFile`: npm/npx/pnpm/yarn and
 * per-package bins such as vitest are installed as `.cmd` shims on Windows
 * (bunx may be one too), and shell interpreters would turn argv back into a
 * shell string. The harness spawn deliberately never goes through either.
 */
const UNSAFE_EXECUTABLES = new Set([
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "vitest",
  "bunx",
  "cmd",
  "powershell",
  "pwsh",
  "sh",
  "bash",
]);

function executableName(executable: string): string {
  return executable.replace(/\\/g, "/").split("/").pop() ?? executable;
}

function expectDirectlySpawnable(command: HarnessCommand): void {
  const name = executableName(command.executable);
  // A bare name is resolved by execFile against PATH; a path separator would
  // make the launch environment, not the catalogue, decide what runs.
  expect(command.executable, `${command.command_id}: executable must be a bare name`).toBe(name);
  expect(name, `${command.command_id}: executable must not be empty`).not.toBe("");
  expect(name, `${command.command_id}: executable must not contain whitespace`).not.toMatch(/\s/);
  expect(name.toLowerCase(), `${command.command_id}: executable must not be a Windows shim`).not.toMatch(
    /\.(?:cmd|bat|ps1|com|sh)$/,
  );
  expect(
    UNSAFE_EXECUTABLES.has(name.toLowerCase()),
    `${command.command_id}: "${name}" is a shim or shell, not a directly spawnable executable`,
  ).toBe(false);
  for (const arg of command.fixed_args) {
    expect(typeof arg, `${command.command_id}: fixed args must be plain strings`).toBe("string");
    expect(arg.length, `${command.command_id}: fixed args must not be empty`).toBeGreaterThan(0);
    expect(arg, `${command.command_id}: fixed args must not embed NUL or newlines`).not.toMatch(/[\0\r\n]/);
  }
}

describe("HARNESS_COMMANDS", () => {
  // One case per command id, so a regression names the offending command.
  for (const command of HARNESS_COMMANDS) {
    test(`${command.command_id} is launchable without a shell`, () => {
      expectDirectlySpawnable(command);
    });
  }

  test("no command id uses npm or vitest as its executable", () => {
    for (const command of HARNESS_COMMANDS) {
      const name = executableName(command.executable).toLowerCase();
      expect(name, `${command.command_id} must not spawn npm`).not.toBe("npm");
      expect(name, `${command.command_id} must not spawn vitest`).not.toBe("vitest");
    }
  });
});
