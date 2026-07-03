import { describe, expect, test } from "bun:test";
import { prepareToolResultForContext } from "./tool-result-truncation";

describe("prepareToolResultForContext", () => {
  test("leaves a result within the context limit unmarked", () => {
    const prepared = prepareToolResultForContext("complete output", 2_000);

    expect(prepared.context).toBe("complete output");
    expect(prepared.metadata).toEqual({
      truncated: false,
      original_chars: 15,
      retained_chars: 15,
      removed_chars: 0,
      limit_chars: 2_000,
    });
  });

  test("reports exact context truncation metadata while preserving both ends", () => {
    const output = `${"a".repeat(1_500)}${"z".repeat(1_500)}`;
    const prepared = prepareToolResultForContext(output, 2_000);

    expect(prepared.metadata.truncated).toBe(true);
    expect(prepared.metadata.original_chars).toBe(3_000);
    expect(prepared.metadata.retained_chars).toBeLessThanOrEqual(2_000);
    expect(prepared.metadata.removed_chars).toBe(
      prepared.metadata.original_chars - prepared.metadata.retained_chars,
    );
    expect(prepared.context.startsWith("a".repeat(100))).toBe(true);
    expect(prepared.context.endsWith("z".repeat(100))).toBe(true);
    expect(prepared.context).toContain(`${prepared.metadata.removed_chars} chars removed`);
  });
});
