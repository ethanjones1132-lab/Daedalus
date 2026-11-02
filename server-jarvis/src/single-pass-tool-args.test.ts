import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  TOOL_ARGUMENTS_NOT_JSON_ERROR,
  TOOL_ARGUMENTS_NOT_OBJECT_ERROR,
  classifySinglePassToolArgs,
} from "./single-pass-tool-args";

describe("classifySinglePassToolArgs", () => {
  test("valid JSON arguments execute with the parsed object", () => {
    const result = classifySinglePassToolArgs('{"query":"tokio runtime","limit":3}');

    expect(result).toEqual({
      ok: true,
      args: { query: "tokio runtime", limit: 3 },
    });
  });

  test("a missing or empty arguments string still means no arguments", () => {
    expect(classifySinglePassToolArgs("")).toEqual({ ok: true, args: {} });
    expect(classifySinglePassToolArgs(undefined)).toEqual({ ok: true, args: {} });
    expect(classifySinglePassToolArgs(null)).toEqual({ ok: true, args: {} });
  });

  test("a truncated arguments string is a rejected call", () => {
    const result = classifySinglePassToolArgs('{"query":"unterminated');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejected call");
    expect(result.error).toBe(TOOL_ARGUMENTS_NOT_JSON_ERROR);
    expect(result.raw).toBe('{"query":"unterminated');
    // A rejection carries no arguments payload, so it cannot be mistaken for
    // an executed `{}` call.
    expect("args" in result).toBe(false);
  });

  test("JSON that is not an object is a rejected call, not an empty one", () => {
    for (const raw of ["[]", "null", "42", '"text"', "true"]) {
      const result = classifySinglePassToolArgs(raw);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected ${raw} to be rejected`);
      expect(result.error).toBe(TOOL_ARGUMENTS_NOT_OBJECT_ERROR);
    }
  });
});

describe("index.ts single-pass tool-call wiring", () => {
  function toolExecutionLoop(): string {
    const source = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");
    const start = source.indexOf("// Model called tools!");
    const end = source.indexOf("// Continue the loop to get assistant's next turn", start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  test("the loop classifies arguments before executing anything", () => {
    // index.ts cannot be imported (it starts the server), so pin the wiring:
    // restoring `parsedArgs = {}` + execute on the parse catch path must fail.
    const loop = toolExecutionLoop();

    expect(loop).toContain("classifySinglePassToolArgs(tc.function.arguments)");
    expect(loop).not.toContain("JSON.parse(tc.function.arguments");
    expect(loop).not.toMatch(/parsedArgs\s*=\s*\{\}/);

    const classifyAt = loop.indexOf("const toolArgs = classifySinglePassToolArgs(");
    const guardAt = loop.indexOf("if (!toolArgs.ok) {");
    const executeAt = loop.indexOf("runtime.execute(");

    expect(classifyAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(classifyAt);
    expect(executeAt).toBeGreaterThan(guardAt);
  });

  test("the rejection branch records an error and never executes", () => {
    const loop = toolExecutionLoop();
    const guardAt = loop.indexOf("if (!toolArgs.ok) {");
    const executeAt = loop.indexOf("const parsedArgs = toolArgs.args;");

    expect(guardAt).toBeGreaterThan(-1);
    expect(executeAt).toBeGreaterThan(guardAt);

    const rejection = loop.slice(guardAt, executeAt);
    expect(rejection).toContain('type: "tool_result"');
    expect(rejection).toContain("is_error: true");
    expect(rejection).toContain("content: toolArgs.error");
    expect(rejection).toContain("continue;");
    expect(rejection).not.toContain("runtime.execute(");
    expect(rejection).not.toContain("toolExecutionCount++");
    expect(rejection).not.toContain("verifiedWebSearchDone");
  });

  test("a rejected call cannot set verifiedWebSearchDone or count as tool work", () => {
    const loop = toolExecutionLoop();
    const executeAt = loop.indexOf("runtime.execute(");
    const countAt = loop.indexOf("toolExecutionCount++");
    const verifiedAt = loop.indexOf("verifiedWebSearchDone = true");

    // Both happen only on the executed path, after the successful execution
    // call itself.
    expect(executeAt).toBeGreaterThan(-1);
    expect(countAt).toBeGreaterThan(executeAt);
    expect(verifiedAt).toBeGreaterThan(executeAt);
    expect(loop.split("verifiedWebSearchDone = true")).toHaveLength(2);
  });
});
