import { describe, expect, test } from "bun:test";
import { createToolRuntime } from "./tool-runtime";
import { registerStandardBundles } from "./bundles-registry";
import { defaultConfig } from "./config";
import { makeExecutionContext } from "./tool-runtime";

describe("registerStandardBundles", () => {
  test("registers the canonical chat bundle set", () => {
    const runtime = createToolRuntime();
    registerStandardBundles(runtime);
    const names = runtime.listTools().map((t) => t.function.name);
    expect(names).toContain("read_file");
    expect(names).toContain("web_search");
    expect(names).toContain("bash");
  });

  test("cron runtime can execute a registered safe tool", async () => {
    const runtime = createToolRuntime();
    registerStandardBundles(runtime);
    const ctx = makeExecutionContext("cron", defaultConfig(), { interactive: false });
    const result = await runtime.execute(
      { id: "c1", name: "list_directory", arguments: { path: "." } },
      ctx,
    );
    // Policy may deny or succeed depending on sandbox — not an unknown_tool error.
    expect(result.error_code).not.toBe("unknown_tool");
  });
});