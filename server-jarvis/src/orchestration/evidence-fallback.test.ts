import { describe, expect, test } from "bun:test";
import { composeEvidenceFallbackAnswer } from "./pipeline";
import type { PipelineStageState } from "./stage-output";
import type { ToolCallRecord } from "./stage-output";

function call(partial: Partial<ToolCallRecord> & Pick<ToolCallRecord, "name" | "output">): ToolCallRecord {
  return {
    arguments: {},
    is_error: false,
    duration_ms: 10,
    ...partial,
  } as ToolCallRecord;
}

function stateWith(toolCalls: ToolCallRecord[], reviewerFeedback?: string): PipelineStageState {
  return {
    executor: { ok: true, narrative: "did things", toolCalls },
    ...(reviewerFeedback !== undefined
      ? { reviewer: { ok: true, feedback: reviewerFeedback, hasIssues: false } }
      : {}),
  } as PipelineStageState;
}

describe("composeEvidenceFallbackAnswer", () => {
  test("composes a grounded digest from reads, listings, and reviewer notes", () => {
    const state = stateWith(
      [
        call({ name: "read_file", arguments: { path: "C:\\Projects\\Versutus\\src\\lib\\gateway\\client.ts" }, output: "export class GatewayClient { /* websocket logic */ }" }),
        call({ name: "read_file", arguments: { path: "C:\\Projects\\Versutus\\src\\app\\_layout.tsx" }, output: "export default function Layout() {}" }),
        call({ name: "list_directory", arguments: { path: "C:\\Projects\\Versutus\\src" }, output: "3 items in src:\napp\nlib\ncontext" }),
      ],
      "ACCEPT — evidence covers the gateway client but not reconnection paths.",
    );
    const digest = composeEvidenceFallbackAnswer(state);
    expect(digest).toContain("client.ts");
    expect(digest).toContain("_layout.tsx");
    expect(digest).toContain("GatewayClient");
    expect(digest).toContain("Directories inspected");
    expect(digest).toContain("Reviewer notes");
    expect(digest).toContain("Runtime-composed digest");
  });

  test("returns empty string when there is no usable evidence", () => {
    expect(composeEvidenceFallbackAnswer({} as PipelineStageState)).toBe("");
    expect(composeEvidenceFallbackAnswer(stateWith([]))).toBe("");
    expect(
      composeEvidenceFallbackAnswer(
        stateWith([call({ name: "read_file", output: "boom", is_error: true })]),
      ),
    ).toBe("");
    expect(
      composeEvidenceFallbackAnswer(stateWith([call({ name: "read_file", output: "   " })])),
    ).toBe("");
  });

  test("caps digest size: at most 6 read excerpts, each excerpt bounded", () => {
    const reads = Array.from({ length: 10 }, (_, i) =>
      call({
        name: "read_file",
        arguments: { path: `src/file-${i}.ts` },
        output: "x".repeat(5_000),
      }),
    );
    const digest = composeEvidenceFallbackAnswer(stateWith(reads));
    expect((digest.match(/### read_file/g) ?? []).length).toBe(6);
    expect(digest.length).toBeLessThan(6 * 1_700 + 2_000);
  });
});
