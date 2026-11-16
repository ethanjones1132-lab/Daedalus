import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { StreamSession } from "./stream-emitter";
import {
  REJECTED_TOOL_CALL_ERROR_CODE,
  REJECTED_TOOL_CALL_FALLBACK,
  finishSinglePassCompletion,
} from "./single-pass-completion";
import {
  TRUNCATED_TOOL_CALL_ERROR,
  UNPARSEABLE_TOOL_CALL_ERROR,
  UNPARSED_TOOL_CALL_NAME,
  extractTextToolCalls,
  rejectedTextToolCallResult,
  resolveToolCallsFromTurn,
  unavailableToolCallError,
} from "./text-tools";
import type { ToolDefinition } from "./tool-types";

// DD-088: a `<tool_call>` block the model emitted but we could not parse must
// be reported, not silently dropped, and the turn must not settle as a clean
// success when the discarded call was the only call it made.

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

interface SseFrame {
  type: string;
  subtype?: string;
  is_error?: boolean;
  code?: string;
  result?: string;
  [key: string]: unknown;
}

interface Receipt {
  status: string;
  errorCode: string | null;
}

/** The production terminal path with a fake stream writer and memory recorder. */
function harness() {
  const frames: SseFrame[] = [];
  const receipts: Receipt[] = [];
  const session = new StreamSession({
    sessionId: "sess_dd088",
    write: async (frame: string): Promise<boolean> => {
      frames.push(JSON.parse(frame.trim().replace(/^data: /, "")) as SseFrame);
      return true;
    },
    isAborted: () => false,
    turnId: "turn_dd088",
  });

  const settle = (
    answer: string,
    toolExecutionCount: number,
    rejectedToolCallCount: number,
  ) =>
    finishSinglePassCompletion({
      answer,
      toolExecutionCount,
      rejectedToolCallCount,
      session,
      recordMemoryTerminal: (status, errorCode = null) => {
        receipts.push({ status, errorCode });
      },
    });

  const ofType = (type: string) => frames.filter((frame) => frame.type === type);

  return { frames, receipts, settle, ofType };
}

describe("a truncated <tool_call> block is reported (DD-088)", () => {
  const text =
    'Let me read it.\n<tool_call>{"name":"read_file","arguments":{"path":"READ';

  test("yields one rejected-call record with the recoverable name and range", () => {
    const parsed = extractTextToolCalls(text, tools);

    // Nothing executed, and the block is not left as visible prose either.
    expect(parsed.calls).toHaveLength(0);
    expect(parsed.cleanedText).toBe("Let me read it.");

    expect(parsed.rejected).toHaveLength(1);
    const [record] = parsed.rejected;
    expect(record.name).toBe("read_file");
    expect(record.reason).toBe(TRUNCATED_TOOL_CALL_ERROR);
    expect(record.start).toBe(text.indexOf("<tool_call>"));
    expect(record.end).toBe(text.length);
    expect(text.slice(record.start, record.end)).toBe(
      '<tool_call>{"name":"read_file","arguments":{"path":"READ',
    );
    // The record describes the discard; it never invents a call.
    expect("arguments" in record).toBe(false);
  });

  test("the record becomes an is_error tool result in the existing envelope", () => {
    const [record] = extractTextToolCalls(text, tools).rejected;
    const result = rejectedTextToolCallResult(record);

    expect(result.call_id).toStartWith("call_");
    expect(result.name).toBe("read_file");
    expect(result.output).toBe(TRUNCATED_TOOL_CALL_ERROR);
    expect(result.error).toBe(TRUNCATED_TOOL_CALL_ERROR);
    expect(result.is_error).toBe(true);
  });

  test("resolveToolCallsFromTurn passes the rejected record through", () => {
    const resolved = resolveToolCallsFromTurn({
      nativeCalls: [],
      fullText: text,
      tools,
      useTextTools: true,
    });

    expect(resolved.calls).toHaveLength(0);
    expect(resolved.rejected).toHaveLength(1);
    expect(resolved.rejected[0].name).toBe("read_file");
  });

  test("a complete block with unparseable JSON names a reason and an <unparsed> name", () => {
    const invalid = '<tool_call>plain prose, no json</tool_call>';
    const parsed = extractTextToolCalls(invalid, tools);

    expect(parsed.calls).toHaveLength(0);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0].name).toBe(UNPARSED_TOOL_CALL_NAME);
    expect(parsed.rejected[0].reason).toBe(UNPARSEABLE_TOOL_CALL_ERROR);
    expect(parsed.rejected[0].start).toBe(0);
    expect(parsed.rejected[0].end).toBe(invalid.length);
  });

  test("a block naming an unavailable tool is rejected, not executed", () => {
    const parsed = extractTextToolCalls(
      '<tool_call>{"name":"delete_everything","arguments":{}}</tool_call>',
      tools,
    );

    expect(parsed.calls).toHaveLength(0);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0].name).toBe("delete_everything");
    expect(parsed.rejected[0].reason).toBe(
      unavailableToolCallError("delete_everything"),
    );
  });
});

