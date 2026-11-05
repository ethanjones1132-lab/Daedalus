import { describe, expect, test } from "bun:test";
import { getHarnessCommand } from "./commands";
import { manifestHash, validateManifest, type HarnessManifest } from "./manifest";

function fixture(overrides: Partial<HarnessManifest> = {}): HarnessManifest {
  return {
    schema_version: 1,
    id: "project-bugfix",
    project_root: "/workspace/project",
    project_kind: "typescript_node",
    purpose: "bug_fix",
    template_family: "typescript_node",
    guides: { rules: ["Keep the change focused"], brief_template: "Fix the reported defect", skills: [], references: [], banned_defaults: [] },
    maker_agent_id: "maker",
    checker: { enabled: true, agent_id: "checker", rubric: "Review correctness and regression risk" },
    sensors: [{ id: "typecheck", kind: "command", command_id: "bun_typecheck", args: [], timeout_ms: 120_000, zero_threshold: 0, failure_message: "Typecheck must pass", required: true }],
    loop: { max_rounds: 5, abort_on_no_progress: true },
    approval: { required_for_new_commands: true },
    ...overrides,
  };
}

function rejected(change: (manifest: HarnessManifest) => void, includes: string) {
  const manifest = fixture();
  change(manifest);
  const result = validateManifest(manifest);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected invalid manifest");
  expect(result.errors.join(" ")).toContain(includes);
}

describe("harness manifest v1", () => {
  test("accepts a TypeScript bug_fix manifest", () => {
    expect(validateManifest(fixture()).ok).toBe(true);
  });

  test("accepts a Rust feature manifest", () => {
    const rust = fixture({
      id: "rust-feature", project_kind: "rust_cargo", purpose: "feature", template_family: "rust_cargo",
      sensors: [{ id: "cargo-check", kind: "command", command_id: "cargo_check", args: [], timeout_ms: 300_000, zero_threshold: 0, failure_message: "Cargo check must pass", required: true }],
    });
    expect(validateManifest(rust).ok).toBe(true);
  });

  test("rejects an unknown command_id", () => rejected((m) => { m.sensors[0].command_id = "shell"; }, "command_id is unknown"));
  test("rejects shell metacharacters and path traversal in args", () => {
    rejected((m) => { m.sensors[0].command_id = "bun_test"; m.sensors[0].args = ["tests;whoami"]; }, "safe strings");
    rejected((m) => { m.sensors[0].command_id = "bun_test"; m.sensors[0].args = ["../outside"]; }, "safe strings");
  });
  test("rejects max_rounds outside 1..5", () => rejected((m) => { m.loop.max_rounds = 6; }, "max_rounds"));
  test("rejects checker identity matching maker", () => rejected((m) => { m.checker.agent_id = m.maker_agent_id; }, "must differ"));
  test("rejects non-absolute or non-canonical project roots", () => {
    rejected((m) => { m.project_root = "relative/project"; }, "absolute canonical");
    rejected((m) => { m.project_root = "/workspace/../project"; }, "absolute canonical");
  });
  test("rejects duplicate sensor ids", () => rejected((m) => { m.sensors.push({ ...m.sensors[0] }); }, "duplicated"));
  test("rejects invalid zero_threshold", () => {
    rejected((m) => { m.sensors[0].zero_threshold = -1; }, "zero_threshold");
    rejected((m) => { (m.sensors[0] as { zero_threshold: number }).zero_threshold = 0.5; }, "zero_threshold");
  });
  test("rejects timeout_ms over 600000", () => rejected((m) => { m.sensors[0].timeout_ms = 600_001; }, "timeout_ms"));
  test("rejects unknown schema_version", () => rejected((m) => { (m as { schema_version: number }).schema_version = 2; }, "schema_version"));

  test("hash is stable under object key reordering", () => {
    const manifest = fixture();
    const reordered = JSON.parse(JSON.stringify(manifest));
    reordered.sensors[0] = Object.fromEntries(Object.entries(reordered.sensors[0]).reverse());
    expect(manifestHash(manifest)).toBe(manifestHash(reordered));
  });

  test("hash changes when a sensor argument changes", () => {
    const manifest = fixture();
    manifest.sensors[0].command_id = "bun_test";
    manifest.sensors[0].args = ["before"];
    const before = manifestHash(manifest);
    manifest.sensors[0].args = ["after"];
    expect(manifestHash(manifest)).not.toBe(before);
  });
});

describe("harness command parsers", () => {
  const parser = getHarnessCommand("bun_test")!.parse;

  test("parses a zero counter", () => expect(parser("Errors: 0", "", 0)).toEqual({ ok: true, counter: 0 }));
  test("parses a non-zero counter", () => expect(parser("Errors: 3", "", 0)).toEqual({ ok: true, counter: 3 }));
  test("treats empty output as failure", () => expect(parser("", "", 0).ok).toBe(false));
  test("treats garbage output as failure", () => expect(parser("all good", "", 0).ok).toBe(false));
  test("treats a timeout marker as failure", () => expect(parser("TIMEOUT", "Errors: 0", 0).ok).toBe(false));
});
