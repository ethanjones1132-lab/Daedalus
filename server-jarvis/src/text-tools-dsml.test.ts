// W3.2 — DSML / bare XML text-tool dialects observed in stage_runs.diagnostic_json.
// Fullwidth pipe U+FF5C (｜) is the real delimiter; tests encode it explicitly.

import { describe, expect, test } from "bun:test";
import { extractTextToolCalls, resolveToolCallsFromTurn } from "./text-tools";
import type { ToolDefinition } from "./tool-types";

const FW = "\uFF5C"; // fullwidth vertical line ｜

const tools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path" } },
        required: ["path"],
      },
    },
    requires_approval: false,
    dangerous: false,
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Edit a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path" },
          old_string: { type: "string", description: "Old" },
          new_string: { type: "string", description: "New" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    requires_approval: false,
    dangerous: false,
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path" },
          content: { type: "string", description: "Content" },
        },
        required: ["path", "content"],
      },
    },
    requires_approval: false,
    dangerous: false,
  },
];

describe("DSML / bare text-tool dialects (W3.2)", () => {
  test("full DSML with fullwidth pipes: invoke + parameter", () => {
    const text = [
      `<${FW}DSML${FW}tool_calls>`,
      `<${FW}DSML${FW}invoke name="read_file">`,
      `<${FW}DSML${FW}parameter name="path" string="true">C:\\Projects\\IMPLEMENTATION_PLAN.md</${FW}DSML${FW}parameter>`,
      `</${FW}DSML${FW}invoke>`,
      `</${FW}DSML${FW}tool_calls>`,
    ].join("\n");

    const parsed = extractTextToolCalls(text, tools);
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0].name).toBe("read_file");
    expect(parsed.calls[0].arguments).toEqual({
      path: "C:\\Projects\\IMPLEMENTATION_PLAN.md",
    });
    expect(parsed.cleanedText).not.toContain("read_file");
    expect(parsed.cleanedText).not.toContain("DSML");
  });

  test("full DSML with ASCII pipes after normalization is accepted", () => {
    const text = [
      `<|DSML|tool_calls>`,
      `<|DSML|invoke name="write_file">`,
      `<|DSML|parameter name="path">notes.md</|DSML|parameter>`,
      `<|DSML|parameter name="content">hello</|DSML|parameter>`,
      `</|DSML|invoke>`,
      `</|DSML|tool_calls>`,
    ].join("\n");

    const parsed = extractTextToolCalls(text, tools);
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0].name).toBe("write_file");
    expect(parsed.calls[0].arguments).toEqual({
      path: "notes.md",
      content: "hello",
    });
  });

  test("degraded DSML: <|DSML|:tool><|DSML|:arg>…</|DSML|:arg>", () => {
    const text =
      `<${FW}DSML${FW}:read_file>` +
      `<${FW}DSML${FW}:path>C:\\Projects\\home-base\\README.md</${FW}DSML${FW}:path>`;

    const parsed = extractTextToolCalls(text, tools);
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0].name).toBe("read_file");
    expect(parsed.calls[0].arguments).toEqual({
      path: "C:\\Projects\\home-base\\README.md",
    });
  });

  test("degraded DSML multi-arg edit_file", () => {
    const text =
      `<${FW}DSML${FW}:edit_file>` +
      `<${FW}DSML${FW}:path>src/a.ts</${FW}DSML${FW}:path>` +
      `<${FW}DSML${FW}:old_string>foo</${FW}DSML${FW}:old_string>` +
      `<${FW}DSML${FW}:new_string>bar</${FW}DSML${FW}:new_string>`;

    const parsed = extractTextToolCalls(text, tools);
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0].name).toBe("edit_file");
    expect(parsed.calls[0].arguments).toEqual({
      path: "src/a.ts",
      old_string: "foo",
      new_string: "bar",
    });
  });

  test("bare XML tool tags: <read_file><path>…</path></read_file>", () => {
    const text = `<read_file><path>docs/plan.md</path></read_file>`;
    const parsed = extractTextToolCalls(text, tools);
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0].name).toBe("read_file");
    expect(parsed.calls[0].arguments).toEqual({ path: "docs/plan.md" });
    expect(parsed.cleanedText).toBe("");
  });

  test("bare write_file with content body", () => {
    const text =
      `<write_file><path>out.txt</path><content>line1\nline2</content></write_file>`;
    const parsed = extractTextToolCalls(text, tools);
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0].name).toBe("write_file");
    expect(parsed.calls[0].arguments).toEqual({
      path: "out.txt",
      content: "line1\nline2",
    });
  });

  test("mixed bare open + DSML close tags", () => {
    const text =
      `<read_file><path>C:\\Projects\\IMPLEMENTATION_PLAN.md</path></${FW}DSML${FW}tool>`;
    const parsed = extractTextToolCalls(text, tools);
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0].name).toBe("read_file");
    expect(parsed.calls[0].arguments).toEqual({
      path: "C:\\Projects\\IMPLEMENTATION_PLAN.md",
    });
  });

  test("fullwidth pipe alone is normalized inside DSML markers", () => {
    // Explicit contract: U+FF5C must be treated as the DSML delimiter.
    expect(FW).toBe("｜");
    const withFw = `<${FW}DSML${FW}:read_file><${FW}DSML${FW}:path>x.md</${FW}DSML${FW}:path>`;
    const withAscii = `<|DSML|:read_file><|DSML|:path>x.md</|DSML|:path>`;
    const a = extractTextToolCalls(withFw, tools);
    const b = extractTextToolCalls(withAscii, tools);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(a.calls[0].arguments).toEqual(b.calls[0].arguments);
  });

  test("prose before full DSML is preserved; block is stripped", () => {
    const text =
      `I'll read the plan.\n` +
      `<${FW}DSML${FW}invoke name="read_file">` +
      `<${FW}DSML${FW}parameter name="path">plan.md</${FW}DSML${FW}parameter>` +
      `</${FW}DSML${FW}invoke>`;
    const parsed = extractTextToolCalls(text, tools);
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.cleanedText).toBe("I'll read the plan.");
  });

  test("unclosed bare block caps at last closed param and keeps trailing prose", () => {
    // No </read_file> — candidate must not extend to EOF and erase prose.
    const text =
      `<read_file><path>docs/plan.md</path>\n` +
      `Here is the summary after the tool markup.`;
    const parsed = extractTextToolCalls(text, tools);
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0].name).toBe("read_file");
    expect(parsed.calls[0].arguments).toEqual({ path: "docs/plan.md" });
    expect(parsed.cleanedText).toContain("Here is the summary after the tool markup.");
    expect(parsed.cleanedText).not.toContain("<read_file>");
    expect(parsed.cleanedText).not.toContain("<path>");
  });

  test("unclosed degraded DSML caps at last closed param and keeps trailing prose", () => {
    const text =
      `<${FW}DSML${FW}:read_file>` +
      `<${FW}DSML${FW}:path>notes.md</${FW}DSML${FW}:path>\n` +
      `Trailing prose must survive cleanup.`;
    const parsed = extractTextToolCalls(text, tools);
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0].arguments).toEqual({ path: "notes.md" });
    expect(parsed.cleanedText).toContain("Trailing prose must survive cleanup.");
  });

  test("bare/degraded with zero closed params is rejected (no EOF span)", () => {
    const bareOpenOnly = `<read_file><path>docs/plan.md\nProse after unclosed param.`;
    const bareParsed = extractTextToolCalls(bareOpenOnly, tools);
    expect(bareParsed.calls).toHaveLength(0);
    expect(bareParsed.cleanedText).toContain("Prose after unclosed param.");

    const degradedOpenOnly =
      `<${FW}DSML${FW}:read_file><${FW}DSML${FW}:path>docs/plan.md\nMore prose.`;
    const degradedParsed = extractTextToolCalls(degradedOpenOnly, tools);
    expect(degradedParsed.calls).toHaveLength(0);
    expect(degradedParsed.cleanedText).toContain("More prose.");
  });

  test("non-aliased offered tool is recognized in bare and degraded DSML", () => {
    // apply_patch is not in TOOL_ALIASES; recognition must union availableNames.
    const applyPatchTool: ToolDefinition = {
      type: "function",
      function: {
        name: "apply_patch",
        description: "Apply a patch",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path" },
            patch: { type: "string", description: "Patch body" },
          },
          required: ["path", "patch"],
        },
      },
      requires_approval: false,
      dangerous: false,
    };
    const offered = [...tools, applyPatchTool];

    const bare =
      `<apply_patch><path>src/a.ts</path><patch>--- a\n+++ b</patch></apply_patch>`;
    const bareParsed = extractTextToolCalls(bare, offered);
    expect(bareParsed.calls).toHaveLength(1);
    expect(bareParsed.calls[0].name).toBe("apply_patch");
    expect(bareParsed.calls[0].arguments).toEqual({
      path: "src/a.ts",
      patch: "--- a\n+++ b",
    });

    const degraded =
      `<${FW}DSML${FW}:apply_patch>` +
      `<${FW}DSML${FW}:path>src/b.ts</${FW}DSML${FW}:path>` +
      `<${FW}DSML${FW}:patch>diff</${FW}DSML${FW}:patch>`;
    const degradedParsed = extractTextToolCalls(degraded, offered);
    expect(degradedParsed.calls).toHaveLength(1);
    expect(degradedParsed.calls[0].name).toBe("apply_patch");
    expect(degradedParsed.calls[0].arguments).toEqual({
      path: "src/b.ts",
      patch: "diff",
    });

    // Without offering apply_patch, bare markup must not produce a call.
    const notOffered = extractTextToolCalls(bare, tools);
    expect(notOffered.calls).toHaveLength(0);
  });
});

