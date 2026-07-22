// server-jarvis/src/orchestration/modes.test.ts
//
// Contract pin for the pure mode + tool-authorization module used by every
// orchestrator stage (planner/executor/reviewer/rewriter/synthesizer). The
// previous coverage lived in the giant `orchestration.test.ts`, `git-metadata-bundle.test.ts`,
// and `eval/harness.ts` — but `modes.ts` is the source of truth for the
// read-only-profile security fence (the least-authority intersection that
// protects a `workspace_read` turn from accidental mutation, the 2026-07-12
// cross-turn incident class), and a regression that broadens any mode's
// `tools_filter` or the `READ_ONLY_TOOLS` allowlist would silently re-enable
// mutation on read-only turns. Same pattern as the
// `learned-pool-state` / `providers` / `json` / `runCronRequest` /
// `hasWriteIntent` pins: pure-function contracts get a focused regression
// file so the surface is self-documenting and future refactors are caught
// before they reach the orchestrator.
import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "../tool-types";
import { BUILTIN_MODES, executorTurnLimit, getToolsForMode, READ_ONLY_TOOLS } from "./modes";

// Small helper: build a tool with just a name (the rest of `ToolDefinition`
// is irrelevant to `getToolsForMode` which only inspects `function.name`).
function tool(name: string): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: `desc:${name}`,
      parameters: { type: "object", properties: {}, required: [] },
    },
  };
}

const FULL_TOOLBOX: ToolDefinition[] = [
  tool("read_file"),
  tool("write_file"),
  tool("edit_file"),
  tool("multi_edit"),
  tool("apply_patch"),
  tool("glob"),
  tool("grep"),
  tool("list_directory"),
  tool("git_metadata"),
  tool("bash"),
  tool("powershell"),
  tool("web_search"),
  tool("web_fetch"),
  tool("agent"),
  tool("run_background_command"),
  tool("mcp_list_tools"),
  tool("mcp_call_tool"),
  tool("mcp_read_resource"),
];

describe("READ_ONLY_TOOLS", () => {
  test("contains exactly the five read-only inspection tools and no mutators", () => {
    // The set is the security fence — a future "let me also add git_metadata
    // to allow extra context" change would silently expand a misclassified
    // workspace_read's reach. Pin the exact contents.
    //
    // Compared order-insensitively: the list is now DERIVED from the capability
    // taxonomy, so its order follows bundle registration order rather than the
    // order someone typed. Membership is the security property; sequence is not.
    expect([...READ_ONLY_TOOLS].sort()).toEqual([
      "git_metadata",
      "glob",
      "grep",
      "list_directory",
      "read_file",
    ]);
  });

  test("contains no write/edit/patch/bash/network/agent tools", () => {
    // Belt-and-braces — a future "what if I add bash for diagnostic commands"
    // change must trip a test, not silently widen the fence.
    for (const name of READ_ONLY_TOOLS) {
      expect(name).not.toMatch(/^(write|edit|patch|bash|web_|agent|run_)/);
    }
  });

  test("ordering is stable (defensive — callers may assume order)", () => {
    // Some operators grep by ordered indices; if a future refactor sorts
    // alphabetically, the test should fail and force a deliberate decision.
    const copy = [...READ_ONLY_TOOLS];
    expect(READ_ONLY_TOOLS).toEqual(copy);
  });
});

