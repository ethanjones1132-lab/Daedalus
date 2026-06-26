import { describe, expect, test } from "bun:test";
import {
  normalizeStreamedToolCalls,
  type RawStreamedToolCall,
} from "./streaming-tool-calls";

// Deterministic id factory so warning-message assertions are stable.
const fixedId = (() => {
  let n = 0;
  return () => `call_test${++n}`;
})();

describe("normalizeStreamedToolCalls", () => {
  test("returns empty lists for an empty stream", () => {
    const result = normalizeStreamedToolCalls([]);
    expect(result.calls).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("skips null and undefined slots without warnings", () => {
    const result = normalizeStreamedToolCalls([null, undefined, { name: "x", arguments: "{}" }]);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.name).toBe("x");
    expect(result.warnings).toEqual([]);
  });

  test("keeps a fully-formed tool call with no warnings", () => {
    const raw: RawStreamedToolCall[] = [
      { id: "call_abc", name: "read_file", arguments: '{"path":"/tmp/x"}' },
    ];
    const result = normalizeStreamedToolCalls(raw, fixedId);
    expect(result.calls).toEqual([
      { id: "call_abc", name: "read_file", arguments: { path: "/tmp/x" } },
    ]);
    expect(result.warnings).toEqual([]);
  });

  test("keeps a call with empty arguments and no warning (zero-arg tool)", () => {
    const raw: RawStreamedToolCall[] = [
      { id: "call_abc", name: "tools_enum", arguments: "" },
    ];
    const result = normalizeStreamedToolCalls(raw, fixedId);
    expect(result.calls).toEqual([
      { id: "call_abc", name: "tools_enum", arguments: {} },
    ]);
    expect(result.warnings).toEqual([]);
  });

  test("drops a slot with no function.name and records a missing_name warning", () => {
    const raw: RawStreamedToolCall[] = [
      { id: "call_abc", arguments: '{"path":"/tmp/x"}' },
    ];
    const result = normalizeStreamedToolCalls(raw, fixedId);
    expect(result.calls).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.kind).toBe("missing_name");
    expect(result.warnings[0]?.index).toBe(0);
    expect(result.warnings[0]?.message).toContain("no function.name");
    // The partial preview must echo the raw arguments so the operator can
    // see *what* the model streamed without a name.
    expect(result.warnings[0]?.message).toContain('{"path":"/tmp/x"}');
  });

  test("synthesizes a fallback id when the slot has a name but no id", () => {
    const raw: RawStreamedToolCall[] = [
      { name: "read_file", arguments: '{"path":"/tmp/x"}' },
    ];
    const result = normalizeStreamedToolCalls(raw, fixedId);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.id).toBe("call_test1");
    expect(result.warnings).toEqual([]);
  });

  test("coerces non-JSON arguments to {} and records an unparseable warning", () => {
    // Truncated JSON: the model ran out of tokens mid-stream.
    const raw: RawStreamedToolCall[] = [
      { id: "call_abc", name: "read_file", arguments: '{"path":"/tm' },
    ];
    const result = normalizeStreamedToolCalls(raw, fixedId);
    expect(result.calls).toEqual([
      { id: "call_abc", name: "read_file", arguments: {} },
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.kind).toBe("unparseable_arguments");
    expect(result.warnings[0]?.message).toContain("unparseable arguments");
    expect(result.warnings[0]?.message).toContain('"read_file"');
  });

  test("coerces scalar-JSON arguments (number, string, array) to {}", () => {
    const raw: RawStreamedToolCall[] = [
      { id: "c1", name: "read_file", arguments: "42" },
      { id: "c2", name: "read_file", arguments: '"oops"' },
      { id: "c3", name: "read_file", arguments: "[1,2,3]" },
    ];
    const result = normalizeStreamedToolCalls(raw, fixedId);
    for (const call of result.calls) {
      expect(call.arguments).toEqual({});
    }
    expect(result.warnings).toHaveLength(3);
    for (const w of result.warnings) {
      expect(w.kind).toBe("unparseable_arguments");
    }
  });

  test("truncates the arguments preview at the documented limit on unparseable input", () => {
    // Build a 500+ char truncated-JSON string so the warning preview is the
    // canonical "model ran out of tokens mid-stream" shape.
    const hugeArgs = `{"path":"${"a".repeat(500)}`;
    const raw: RawStreamedToolCall[] = [
      { id: "c1", name: "read_file", arguments: hugeArgs },
    ];
    const result = normalizeStreamedToolCalls(raw, fixedId);
    expect(result.warnings).toHaveLength(1);
    const preview = result.warnings[0]?.partial.argumentsPreview ?? "";
    // The ellipsis must be present so the operator sees the truncation.
    expect(preview.endsWith("…")).toBe(true);
    // Hard upper bound: ARGUMENTS_PREVIEW_LIMIT (120) + ellipsis (1 char).
    expect(preview.length).toBeLessThanOrEqual(121);
  });

  test("preserves stream order in both calls and warnings", () => {
    const raw: RawStreamedToolCall[] = [
      { id: "a", name: "read_file", arguments: '{"path":"a"}' }, // ok
      { id: "b", arguments: '{"path":"b"}' }, // missing name -> dropped + warning
      { id: "c", name: "glob", arguments: "{not json" }, // unparseable -> kept + warning
      undefined, // skipped silently
      { id: "d", name: "list_directory", arguments: '{"path":"."}' }, // ok
    ];
    const result = normalizeStreamedToolCalls(raw, fixedId);
    // Missing-name slot is dropped from `calls`; the rest keep their original ids.
    expect(result.calls.map((c) => c.id)).toEqual(["a", "c", "d"]);
    // Warnings are in stream order, indexed by original slot position.
    expect(result.warnings.map((w) => w.index)).toEqual([1, 2]);
    expect(result.warnings.map((w) => w.kind)).toEqual([
      "missing_name",
      "unparseable_arguments",
    ]);
  });

  test("uses the default crypto.randomUUID-based id factory when none is provided", () => {
    const raw: RawStreamedToolCall[] = [
      { name: "read_file", arguments: '{"path":"x"}' },
    ];
    const result = normalizeStreamedToolCalls(raw);
    expect(result.calls[0]?.id).toMatch(/^call_[0-9a-f]{8}$/);
  });
});
