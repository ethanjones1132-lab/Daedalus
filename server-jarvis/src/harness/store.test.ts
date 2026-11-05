import { describe, expect, test } from "bun:test";
import { HarnessStore } from "./store";
import type { HarnessManifest } from "./manifest";

function manifest(root: string, id = "bugfix"): HarnessManifest {
  return {
    schema_version: 1,
    id,
    project_root: root,
    project_kind: "typescript",
    purpose: "bug_fix",
    template_family: "typescript_node",
    guides: { rules: [], brief_template: "", skills: [], references: [], banned_defaults: [] },
    maker_agent_id: "maker",
    checker: { enabled: true, agent_id: "checker", rubric: "Check independently" },
    sensors: [{ id: "typecheck", kind: "command", command_id: "bun_typecheck", args: [], timeout_ms: 1000,
      zero_threshold: 0, failure_message: "type errors", required: true }],
    loop: { max_rounds: 5, abort_on_no_progress: true },
    approval: { required_for_new_commands: true },
  };
}

describe("HarnessStore", () => {
  test("a manifest's identity is its canonical project root plus its purpose id", () => {
    const store = new HarnessStore({ dbPath: ":memory:" });
    store.saveManifest(manifest("/workspace/one", "bugfix"), 0);
    // Same root, same purpose id: the same manifest, so it needs the current revision.
    expect(() => store.saveManifest(manifest("/workspace/one", "bugfix"), 0)).toThrow(/Stale manifest revision/);
    // A different purpose id or a different root starts its own revision history.
    expect(store.saveManifest(manifest("/workspace/one", "feature"), 0).revision).toBe(1);
    expect(store.saveManifest(manifest("/workspace/two", "bugfix"), 0).revision).toBe(1);
    expect(store.listManifests("/workspace/one").map((saved) => saved.manifest.id).sort()).toEqual(["bugfix", "feature"]);
    expect(store.getManifest("/workspace/two", "feature")).toBeUndefined();
  });

  test("saves revisions monotonically and rejects a stale expected revision", () => {
    const store = new HarnessStore({ dbPath: ":memory:" });
    const first = store.saveManifest(manifest("/workspace/one"), 0);
    expect(first.revision).toBe(1);
    const changed = manifest("/workspace/one");
    changed.guides.rules = ["updated"];
    expect(store.saveManifest(changed, 1).revision).toBe(2);
    expect(store.getManifest("/workspace/one", "bugfix")?.revision).toBe(2);
    expect(() => store.saveManifest(manifest("/workspace/one"), 1)).toThrow(/Stale manifest revision/);
  });

  test("approval only matches the complete command, root, and manifest-hash binding", () => {
    const store = new HarnessStore({ dbPath: ":memory:" });
    store.recordApproval({ command_id: "bun_test", project_root: "/workspace/one", manifest_hash: "hash-a", decision: "approved" });
    expect(store.findApproval("bun_test", "/workspace/one", "hash-a")?.decision).toBe("approved");
    expect(store.findApproval("cargo_test", "/workspace/one", "hash-a")).toBeUndefined();
    expect(store.findApproval("bun_test", "/workspace/two", "hash-a")).toBeUndefined();
    expect(store.findApproval("bun_test", "/workspace/one", "hash-b")).toBeUndefined();
  });

  test("stores bounded sensor output and reports truncation explicitly", () => {
    const store = new HarnessStore({ dbPath: ":memory:" });
    const run = store.createRun({ project_root: "/workspace/one", manifest_id: "bugfix", manifest_hash: "hash" });
    const round = store.appendRound({ run_id: run.id, round_number: 1, counter_vector: { typecheck: 0 } });
    const result = store.appendSensorResult({ run_id: run.id, round_id: round.id, sensor_id: "typecheck", status: "passed",
      counter: 0, exit_code: 0, stdout: "x".repeat(65 * 1024), stderr: "small" });
    const persistedResultId: string = result.id;
    expect(persistedResultId).toBeTruthy();
    expect(Buffer.byteLength(result.stdout, "utf8")).toBe(64 * 1024);
    expect(result.stdout_truncated).toBe(true);
    expect(result.stderr).toBe("small");
    expect(result.stderr_truncated).toBe(false);
    expect(store.getRun(run.id)?.rounds[0]?.sensor_results[0]?.stdout_truncated).toBe(true);
  });

  test("lists manifests and runs only for the requested project root", () => {
    const store = new HarnessStore({ dbPath: ":memory:" });
    store.saveManifest(manifest("/workspace/one"), 0);
    store.saveManifest(manifest("/workspace/two"), 0);
    const firstRun = store.createRun({ project_root: "/workspace/one", manifest_id: "bugfix", manifest_hash: "a" });
    store.createRun({ project_root: "/workspace/two", manifest_id: "bugfix", manifest_hash: "b" });
    expect(store.listManifests("/workspace/one").map(({ manifest: item }) => item.project_root)).toEqual(["/workspace/one"]);
    expect(store.listRuns("/workspace/one").map(({ id }) => id)).toEqual([firstRun.id]);
  });

  test("exposes append operations but no update or delete API for run evidence", () => {
    const methods = Object.getOwnPropertyNames(HarnessStore.prototype);
    expect(methods).toContain("appendRound");
    expect(methods).toContain("appendSensorResult");
    expect(methods).toContain("appendEvent");
    expect(methods.some((name) => /^(update|delete|remove)(Round|SensorResult|Event)/i.test(name))).toBe(false);
  });
});