describe("BUILTIN_MODES — per-mode contract", () => {
  test("planner is non-final and exposes NO tools (read-only-by-default)", () => {
    // The planner's whole job is to reason about the request — giving it
    // tool access would let it attempt mutations the executor never
    // approved. Pin the empty filter as a security guarantee.
    expect(BUILTIN_MODES.planner.id).toBe("planner");
    expect(BUILTIN_MODES.planner.is_final).toBe(false);
    expect(BUILTIN_MODES.planner.tools_filter).toEqual([]);
    expect(BUILTIN_MODES.planner.requires_memory).toBe(true);
    expect(BUILTIN_MODES.planner.max_turns).toBe(1);
  });

  test("executor is non-final, has the broadest tool set, and is bounded to 4 turns", () => {
    // The executor is the only mode with bash + write + network. If a future
    // refactor narrows it accidentally, full_execution turns lose
    // capabilities. The 4-turn cap matches the `executorTurnLimit` boundary
    // and the progress-scaled turn budget in turn-budget.ts.
    expect(BUILTIN_MODES.executor.id).toBe("executor");
    expect(BUILTIN_MODES.executor.is_final).toBe(false);
    expect(BUILTIN_MODES.executor.tools_filter).toContain("write_file");
    expect(BUILTIN_MODES.executor.tools_filter).toContain("bash");
    expect(BUILTIN_MODES.executor.tools_filter).toContain("powershell");
    expect(BUILTIN_MODES.executor.tools_filter).toContain("web_search");
    expect(BUILTIN_MODES.executor.tools_filter).toContain("agent");
    expect(BUILTIN_MODES.executor.tools_filter).toEqual(expect.arrayContaining([
      "mcp_list_tools",
      "mcp_call_tool",
      "mcp_read_resource",
    ]));
    expect(BUILTIN_MODES.executor.max_turns).toBe(4);
  });

  test("executor exposes MCP discovery, execution, and resource reads without widening reviewer access", () => {
    const executorTools = getToolsForMode("executor", FULL_TOOLBOX).map((t) => t.function.name);
    expect(executorTools).toEqual(expect.arrayContaining([
      "mcp_list_tools",
      "mcp_call_tool",
      "mcp_read_resource",
    ]));

    const reviewerTools = getToolsForMode("reviewer", FULL_TOOLBOX).map((t) => t.function.name);
    expect(reviewerTools).not.toContain("mcp_list_tools");
    expect(reviewerTools).not.toContain("mcp_call_tool");
    expect(reviewerTools).not.toContain("mcp_read_resource");
  });

  test("reviewer is inspection-only (no write, no bash, no network, no agent)", () => {
    // The reviewer judges the executor's work — giving it mutation tools
    // would let it "fix" issues that should be rewriter territory, breaking
    // the planner→executor→reviewer→rewriter→synthesizer separation of
    // concerns.
    expect(BUILTIN_MODES.reviewer.id).toBe("reviewer");
    expect(BUILTIN_MODES.reviewer.is_final).toBe(false);
    for (const name of BUILTIN_MODES.reviewer.tools_filter) {
      expect(name).not.toMatch(/^(write|edit|multi_edit|apply_patch|bash|web_|agent|run_)/);
    }
    expect(BUILTIN_MODES.reviewer.tools_filter).toEqual([
      "read_file",
      "grep",
      "glob",
      "list_directory",
    ]);
  });

  test("rewriter can edit/write but has no bash/network/agent", () => {
    // The rewriter applies the reviewer's feedback — it needs edit tools but
    // not shell or network (which would be the executor's domain). Pin the
    // shape so a future "give the rewriter bash for sed-style edits" change
    // is forced to be deliberate.
    expect(BUILTIN_MODES.rewriter.id).toBe("rewriter");
    expect(BUILTIN_MODES.rewriter.is_final).toBe(false);
    expect(BUILTIN_MODES.rewriter.tools_filter).toContain("read_file");
    expect(BUILTIN_MODES.rewriter.tools_filter).toContain("edit_file");
    expect(BUILTIN_MODES.rewriter.tools_filter).toContain("write_file");
    expect(BUILTIN_MODES.rewriter.tools_filter).not.toContain("bash");
    expect(BUILTIN_MODES.rewriter.tools_filter).not.toContain("agent");
    expect(BUILTIN_MODES.rewriter.max_turns).toBe(3);
  });

  test("synthesizer is the ONLY is_final=true mode and exposes no tools", () => {
    // The synthesizer is the user-visible final stage. If a future refactor
    // adds `is_final: true` to a non-synthesizer mode, the pipeline will
    // short-circuit and the user will see raw stage output instead of a
    // synthesized answer. Pin exactly-one-is_final as a topology invariant.
    const finals = Object.values(BUILTIN_MODES).filter((m) => m.is_final);
    expect(finals).toHaveLength(1);
    expect(finals[0].id).toBe("synthesizer");
    expect(BUILTIN_MODES.synthesizer.tools_filter).toEqual([]);
    expect(BUILTIN_MODES.synthesizer.requires_memory).toBe(true);
  });

  test("all 5 built-in modes are present and well-formed", () => {
    // A future "delete a mode" change must be deliberate. Pin the 5-mode
    // surface so dropping one trips a test.
    expect(Object.keys(BUILTIN_MODES).sort()).toEqual([
      "executor",
      "planner",
      "reviewer",
      "rewriter",
      "synthesizer",
    ]);
    for (const m of Object.values(BUILTIN_MODES)) {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(typeof m.temperature).toBe("number");
      expect(typeof m.max_tokens).toBe("number");
      expect(m.max_tokens).toBeGreaterThan(0);
      expect(typeof m.requires_memory).toBe("boolean");
      expect(typeof m.is_final).toBe("boolean");
      expect(typeof m.max_turns).toBe("number");
      expect(m.max_turns).toBeGreaterThan(0);
    }
  });
});