describe("resolveToolCallsFromTurn (W3.1)", () => {
  const nativeRead = {
    id: "call_native",
    name: "read_file",
    arguments: { path: "a.md" },
  };

  const dsmlText =
    `<${FW}DSML${FW}invoke name="read_file">` +
    `<${FW}DSML${FW}parameter name="path">from-dsml.md</${FW}DSML${FW}parameter>` +
    `</${FW}DSML${FW}invoke>`;

  test("prefers native calls when present (useTextTools false)", () => {
    const resolved = resolveToolCallsFromTurn({
      nativeCalls: [nativeRead],
      fullText: dsmlText,
      tools,
      useTextTools: false,
    });
    expect(resolved.calls).toEqual([nativeRead]);
    expect(resolved.toolParseFlags).toEqual({});
    expect(resolved.textParseAttempted).toBe(false);
  });

  test("native empty + non-empty DSML content → text parse fallback even when useTextTools false", () => {
    const resolved = resolveToolCallsFromTurn({
      nativeCalls: [],
      fullText: dsmlText,
      tools,
      useTextTools: false,
    });
    expect(resolved.calls).toHaveLength(1);
    expect(resolved.calls[0].name).toBe("read_file");
    expect(resolved.calls[0].arguments).toEqual({ path: "from-dsml.md" });
    expect(resolved.toolParseFlags).toEqual({ _toolParseAttempted: true });
    expect(resolved.textParseAttempted).toBe(true);
  });

  test("native empty + empty content does not run text parse", () => {
    const resolved = resolveToolCallsFromTurn({
      nativeCalls: [],
      fullText: "   ",
      tools,
      useTextTools: false,
    });
    expect(resolved.calls).toEqual([]);
    expect(resolved.toolParseFlags).toEqual({});
    expect(resolved.textParseAttempted).toBe(false);
  });

  test("native empty + content but no tools offered skips text parse", () => {
    const resolved = resolveToolCallsFromTurn({
      nativeCalls: [],
      fullText: dsmlText,
      tools: [],
      useTextTools: false,
    });
    expect(resolved.calls).toEqual([]);
    expect(resolved.toolParseFlags).toEqual({});
    expect(resolved.textParseAttempted).toBe(false);
  });

  test("useTextTools true always runs text parse (primary path)", () => {
    const tagged =
      'Checking.\n<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>';
    const resolved = resolveToolCallsFromTurn({
      nativeCalls: [],
      fullText: tagged,
      tools,
      useTextTools: true,
    });
    expect(resolved.calls).toHaveLength(1);
    expect(resolved.calls[0].name).toBe("read_file");
    expect(resolved.toolParseFlags).toEqual({ _toolParseAttempted: true });
    expect(resolved.textParseAttempted).toBe(true);
  });

  test("useTextTools true with zero extract marks parse failed", () => {
    const resolved = resolveToolCallsFromTurn({
      nativeCalls: [],
      fullText: "Just thinking out loud, no tools.",
      tools,
      useTextTools: true,
    });
    expect(resolved.calls).toEqual([]);
    expect(resolved.toolParseFlags).toEqual({
      _toolParseAttempted: true,
      _toolParseFailed: true,
    });
  });

  test("fallback with prose-only content marks parse failed", () => {
    const resolved = resolveToolCallsFromTurn({
      nativeCalls: [],
      fullText: "I cannot use tools right now.",
      tools,
      useTextTools: false,
    });
    expect(resolved.calls).toEqual([]);
    expect(resolved.toolParseFlags).toEqual({
      _toolParseAttempted: true,
      _toolParseFailed: true,
    });
    expect(resolved.textParseAttempted).toBe(true);
  });
});
