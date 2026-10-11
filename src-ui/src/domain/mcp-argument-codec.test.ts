import { describe, expect, it } from 'vitest';
import { decodeMcpArguments, encodeMcpArguments } from './mcp-argument-codec';

describe('MCP argument JSON codec', () => {
  it('round-trips an empty argument vector', () => {
    expect(encodeMcpArguments([])).toBe('[]');
    expect(decodeMcpArguments('[]')).toEqual([]);
  });

  it('round-trips ordinary flags and values', () => {
    const args = ['-y', '@modelcontextprotocol/server-filesystem', '--yes'];
    expect(encodeMcpArguments(args)).toBe('["-y","@modelcontextprotocol/server-filesystem","--yes"]');
    expect(decodeMcpArguments(encodeMcpArguments(args))).toEqual(args);
  });

  it('round-trips Windows paths containing spaces', () => {
    const args = ['--root', 'C:\\Program Files\\repo'];
    expect(decodeMcpArguments(encodeMcpArguments(args))).toEqual(args);
  });

  it('round-trips quoted, escaped, empty, and multiline values', () => {
    const args = ['', 'say "hello"', 'C:\\repo\\branch', 'first\nsecond', 'back\\slash'];
    expect(decodeMcpArguments(encodeMcpArguments(args))).toEqual(args);
  });

  it('rejects non-arrays and non-string entries', () => {
    expect(() => decodeMcpArguments('{}')).toThrow('MCP arguments must be a JSON array of strings.');
    expect(() => decodeMcpArguments('["-y",1]')).toThrow('MCP arguments must be a JSON array of strings.');
  });
});