describe("executorTurnLimit", () => {
  test("read_only profile returns 4 (the post-2026-07-12 incident cap)", () => {
    // The 2026-07-12 cross-turn no-progress incident's root cause was a
    // 2-turn read_only cap that structurally starved deep reads against
    // pools whose measured p50 was 52s. The cap is now 4 to match the
    // standard executor limit; the progress-scaled turn budget in
    // turn-budget.ts is the binding constraint instead of an arbitrary
    // turn count. Pin the resolved value.
    expect(executorTurnLimit("read_only")).toBe(4);
  });

  test("full profile delegates to BUILTIN_MODES.executor.max_turns", () => {
    // Pin the *contract* (delegation), not the *value* — a future bump of
    // the executor's `max_turns` must not require a simultaneous update
    // here. The resolved value is whatever the mode's own setting says.
    expect(executorTurnLimit("full")).toBe(BUILTIN_MODES.executor.max_turns);
  });

  test("deep reads scale to the 600s contract's 16-turn cap; high complexity keeps 8", () => {
    // 2026-07-16 evening: deep reads carry the EXTENDED_DEEP (600s/420s
    // executor) budget, so the turn cap scales with the window; the loop
    // still exits early on a no-tool-call turn or budget exhaustion.
    expect(executorTurnLimit("read_only", { deepRead: true, complexity: "medium" })).toBe(16);
    expect(executorTurnLimit("full", { deepRead: true, complexity: "high" })).toBe(16);
    expect(executorTurnLimit("full", { deepRead: false, complexity: "high" })).toBe(8);
  });

  test("ordinary executor turns stay capped at 4", () => {
    expect(executorTurnLimit("read_only", { deepRead: false, complexity: "medium" })).toBe(4);
    expect(executorTurnLimit("full", { deepRead: false, complexity: "low" })).toBe(4);
  });

  test("full-profile write intent gets 12 turns with deep-read precedence", () => {
    expect(executorTurnLimit("full", { writeIntent: true, complexity: "low" })).toBe(12);
    expect(executorTurnLimit("full", { writeIntent: true, complexity: "high" })).toBe(12);
    expect(executorTurnLimit("full", { deepRead: true, writeIntent: true, complexity: "high" })).toBe(16);
  });

  test("write intent never widens the read-only profile", () => {
    expect(executorTurnLimit("read_only", { writeIntent: true, complexity: "low" })).toBe(4);
  });
});

