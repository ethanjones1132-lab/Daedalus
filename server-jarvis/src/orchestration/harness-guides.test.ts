import { describe, expect, test } from "bun:test";
import {
  HARNESS_GUIDE_BUDGET,
  renderHarnessGuides,
  type HarnessGuideInput,
} from "./harness-guides";
import { applyAgentSystemPrompt } from "./agent-system-prompt";

function input(overrides: Partial<HarnessGuideInput> = {}): HarnessGuideInput {
  return {
    rules: "Maker rules",
    briefTemplate: "Fix {{issue}} in {{file}}",
    briefValues: { issue: "the crash", file: "src/app.ts" },
    skills: [],
    references: [],
    bannedDefaults: [],
    role: "maker",
    ...overrides,
  };
}

describe("renderHarnessGuides", () => {
  test("fills brief placeholders and labels provenance", () => {
    const rendered = renderHarnessGuides(input({
      skills: ["Use focused tests"],
      references: ["API docs"],
      bannedDefaults: ["Do not claim unrun tests passed"],
    }));
    expect(rendered.text).toContain("Fix the crash in src/app.ts");
    expect(rendered.provenance).toEqual(["rules", "brief", "skills", "references", "banned defaults"]);
    for (const label of ["rules", "brief", "skills", "references", "banned defaults"]) {
      expect(rendered.text).toContain(`[Harness ${label}]`);
    }
  });

  test("fails closed when a brief placeholder has no value", () => {
    expect(() => renderHarnessGuides(input({ briefValues: { issue: "the crash" } })))
      .toThrow("missing a value for placeholder: file");
  });

  test("drops references before skills to stay within the fixed budget", () => {
    const rendered = renderHarnessGuides(input({
      skills: ["S".repeat(HARNESS_GUIDE_BUDGET / 2)],
      references: ["R".repeat(HARNESS_GUIDE_BUDGET / 2)],
    }));
    expect(rendered.truncated).toBe(true);
    expect(rendered.text.length).toBeLessThanOrEqual(HARNESS_GUIDE_BUDGET);
    expect(rendered.text).not.toContain("[Harness references]");
    expect(rendered.text).toContain("[Harness skills]");
  });

  test("preserves banned defaults while truncating lower-priority blocks", () => {
    const bannedDefault = "Never assume tests pass";
    const rendered = renderHarnessGuides(input({
      skills: ["S".repeat(HARNESS_GUIDE_BUDGET)],
      references: ["R".repeat(HARNESS_GUIDE_BUDGET)],
      bannedDefaults: [bannedDefault],
    }));
    expect(rendered.truncated).toBe(true);
    expect(rendered.text).toContain(bannedDefault);
    expect(rendered.text).toContain("[Harness banned defaults]");
  });

  test("checker receives only the diff brief and rubric, never maker rules", () => {
    const rendered = renderHarnessGuides(input({
      role: "checker",
      rubric: "Check correctness and regressions",
      skills: ["Maker skill"],
      references: ["Maker reference"],
      bannedDefaults: ["Maker banned default"],
    }));
    expect(rendered.text).toContain("[Harness brief]");
    expect(rendered.text).toContain("[Harness rubric]");
    expect(rendered.text).not.toContain("Maker rules");
    expect(rendered.text).not.toContain("Maker skill");
    expect(rendered.text).not.toContain("Maker reference");
    expect(rendered.text).not.toContain("Maker banned default");
    expect(rendered.provenance).toEqual(["brief", "rubric"]);
  });

  test("appends rendered guides without consuming the agent prompt's 4,000-character cap", () => {
    const guide = renderHarnessGuides(input()).text;
    const messages = applyAgentSystemPrompt([{ role: "system", content: "BASE" }], "x".repeat(5_000), guide);
    const content = messages[0].content as string;
    expect(content).toContain("x".repeat(4_000));
    expect(content).not.toContain("x".repeat(4_001));
    expect(content).toContain(guide);
  });
});
