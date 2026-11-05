import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { getHarnessCommand } from "./commands";

export const HARNESS_SCHEMA_VERSION = 1 as const;

export type HarnessPurpose = "bug_fix" | "feature" | "generic_audit" | "release_prep";
export type HarnessTemplateFamily = "typescript_node" | "rust_cargo" | "generic_audit" | "release_prep";

export interface HarnessGuides {
  rules: string[];
  brief_template: string;
  skills: string[];
  references: string[];
  banned_defaults: string[];
}

export interface HarnessSensor {
  id: string;
  kind: "command" | "unavailable";
  command_id?: string;
  args: string[];
  timeout_ms: number;
  zero_threshold: number;
  failure_message: string;
  required: boolean;
  baseline?: number;
}

export interface HarnessManifest {
  schema_version: typeof HARNESS_SCHEMA_VERSION;
  id: string;
  project_root: string;
  project_kind: string;
  purpose: HarnessPurpose;
  template_family: HarnessTemplateFamily;
  guides: HarnessGuides;
  maker_agent_id: string;
  checker: { enabled: boolean; agent_id: string; rubric: string };
  sensors: HarnessSensor[];
  loop: { max_rounds: number; abort_on_no_progress: boolean };
  approval: { required_for_new_commands: boolean };
}

export type ManifestValidationResult =
  | { ok: true; manifest: HarnessManifest }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, errors: string[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${label} contains unknown field ${key}`);
  }
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  if (!isString(value) || value.length === 0 || value.trim() !== value) return false;
  if (value.split(/[\\/]+/).some((part) => part === "." || part === "..")) return false;
  // node:path's default is win32 on Windows, and win32.normalize rewrites a
  // POSIX absolute path. Judge each form with its own implementation.
  const posixOk = posix.isAbsolute(value) && !value.includes("\\") && posix.normalize(value) === value;
  const windowsOk = win32.isAbsolute(value) && win32.normalize(value) === value;
  return posixOk || windowsOk;
}

const SHELL_META = /[;&|`$<>()[\]{}*?!'"\\\n\r]/;
function validSensorArg(arg: unknown): arg is string {
  return isString(arg) && arg.length > 0 && !SHELL_META.test(arg) &&
    !arg.split(/[\\/]+/).some((part) => part === "..") && !arg.startsWith("-");
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** SHA-256 of recursively key-sorted JSON; array order remains significant. */
export function manifestHash(manifest: HarnessManifest): string {
  return createHash("sha256").update(canonicalize(manifest), "utf8").digest("hex");
}

export function validateManifest(input: unknown): ManifestValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["manifest must be an object"] };
  const value = input;
  rejectUnknownKeys(value, ["schema_version", "id", "project_root", "project_kind", "purpose", "template_family", "guides", "maker_agent_id", "checker", "sensors", "loop", "approval"], "manifest", errors);

  if (value.schema_version !== HARNESS_SCHEMA_VERSION) errors.push("schema_version must be 1");
  if (!isString(value.id) || !value.id.trim()) errors.push("id must be a non-empty string");
  if (!isCanonicalAbsolutePath(value.project_root)) errors.push("project_root must be an absolute canonical path");
  if (!isString(value.project_kind) || !value.project_kind.trim()) errors.push("project_kind must be a non-empty string");
  if (!["bug_fix", "feature", "generic_audit", "release_prep"].includes(String(value.purpose))) errors.push("purpose is invalid");
  if (!["typescript_node", "rust_cargo", "generic_audit", "release_prep"].includes(String(value.template_family))) errors.push("template_family is invalid");

  const guides = value.guides;
  if (isRecord(guides)) rejectUnknownKeys(guides, ["rules", "brief_template", "skills", "references", "banned_defaults"], "guides", errors);
  if (!isRecord(guides) || !isStringArray(guides.rules) || !isString(guides.brief_template) ||
      !isStringArray(guides.skills) || !isStringArray(guides.references) || !isStringArray(guides.banned_defaults)) {
    errors.push("guides must contain rules, brief_template, skills, references, and banned_defaults");
  }

  if (!isString(value.maker_agent_id) || !value.maker_agent_id.trim()) errors.push("maker_agent_id must be a non-empty string");
  const checker = value.checker;
  if (isRecord(checker)) rejectUnknownKeys(checker, ["enabled", "agent_id", "rubric"], "checker", errors);
  if (!isRecord(checker) || typeof checker.enabled !== "boolean" || !isString(checker.agent_id) || !isString(checker.rubric)) {
    errors.push("checker must contain enabled, agent_id, and rubric");
  } else if (checker.agent_id === value.maker_agent_id) {
    errors.push("checker.agent_id must differ from maker_agent_id");
  }

  if (!Array.isArray(value.sensors)) {
    errors.push("sensors must be an array");
  } else {
    const ids = new Set<string>();
    value.sensors.forEach((raw: unknown, index: number) => {
      const label = `sensors[${index}]`;
      if (!isRecord(raw)) { errors.push(`${label} must be an object`); return; }
      rejectUnknownKeys(raw, ["id", "kind", "command_id", "args", "timeout_ms", "zero_threshold", "failure_message", "required", "baseline"], label, errors);
      if (!isString(raw.id) || !raw.id.trim()) errors.push(`${label}.id must be a non-empty string`);
      else if (ids.has(raw.id)) errors.push(`${label}.id is duplicated`);
      else ids.add(raw.id);
      if (raw.kind !== "command" && raw.kind !== "unavailable") errors.push(`${label}.kind is invalid`);
      if (raw.kind === "command") {
        if (!isString(raw.command_id) || !getHarnessCommand(raw.command_id)) {
          errors.push(`${label}.command_id is unknown`);
        } else {
          const definition = getHarnessCommand(raw.command_id)!;
          if (!Array.isArray(raw.args) || !raw.args.every(validSensorArg)) {
            errors.push(`${label}.args must contain safe strings without shell metacharacters or traversal`);
          } else if (raw.args.length < definition.args_schema.min_items || raw.args.length > definition.args_schema.max_items ||
            (definition.args_schema.item_pattern && raw.args.some((arg: string) => !definition.args_schema.item_pattern!.test(arg)))) {
            errors.push(`${label}.args do not match the fixed schema for ${raw.command_id}`);
          }
        }
      } else if (raw.command_id !== undefined) {
        errors.push(`${label}.command_id must be absent for unavailable sensors`);
      }
      if (!Array.isArray(raw.args) || !raw.args.every(validSensorArg)) errors.push(`${label}.args must be safe strings`);
      if (!Number.isInteger(raw.timeout_ms) || (raw.timeout_ms as number) <= 0 || (raw.timeout_ms as number) > 600_000) errors.push(`${label}.timeout_ms must be an integer from 1 through 600000`);
      if (!Number.isInteger(raw.zero_threshold) || (raw.zero_threshold as number) < 0) errors.push(`${label}.zero_threshold must be a non-negative integer`);
      if (!isString(raw.failure_message)) errors.push(`${label}.failure_message must be a string`);
      if (typeof raw.required !== "boolean") errors.push(`${label}.required must be boolean`);
      if (raw.baseline !== undefined && (!Number.isInteger(raw.baseline) || (raw.baseline as number) < 0)) errors.push(`${label}.baseline must be a non-negative integer`);
    });
  }

  const loop = value.loop;
  if (isRecord(loop)) rejectUnknownKeys(loop, ["max_rounds", "abort_on_no_progress"], "loop", errors);
  if (!isRecord(loop) || !Number.isInteger(loop.max_rounds) || (loop.max_rounds as number) < 1 || (loop.max_rounds as number) > 5) {
    errors.push("loop.max_rounds must be an integer from 1 through 5");
  }
  if (!isRecord(loop) || typeof loop.abort_on_no_progress !== "boolean") errors.push("loop.abort_on_no_progress must be boolean");
  if (isRecord(value.approval)) rejectUnknownKeys(value.approval, ["required_for_new_commands"], "approval", errors);
  if (!isRecord(value.approval) || typeof value.approval.required_for_new_commands !== "boolean") errors.push("approval.required_for_new_commands must be boolean");

  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: value as unknown as HarnessManifest };
}
