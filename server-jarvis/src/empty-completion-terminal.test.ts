import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { StreamSession } from "./stream-emitter";
import { RoutePlan } from "./orchestration/route-plan";
import {
  EMPTY_ANSWER_WITHOUT_TOOLS_FALLBACK,
  EMPTY_ANSWER_WITH_TOOL_WORK_FALLBACK,
  EMPTY_COMPLETION_ERROR_CODE,
  finishSinglePassCompletion,
} from "./single-pass-completion";

interface SseFrame {
  type: string;
  subtype?: string;
  is_error?: boolean;
  code?: string;
  result?: string;
  name?: string;
  [key: string]: unknown;
}

interface Receipt {
  status: string;
  errorCode: string | null;
}

/**
 * Production terminal path with a fake stream writer and a fake memory
 * recorder: the real `StreamSession` owns the terminal frames, and the helper
 * under test is exactly what index.ts calls in the single-pass branch.
 */
function harness() {
  const frames: SseFrame[] = [];
  const receipts: Receipt[] = [];
  const session = new StreamSession({
    sessionId: "sess_dd045",
    write: async (frame: string): Promise<boolean> => {
      frames.push(JSON.parse(frame.trim().replace(/^data: /, "")) as SseFrame);
      return true;
    },
    isAborted: () => false,
    turnId: "turn_dd045",
  });

  const settle = (answer: string, toolExecutionCount: number, route?: ReturnType<RoutePlan["summary"]>) =>
    finishSinglePassCompletion({
      answer,
      toolExecutionCount,
      session,
      recordMemoryTerminal: (status, errorCode = null) => {
        receipts.push({ status, errorCode });
      },
      route,
    });

  const ofType = (type: string) => frames.filter((frame) => frame.type === type);
  const terminalOutcomes = () =>
    frames.filter(
      (frame) =>
        frame.type === "result" ||
        frame.type === "error" ||
        frame.type === "cancelled",
    );

  return { frames, receipts, settle, ofType, terminalOutcomes };
}

