const INVALID_ARGUMENTS_MESSAGE = 'MCP arguments must be a JSON array of strings.';

export function encodeMcpArguments(args: readonly string[]): string {
  return JSON.stringify(args);
}

export function decodeMcpArguments(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError(INVALID_ARGUMENTS_MESSAGE);
  }
  if (!Array.isArray(parsed) || !parsed.every((argument) => typeof argument === 'string')) {
    throw new TypeError(INVALID_ARGUMENTS_MESSAGE);
  }
  return parsed;
}
