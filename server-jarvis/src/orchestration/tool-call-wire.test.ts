import { describe, expect, test } from "bun:test";
import { toWireToolCall, withWireToolCalls } from "./tool-call-wire";

describe("tool calls on the wire", () => {
  test("a parsed pipeline call becomes the OpenAI shape llama.cpp requires", () => {
    const message = { role: "assistant", content: null, tool_calls: [{ id: "abc", name: "list_directory", arguments: { path: "." } }] };
    expect(withWireToolCalls(message)).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "abc", type: "function", function: { name: "list_directory", arguments: "{\"path\":\".\"}" } }],
    });
    // The in-memory history is not mutated.
    expect(message.tool_calls[0]).toEqual({ id: "abc", name: "list_directory", arguments: { path: "." } });
  });

  test("an already-wire call is kept, with string arguments and a type", () => {
    expect(toWireToolCall({ id: "x", function: { name: "read_file", arguments: { path: "a" } } }, 0))
      .toEqual({ id: "x", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } });
    expect(toWireToolCall({ id: "y", type: "function", function: { name: "f", arguments: "{}" } }, 0))
      .toEqual({ id: "y", type: "function", function: { name: "f", arguments: "{}" } });
  });

  test("missing ids and arguments get safe defaults; nameless calls are dropped", () => {
    expect(toWireToolCall({ name: "f" }, 3)).toEqual({ id: "call_3", type: "function", function: { name: "f", arguments: "{}" } });
    expect(toWireToolCall({ arguments: {} }, 0)).toBeNull();
    expect(withWireToolCalls({ role: "assistant", content: "hi", tool_calls: [{}] })).toEqual({ role: "assistant", content: "hi" });
  });

  test("messages without tool calls are returned unchanged", () => {
    const user = { role: "user", content: "q" };
    expect(withWireToolCalls(user)).toBe(user);
    const tool = { role: "tool", tool_call_id: "abc", content: "ok" };
    expect(withWireToolCalls(tool)).toBe(tool);
  });
});
