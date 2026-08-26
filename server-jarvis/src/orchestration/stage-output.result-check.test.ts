import { isEmptyStageOutput, renderExecutorSummary, assertStageResultNotEmpty } from "./stage-output";

describe("stage-output result check (regression guard)", () => {
  test("empty stage output is flagged, not reported as success", () => {
    // The stage-output boundary must reject an empty completion rather than
    // letting it reach the self-tuning collector as successful work.
    expect(isEmptyStageOutput("")).toBe(true);
    expect(isEmptyStageOutput("   ")).toBe(true);
    expect(isEmptyStageOutput(null)).toBe(true);
    expect(isEmptyStageOutput("real result")).toBe(false);
  });

  test("a stage reporting ok=true with empty narrative must not render success", () => {
    const executor = { ok: true, narrative: "", toolCalls: [] };
    const rendered = renderExecutorSummary(executor);
    expect(rendered).toBe("");
    expect(rendered).not.toContain("completed");
    expect(rendered).not.toContain("success");
  });

  test("assertStageResultNotEmpty throws on empty content (regression can fail)", () => {
    expect(() => assertStageResultNotEmpty("")).toThrow("empty result reported as success");
    expect(() => assertStageResultNotEmpty(null)).toThrow("empty result reported as success");
    expect(() => assertStageResultNotEmpty("valid")).not.toThrow();
  });
});
