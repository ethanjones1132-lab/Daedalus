import { describe, expect, test } from "bun:test";
import { HarnessStore } from "./store";
import { handleHarnessRequest } from "./routes";
import { HARNESS_TEMPLATES, instantiateHarnessTemplate } from "./templates";
import { validateManifest, type HarnessManifest } from "./manifest";

const ROOT = "/known/project";
function manifest(id = "bug-fix", root = ROOT): HarnessManifest {
  return {
    schema_version: 1, id, project_root: root, project_kind: "typescript_node", purpose: "bug_fix", template_family: "typescript_node",
    guides: { rules: ["Be precise"], brief_template: "{{task}}", skills: [], references: [], banned_defaults: [] },
    maker_agent_id: "maker", checker: { enabled: true, agent_id: "checker", rubric: "Review independently" },
    sensors: [{ id: "typecheck", kind: "command", command_id: "bun_typecheck", args: [], timeout_ms: 1000, zero_threshold: 0,
      failure_message: "must pass", required: true }],
    loop: { max_rounds: 5, abort_on_no_progress: true }, approval: { required_for_new_commands: true },
  };
}

function setup() {
  const store = new HarnessStore({ dbPath: ":memory:" });
  const request = (path: string, method = "GET", body?: unknown) => handleHarnessRequest(new Request(`http://local${path}`, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }), { store, resolveKnownProjectRoot: (root) => root === ROOT || root === "/alias" ? ROOT : root === "/other" ? "/other" : null });
  return { store, request };
}
const payload = async (response: Response | null) => response!.json();

describe("harness routes", () => {
  test("lists templates, each validated when bound to a canonical project root", async () => {
    expect((await payload(await setup().request("/harness/templates"))).templates).toHaveLength(HARNESS_TEMPLATES.length);
    for (const template of HARNESS_TEMPLATES) expect(validateManifest(instantiateHarnessTemplate(template.id, ROOT)).ok).toBe(true);
    expect(HARNESS_TEMPLATES.find((item) => item.id === "release_prep")?.sensors.every((sensor) => sensor.kind === "unavailable")).toBe(true);
  });

  test("resolves only app-known project roots and creates a manifest from a template", async () => {
    const { request } = setup();
    expect((await request("/harness/projects/resolve", "POST", { root: "/alias" }))?.status).toBe(200);
    expect((await payload(await request("/harness/manifests/from-template", "POST", { template_id: "typescript_node_bug_fix", project_root: ROOT, expected_revision: 0 }))).revision).toBe(1);
    expect((await request("/harness/projects/resolve", "POST", { root: "/unknown" }))?.status).toBe(404);
    expect((await request("/harness/manifests/from-template", "POST", { template_id: "typescript_node_bug_fix", project_root: "/unknown", expected_revision: 0 }))?.status).toBe(404);
  });

  test("creates, lists, gets, and updates manifests; stale revisions return 409", async () => {
    const { request } = setup();
    const created = await request("/harness/manifests", "POST", { manifest: manifest(), expected_revision: 0 });
    expect(created?.status).toBe(201);
    expect((await payload(await request(`/harness/manifests?project_root=${encodeURIComponent(ROOT)}`))).manifests).toHaveLength(1);
    expect((await payload(await request(`/harness/manifests/bug-fix?project_root=${encodeURIComponent(ROOT)}`))).revision).toBe(1);
    const updated = manifest(); updated.guides.rules = ["Updated"];
    expect((await request("/harness/manifests/bug-fix", "PUT", { manifest: updated, expected_revision: 1 }))?.status).toBe(200);
    expect((await request("/harness/manifests/bug-fix", "PUT", { manifest: updated, expected_revision: 1 }))?.status).toBe(409);
  });

  test("returns validator errors for invalid manifests and refuses unknown roots", async () => {
    const { request } = setup();
    const bad = { ...manifest(), sensors: [{ ...manifest().sensors[0], command_id: "arbitrary_shell" }] };
    const response = await request("/harness/manifests", "POST", { manifest: bad, expected_revision: 0 });
    expect(response?.status).toBe(400);
    expect((await payload(response)).errors).toContain("sensors[0].command_id is unknown");
    expect((await request("/harness/manifests", "POST", { manifest: manifest("x", "/unknown"), expected_revision: 0 }))?.status).toBe(404);
  });

  test("previews rendered guides for stored and inline manifests", async () => {
    const { request } = setup();
    await request("/harness/manifests", "POST", { manifest: manifest(), expected_revision: 0 });
    const preview = await payload(await request("/harness/guides/preview", "POST", { project_root: ROOT, manifest_id: "bug-fix", brief_values: { task: "Fix it" } }));
    expect(preview.guides_rendered).toBe(true);
    expect(preview.text).toContain("Fix it");
    expect((await request("/harness/guides/preview", "POST", { project_root: "/unknown", manifest_id: "bug-fix" }))?.status).toBe(404);
  });

  test("lists run history by project root and scopes individual run reads", async () => {
    const { store, request } = setup();
    const one = store.createRun({ project_root: ROOT, manifest_id: "m", manifest_hash: "hash" });
    store.createRun({ project_root: "/other", manifest_id: "m", manifest_hash: "hash" });
    const history = await payload(await request(`/harness/runs?project_root=${encodeURIComponent(ROOT)}`));
    expect(history.runs.map((run: { id: string }) => run.id)).toEqual([one.id]);
    expect((await request(`/harness/runs/${one.id}?project_root=${encodeURIComponent(ROOT)}`))?.status).toBe(200);
    expect((await request(`/harness/runs/${one.id}?project_root=%2Fother`))?.status).toBe(404);
  });
});
