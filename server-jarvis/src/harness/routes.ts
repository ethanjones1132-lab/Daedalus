import { renderHarnessGuides } from "../orchestration/harness-guides";
import { validateManifest, type HarnessManifest } from "./manifest";
import { HarnessStore } from "./store";
import { HARNESS_TEMPLATES, instantiateHarnessTemplate } from "./templates";

export interface HarnessRouteOptions {
  store?: HarnessStore;
  /** Return an app-known canonical project root, or null for an unknown root. */
  resolveKnownProjectRoot?: (root: string) => string | null;
}

function jsonError(error: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error, ...extra }, { status });
}

function projectRootFrom(url: URL, body?: Record<string, unknown>): unknown {
  return body?.project_root ?? url.searchParams.get("project_root") ?? body?.root ?? url.searchParams.get("root");
}

/** Harness HTTP routes. All filesystem authority is supplied by app-known roots. */
export async function handleHarnessRequest(req: Request, options: HarnessRouteOptions = {}): Promise<Response | null> {
  const url = new URL(req.url, "http://local");
  const path = url.pathname;
  const store = options.store ?? new HarnessStore();
  const resolveRoot = options.resolveKnownProjectRoot ?? (() => null);
  if (!path.startsWith("/harness/")) return null;

  if (path === "/harness/templates" && req.method === "GET") {
    return Response.json({ templates: HARNESS_TEMPLATES });
  }

  if (path === "/harness/projects/resolve" && req.method === "POST") {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (typeof body?.root !== "string") return jsonError("root must be a string", 400);
    const canonical = resolveRoot(body.root);
    return canonical ? Response.json({ project_root: canonical }) : jsonError("unknown_project_root", 404);
  }

  if (path === "/harness/manifests" && req.method === "GET") {
    const inputRoot = url.searchParams.get("project_root");
    if (!inputRoot) return jsonError("project_root is required", 400);
    const root = resolveRoot(inputRoot);
    return root ? Response.json({ manifests: store.listManifests(root) }) : jsonError("unknown_project_root", 404);
  }

  if (path === "/harness/manifests" && req.method === "POST") {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const candidate = body?.manifest;
    const checked = validateManifest(candidate);
    if (!checked.ok) return jsonError("invalid_manifest", 400, { errors: checked.errors });
    const root = resolveRoot(checked.manifest.project_root);
    if (!root) return jsonError("unknown_project_root", 404);
    if (root !== checked.manifest.project_root) return jsonError("project_root must be canonical", 400);
    const revision = body?.expected_revision;
    if (revision !== 0) return jsonError("expected_revision must be 0 for create", 400);
    try { return Response.json(store.saveManifest(checked.manifest, 0), { status: 201 }); }
    catch (error) { return jsonError(String(error), /Stale manifest revision/.test(String(error)) ? 409 : 400); }
  }

  const manifestMatch = path.match(/^\/harness\/manifests\/([^/]+)$/);
  if (manifestMatch) {
    let id: string;
    try { id = decodeURIComponent(manifestMatch[1]); } catch { return jsonError("invalid manifest id", 400); }
    if (req.method === "GET") {
      const inputRoot = url.searchParams.get("project_root");
      if (!inputRoot) return jsonError("project_root is required", 400);
      const root = resolveRoot(inputRoot);
      if (!root) return jsonError("unknown_project_root", 404);
      const saved = store.getManifest(root, id);
      return saved ? Response.json(saved) : jsonError("manifest_not_found", 404);
    }
    if (req.method === "PUT") {
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      const checked = validateManifest(body?.manifest);
      if (!checked.ok) return jsonError("invalid_manifest", 400, { errors: checked.errors });
      if (checked.manifest.id !== id) return jsonError("manifest id cannot change", 400);
      const root = resolveRoot(checked.manifest.project_root);
      if (!root) return jsonError("unknown_project_root", 404);
      if (root !== checked.manifest.project_root) return jsonError("project_root must be canonical", 400);
      const revision = body?.expected_revision;
      if (!Number.isInteger(revision) || (revision as number) < 1) return jsonError("expected_revision must be a positive integer", 400);
      try { return Response.json(store.saveManifest(checked.manifest, revision as number)); }
      catch (error) { return jsonError(String(error), /Stale manifest revision/.test(String(error)) ? 409 : 400); }
    }
  }

  if (path === "/harness/manifests/from-template" && req.method === "POST") {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (typeof body?.template_id !== "string" || typeof body.project_root !== "string") return jsonError("template_id and project_root are required", 400);
    const root = resolveRoot(body.project_root);
    if (!root) return jsonError("unknown_project_root", 404);
    const manifest = instantiateHarnessTemplate(body.template_id, root);
    if (!manifest) return jsonError("template_not_found", 404);
    const revision = body.expected_revision;
    if (revision !== 0) return jsonError("expected_revision must be 0 for create", 400);
    try { return Response.json(store.saveManifest(manifest, 0), { status: 201 }); }
    catch (error) { return jsonError(String(error), /Stale manifest revision/.test(String(error)) ? 409 : 400); }
  }

  if (path === "/harness/guides/preview" && req.method === "POST") {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const rootValue = projectRootFrom(url, body ?? undefined);
    if (typeof rootValue !== "string") return jsonError("project_root is required", 400);
    const root = resolveRoot(rootValue);
    if (!root) return jsonError("unknown_project_root", 404);
    let manifest: HarnessManifest | undefined;
    if (typeof body?.manifest_id === "string") manifest = store.getManifest(root, body.manifest_id)?.manifest;
    else {
      const checked = validateManifest(body?.manifest);
      if (!checked.ok) return jsonError("invalid_manifest", 400, { errors: checked.errors });
      if (checked.manifest.project_root !== root) return jsonError("project_root mismatch", 400);
      manifest = checked.manifest;
    }
    if (!manifest) return jsonError("manifest_not_found", 404);
    const values = body?.brief_values;
    if (values !== undefined && (!values || typeof values !== "object" || Array.isArray(values) || Object.values(values).some((v) => typeof v !== "string"))) return jsonError("brief_values must be a string map", 400);
    try {
      const rendered = renderHarnessGuides({ rules: manifest.guides.rules.join("\n"), briefTemplate: manifest.guides.brief_template,
        briefValues: (values ?? {}) as Record<string, string>, skills: manifest.guides.skills, references: manifest.guides.references,
        bannedDefaults: manifest.guides.banned_defaults, role: body?.role === "checker" ? "checker" : "maker",
        rubric: manifest.checker.rubric });
      return Response.json({ guides_rendered: true, ...rendered });
    } catch (error) { return jsonError(String(error), 400); }
  }

  if (path === "/harness/runs" && req.method === "GET") {
    const inputRoot = url.searchParams.get("project_root");
    if (!inputRoot) return jsonError("project_root is required", 400);
    const root = resolveRoot(inputRoot);
    return root ? Response.json({ runs: store.listRuns(root) }) : jsonError("unknown_project_root", 404);
  }
  const runMatch = path.match(/^\/harness\/runs\/([^/]+)$/);
  if (runMatch && req.method === "GET") {
    const inputRoot = url.searchParams.get("project_root");
    if (!inputRoot) return jsonError("project_root is required", 400);
    const root = resolveRoot(inputRoot);
    if (!root) return jsonError("unknown_project_root", 404);
    let id: string;
    try { id = decodeURIComponent(runMatch[1]); } catch { return jsonError("invalid run id", 400); }
    const run = store.getRun(id);
    return run?.project_root === root ? Response.json({ run }) : jsonError("run_not_found", 404);
  }
  return jsonError("not_found", 404);
}
