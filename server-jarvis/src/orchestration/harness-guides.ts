/**
 * This text is guidance for an agent, not a permission boundary. Runtime policy
 * must enforce permissions independently of anything rendered here.
 */

export const HARNESS_GUIDE_BUDGET = 8_000;

export interface HarnessGuideInput {
  rules: string;
  briefTemplate: string;
  briefValues: Record<string, string>;
  skills: string[];
  references: string[];
  bannedDefaults: string[];
  role: "maker" | "checker";
  rubric?: string;
}

export type HarnessGuideSource =
  | "rules"
  | "brief"
  | "skills"
  | "references"
  | "banned defaults"
  | "rubric";

export interface RenderedHarnessGuides {
  text: string;
  truncated: boolean;
  provenance: HarnessGuideSource[];
}

interface GuideBlock {
  source: HarnessGuideSource;
  content: string;
  removable: boolean;
}

function fillBrief(template: string, values: Record<string, string>): string {
  return template.replace(/{{([^{}]*)}}/g, (_placeholder, rawKey: string) => {
    const key = rawKey.trim();
    if (!Object.prototype.hasOwnProperty.call(values, key) || typeof values[key] !== "string") {
      throw new Error(`Harness brief is missing a value for placeholder: ${key}`);
    }
    return values[key];
  });
}

function formatBlocks(blocks: GuideBlock[]): string {
  return blocks.map(({ source, content }) => `[Harness ${source}]\n${content}`).join("\n\n");
}

export function renderHarnessGuides(input: HarnessGuideInput): RenderedHarnessGuides {
  const blocks: GuideBlock[] = [
    // Checker inputs are deliberately isolated from maker instructions and materials.
    ...(input.role === "maker" && input.rules.trim()
      ? [{ source: "rules" as const, content: input.rules, removable: false }]
      : []),
    {
      source: "brief",
      content: fillBrief(input.briefTemplate, input.briefValues),
      removable: false,
    },
    ...(input.role === "maker"
      ? [
          ...input.skills.filter((value) => value.trim()).map((content) => ({
            source: "skills" as const,
            content,
            removable: true,
          })),
          ...input.references.filter((value) => value.trim()).map((content) => ({
            source: "references" as const,
            content,
            removable: true,
          })),
          ...input.bannedDefaults.filter((value) => value.trim()).map((content) => ({
            source: "banned defaults" as const,
            content,
            removable: false,
          })),
        ]
      : input.rubric?.trim()
        ? [{ source: "rubric" as const, content: input.rubric, removable: false }]
        : []),
  ];

  let text = formatBlocks(blocks);
  let truncated = false;

  // Evict lower-priority references before skills, retaining all core guidance
  // and every banned default. Fail closed if non-evictable content cannot fit.
  for (const source of ["references", "skills"] as const) {
    while (text.length > HARNESS_GUIDE_BUDGET) {
      const index = blocks.findIndex((block) => block.source === source && block.removable);
      if (index < 0) break;
      blocks.splice(index, 1);
      truncated = true;
      text = formatBlocks(blocks);
    }
  }

  if (text.length > HARNESS_GUIDE_BUDGET) {
    throw new RangeError("Required harness guide content exceeds the fixed prompt budget");
  }

  return {
    text,
    truncated,
    provenance: blocks.map(({ source }) => source),
  };
}
