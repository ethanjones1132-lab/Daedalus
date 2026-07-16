import { describe, expect, test } from "bun:test";
import { composeEvidenceFallbackAnswer, shouldCutToSynthesis, SYNTHESIS_RUNWAY_MS } from "./pipeline";
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

describe("shouldCutToSynthesis", () => {
  const base = { wantsSynthesizer: true, hasEvidence: true, reserveMs: 30_000 };

  test("cuts inside the danger zone (reserve + runway)", () => {
    expect(shouldCutToSynthesis({ ...base, remainingMs: 30_000 + SYNTHESIS_RUNWAY_MS })).toBe(true);
    expect(shouldCutToSynthesis({ ...base, remainingMs: 40_000 })).toBe(true);
  });

  test("does not cut with ample budget", () => {
    expect(shouldCutToSynthesis({ ...base, remainingMs: 30_001 + SYNTHESIS_RUNWAY_MS })).toBe(false);
    expect(shouldCutToSynthesis({ ...base, remainingMs: 120_000 })).toBe(false);
  });

  test("never cuts without a queued synthesizer, evidence, or a budget", () => {
    expect(shouldCutToSynthesis({ ...base, wantsSynthesizer: false, remainingMs: 10_000 })).toBe(false);
    expect(shouldCutToSynthesis({ ...base, hasEvidence: false, remainingMs: 10_000 })).toBe(false);
    expect(shouldCutToSynthesis({ ...base, remainingMs: undefined })).toBe(false);
    expect(shouldCutToSynthesis({ ...base, remainingMs: 10_000, reserveMs: undefined })).toBe(false);
  });
});
