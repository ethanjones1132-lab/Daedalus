import { validateManifest, type HarnessManifest, type HarnessPurpose, type HarnessTemplateFamily } from "./manifest";

export interface HarnessTemplate {
  id: string;
  project_kind: string;
  purpose: HarnessPurpose;
  template_family: HarnessTemplateFamily;
  guides: HarnessManifest["guides"];
  maker_agent_id: string;
  checker: HarnessManifest["checker"];
  sensors: HarnessManifest["sensors"];
  loop: HarnessManifest["loop"];
  approval: HarnessManifest["approval"];
}

const sharedGuides: HarnessManifest["guides"] = {
  rules: ["Follow the project's conventions and report verification evidence honestly."],
  brief_template: "{{task}}",
  skills: [], references: [], banned_defaults: ["Never claim a check passed unless its runtime result confirms it."],
};
const common = {
  guides: sharedGuides,
  maker_agent_id: "maker",
  checker: { enabled: true, agent_id: "independent-checker", rubric: "Assess the result independently against the task and evidence." },
  loop: { max_rounds: 5, abort_on_no_progress: true },
  approval: { required_for_new_commands: true },
} as const;

function commandSensor(id: string, command_id: string, failure_message: string) {
  return { id, kind: "command" as const, command_id, args: [], timeout_ms: 120_000, zero_threshold: 0, failure_message, required: true };
}

/** V1 template definitions contain no project authority; a canonical root is bound when instantiated. */
export const HARNESS_TEMPLATES: readonly HarnessTemplate[] = [
  ...(["bug_fix", "feature"] as const).flatMap((purpose) => [
    { ...common, id: `typescript_node_${purpose}`, project_kind: "typescript_node", purpose, template_family: "typescript_node" as const,
      sensors: [commandSensor("typecheck", "bun_typecheck", "TypeScript typecheck must report zero errors.") ] },
    { ...common, id: `rust_cargo_${purpose}`, project_kind: "rust_cargo", purpose, template_family: "rust_cargo" as const,
      sensors: [commandSensor("format", "cargo_fmt_check", "Cargo formatting must pass."), commandSensor("check", "cargo_check", "Cargo check must report zero errors.")] },
  ]),
  { ...common, id: "generic_audit", project_kind: "generic", purpose: "generic_audit", template_family: "generic_audit",
    guides: { ...sharedGuides, rules: [...sharedGuides.rules, "Provide read-only findings and state explicit acceptance criteria."] }, sensors: [] },
  { ...common, id: "release_prep", project_kind: "generic", purpose: "release_prep", template_family: "release_prep",
    sensors: ["publishing", "signing", "installation"].map((id) => ({ id, kind: "unavailable" as const, args: [], timeout_ms: 1, zero_threshold: 0,
      failure_message: "Unavailable: release preparation does not execute publishing, signing, or installation.", required: false })) },
];

export function instantiateHarnessTemplate(templateId: string, projectRoot: string): HarnessManifest | undefined {
  const template = HARNESS_TEMPLATES.find(({ id }) => id === templateId);
  if (!template) return undefined;
  const candidate: unknown = { schema_version: 1, ...template, id: template.id, project_root: projectRoot };
  const result = validateManifest(candidate);
  if (!result.ok) throw new Error(`Invalid built-in harness template ${templateId}: ${result.errors.join("; ")}`);
  return result.manifest;
}
