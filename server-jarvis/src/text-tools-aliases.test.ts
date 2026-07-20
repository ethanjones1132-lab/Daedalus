// Pin: every text-protocol alias resolves to a tool that is actually registered.
//
// The text protocol is the fallback path for models without native function
// calling, and an alias whose target does not exist fails at dispatch time with
// an "unknown tool" that looks like a model error rather than a registry gap.
// `browse`/`browser`/`open_url` pointed at a non-existent `browse` tool for the
// life of the file; this test is what stops that class of drift recurring.

import { describe, expect, test } from "bun:test";
import { TOOL_ALIASES } from "./text-tools";
import { createToolRuntime } from "./tool-runtime";
import { registerStandardBundles } from "./bundles-registry";

function registeredNames(): Set<string> {
  const runtime = createToolRuntime();
  registerStandardBundles(runtime);
  return new Set(runtime.listTools().map((t) => t.function.name));
}

describe("text-protocol tool aliases", () => {
  test("every alias target is a registered tool", () => {
    const registered = registeredNames();
    const dangling = Object.entries(TOOL_ALIASES)
      .filter(([, target]) => !registered.has(target))
      .map(([alias, target]) => `${alias} -> ${target}`);
    expect(dangling).toEqual([]);
  });

  test("browse aliases reach web_fetch, not a phantom browse tool", () => {
    expect(TOOL_ALIASES.browse).toBe("web_fetch");
    expect(TOOL_ALIASES.browser).toBe("web_fetch");
    expect(TOOL_ALIASES.open_url).toBe("web_fetch");
  });
});