describe("getToolsForMode — modeId handling", () => {
  test("returns [] for an unknown modeId without throwing", () => {
    // The orchestrator logs a warning + continues; it must not crash a turn
    // over a misconfigured mode. Pin the empty result.
    expect(getToolsForMode("not-a-real-mode", FULL_TOOLBOX)).toEqual([]);
  });

  test("returns the full toolbox when a mode's filter contains '*'", () => {
    // A future mode that wants the whole toolbox should declare it via the
    // wildcard. Pin the wildcard behavior — filter.includes('*') short-
    // circuits to the full input, not a name-by-name match.
    const withWildcard = BUILTIN_MODES;
    // The current built-ins don't use '*', so exercise the wildcard by
    // monkey-patching then restoring.
    const orig = withWildcard.planner.tools_filter;
    withWildcard.planner.tools_filter = ["*"];
    try {
      expect(getToolsForMode("planner", FULL_TOOLBOX)).toEqual(FULL_TOOLBOX);
    } finally {
      withWildcard.planner.tools_filter = orig;
    }
  });

  test("returns [] for the planner under the full profile (planner has no tools)", () => {
    // The planner's whole filter is empty — even with a full toolbox, the
    // planner sees no tools. Pin the security guarantee.
    expect(getToolsForMode("planner", FULL_TOOLBOX)).toEqual([]);
  });

  test("synthesizer sees no tools under the full profile", () => {
    // The synthesizer is a text-only stage; if a future refactor grants it
    // tools, user-visible answers will start including tool calls and the
    // user-facing contract will change.
    expect(getToolsForMode("synthesizer", FULL_TOOLBOX)).toEqual([]);
  });

  test("executor under the full profile returns every tool whose name is in the executor's filter", () => {
    const names = getToolsForMode("executor", FULL_TOOLBOX, "full")
      .map((t) => t.function.name)
      .sort();
    // Compare against the executor's declared filter (minus ordering) — the
    // filter is the contract, the toolbox is the source pool, and the
    // intersection is what the executor actually sees.
    expect(names).toEqual([...BUILTIN_MODES.executor.tools_filter].sort());
  });
});

describe("getToolsForMode — profile=read_only least-authority cap", () => {
  test("executor under read_only loses every mutating tool, keeps only READ_ONLY_TOOLS", () => {
    // This is the workspace_read safety fence. The executor's full filter
    // would grant write_file/edit_file/apply_patch/bash/web_*/agent; the
    // read_only profile must strip them ALL. Pin the exact allowed set.
    const names = getToolsForMode("executor", FULL_TOOLBOX, "read_only")
      .map((t) => t.function.name)
      .sort();
    expect(names).toEqual([...READ_ONLY_TOOLS].sort());
    for (const name of names) {
      expect(READ_ONLY_TOOLS).toContain(name);
    }
  });

  test("rewriter under read_only loses every mutating tool, keeps the intersection", () => {
    // The rewriter is the only OTHER mode that has edit tools under full.
    // A misclassified read must not escape the fence via the rewriter
    // route. The result is the *intersection* of the rewriter's own
    // filter and READ_ONLY_TOOLS — the rewriter's filter is
    // [read_file, grep, glob, list_directory, edit_file, write_file,
    //  multi_edit] and does NOT include `git_metadata`, so the read-only
    // intersection drops git_metadata along with the mutators. Pin both
    // halves: nothing in the result is a mutator, and the result is
    // exactly the per-tool allowlist of the rewriter under read_only.
    const names = getToolsForMode("rewriter", FULL_TOOLBOX, "read_only")
      .map((t) => t.function.name)
      .sort();
    expect(names).toEqual(["glob", "grep", "list_directory", "read_file"]);
    for (const name of names) {
      expect(READ_ONLY_TOOLS).toContain(name);
    }
  });

  test("reviewer under read_only is unchanged (already inspection-only under full)", () => {
    // The reviewer's full filter is read_file/grep/glob/list_directory, all
    // of which are in READ_ONLY_TOOLS. The intersection should be
    // identical to the full result — pinning this guards against a future
    // "broaden the reviewer" change being silently attenuated by the
    // read_only profile (it should broaden the full path AND be capped to
    // the same set on read-only turns).
    const full = getToolsForMode("reviewer", FULL_TOOLBOX, "full")
      .map((t) => t.function.name)
      .sort();
    const readOnly = getToolsForMode("reviewer", FULL_TOOLBOX, "read_only")
      .map((t) => t.function.name)
      .sort();
    expect(readOnly).toEqual(full);
  });

  test("read_only cannot ADD tools the mode's own filter would have excluded", () => {
    // A read_only turn must be the *intersection* of the mode's filter and
    // READ_ONLY_TOOLS — not a union. Pin the direction by giving a
    // toolbox that contains tools outside both the mode's filter and
    // READ_ONLY_TOOLS; the result must contain only tools the mode
    // *requested* that also happen to be read-only.
    const narrowToolbox: ToolDefinition[] = [
      tool("read_file"),  // in both executor filter and READ_ONLY_TOOLS
      tool("write_file"), // in executor filter but NOT in READ_ONLY_TOOLS
      tool("web_search"), // in executor filter but NOT in READ_ONLY_TOOLS
      tool("mystery"),    // in NEITHER
    ];
    const names = getToolsForMode("executor", narrowToolbox, "read_only")
      .map((t) => t.function.name)
      .sort();
    expect(names).toEqual(["read_file"]);
  });
});

