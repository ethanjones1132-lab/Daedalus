// Pins for prompt truth (P2.4).
//
// The invariant: a stage prompt names all and only the tools that stage can
// actually call, with real parameter names. Before this, the prose drifted —
// executor.md capped `bash` at 60000ms and forbade `workdir`/`background`,
// reviewer.md named `search_files`, rewriter.md named `patch` — none of which
// matched the registry. These tests fail if that drift returns.

import { describe, expect, test } from "bun:test";
import {
  injectToolGuidelines,
  renderToolGuidelines,
  TOOL_GUIDELINES_MARKER,
} from "./tool-guidelines";
import { loadPrompt } from "./prompt-loader";
import { getToolsForMode, type BUILTIN_MODES } from "./modes";
import { createToolRuntime } from "../tool-runtime";
import { registerStandardBundles } from "../bundles-registry";
import type { ExecutionProfile } from "./route-normalization";
import type { ToolDefinition } from "../tool-types";

function runtimeTools(): ToolDefinition[] {
  const runtime = createToolRuntime();
  registerStandardBundles(runtime);
  return runtime.listTools();
}

const MARKER_STAGES = ["executor", "reviewer", "rewriter"] as const;
type MarkerStage = (typeof MARKER_STAGES)[number];

const STAGE_FILE: Record<MarkerStage, string> = {
  executor: "modes/executor.md",
  reviewer: "modes/reviewer.md",
  rewriter: "modes/rewriter.md",
};

describe("renderToolGuidelines", () => {
  test("lists each tool with its real parameter names", () => {
    const tools = runtimeTools();
    const bash = tools.find((t) => t.function.name === "bash")!;
    const block = renderToolGuidelines([bash]);
    expect(block).toContain("`bash`");
    for (const param of Object.keys(bash.function.parameters.properties)) {
      expect(block).toContain(`\`${param}\``);
    }
    // The drift that used to live in executor.md: a phantom parameter name.
    expect(block).not.toContain("workdir");
    expect(block).not.toContain("background");
  });

  test("empty tool set renders a no-tools notice, not an empty list", () => {
    expect(renderToolGuidelines([])).toContain("no tools");
  });
});

describe("injectToolGuidelines", () => {
  test("replaces the marker and leaves marker-free prompts untouched", () => {
    const tools = runtimeTools();
    expect(injectToolGuidelines("before {{TOOL_GUIDELINES}} after", tools)).not.toContain(TOOL_GUIDELINES_MARKER);
    expect(injectToolGuidelines("no marker here", tools)).toBe("no marker here");
  });
});

describe("stage prompts name all and only their callable tools", () => {
  for (const stage of MARKER_STAGES) {
    test(`${stage}.md carries the marker`, () => {
      // If a maintainer removes the marker, the prompt silently stops telling
      // the model its tools — catch that here.
      expect(loadPrompt(STAGE_FILE[stage])).toContain(TOOL_GUIDELINES_MARKER);
    });

    for (const profile of ["full", "read_only"] as ExecutionProfile[]) {
      test(`${stage}.md @ ${profile}: every exposed tool appears, no marker leaks`, () => {
        const stageTools = getToolsForMode(
          stage as keyof typeof BUILTIN_MODES,
          runtimeTools(),
          profile,
        );
        const rendered = injectToolGuidelines(loadPrompt(STAGE_FILE[stage]), stageTools);

        // No unrendered marker survives.
        expect(rendered).not.toContain(TOOL_GUIDELINES_MARKER);

        // Every tool the stage can call is named in the prompt.
        for (const tool of stageTools) {
          expect(rendered).toContain(`\`${tool.function.name}\``);
        }
      });
    }
  }

  test("hand-written prose no longer references phantom tools", () => {
    // Checked against the RAW prompt prose (pre-injection). `patch` is
    // deliberately NOT in this list — it is a real PARAMETER of `apply_patch`,
    // so it legitimately appears once tools are rendered; the drift was the
    // prose phrase "Prefer `patch`", which the edits removed. These tokens have
    // no such collision and must never reappear.
    const phantomTokens = ["search_files", "workdir", "background"];
    for (const stage of MARKER_STAGES) {
      const raw = loadPrompt(STAGE_FILE[stage]);
      for (const token of phantomTokens) {
        expect(raw).not.toContain(token);
      }
    }
  });

  test("every tool-header line in a rendered block names a registered tool", () => {
    const registered = new Set(runtimeTools().map((t) => t.function.name));
    for (const stage of MARKER_STAGES) {
      const stageTools = getToolsForMode(stage as keyof typeof BUILTIN_MODES, runtimeTools(), "full");
      const block = renderToolGuidelines(stageTools);
      // Header lines look like: "- `tool_name` _(flags)_ — description".
      const headerNames = [...block.matchAll(/^- `([a-z_]+)`/gm)].map((m) => m[1]);
      expect(headerNames.length).toBe(stageTools.length);
      for (const name of headerNames) {
        expect(registered.has(name)).toBe(true);
      }
    }
  });
});
