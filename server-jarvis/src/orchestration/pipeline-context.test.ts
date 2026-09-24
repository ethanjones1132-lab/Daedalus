import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config";
import { resolveSkillsForTurn } from "../intelligence/skill-resolver";
import { saveSkillCandidate } from "../intelligence/skill-store";
import type { SkillCandidate } from "../intelligence/skill-types";
import { createToolRuntime, makeExecutionContext } from "../tool-runtime";
import type { StageRun } from "../self-tuning/store";
import { PipelineExecutor, type StageRunRecorder } from "./pipeline";

function toolDefinition(name: string) {
  return {
    type: "function" as const,
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  };
}

function toolCall(name: string, id: string) {
  return { id, type: "function", function: { name, arguments: JSON.stringify({ path: "src/a.ts" }) } };
}

describe("orchestrator transcript context", () => {
  test("bounds model-facing tool results while preserving raw evidence records", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    const rawOutput = "x".repeat(50_000);
    runtime.register(toolDefinition("read_file"), async () => rawOutput);
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    const executorInputs: any[][] = [];
    let executorTurns = 0;
    const callModel = async (messages: any[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") {
        executorInputs.push(messages.map((message) => ({ ...message })));
        if (executorTurns++ === 0) {
          return { content: "reading", tool_calls: [toolCall("read_file", "read-1")] };
        }
        return { content: "read complete" };
      }
      return { content: "The file contains the requested evidence." };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "read src/a.ts",
      ["executor", "synthesizer"],
      "run-context-boundary",
      () => {},
      { executionProfile: "read_only" },
    );

    const toolMessage = executorInputs[1].find((message) => message.role === "tool");
    expect(toolMessage.content.length).toBeLessThanOrEqual(6_000);
    expect(toolMessage.content).toContain("Result recorded in full for verification");
    expect(result.toolCalls?.[0].output.length).toBe(rawOutput.length);
    expect(rows.find((row) => row.mode_id === "executor")?.input_tokens).toBeGreaterThan(0);
  });

  test("does not spawn a rewriter for reviewer issues on a read-intent turn", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") return { content: "read complete" };
      if (options.stageLabel === "reviewer") return { content: "PARTIAL: issue remains" };
      if (options.stageLabel === "synthesizer") return { content: "Read-only answer." };
      throw new Error(`unexpected stage: ${options.stageLabel}`);
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "create a comprehensive implementation plan. Do not modify files.",
      ["executor", "reviewer", "synthesizer"],
      "run-read-review-no-rewriter",
      () => {},
      { executionProfile: "full", maxReviewRepairRounds: 2 },
    );

    expect(result.outcome).toBe("success");
    expect(rows.some((row) => row.mode_id === "rewriter")).toBe(false);
  });

  test("no-tool write pressure note appears only once in the executor transcript", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    runtime.register(toolDefinition("write_file"), async () => "written");
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    const executorInputs: any[][] = [];
    let executorTurns = 0;
    const callModel = async (messages: any[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") {
        executorInputs.push(messages.map((message) => ({ ...message })));
        executorTurns++;
        return {
          content: "Here is the patch as prose without calling tools.",
          _provider: "openrouter",
          _modelUsed: executorTurns === 1 ? "m1" : "m2",
        };
      }
      return { content: "Could not complete the write." };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "edit src/a.ts to export a helper",
      ["executor", "synthesizer"],
      "run-no-tool-single-pressure",
      () => {},
      {
        executionProfile: "full",
        turnBudget: {
          stageRemainingMs: () => 60_000,
          extendStageOnProgress: () => 0,
        } as any,
      },
    );

    expect(executorTurns).toBe(2);
    const pressureNotes = executorInputs.flat().filter(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("CHANGE request") &&
        message.content.includes("write tools"),
    );
    expect(pressureNotes).toHaveLength(1);
    expect(result.error_code).toBe("executor_no_tool");
    expect(rows.filter((row) => row.stop_reason === "no_tool")).toHaveLength(2);
  });

  test("passes the same bounded skill selection to planner and executor", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-pipeline-skills-"));
    const globalState = globalThis as { __skillCandidatesDirOverride?: string };
    const previousRoot = globalState.__skillCandidatesDirOverride;
    globalState.__skillCandidatesDirOverride = root;

    try {
      const rows: SkillCandidate[] = [
        ["pipeline-newest", "newest", "2026-09-24T04:00:00.000Z", "newest guidance"],
        ["pipeline-middle", "middle", "2026-09-24T03:00:00.000Z", "middle guidance"],
        ["pipeline-omitted", "omitted", "2026-09-24T02:00:00.000Z", "omitted guidance"],
      ].map(([id, name, updatedAt, body]) => ({
        id,
        name,
        description: `${name} description`,
        trigger: { task_types: ["debug"] as const, requirements: ["full_execution"] as const, signals: ["mutation_verb"] },
        body,
        source_run_ids: [`run-${id}`],
        confidence: 0.9,
        status: "promoted" as const,
        created_at: updatedAt,
        updated_at: updatedAt,
      }));
      for (const row of rows.slice().reverse()) saveSkillCandidate(row);

      const resolved = resolveSkillsForTurn(
        "fix the failing import in src/auth.ts",
        "debug",
        { maxSkills: 2, maxTokens: 200 },
      );
      const captured = new Map<string, string>();
      const runtime = createToolRuntime();
      const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
      const callModel = async (messages: any[], options: { stageLabel?: string } = {}) => {
        const stage = options.stageLabel ?? "unknown";
        const system = messages.find((message) => message.role === "system")?.content;
        if (typeof system === "string" && (stage === "planner" || stage === "executor")) {
          captured.set(stage, system);
        }
        if (stage === "planner") return { content: "1. Summarize the relevant debug guidance." };
        if (stage === "executor") return { content: "The selected guidance was considered." };
        if (stage === "synthesizer") return { content: "A concise answer." };
        return { content: "ok" };
      };

      const executor = new PipelineExecutor(callModel as any, runtime, ctx, {
        recordStageRun: () => {},
      });
      await executor.execute(
        "summarize the debug notes",
        ["planner", "executor", "synthesizer"],
        "run-pipeline-skill-selection",
        () => {},
        {
          executionProfile: "read_only",
          rawMessage: "summarize the debug notes",
          turnRequirement: "conversational",
          distilledSkillsBlock: resolved.promptBlock,
        },
      );

      const skillBlock = (system: string | undefined) => {
        const start = system?.indexOf("Promoted distilled skills") ?? -1;
        const end = system?.indexOf("Stage baseline contract") ?? -1;
        return start >= 0 && end > start ? system?.slice(start, end).trim() : "";
      };

      expect(skillBlock(captured.get("planner"))).toBe(skillBlock(captured.get("executor")));
      expect(captured.get("planner")).toContain("newest");
      expect(captured.get("planner")).toContain("middle");
      expect(captured.get("planner")).not.toContain("omitted");
    } finally {
      if (previousRoot === undefined) delete globalState.__skillCandidatesDirOverride;
      else globalState.__skillCandidatesDirOverride = previousRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