describe("the single-pass settle decision (DD-088)", () => {
  test("a discarded call with no other call settles partial, not success", async () => {
    const { receipts, settle, ofType } = harness();

    const completion = await settle("Let me read it.", 0, 1);

    expect(completion.subtype).toBe("partial");
    expect(completion.memoryStatus).toBe("partial");
    expect(completion.code).toBe(REJECTED_TOOL_CALL_ERROR_CODE);
    expect(completion.errorCode).toBe(REJECTED_TOOL_CALL_ERROR_CODE);

    const results = ofType("result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      subtype: "partial",
      is_error: false,
      code: REJECTED_TOOL_CALL_ERROR_CODE,
      result: "Let me read it.",
    });
    expect(receipts).toEqual([
      { status: "partial", errorCode: REJECTED_TOOL_CALL_ERROR_CODE },
    ]);
  });

  test("a discarded call with no answer still settles partial with a visible fallback", async () => {
    const { receipts, settle, ofType } = harness();

    const completion = await settle("", 0, 1);

    expect(completion.subtype).toBe("partial");
    expect(completion.result).toBe(REJECTED_TOOL_CALL_FALLBACK);
    expect(ofType("result")[0]).toMatchObject({
      subtype: "partial",
      code: REJECTED_TOOL_CALL_ERROR_CODE,
      result: REJECTED_TOOL_CALL_FALLBACK,
    });
    expect(receipts).toEqual([
      { status: "partial", errorCode: REJECTED_TOOL_CALL_ERROR_CODE },
    ]);
  });

  test("another executed call keeps the turn a success", async () => {
    const { receipts, settle } = harness();

    const completion = await settle("Read it and wrote the summary.", 1, 1);

    expect(completion.subtype).toBe("success");
    expect(receipts).toEqual([{ status: "completed", errorCode: null }]);
  });

  test("text with no tool call at all still settles success as today", async () => {
    const { receipts, settle, ofType } = harness();

    const parsed = extractTextToolCalls("Just prose, nothing to call.", tools);
    expect(parsed.calls).toHaveLength(0);
    expect(parsed.rejected).toEqual([]);

    const completion = await settle("Just prose, nothing to call.", 0, 0);

    expect(completion.subtype).toBe("success");
    expect(completion.code).toBeUndefined();
    expect(ofType("result")[0]?.subtype).toBe("success");
    expect(receipts).toEqual([{ status: "completed", errorCode: null }]);
  });
});

describe("existing text-tool behaviour is unchanged (DD-088 regression guards)", () => {
  test("a valid <tool_call> block still executes with no rejection", () => {
    const parsed = extractTextToolCalls(
      '<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>',
      tools,
    );

    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0].name).toBe("read_file");
    expect(parsed.rejected).toEqual([]);
  });

  test("an unclosed tag with complete JSON still executes (existing behaviour)", () => {
    const parsed = extractTextToolCalls(
      'Reading it now.\n<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}',
      tools,
    );

    expect(parsed.calls).toHaveLength(1);
    expect(parsed.rejected).toEqual([]);
  });

  test("a bare JSON call still executes with no rejection", () => {
    const parsed = extractTextToolCalls(
      '{"name":"read_file","arguments":{"path":"README.md"}}',
      tools,
    );

    expect(parsed.calls).toHaveLength(1);
    expect(parsed.rejected).toEqual([]);
  });

  test("a stage with no tools offered does not invent a rejected call", () => {
    // The synthesizer/planner echo path passes an empty tool list and only
    // strips markup; there is no call to reject, so nothing is reported.
    const parsed = extractTextToolCalls(
      '<tool_call>{"name":"list_directory","arguments":{"path":"src"}}</tool_call>',
      [],
    );

    expect(parsed.calls).toHaveLength(0);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.cleanedText).toBe("");
  });

  test("a fenced JSON example stays inert and is not reported as rejected (DD-087)", () => {
    const example = '{"name":"write_file","arguments":{"path":"notes.txt","content":"hello"}}';
    const text = `Here is the shape I will use:\n\n\`\`\`json\n${example}\n\`\`\`\n\nThen I will call it.`;

    const parsed = extractTextToolCalls(text, tools);

    expect(parsed.calls).toHaveLength(0);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.cleanedText).toBe(text);
  });

  test("a truncated tag inside a fence is an example, not a rejected call (DD-087)", () => {
    const text = 'Example:\n\n```\n<tool_call>{"name":"read_file","arguments":{"path":"READ\n```';
    const parsed = extractTextToolCalls(text, tools);

    expect(parsed.calls).toHaveLength(0);
    expect(parsed.rejected).toEqual([]);
    // DD-087's cleanup is untouched: the unclosed tag is still suppressed
    // from visible text, it just is not reported as a discarded call.
    expect(parsed.cleanedText).not.toContain("<tool_call>");
  });
});

describe("index.ts rejected-call wiring (DD-088)", () => {
  function turnBranch(): string {
    const source = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");
    const start = source.indexOf("const textExtraction = validCalls.length === 0");
    const end = source.indexOf("// Model called tools!", start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  test("the turn streams a tool_use + is_error tool_result for each rejected call", () => {
    const branch = turnBranch();

    expect(branch).toContain("textExtraction.rejected");
    expect(branch).toContain("rejectedTextToolCallResult(rejected)");

    const rejectionStart = branch.indexOf("textExtraction.rejected.length > 0");
    const rejectionEnd = branch.indexOf("rejectedTextCallCount++", rejectionStart);
    expect(rejectionStart).toBeGreaterThan(-1);
    expect(rejectionEnd).toBeGreaterThan(rejectionStart);

    const rejection = branch.slice(rejectionStart, rejectionEnd);
    expect(rejection).toContain('type: "tool_use"');
    expect(rejection).toContain('type: "tool_result"');
    expect(rejection).toContain("is_error: true");
    expect(rejection).toContain("rejected.reason");
    // Nothing executes and nothing counts as tool work.
    expect(rejection).not.toContain("runtime.execute(");
    expect(rejection).not.toContain("toolExecutionCount++");
  });

  test("the settle decision receives the discarded-call count", () => {
    const branch = turnBranch();

    expect(branch).toContain("rejectedToolCallCount: rejectedTextCallCount");
    expect(branch).toContain("finishSinglePassCompletion({");
  });
});
