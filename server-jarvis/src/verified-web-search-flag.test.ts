import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  WEB_SEARCH_TOOL_NAME,
  isSuccessfulWebSearchResult,
  nextVerifiedWebSearchState,
} from "./verified-web-search";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import type { ToolDefinition, ToolResult } from "./tool-runtime";
import { defaultConfig } from "./config";

// DD-048 / DD-T2: a failed required web_search must not be recorded as
// verified. These tests exercise the production transition with envelopes from
// the real ToolRuntime (stub handlers, no network) and pin that all three live
// consumers in index.ts — forced search, text-fallback tools, native tools —
// route through it.

function executionContext() {
  const cfg = defaultConfig();
  cfg.tools.enabled = true;
  cfg.tools.sandbox_mode = "workspace";
  return makeExecutionContext("agent", cfg);
}

/**
 * Run one call through the canonical ToolRuntime so the result carries the
 * real production envelope (`is_error`, `error`, `error_code`, `duration_ms`).
 * Only the handler is stubbed; nothing here reaches the network.
 */
async function runStubTool(
  name: string,
  handler: (args: Record<string, unknown>) => Promise<string>,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const runtime = createToolRuntime();
  const def: ToolDefinition = {
    type: "function",
    function: {
      name,
      description: "Stub definition for a production ToolRuntime envelope.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Query" } },
        required: name === WEB_SEARCH_TOOL_NAME ? ["query"] : [],
      },
    },
    requires_approval: false,
    dangerous: false,
    capability: { class: "network", evidence: "network" },
  };
  runtime.register(def, handler);

  return runtime.execute({ id: `call_${name}_1`, name, arguments: args }, executionContext());
}

/** A successful web_search, shaped like `searchWeb`'s real JSON output. */
function successfulWebSearch(): Promise<ToolResult> {
  return runStubTool(
    WEB_SEARCH_TOOL_NAME,
    async (args) => JSON.stringify({
      query: args.query,
      answer: "",
      abstract: "Tokio is an asynchronous runtime for Rust.",
      abstract_url: "https://tokio.rs/",
      related_topics: [],
      results: [{ title: "Tokio", url: "https://tokio.rs/", snippet: "Async runtime" }],
      results_count: 1,
    }, null, 2),
    { query: "tokio runtime" },
  );
}

/** A failed web_search: the provider call throws inside the tool handler. */
function failedWebSearch(): Promise<ToolResult> {
  return runStubTool(
    WEB_SEARCH_TOOL_NAME,
    async () => {
      throw new Error("search provider unreachable");
    },
    { query: "tokio runtime" },
  );
}

describe("isSuccessfulWebSearchResult", () => {
  test("a successful web_search result is verified evidence", async () => {
    const result = await successfulWebSearch();

    expect(result.is_error).toBe(false);
    expect(result.error).toBeUndefined();
    expect(isSuccessfulWebSearchResult(result.name, result)).toBe(true);
  });

  test("a failed web_search result is not verified evidence", async () => {
    const result = await failedWebSearch();

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("handler_error");
    expect(isSuccessfulWebSearchResult(result.name, result)).toBe(false);
  });

  test("a successful unrelated tool is not verified evidence", async () => {
    const result = await runStubTool("list_directory", async () => "a.txt\nb.txt");

    expect(result.is_error).toBe(false);
    expect(isSuccessfulWebSearchResult(result.name, result)).toBe(false);
  });

  test("a missing result or missing is_error is not verified evidence", () => {
    // Fail closed: only the runtime's explicit success flag counts.
    expect(isSuccessfulWebSearchResult(WEB_SEARCH_TOOL_NAME, undefined)).toBe(false);
    expect(isSuccessfulWebSearchResult(WEB_SEARCH_TOOL_NAME, null)).toBe(false);
    expect(isSuccessfulWebSearchResult(WEB_SEARCH_TOOL_NAME, {})).toBe(false);
  });
});

describe("nextVerifiedWebSearchState", () => {
  for (const consumer of ["forced", "text-fallback", "native"] as const) {
    test(`a failed ${consumer} web_search leaves verification false`, async () => {
      const result = await failedWebSearch();

      expect(nextVerifiedWebSearchState(false, result.name, result)).toBe(false);
    });

    test(`a successful ${consumer} web_search marks verification true`, async () => {
      const result = await successfulWebSearch();

      expect(nextVerifiedWebSearchState(false, result.name, result)).toBe(true);
    });
  }

  test("an unrelated tool leaves verification unchanged", async () => {
    const result = await runStubTool("read_file", async () => "file contents");

    expect(result.is_error).toBe(false);
    expect(nextVerifiedWebSearchState(false, result.name, result)).toBe(false);
    expect(nextVerifiedWebSearchState(true, result.name, result)).toBe(true);
  });

  test("a success followed by a failure keeps verification true", async () => {
    const success = await successfulWebSearch();
    const failure = await failedWebSearch();

    let verified = nextVerifiedWebSearchState(false, success.name, success);
    expect(verified).toBe(true);

    verified = nextVerifiedWebSearchState(verified, failure.name, failure);
    expect(verified).toBe(true);
  });

  test("a failure followed by a success records the success", async () => {
    const failure = await failedWebSearch();
    const success = await successfulWebSearch();

    let verified = nextVerifiedWebSearchState(false, failure.name, failure);
    expect(verified).toBe(false);

    verified = nextVerifiedWebSearchState(verified, success.name, success);
    expect(verified).toBe(true);
  });

  test("later failures and unrelated tools cannot erase a prior success", async () => {
    const success = await successfulWebSearch();
    const failure = await failedWebSearch();
    const other = await runStubTool("list_directory", async () => "a.txt");

    const sequence: Array<[string, ToolResult]> = [
      [success.name, success],
      [failure.name, failure],
      [other.name, other],
      [failure.name, failure],
    ];

    let verified = false;
    for (const [name, result] of sequence) {
      verified = nextVerifiedWebSearchState(verified, name, result);
    }

    expect(verified).toBe(true);
  });
});