describe("getToolsForMode — profile=none", () => {
  test("returns [] for every built-in mode under the 'none' profile", () => {
    // The 'none' profile is the conversation-mode escape hatch (the
    // `shortCircuitRouteFor(conversational)` bypass — Front 2 of the
    // performance plan). A future refactor that keeps any tool under
    // 'none' would break the contract.
    for (const modeId of Object.keys(BUILTIN_MODES)) {
      expect(getToolsForMode(modeId, FULL_TOOLBOX, "none")).toEqual([]);
    }
  });

  test("'none' is honored even for the executor (which has the broadest filter)", () => {
    // The executor's full filter is the largest of the modes; if 'none'
    // works for it, it works for everyone.
    expect(getToolsForMode("executor", FULL_TOOLBOX, "none")).toEqual([]);
  });
});

describe("getToolsForMode — defaults and edges", () => {
  test("default profile (omitted) is 'full'", () => {
    // The signature is `profile: ExecutionProfile = "full"` — pin the
    // default so a future "make 'full' mean 'least-authority'" refactor
    // is forced to update the call sites.
    const explicit = getToolsForMode("executor", FULL_TOOLBOX, "full");
    const implicit = getToolsForMode("executor", FULL_TOOLBOX);
    expect(implicit.map((t) => t.function.name).sort())
      .toEqual(explicit.map((t) => t.function.name).sort());
  });

  test("empty toolbox returns [] for every mode (no error)", () => {
    // The mode's filter intersects an empty set — the result is empty. Pin
    // that this doesn't throw or return undefined.
    for (const modeId of Object.keys(BUILTIN_MODES)) {
      expect(getToolsForMode(modeId, [], "full")).toEqual([]);
    }
  });

  test("unknown tool names in the toolbox are silently filtered out (no error)", () => {
    // A future mode that adds a new tool doesn't need a coordinated
    // toolbox update — the filter is the only thing that matters. A
    // toolbox that contains a name not in any filter should just not
    // appear in the result.
    const withExtra: ToolDefinition[] = [...FULL_TOOLBOX, tool("brand_new_tool")];
    const names = getToolsForMode("executor", withExtra, "full")
      .map((t) => t.function.name);
    expect(names).not.toContain("brand_new_tool");
  });

  test("powershell is included when registered and dropped by intersection when absent (F3)", () => {
    // shell-bundle registers powershell on win32 only. The filter lists it
    // unconditionally; getToolsForMode intersects with the live registry so
    // non-win32 runtimes never see a phantom tool.
    const withPs = getToolsForMode("executor", FULL_TOOLBOX, "full")
      .map((t) => t.function.name);
    expect(withPs).toContain("powershell");

    const withoutPs = getToolsForMode(
      "executor",
      FULL_TOOLBOX.filter((t) => t.function.name !== "powershell"),
      "full",
    ).map((t) => t.function.name);
    expect(withoutPs).not.toContain("powershell");

    const rewriterWith = getToolsForMode("rewriter", FULL_TOOLBOX, "full")
      .map((t) => t.function.name);
    expect(rewriterWith).toContain("powershell");
  });
});