describe("single-pass terminal completion", () => {
  test("Direct Session terminal carries failed fallback and actual answer attribution", async () => {
    const { settle, ofType } = harness();
    const route = new RoutePlan();
    route.add({ stage: "agent_loop", provider: "openrouter", model: "model-a", choice: "configured", outcome: "http_error", duration_ms: 9, error: "HTTP 503" });
    route.add({ stage: "agent_loop", provider: "ollama", model: "org/model:tag", choice: "fallback", outcome: "success", duration_ms: 13 });

    await settle("answer from local", 0, route.summary());

    expect(ofType("result")[0]?.route).toMatchObject({
      answered_by: { stage: "agent_loop", provider: "ollama", model: "org/model:tag", cloud: false },
      left_machine: true,
      attempts: [
        { provider: "openrouter", model: "model-a", outcome: "http_error", answered: false },
        { provider: "ollama", model: "org/model:tag", outcome: "success", answered: true },
      ],
    });
  });

  test("Direct Session terminal retains a failed model attempt without naming an answer", async () => {
    const { settle, ofType } = harness();
    const route = new RoutePlan();
    route.add({ stage: "agent_loop", provider: "openrouter", model: "model-a", choice: "configured", outcome: "http_error", duration_ms: 9, error: "HTTP 503" });

    await settle("", 0, route.summary());

    expect(ofType("result")[0]?.route).toMatchObject({
      left_machine: true,
      attempts: [{ provider: "openrouter", model: "model-a", outcome: "http_error", answered: false }],
    });
    expect((ofType("result")[0]?.route as { answered_by?: unknown }).answered_by).toBeUndefined();
  });

  test("no tools and no answer fails honestly on both the stream and the receipt", async () => {
    const { receipts, settle, ofType, terminalOutcomes } = harness();

    const completion = await settle("", 0);

    expect(completion.subtype).toBe("error");
    expect(completion.code).toBe(EMPTY_COMPLETION_ERROR_CODE);
    expect(terminalOutcomes()).toHaveLength(1);
    expect(ofType("message_stop")).toHaveLength(1);
    const results = ofType("result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: "result",
      subtype: "error",
      is_error: true,
      code: EMPTY_COMPLETION_ERROR_CODE,
      result: EMPTY_ANSWER_WITHOUT_TOOLS_FALLBACK,
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toEqual({
      status: "failed",
      errorCode: EMPTY_COMPLETION_ERROR_CODE,
    });
  });

  test("tool results with no final answer settle partial and keep the results visible", async () => {
    const { frames, receipts, settle, ofType, terminalOutcomes } = harness();
    // A tool result already streamed before the terminal branch runs.
    frames.push({ type: "tool_result", call_id: "call_1", name: "read_file", output: "contents" });

    const completion = await settle("", 2);

    expect(completion.subtype).toBe("partial");
    expect(completion.code).toBe(EMPTY_COMPLETION_ERROR_CODE);
    expect(terminalOutcomes()).toHaveLength(1);
    expect(ofType("message_stop")).toHaveLength(1);
    const results = ofType("result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      subtype: "partial",
      is_error: false,
      code: EMPTY_COMPLETION_ERROR_CODE,
      result: EMPTY_ANSWER_WITH_TOOL_WORK_FALLBACK,
    });
    expect(results[0].result).toContain("streamed tool results above are preserved");
    // The earlier tool_result is preserved in stream order before the terminal.
    expect(ofType("tool_result")).toEqual([
      { type: "tool_result", call_id: "call_1", name: "read_file", output: "contents" },
    ]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toEqual({
      status: "partial",
      errorCode: EMPTY_COMPLETION_ERROR_CODE,
    });
  });

  test("a whitespace-only answer is empty, not a success", async () => {
    const { receipts, settle, ofType, terminalOutcomes } = harness();

    const completion = await settle("  \n\t  ", 0);

    expect(completion.subtype).toBe("error");
    expect(terminalOutcomes()).toHaveLength(1);
    const results = ofType("result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      subtype: "error",
      is_error: true,
      code: EMPTY_COMPLETION_ERROR_CODE,
      result: EMPTY_ANSWER_WITHOUT_TOOLS_FALLBACK,
    });
    expect(receipts).toEqual([
      { status: "failed", errorCode: EMPTY_COMPLETION_ERROR_CODE },
    ]);
  });

  test("a non-empty answer after the retry succeeds normally", async () => {
    const { receipts, settle, ofType, terminalOutcomes } = harness();

    const completion = await settle("Here is the answer after the retry.", 0);

    expect(completion.subtype).toBe("success");
    expect(completion.code).toBeUndefined();
    expect(terminalOutcomes()).toHaveLength(1);
    const results = ofType("result");
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Here is the answer after the retry.",
      session_id: "sess_dd045",
      turn_id: "turn_dd045",
    });
    expect(receipts).toEqual([{ status: "completed", errorCode: null }]);
  });

  test("an ordinary answer still succeeds with one terminal outcome", async () => {
    const { receipts, settle, ofType, terminalOutcomes } = harness();

    const completion = await settle("The file defines three functions.", 1);

    expect(completion.subtype).toBe("success");
    expect(completion.memoryStatus).toBe("completed");
    expect(terminalOutcomes()).toHaveLength(1);
    expect(ofType("message_stop")).toHaveLength(1);
    const results = ofType("result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      subtype: "success",
      is_error: false,
      result: "The file defines three functions.",
    });
    expect(results[0].code).toBeUndefined();
    expect(receipts).toEqual([{ status: "completed", errorCode: null }]);
  });
});

describe("index.ts single-pass terminal wiring", () => {
  test("the final-answer branch settles through the shared completion seam", () => {
    // index.ts cannot be imported (it starts the server), so pin the wiring
    // deterministically: reverting the branch to the old unconditional
    // `recordMemoryTerminal("completed")` + `session.finish(resultText)` pair
    // must fail here even though the seam's own behaviour tests still pass.
    const source = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");
    const branchStart = source.indexOf("if (validCalls.length === 0) {");
    const branchEnd = source.indexOf("// Model called tools!", branchStart);

    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);

    const branch = source.slice(branchStart, branchEnd);
    expect(branch).toContain("finishSinglePassCompletion({");
    expect(branch).toContain("recordMemoryTerminal,");
    expect(branch).not.toContain('recordMemoryTerminal("completed")');
    expect(branch).not.toMatch(/session\.finish\(resultText\)/);
  });
});
