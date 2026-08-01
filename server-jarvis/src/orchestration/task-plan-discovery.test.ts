import { describe, expect, test } from "bun:test";
import { discoverPlanItems, isPlanDocumentPath, requestedPlanGroupFromMessage } from "./task-plan-discovery";

const markdown = `
# Execution Plan
## Group A
### A1 — Add the bypass invariant
- [ ] Implement the invariant
### A2 — Replace volatility depth
- [ ] Update the calculation
### A3 — Add regression coverage
- [ ] Run the focused suite
### A4 — Verify the full group
- [ ] Build and smoke
## Group B
### B1 — Later work
`;

describe("discoverPlanItems", () => {
  test("extracts only the requested numbered group", () => {
    expect(
      discoverPlanItems({
        path: "GROUP_A_EXECUTION.md",
        content: markdown,
        requestedGroup: "A",
      }).map((item) => item.externalKey),
    ).toEqual(["A1", "A2", "A3", "A4"]);
  });

  test("ignores ordinary source files", () => {
    expect(
      discoverPlanItems({
        path: "PluginProcessor.cpp",
        content: markdown,
        requestedGroup: "A",
      }),
    ).toEqual([]);
  });

  test("attaches code-work acceptance checks to each discovered item", () => {
    const items = discoverPlanItems({
      path: "docs/GROUP_A_EXECUTION.md",
      content: markdown,
      requestedGroup: "A",
    });
    expect(items).toHaveLength(4);
    expect(items[0].title).toContain("bypass invariant");
    expect(items[0].acceptanceChecks).toEqual([
      {
        id: "ac_a1_diff",
        description: "A1 produced a verified workspace mutation",
        kind: "diff_match",
      },
      {
        id: "ac_a1_check",
        description: "A1 passed an authoritative runtime/build check",
        kind: "test_pass",
      },
    ]);
  });

  test("deduplicates by externalKey and stops at the next top-level group", () => {
    const dup = `
## Group A
### A1 — First
### A1 — Duplicate title
### A2 — Second
## Group B
### A3 — Should not appear under group A filter after group B
`;
    const keys = discoverPlanItems({
      path: "tasks.md",
      content: dup,
      requestedGroup: "A",
    }).map((i) => i.externalKey);
    expect(keys).toEqual(["A1", "A2"]);
  });
});

describe("isPlanDocumentPath", () => {
  test("accepts plan-like basenames only", () => {
    expect(isPlanDocumentPath("GROUP_A_EXECUTION.md")).toBe(true);
    expect(isPlanDocumentPath("roadmap.txt")).toBe(true);
    expect(isPlanDocumentPath("docs/checklist-v2.md")).toBe(true);
    expect(isPlanDocumentPath("PluginProcessor.cpp")).toBe(false);
    expect(isPlanDocumentPath("src/main.ts")).toBe(false);
  });
});

describe("requestedPlanGroupFromMessage", () => {
  test("parses Group A style requests", () => {
    expect(requestedPlanGroupFromMessage("Execute Group A from GROUP_A_EXECUTION.md")).toBe("A");
    expect(requestedPlanGroupFromMessage("complete group-b tasks")).toBe("B");
    expect(requestedPlanGroupFromMessage("implement GROUP_C plan")).toBe("C");
  });
});
