import { describe, expect, test } from "bun:test";
import { HARNESS_COMMANDS, getHarnessCommand, type HarnessCommand } from "./commands";

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

/**
 * tsc (`bun run typecheck`), `cargo fmt --check` and `cargo check` exit 0
 * without printing an integer summary on success. These commands must report
 * counter 0 there, while a non-zero exit or a real diagnostic still fails.
 */
const CLEAN_ON_SUCCESS_COMMANDS = ["bun_typecheck", "npm_typecheck", "cargo_fmt_check", "cargo_check"] as const;

function commandById(commandId: string): HarnessCommand {
  const command = getHarnessCommand(commandId);
  if (!command) throw new Error(`missing harness command: ${commandId}`);
  return command;
}

describe("clean-success counter parsing", () => {
  for (const commandId of CLEAN_ON_SUCCESS_COMMANDS) {
    test(`${commandId} reports counter 0 for a silent exit 0`, () => {
      expect(commandById(commandId).parse("", "", 0)).toEqual({ ok: true, counter: 0 });
    });

    test(`${commandId} reports counter 0 for exit 0 with only warnings`, () => {
      expect(commandById(commandId).parse("warning: unused variable `x`", "", 0)).toEqual({ ok: true, counter: 0 });
    });

    test(`${commandId} keeps a real diagnostic on exit 1 failed`, () => {
      const result = commandById(commandId).parse(
        "",
        "error TS2322: Type 'string' is not assignable to type 'number'.",
        1,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("1");
    });

    test(`${commandId} does not turn a silent non-zero exit into zero`, () => {
      // Silent non-zero must never become zero; the exact wording belongs to
      // `parseCounter`, which reports the missing counter before it reports the
      // exit code, so only the failure itself is pinned here.
      expect(commandById(commandId).parse("", "", 2)).toEqual({ ok: false, error: expect.any(String) });
    });

    test(`${commandId} still parses an explicit counter`, () => {
      expect(commandById(commandId).parse("errors: 3", "", 1)).toEqual({ ok: true, counter: 3 });
    });
  }

  test("a timeout marker on exit 0 is not reported as zero", () => {
    expect(commandById("cargo_check").parse("", "command timed out", 0).ok).toBe(false);
  });

  test("test commands keep requiring a counter on exit 0", () => {
    for (const commandId of ["bun_test", "vitest_run", "cargo_test"]) {
      expect(commandById(commandId).parse("", "", 0).ok, `${commandId} must not infer zero`).toBe(false);
    }
  });
});
