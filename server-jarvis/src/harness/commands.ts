/** Server-owned computational command catalog for harness sensors.
 *
 * Callers must spawn `executable` with `[...fixedArgs, ...sensorArgs]` directly;
 * these definitions are not shell command strings. Extra arguments are limited
 * to one safe positional test filter where the underlying command supports it.
 */

export type CounterParseResult =
  | { ok: true; counter: number }
  | { ok: false; error: string };

export interface HarnessCommand {
  command_id: string;
  executable: string;
  fixed_args: readonly string[];
  args_schema: {
    min_items: number;
    max_items: number;
    item_pattern?: RegExp;
  };
  default_timeout_ms: number;
  parse(stdout: string, stderr: string, exitCode: number): CounterParseResult;
}

function parseCounter(stdout: string, stderr: string, exitCode: number): CounterParseResult {
  const combined = `${stdout}\n${stderr}`;
  if (/\b(?:TIMEOUT|timed out|timeout)\b/i.test(combined)) {
    return { ok: false, error: "command output indicates timeout" };
  }
  if (!combined.trim()) return { ok: false, error: "command produced no counter output" };

  // Accept only explicit machine-readable-ish summaries. An absent summary is
  // not a zero: callers must never infer success from an exit code alone.
  const patterns = [
    /\b(?:errors?|diagnostics?)\s*[:=]\s*(\d+)\b/i,
    /\b(\d+)\s+(?:errors?|diagnostics?)\b/i,
    /\btest result:\s*[^\n]*?\b(\d+)\s+failed\b/i,
    /\b(\d+)\s+failed\b/i,
  ];
  for (const pattern of patterns) {
    const match = combined.match(pattern);
    if (match) return { ok: true, counter: Number(match[1]) };
  }
  if (exitCode !== 0) return { ok: false, error: `command exited with code ${exitCode} without a counter` };
  return { ok: false, error: "command output did not contain a recognized integer counter" };
}

const noArgs = { min_items: 0, max_items: 0 } as const;
const optionalFilter = {
  min_items: 0,
  max_items: 1,
  item_pattern: /^[A-Za-z0-9_./:@-]+$/,
} as const;

export const HARNESS_COMMANDS: readonly HarnessCommand[] = [
  { command_id: "bun_typecheck", executable: "bun", fixed_args: ["run", "typecheck"], args_schema: noArgs, default_timeout_ms: 120_000, parse: parseCounter },
  { command_id: "bun_test", executable: "bun", fixed_args: ["test"], args_schema: optionalFilter, default_timeout_ms: 180_000, parse: parseCounter },
  { command_id: "npm_typecheck", executable: "npm", fixed_args: ["run", "typecheck"], args_schema: noArgs, default_timeout_ms: 120_000, parse: parseCounter },
  { command_id: "vitest_run", executable: "vitest", fixed_args: ["run"], args_schema: optionalFilter, default_timeout_ms: 180_000, parse: parseCounter },
  { command_id: "cargo_fmt_check", executable: "cargo", fixed_args: ["fmt", "--check"], args_schema: noArgs, default_timeout_ms: 120_000, parse: parseCounter },
  { command_id: "cargo_check", executable: "cargo", fixed_args: ["check"], args_schema: noArgs, default_timeout_ms: 300_000, parse: parseCounter },
  { command_id: "cargo_test", executable: "cargo", fixed_args: ["test"], args_schema: optionalFilter, default_timeout_ms: 600_000, parse: parseCounter },
];

export function getHarnessCommand(commandId: string): HarnessCommand | undefined {
  return HARNESS_COMMANDS.find((command) => command.command_id === commandId);
}