describe("index.ts verified web-search wiring", () => {
  function indexSource(): string {
    return readFileSync(join(import.meta.dir, "index.ts"), "utf-8");
  }

  test("all three consumers use the shared transition", () => {
    const source = indexSource();

    // Forced search, text-fallback tools, and native tools — one call each.
    expect(source.match(/nextVerifiedWebSearchState\(/g) ?? []).toHaveLength(3);

    // Two consumers name the call `call.name`; the native loop uses the
    // formatted tool call's function name.
    expect(
      source.match(/nextVerifiedWebSearchState\(verifiedWebSearchDone, call\.name, toolResult\)/g) ?? [],
    ).toHaveLength(2);
    expect(source).toContain(
      "nextVerifiedWebSearchState(verifiedWebSearchDone, tc.function.name, toolResult)",
    );
  });

  test("no consumer sets the flag unconditionally", () => {
    const source = indexSource();
    const assignments = [...source.matchAll(/verifiedWebSearchDone = true/g)]
      .map((match) => match.index!);

    expect(assignments).toHaveLength(3);

    for (const assignmentAt of assignments) {
      // The assignment must sit inside the `if` whose condition is the shared
      // transition, with no statement boundary in between. Restoring the old
      // unconditional `verifiedWebSearchDone = true` fails this.
      const guardAt = source.lastIndexOf("nextVerifiedWebSearchState(", assignmentAt);
      expect(guardAt).toBeGreaterThan(-1);

      const betweenGuardAndAssignment = source.slice(guardAt, assignmentAt);
      expect(betweenGuardAndAssignment).not.toContain(";");
      expect(betweenGuardAndAssignment).not.toContain("verifiedWebSearchDone =");
    }

    // The exact unconditional forms DD-048 removed.
    expect(source).not.toContain('if (call.name === "web_search") verifiedWebSearchDone = true;');
    expect(source).not.toContain('if (tc.function.name === "web_search") verifiedWebSearchDone = true;');
  });

  test("the forced attempt is still consumed even when the search fails", () => {
    const source = indexSource();
    const forcedAt = source.indexOf("if (shouldForceWebSearch) {");
    expect(forcedAt).toBeGreaterThan(-1);

    const forcedEnd = source.indexOf("continue;", forcedAt);
    expect(forcedEnd).toBeGreaterThan(forcedAt);
    const forcedBlock = source.slice(forcedAt, forcedEnd);

    // `forcedWebSearchDone` is the one-forced-attempt guard: set regardless of
    // the result, so a failed forced search cannot force another search.
    expect(forcedBlock).toContain("forcedWebSearchDone = true;");
    expect(forcedBlock).toContain(
      "nextVerifiedWebSearchState(verifiedWebSearchDone, call.name, toolResult)",
    );

    // The attempt is still counted and the error frame/history still stream.
    expect(forcedBlock).toContain("toolExecutionCount++;");
    expect(forcedBlock).toContain("is_error: toolResult.is_error");

    // Only one forced attempt exists in the loop.
    expect(source.match(/forcedWebSearchDone = true;/g) ?? []).toHaveLength(1);
  });

  test("the forced-search trigger still requires both flags", () => {
    const source = indexSource();
    const triggerAt = source.indexOf("const shouldForceWebSearch = ");
    expect(triggerAt).toBeGreaterThan(-1);
    const trigger = source.slice(triggerAt, source.indexOf(";", triggerAt));

    // A failed search leaves verification false, but the forced attempt is
    // already spent, so the turn cannot loop on the same forced search.
    expect(trigger).toContain("&& !verifiedWebSearchDone");
    expect(trigger).toContain("&& !forcedWebSearchDone");
  });

  test("DD-047 rejected calls still cannot reach the transition", () => {
    const source = indexSource();
    const rejectionAt = source.indexOf("if (!toolArgs.ok) {");
    const nativeTransitionAt = source.indexOf(
      "nextVerifiedWebSearchState(verifiedWebSearchDone, tc.function.name, toolResult)",
    );

    expect(rejectionAt).toBeGreaterThan(-1);
    expect(nativeTransitionAt).toBeGreaterThan(rejectionAt);
    // The rejection branch continues before the executed-tool path runs.
    const rejection = source.slice(rejectionAt, source.indexOf("const parsedArgs = toolArgs.args;", rejectionAt));
    expect(rejection).toContain("continue;");
    expect(rejection).not.toContain("nextVerifiedWebSearchState(");
  });
});
